"""DSH 插件兼容桥 —— 让 AstrBot 直接吃 DSH / Cordis 插件，不用装 DSH。

原理（强行兼容，不是协商）：
  * 每个 DSH 插件起一个 node 子进程，跑 host/boot.mjs；
  * boot.mjs 用 ESM loader 劫持 `cordis` / `@deepseek-ai/dsh-tools` 这些 import，
    塞进我们自己的假货（host/shim/），所以插件以为自己跑在 harness 里；
  * 插件调 ctx.tools.register / ctx.systemPrompt.context 时，宿主全记下来；
  * 这边把工具注册成 AstrBot 的 FunctionTool，把提示注入接进 on_llm_request。

对主人：
  /dshcompat            看桥状态（几个插件、几个工具）
  /dshcompat reload     重新拉起
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import ProviderRequest
from astrbot.api.star import Context, Star, register

BRIDGE_DIR = Path(__file__).parent
HOST_DIR = BRIDGE_DIR / "host"
BOOT_JS = HOST_DIR / "boot.mjs"

# DSH 桌面版自带的 node 运行时（有就用，用户不用另装 node）
DSH_NODE_CANDIDATES = [
    Path.home() / ".dsh" / "dsh-runtimes" / "dsh-primary-runtime" / "dependencies" / "node" / "bin" / "node.exe",
    Path.home() / ".dsh" / "dsh-runtimes" / "dsh-primary-runtime" / "dependencies" / "node" / "bin" / "node",
]


def _find_node(configured: str = "") -> str | None:
    if configured and Path(configured).exists():
        return configured
    for p in DSH_NODE_CANDIDATES:
        if p.exists():
            return str(p)
    return shutil.which("node")


class DshProcess:
    """一个 DSH 插件 = 一个 node 子进程 + 一条 stdio JSON-lines 通道。"""

    def __init__(self, plugin_dir: str, node: str, name: str = ""):
        self.dir = str(Path(plugin_dir).resolve())
        self.node = node
        self.name = name or Path(self.dir).name
        self.proc: asyncio.subprocess.Process | None = None
        self.tools: list[dict] = []
        self.prompts: list[dict] = []
        self.routes: list[dict] = []
        self._seq = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._reader: asyncio.Task | None = None
        self.last_error = ""

    async def start(self, timeout: float = 45.0) -> None:
        if not BOOT_JS.exists():
            raise FileNotFoundError(f"桥的宿主脚本没了：{BOOT_JS}")
        self.proc = await asyncio.create_subprocess_exec(
            self.node, str(BOOT_JS), "--plugin", self.dir,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(HOST_DIR),
        )
        self._reader = asyncio.create_task(self._read_loop())
        first = await asyncio.wait_for(self.proc.stdout.readline(), timeout=timeout)
        if not first:
            raise RuntimeError(f"{self.name}: 子进程没返回 ready")
        msg = json.loads(first.decode("utf-8", "replace"))
        if msg.get("event") == "fatal":
            raise RuntimeError(f"{self.name}: {msg.get('error', '')[:400]}")
        self.name = msg.get("plugin") or self.name
        self.tools = msg.get("tools") or []
        self.prompts = msg.get("prompts") or []

    async def _read_loop(self) -> None:
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line.decode("utf-8", "replace"))
            except Exception:
                continue
            rid = msg.get("id")
            if rid is not None and rid in self._pending:
                fut = self._pending.pop(rid)
                if not fut.done():
                    if "error" in msg:
                        fut.set_exception(RuntimeError(str(msg["error"])))
                    else:
                        fut.set_result(msg.get("result"))
            elif msg.get("event") == "fatal":
                self.last_error = str(msg.get("error", ""))[:500]
                logger.error(f"[compat_dsh] {self.name} 致命错误：{self.last_error}")

    async def call(self, method: str, params: dict | None = None, timeout: float = 60.0):
        if not self.proc or self.proc.returncode is not None:
            raise RuntimeError(f"{self.name}: 进程不在")
        self._seq += 1
        rid = self._seq
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        payload = json.dumps({"id": rid, "method": method, "params": params or {}}, ensure_ascii=False)
        self.proc.stdin.write((payload + "\n").encode("utf-8"))
        await self.proc.stdin.drain()
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(rid, None)

    async def stop(self) -> None:
        try:
            if self.proc and self.proc.returncode is None:
                await asyncio.wait_for(self.call("shutdown", timeout=3), timeout=4)
        except Exception:
            pass
        if self._reader:
            self._reader.cancel()
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.proc = None


@register(
    "astrbot_plugin_compat_dsh",
    "shingflash",
    "DSH/Cordis 插件兼容桥：不用装 DSH，把 dsh 插件直接拉进 AstrBot",
    "1.0.0",
)
class DshBridgePlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}
        self.procs: dict[str, DshProcess] = {}
        self.node = ""
        self._booted = False

    # ---------- 生命周期 ----------
    async def initialize(self):
        await self._boot()

    async def _boot(self):
        dirs = self._plugin_dirs()
        if not dirs:
            logger.info("[compat_dsh] 没配插件目录，桥空转")
            return
        self.node = _find_node(self.config.get("node_path", "")) or ""
        if not self.node:
            logger.error("[compat_dsh] 找不到 node：装一个或填 node_path，或装过 DSH 桌面版")
            return
        logger.info(f"[compat_dsh] node = {self.node}")
        for d in dirs:
            await self._add_one(d)
        self._booted = True

    def _plugin_dirs(self) -> list[str]:
        raw = str(self.config.get("plugin_dirs") or "")
        out = []
        for part in raw.replace("\n", ";").replace(",", ";").split(";"):
            p = part.strip().strip('"')
            if p and Path(p).exists():
                out.append(p)
            elif p:
                logger.warning(f"[compat_dsh] 目录不存在，跳过：{p}")
        return out

    async def _add_one(self, d: str) -> None:
        p = DshProcess(d, self.node)
        try:
            await p.start()
            self.procs[p.name] = p
            self._register_tools(p)
            logger.info(
                f"[compat_dsh] {p.name} 已上车：{len(p.tools)} 工具 / "
                f"{len(p.prompts)} 注入口 / {len(p.routes)} 路由"
            )
        except Exception as e:
            logger.error(f"[compat_dsh] {Path(d).name} 起不来：{e}")
            await p.stop()

    def _register_tools(self, p: DshProcess) -> None:
        from astrbot.core.agent.tool import FunctionTool

        made = []
        for t in p.tools:
            name = f"{p.name.replace('-', '_')}__{t['name']}"
            made.append(
                FunctionTool(
                    name=name[:64],
                    description=(t.get("description") or "")[:1000],
                    parameters=t.get("parameters") or {"type": "object", "properties": {}},
                    handler=self._make_handler(p, t["name"]),
                )
            )
        if made:
            try:
                self.context.add_llm_tools(*made)
            except Exception as e:
                logger.error(f"[compat_dsh] 注册工具失败：{e}")

    def _make_handler(self, p: DshProcess, tool_name: str):
        async def handler(**kwargs):
            try:
                res = await p.call("tools.call", {"name": tool_name, "args": kwargs}, timeout=120)
                return str(res)
            except Exception as e:
                return f"[{p.name}/{tool_name} 调用失败] {e}"

        return handler

    async def terminate(self):
        for p in list(self.procs.values()):
            await p.stop()
        self.procs.clear()

    # ---------- 提示注入 ----------
    @filter.on_llm_request()
    async def inject_context(self, event: AstrMessageEvent, req: ProviderRequest):
        if not self.config.get("inject_prompt", True) or not self.procs:
            return
        text = event.message_str or ""
        if not text:
            return
        chunks = []
        for p in self.procs.values():
            if not p.prompts:
                continue
            try:
                out = await p.call(
                    "prompt.render",
                    {"messages": [{"role": "user", "content": text}]},
                    timeout=15,
                )
                if out:
                    chunks.append(str(out))
            except Exception as e:
                logger.debug(f"[compat_dsh] {p.name} 注入失败：{e}")
        if chunks:
            req.system_prompt = (req.system_prompt or "") + "\n\n" + "\n\n".join(chunks)

    # ---------- 指令 ----------
    @filter.command("dshbridge")
    async def cmd_status(self, event: AstrMessageEvent):
        """dshcompat [reload] —— 看桥状态 / 重新拉起"""
        arg = (event.message_str or "").split(maxsplit=1)
        if len(arg) > 1 and arg[1].strip() in ("reload", "重载", "重启"):
            for p in list(self.procs.values()):
                await p.stop()
            self.procs.clear()
            await self._boot()
            return event.plain_result(f"重载完了，现在 {len(self.procs)} 个插件在车上")
        if not self.procs:
            return event.plain_result("桥上没车。配置里填 dsh 插件目录，或装过 DSH 桌面版就去 ~/.dsh/plugins 找。")
        lines = [f"dsh 兼容桥 · node {self.node or '未找到'}"]
        for p in self.procs.values():
            tools = "、".join(t["name"] for t in p.tools) or "无"
            lines.append(f"· {p.name}：工具 {len(p.tools)}（{tools}），注入 {len(p.prompts)}")
        return event.plain_result("\n".join(lines))

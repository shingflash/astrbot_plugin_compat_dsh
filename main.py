"""dsh plugin compatibility layer - let AstrBot consume dsh / Cordis plugins
without installing dsh itself.

How it works (shim, not negotiation):
  * every dsh plugin gets one node child process running host/boot.mjs;
  * boot.mjs hijacks ESM imports of `cordis` / `@deepseek-ai/dsh-tools` to local
    shims, so the plugin believes it runs inside the harness;
  * ctx.tools.register / ctx.systemPrompt.context calls are captured by the host;
  * this plugin re-registers those tools as AstrBot FunctionTools and merges the
    prompt fragments into on_llm_request.

Commands:
  /dshcompat            show bridge status
  /dshcompat reload     restart every plugin
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
from collections import deque
from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import ProviderRequest
from astrbot.api.star import Context, Star, register

BRIDGE_DIR = Path(__file__).parent
HOST_DIR = BRIDGE_DIR / "host"
BOOT_JS = HOST_DIR / "boot.mjs"

# Node runtime shipped with the dsh desktop client.
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
    """One dsh plugin == one node child process + one stdio JSON-lines channel."""

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
        self._stderr_reader: asyncio.Task | None = None
        self._ready: asyncio.Future | None = None
        self.last_error = ""
        self.stderr_tail: deque[str] = deque(maxlen=30)

    async def start(self, timeout: float = 45.0) -> None:
        if not BOOT_JS.exists():
            raise FileNotFoundError(f"host script missing: {BOOT_JS}")
        self.proc = await asyncio.create_subprocess_exec(
            self.node, str(BOOT_JS), "--plugin", self.dir,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(HOST_DIR),
        )
        # A single owner for stdout: the read loop. It hands the ready frame back
        # through this future. Reading the same StreamReader from two coroutines
        # raises "readuntil() called while another coroutine is already waiting".
        self._ready = asyncio.get_running_loop().create_future()
        self._reader = asyncio.create_task(self._read_loop())
        self._stderr_reader = asyncio.create_task(self._drain_stderr())
        try:
            msg = await asyncio.wait_for(self._ready, timeout=timeout)
        except asyncio.TimeoutError:
            detail = " | ".join(self.stderr_tail)
            await self.stop()
            raise RuntimeError(f"{self.name}: no ready frame in {timeout}s {detail}".strip())
        except Exception:
            await self.stop()
            raise
        if not msg:
            raise RuntimeError(f"{self.name}: child process returned no ready frame")
        self.name = msg.get("plugin") or self.name
        self.tools = msg.get("tools") or []
        self.prompts = msg.get("prompts") or []

    async def _drain_stderr(self) -> None:
        """Keep reading stderr: boot.mjs sends every plugin log there, and a full
        64 KiB pipe would block the child forever."""
        assert self.proc and self.proc.stderr
        while True:
            line = await self.proc.stderr.readline()
            if not line:
                break
            self.stderr_tail.append(line.decode("utf-8", "replace").rstrip())

    def _resolve_ready(self, msg: dict) -> None:
        if self._ready is not None and not self._ready.done():
            self._ready.set_result(msg)

    def _fail_ready(self, err: Exception) -> None:
        if self._ready is not None and not self._ready.done():
            self._ready.set_exception(err)
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(err)
        self._pending.clear()

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
            event = msg.get("event")
            if event == "ready":
                self._resolve_ready(msg)
                continue
            if event == "fatal":
                self.last_error = str(msg.get("error", ""))[:500]
                logger.error(f"[compat_dsh] {self.name} fatal: {self.last_error}")
                self._fail_ready(RuntimeError(f"{self.name}: {self.last_error[:400]}"))
                continue
            rid = msg.get("id")
            if rid is not None and rid in self._pending:
                fut = self._pending.pop(rid)
                if not fut.done():
                    if "error" in msg:
                        fut.set_exception(RuntimeError(str(msg["error"])))
                    else:
                        fut.set_result(msg.get("result"))
        self._fail_ready(RuntimeError(f"{self.name}: child process exited"))

    async def call(self, method: str, params: dict | None = None, timeout: float = 60.0):
        if not self.proc or self.proc.returncode is not None:
            raise RuntimeError(f"{self.name}: process is not running")
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
        proc = self.proc
        try:
            if proc and proc.returncode is None:
                await asyncio.wait_for(self.call("shutdown", timeout=3), timeout=4)
        except Exception:
            pass
        for task in (self._reader, self._stderr_reader):
            if task:
                task.cancel()
        if proc and proc.returncode is None:
            try:
                proc.kill()
            except Exception:
                pass
        if proc:
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except Exception:
                pass
        self.proc = None
        self._reader = None
        self._stderr_reader = None


@register(
    "astrbot_plugin_compat_dsh",
    "shingflash",
    "dsh/Cordis plugin compatibility layer: load dsh plugins into AstrBot without dsh",
    "1.0.2",
)
class DshBridgePlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}
        self.procs: dict[str, DshProcess] = {}
        self.node = ""
        self._booted = False

    # ---------- lifecycle ----------
    async def initialize(self):
        await self._boot()

    async def _boot(self):
        dirs = self._plugin_dirs()
        if not dirs:
            logger.info("[compat_dsh] no plugin directories configured; bridge idle")
            return
        self.node = _find_node(self.config.get("node_path", "")) or ""
        if not self.node:
            logger.error("[compat_dsh] node not found: install node, set node_path, or install the dsh desktop client")
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
                logger.warning(f"[compat_dsh] directory missing, skipped: {p}")
        return out

    async def _add_one(self, d: str) -> None:
        p = DshProcess(d, self.node)
        try:
            await p.start()
            self.procs[p.name] = p
            self._register_tools(p)
            logger.info(
                f"[compat_dsh] {p.name} loaded: {len(p.tools)} tools / "
                f"{len(p.prompts)} prompt hooks / {len(p.routes)} routes"
            )
        except Exception as e:
            logger.error(f"[compat_dsh] {Path(d).name} failed to start: {e}")
            await p.stop()

    def _register_tools(self, p: DshProcess) -> None:
        from astrbot.core.agent.tool import FunctionTool

        made = []
        seen: set[str] = set()
        for t in p.tools:
            name = f"{p.name.replace('-', '_')}__{t['name']}"[:64]
            # AstrBot validates `parameters` against the JSON-Schema meta-schema
            # when the FunctionTool is built. One malformed tool must not cost
            # the whole plugin (the exception used to escape to _add_one).
            if name in seen:
                logger.warning(f"[compat_dsh] {p.name}: duplicate tool name skipped: {name}")
                continue
            seen.add(name)
            try:
                made.append(
                    FunctionTool(
                        name=name,
                        description=(t.get("description") or "")[:1000],
                        parameters=t.get("parameters") or {"type": "object", "properties": {}},
                        handler=self._make_handler(p, t["name"]),
                    )
                )
            except Exception as e:
                logger.warning(f"[compat_dsh] {p.name}/{t['name']} skipped: {e}")
        if made:
            try:
                self.context.add_llm_tools(*made)
            except Exception as e:
                logger.error(f"[compat_dsh] failed to register tools: {e}")

    def _make_handler(self, p: DshProcess, tool_name: str):
        async def handler(**kwargs):
            try:
                res = await p.call("tools.call", {"name": tool_name, "args": kwargs}, timeout=120)
                return str(res)
            except Exception as e:
                return f"[{p.name}/{tool_name} call failed] {e}"

        return handler

    async def terminate(self):
        for p in list(self.procs.values()):
            await p.stop()
        self.procs.clear()

    # ---------- prompt injection ----------
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
                logger.debug(f"[compat_dsh] {p.name} injection failed: {e}")
        if chunks:
            req.system_prompt = (req.system_prompt or "") + "\n\n" + "\n\n".join(chunks)

    # ---------- commands ----------
    @filter.command("dshcompat")
    async def cmd_status(self, event: AstrMessageEvent):
        """dshcompat [reload] - show bridge status or restart every plugin"""
        parts = (event.message_str or "").split(maxsplit=1)
        if len(parts) > 1 and parts[1].strip().lower() in ("reload", "restart"):
            for p in list(self.procs.values()):
                await p.stop()
            self.procs.clear()
            await self._boot()
            return event.plain_result(f"reloaded; {len(self.procs)} plugin(s) loaded")
        if not self.procs:
            return event.plain_result("No plugins loaded. Set plugin_dirs, or install the dsh desktop client and point at ~/.dsh/plugins.")
        lines = [f"dsh compatibility bridge - node {self.node or 'not found'}"]
        for p in self.procs.values():
            tools = ", ".join(t["name"] for t in p.tools) or "none"
            lines.append(f"- {p.name}: {len(p.tools)} tools ({tools}), {len(p.prompts)} prompt hooks")
        return event.plain_result("\n".join(lines))

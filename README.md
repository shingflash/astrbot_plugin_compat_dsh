# dsh 插件兼容层（AstrBot 端）

让 AstrBot **直接吃 dsh / Cordis 插件**，不用装 dsh 本体。

## 原理（强行兼容，不是协商）

- 每个 dsh 插件起一个 node 子进程跑 `host/boot.mjs`；
- `boot.mjs` 用 ESM loader 劫持 `cordis` / `@deepseek-ai/dsh-tools` 的 import，
  塞进自带的假货（`host/shim/`），插件以为自己跑在 harness 里；
- 插件调 `ctx.tools.register` / `ctx.systemPrompt.context` 时宿主全记下来；
- 这边把工具注册成 AstrBot 的 FunctionTool，把提示注入接进 `on_llm_request`。

## 安装

1. 整个目录（含 `host/`）放进 AstrBot 的 `data/plugins/`；
2. 配 `plugin_dirs`：dsh 插件目录，多个用 `;` 分隔；
3. `node_path` 留空会自动找 dsh 桌面版自带运行时（`~/.dsh/dsh-runtimes/.../node.exe`），
   再找不到就用系统 `node`；
4. 重启 AstrBot；
5. `/dshcompat` 看桥上有几个插件、几个工具。

工具以 `<插件名>__<工具名>` 注册进 LLM 工具表；插件的系统提示注入口每轮对话拼进 system prompt。

## 配置

| 项 | 说明 |
|---|---|
| `plugin_dirs` | dsh 插件目录，分号/逗号/换行分隔 |
| `node_path` | node 路径，留空自动探测 |
| `inject_prompt` | 是否接 `ctx.systemPrompt.context` 注入 |
| `mcp_mode` | 保留项，同时以 MCP stdio 暴露工具 |

## 指令

- `/dshcompat`：桥状态
- `/dshcompat reload`：重新拉起全部插件

## 另外一半

反方向（dsh 吃 AstrBot 插件）在本组织的 `dsh-compat-astrbot`。

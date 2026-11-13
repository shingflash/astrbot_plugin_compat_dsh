<div align="center">

# 🔌 astrbot_plugin_compat_dsh

**在 AstrBot 里直接加载 dsh / Cordis 插件 —— 不用装 dsh。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Node](https://img.shields.io/badge/Node-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![AstrBot](https://img.shields.io/badge/AstrBot-v4-4B8BBE)](https://github.com/AstrBotDevs/AstrBot)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/shingflash/astrbot_plugin_compat_dsh/pulls)

[English](#-english) · [中文](#-中文)

</div>

---

## 📖 English

### How it works (shim, not negotiation)

- Every dsh plugin gets one Node child process running `host/boot.mjs`.
- `boot.mjs` hijacks ESM imports of `cordis` / `@deepseek-ai/dsh-tools` and redirects them to the bundled shims in `host/shim/`, so the plugin believes it runs inside the harness.
- `ctx.tools.register` / `ctx.systemPrompt.context` calls are captured.
- This plugin re-registers those tools as AstrBot `FunctionTool` objects and merges prompt fragments via `on_llm_request`.

Tools are registered as `<plugin>__<tool>`; prompt hooks run on every request.

### ✨ Features

- **No dsh install required** — a shim layer, not a bridge to a running harness
- **Tool + prompt passthrough** — dsh tools become AstrBot tools, prompt fragments merge into requests
- **Zero-config node discovery** — auto-detects the dsh desktop runtime, falls back to system `node`
- **Hot reload** — `/dshcompat reload` restarts every bridged plugin

### 📦 Installation

1. Drop this directory (including `host/`) into AstrBot's `data/plugins/`.
2. Set `plugin_dirs` to the dsh plugin directories, separated by `;`.
3. Leave `node_path` empty to auto-detect the dsh desktop runtime (`~/.dsh/dsh-runtimes/.../node.exe`), falling back to system `node`.
4. Restart AstrBot.
5. `/dshcompat` shows how many plugins and tools are loaded.

### ⚙️ Configuration

| Key | Description |
|---|---|
| `plugin_dirs` | dsh plugin directories, `;` / `,` / newline separated |
| `node_path` | node executable; empty means auto-detect |
| `inject_prompt` | Merge `ctx.systemPrompt.context` output into requests |
| `mcp_mode` | Reserved; also expose tools over MCP stdio |

### 💬 Commands

| Command | Description |
|---|---|
| `/dshcompat` | Bridge status |
| `/dshcompat reload` | Restart every bridged plugin |

### 🔁 The other half

For the reverse direction (dsh loading AstrBot plugins) see [`dsh-compat-astrbot`](https://github.com/shingflash/dsh-compat-astrbot).

---

## 📖 中文

### 原理（垫片，不做协议协商）

- 每个 dsh 插件起一个 Node 子进程跑 `host/boot.mjs`。
- `boot.mjs` 劫持 `cordis` / `@deepseek-ai/dsh-tools` 的 ESM 导入，重定向到 `host/shim/` 里自带的垫片，于是插件以为自己跑在 harness 里。
- 捕获 `ctx.tools.register` / `ctx.systemPrompt.context` 调用。
- 本插件再把这些工具注册成 AstrBot 的 `FunctionTool`，并通过 `on_llm_request` 合并提示词片段。

工具注册名格式为 `<插件名>__<工具名>`；提示词钩子每次请求都会跑。

### ✨ 特点

- **不用装 dsh** —— 是垫片，不是连到一个跑着的 harness
- **工具与提示词透传** —— dsh 工具变成 AstrBot 工具，提示词片段注入请求
- **node 自动发现** —— 优先找 dsh 桌面运行时，找不到再退回系统 `node`
- **热重载** —— `/dshcompat reload` 重启所有已桥接插件

### 📦 安装

1. 把整个目录（**包括 `host/`**）放进 AstrBot 的 `data/plugins/`。
2. `plugin_dirs` 填 dsh 插件目录，多个用 `;` 分隔。
3. `node_path` 留空自动探测 dsh 桌面运行时（`~/.dsh/dsh-runtimes/.../node.exe`），不行再用系统 `node`。
4. 重启 AstrBot。
5. `/dshcompat` 看加载了几个插件、几个工具。

### ⚙️ 配置

| 项 | 说明 |
|---|---|
| `plugin_dirs` | dsh 插件目录，`;` / `,` / 换行分隔 |
| `node_path` | node 可执行文件；留空自动探测 |
| `inject_prompt` | 是否把 `ctx.systemPrompt.context` 的输出并入请求 |
| `mcp_mode` | 预留；额外用 MCP stdio 暴露工具 |

### 💬 命令

| 命令 | 作用 |
|---|---|
| `/dshcompat` | 桥接状态 |
| `/dshcompat reload` | 重启所有已桥接插件 |

### 🔁 另一半

反方向（dsh 加载 AstrBot 插件）见 [`dsh-compat-astrbot`](https://github.com/shingflash/dsh-compat-astrbot)。

---

<div align="center">

### 📄 License

[MIT](LICENSE) · 有问题欢迎开 issue / PR

</div>

# dsh plugin compatibility layer (AstrBot side)

Load **dsh / Cordis plugins inside AstrBot** without installing dsh.

## How it works (shim, not negotiation)

- Every dsh plugin gets one node child process running `host/boot.mjs`.
- `boot.mjs` hijacks ESM imports of `cordis` / `@deepseek-ai/dsh-tools` and
  redirects them to the bundled shims in `host/shim/`, so the plugin believes
  it runs inside the harness.
- `ctx.tools.register` / `ctx.systemPrompt.context` calls are captured.
- This plugin re-registers those tools as AstrBot `FunctionTool` objects and
  merges prompt fragments via `on_llm_request`.

## Install

1. Drop this directory (including `host/`) into AstrBot's `data/plugins/`.
2. Set `plugin_dirs` to the dsh plugin directories, separated by `;`.
3. Leave `node_path` empty to auto-detect the dsh desktop runtime
   (`~/.dsh/dsh-runtimes/.../node.exe`), falling back to system `node`.
4. Restart AstrBot.
5. `/dshcompat` shows how many plugins and tools are loaded.

Tools are registered as `<plugin>__<tool>`. Prompt hooks run on every request.

## Configuration

| Key | Description |
|---|---|
| `plugin_dirs` | dsh plugin directories, `;` / `,` / newline separated |
| `node_path` | node executable; empty means auto-detect |
| `inject_prompt` | Merge `ctx.systemPrompt.context` output into requests |
| `mcp_mode` | Reserved; also expose tools over MCP stdio |

## Commands

- `/dshcompat` - bridge status
- `/dshcompat reload` - restart every plugin

## The other half

For the reverse direction (dsh loading AstrBot plugins) see `dsh-compat-astrbot`.

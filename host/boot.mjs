/**
 * boot.mjs —— 把一个 DSH / Cordis 插件强行拉起来，挂到我们自己的宿主上。
 *
 * 用法：
 *   node boot.mjs --plugin <插件目录> [--probe]
 *   node boot.mjs --plugin <dir> --rpc        # 进入 stdio JSON-lines RPC 模式
 *
 * 协议：一行一个 JSON。
 *   请求：{"id":1,"method":"tools.call","params":{"name":"x","args":{}}}
 *   响应：{"id":1,"result":...} 或 {"id":1,"error":"..."}
 *   主动推送：{"event":"ready","plugin":"memewiki","tools":[{"name":...}]}
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { createHost } from './cordis-mini.mjs'

// stdout 只留协议帧，插件里的 console.log 一律改道 stderr
const writeFrame = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.info = console.log
console.debug = console.log
console.warn = console.log
console.error = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')

// ---- 参数 ----
const argv = process.argv.slice(2)
const arg = (k) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : undefined
}
const pluginDir = arg('--plugin')
const probe = argv.includes('--probe')
const debug = argv.includes('--debug')
if (!pluginDir) {
  console.error('缺 --plugin <插件目录>')
  process.exit(2)
}
if (!existsSync(pluginDir) || !statSync(pluginDir).isDirectory()) {
  console.error('插件目录不存在：' + pluginDir)
  process.exit(2)
}

// ---- 装 shim：让插件的 import 'cordis' / '@deepseek-ai/dsh-tools' 落到我们自己的假货上 ----
register('./shim-loader.mjs', import.meta.url)

const sink = (rec) => {
  if (!debug && rec.level === 'debug') return
  process.stderr.write(`[${rec.level}] ${rec.scope ? rec.scope + ': ' : ''}${rec.text}\n`)
}

// ---- 找入口 ----
function findEntry(dir) {
  const pkgPath = join(dir, 'package.json')
  let entry
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const ex = pkg.exports
    let cand = pkg.main
    if (!cand && typeof ex === 'string') cand = ex
    if (!cand && ex && typeof ex === 'object') {
      const dot = ex['.'] ?? ex
      cand = typeof dot === 'string' ? dot : dot?.import ?? dot?.default
    }
    entry = cand || 'index.js'
  } else {
    entry = 'index.js'
  }
  const full = isAbsolute(entry) ? entry : resolve(dir, entry)
  if (!existsSync(full)) throw new Error('入口不存在：' + full)
  return full
}

let host
let pluginName = 'unknown'

function load() {
  const entry = findEntry(pluginDir)
  host = createHost({
    logger: sink,
    onTool: (t) => debug && sink({ level: 'debug', scope: 'host', text: 'tool 注册 ' + t.name }),
    onContext: (c) => debug && sink({ level: 'debug', scope: 'host', text: 'prompt 注入 ' + c.name }),
    onRoute: (r) => debug && sink({ level: 'debug', scope: 'host', text: `route ${r.kind} ${r.path}` }),
  })
  return import(pathToFileURL(entry).href).then((mod) => {
    pluginName = mod.name || mod.default?.name || 'unknown'
    const apply = mod.apply || mod.default?.apply || (typeof mod.default === 'function' ? mod.default : null)
    if (typeof apply !== 'function') {
      throw new Error('这个模块没有 apply(ctx)，不像 dsh 插件')
    }
    // inject 声明的服务，我们全都有（假装有），不看顺序
    const injected = mod.inject || mod.default?.inject || []
    if (debug && injected.length) sink({ level: 'debug', scope: 'host', text: 'inject: ' + injected.join(',') })
    apply(host.ctx)
    return { pluginName, injected }
  })
}

/**
 * 把宿主（AstrBot）的对话消息翻译成 dsh 那种 session 事件流。
 * dsh 插件普遍从 ctx.agent.session.snapshotEvents() 里挖最后一条 user/message，
 * 所以这里必须伪造出同形状的东西，否则注入口一律返回空。
 */
function makePromptContext(params) {
  if (params?.arg && typeof params.arg === 'object') return params.arg
  const msgs = Array.isArray(params?.messages) ? params.messages : []
  const events = msgs.map((m) => {
    const isUser = (m.role || 'user') === 'user'
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
    return {
      type: isUser ? 'user/message' : 'agent/message',
      payload: {
        source: { kind: isUser ? 'user' : 'agent' },
        parts: [{ type: 'text', text }],
      },
    }
  })
  return {
    messages: msgs,
    agent: {
      session: {
        snapshotEvents: () => events,
        messages: msgs,
      },
    },
  }
}

async function callTool(name, args) {
  const tool = host.ctx.tools.get(name)
  if (!tool) throw new Error('没有这个工具：' + name)
  const value = await tool.execute(args ?? {})
  // dsh 的 output.render 负责把值转成消息块，有就用它
  const render = tool.output?.render
  if (typeof render === 'function') {
    const blocks = await render(args ?? {}, value)
    const text = (Array.isArray(blocks) ? blocks : [])
      .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
      .filter(Boolean)
      .join('\n')
    return text || (typeof value === 'string' ? value : JSON.stringify(value))
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

async function rpcLoop() {
  const rl = createInterface({ input: process.stdin, terminal: false })
  for await (const line of rl) {
    const raw = line.trim()
    if (!raw) continue
    let req
    try {
      req = JSON.parse(raw)
    } catch {
      writeFrame({ error: '不是合法 JSON' })
      continue
    }
    const { id, method, params } = req
    try {
      let result
      switch (method) {
        case 'ping':
          result = { ok: true, plugin: pluginName, pid: process.pid }
          break
        case 'tools.list':
          result = host.ctx.tools.list()
          break
        case 'tools.call':
          result = await callTool(params?.name, params?.args)
          break
        case 'prompt.render':
          result = await host.renderSystemContext(makePromptContext(params))
          break
        case 'prompt.items':
          result = host.contexts.map((c) => ({ name: c.name, order: c.order ?? 1000 }))
          break
        case 'routes.list':
          result = host.routes.map((r) => ({ kind: r.kind, path: r.path }))
          break
        case 'shutdown':
          writeFrame({ id, result: 'bye' })
          host.disposeAll()
          process.exit(0)
        default:
          throw new Error('未知方法：' + method)
      }
      writeFrame({ id, result })
    } catch (e) {
      writeFrame({ id, error: String(e?.message || e) })
    }
  }
}

// ---- 跑 ----
load()
  .then(async () => {
    if (probe) {
      writeFrame({
        event: 'probe',
        plugin: pluginName,
        node: process.version,
        entry: findEntry(pluginDir),
        tools: host.ctx.tools.list(),
        prompts: host.contexts.map((c) => ({ name: c.name, order: c.order ?? 1000 })),
        routes: host.routes.map((r) => ({ kind: r.kind, path: r.path })),
      })
      host.disposeAll()
      process.exit(0)
    }
    writeFrame({
      event: 'ready',
      plugin: pluginName,
      node: process.version,
      tools: host.ctx.tools.list(),
      prompts: host.contexts.map((c) => ({ name: c.name, order: c.order ?? 1000 })),
    })
    await rpcLoop()
  })
  .catch((e) => {
    writeFrame({ event: 'fatal', error: String(e?.stack || e?.message || e) })
    process.exit(1)
  })

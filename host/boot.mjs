/**
 * boot.mjs - start a dsh / Cordis plugin on top of our own host.
 *
 * Usage:
 *   node boot.mjs --plugin <plugin dir> [--probe]
 *   node boot.mjs --plugin <dir> --rpc        # stdio JSON-lines RPC mode
 *
 * Protocol: one JSON per line.
 *   request : {"id":1,"method":"tools.call","params":{"name":"x","args":{}}}
 *   response: {"id":1,"result":...} or {"id":1,"error":"..."}
 *   event   : {"event":"ready","plugin":"memewiki","tools":[{"name":...}]}
 */
import { register } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import { createHost } from './cordis-mini.mjs'

// stdout carries protocol frames only; plugin console.log is redirected to stderr
const writeFrame = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
console.log = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')
console.info = console.log
console.debug = console.log
console.warn = console.log
console.error = (...a) => process.stderr.write(a.map(String).join(' ') + '\n')

// ---- arguments ----
const argv = process.argv.slice(2)
const arg = (k) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : undefined
}
const pluginDir = arg('--plugin')
const probe = argv.includes('--probe')
const debug = argv.includes('--debug')
if (!pluginDir) {
  console.error('missing --plugin <plugin dir>')
  process.exit(2)
}
if (!existsSync(pluginDir) || !statSync(pluginDir).isDirectory()) {
  console.error('plugin directory not found: ' + pluginDir)
  process.exit(2)
}

// ---- install shim: route imports of 'cordis' / '@deepseek-ai/dsh-tools' to our fakes ----
register('./shim-loader.mjs', import.meta.url)

const sink = (rec) => {
  if (!debug && rec.level === 'debug') return
  process.stderr.write(`[${rec.level}] ${rec.scope ? rec.scope + ': ' : ''}${rec.text}\n`)
}

// ---- locate entry ----
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
  if (!existsSync(full)) throw new Error('entry not found: ' + full)
  return full
}

let host
let pluginName = 'unknown'

function load() {
  const entry = findEntry(pluginDir)
  host = createHost({
    logger: sink,
    onTool: (t) => debug && sink({ level: 'debug', scope: 'host', text: 'tool registered ' + t.name }),
    onContext: (c) => debug && sink({ level: 'debug', scope: 'host', text: 'prompt hook ' + c.name }),
    onRoute: (r) => debug && sink({ level: 'debug', scope: 'host', text: `route ${r.kind} ${r.path}` }),
  })
  return import(pathToFileURL(entry).href).then((mod) => {
    pluginName = mod.name || mod.default?.name || 'unknown'
    const apply = mod.apply || mod.default?.apply || (typeof mod.default === 'function' ? mod.default : null)
    if (typeof apply !== 'function') {
      throw new Error('module has no apply(ctx); not a dsh plugin')
    }
    // pretend every injected service exists; order is irrelevant here
    const injected = mod.inject || mod.default?.inject || []
    if (debug && injected.length) sink({ level: 'debug', scope: 'host', text: 'inject: ' + injected.join(',') })
    apply(host.ctx)
    return { pluginName, injected }
  })
}

/**
 * Translate a host (AstrBot) message list into the dsh session event stream.
 * dsh plugins usually dig the last user/message out of
 * ctx.agent.session.snapshotEvents(), so we fake that shape; otherwise prompt
 * hooks return nothing.
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
  if (!tool) throw new Error('no such tool: ' + name)
  const value = await tool.execute(args ?? {})
  // dsh output.render turns the value into message blocks; use it when present
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
      writeFrame({ error: 'invalid JSON' })
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
          throw new Error('unknown method: ' + method)
      }
      writeFrame({ id, result })
    } catch (e) {
      writeFrame({ id, error: String(e?.message || e) })
    }
  }
}

// ---- run ----
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

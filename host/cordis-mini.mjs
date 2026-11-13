/**
 * cordis-mini - a stand-in for the dsh Cordis host, implementing only the
 * services dsh plugins actually touch.
 *
 * Design rules:
 *   1. Do not chase full Cordis semantics, only what plugin authors really call.
 *   2. Missing services never crash: return a no-op and log a warning so the
 *      plugin degrades instead of failing to start.
 *   3. Every registration is reported to the host so AstrBot can adopt it.
 */
import { inspect } from 'node:util'

const LEVELS = ['debug', 'info', 'warn', 'error']

function stringify(v) {
  if (typeof v === 'string') return v
  try {
    return inspect(v, { depth: 3, breakLength: 120 })
  } catch {
    return String(v)
  }
}

export function createLogger(sink, scope) {
  const make = (level) => (...args) =>
    sink({ level, scope, text: args.map(stringify).join(' ') })

  const fn = make('info')
  for (const lv of LEVELS) fn[lv] = make(lv)
  // in cordis, ctx.logger is also callable: ctx.logger('name') returns a child logger
  fn.scope = (name) => createLogger(sink, String(name))
  return fn
}

export function createHost({ onTool, onContext, onRoute, logger }) {
  const tools = new Map()
  const contexts = []
  const routes = []
  const effects = []
  const disposed = []

  const ctx = {
    // ---- lifecycle ----
    effect(fn) {
      try {
        const d = fn()
        if (typeof d === 'function') effects.push(d)
      } catch (e) {
        logger({ level: 'warn', scope: 'effect', text: 'effect failed: ' + e.message })
      }
      return () => {}
    },
    on() { return () => {} },
    emit() {},

    // ---- tools ----
    tools: {
      register(tool) {
        if (!tool || !tool.name) throw new Error('tool has no name')
        if (typeof tool.execute !== 'function') throw new Error(`tool ${tool.name} has no execute`)
        tools.set(tool.name, tool)
        onTool?.(describeTool(tool))
        return () => tools.delete(tool.name)
      },
      get(name) { return tools.get(name) },
      list() { return [...tools.values()].map(describeTool) },
    },

    // ---- system prompt hooks ----
    systemPrompt: {
      context(item) {
        if (item && typeof item === 'object') {
          contexts.push(item)
          onContext?.({ name: item.name || 'anonymous', order: item.order ?? 1000 })
        }
        return () => {}
      },
    },

    // ---- web routes (mounted only if the host has HTTP; otherwise just recorded) ----
    webServer: {
      register(r) {
        routes.push(r)
        onRoute?.({ kind: r?.kind, path: r?.path })
        return () => {}
      },
    },

    // ---- misc: plugins poke these now and then; all stubbed so they do not crash ----
    logger: createLogger(logger, 'plugin'),
    console: { log: (...a) => logger({ level: 'info', scope: 'plugin', text: a.map(stringify).join(' ') }) },
    storage: {
      _m: new Map(),
      get(k, d) { return this._m.has(k) ? this._m.get(k) : d },
      set(k, v) { this._m.set(k, v); return v },
      delete(k) { return this._m.delete(k) },
    },
  }

  // ctx.plugin(): dsh plugins sometimes load sub-plugins inline
  ctx.plugin = (mod) => {
    try {
      if (typeof mod === 'function') mod(ctx)
      else if (mod && typeof mod.apply === 'function') mod.apply(ctx)
    } catch (e) {
      logger({ level: 'error', scope: 'plugin', text: 'sub-plugin load failed: ' + e.message })
    }
  }

  return {
    ctx,
    tools,
    contexts,
    routes,
    async renderSystemContext(arg) {
      const items = [...contexts].sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000))
      const out = []
      for (const it of items) {
        try {
          const v = typeof it.text === 'function' ? await it.text(arg) : it.text
          if (v) out.push(String(v))
        } catch (e) {
          logger({ level: 'warn', scope: 'systemPrompt', text: `${it.name} evaluation failed: ${e.message}` })
        }
      }
      return out.join('\n\n')
    },
    disposeAll() {
      for (const d of [...effects, ...disposed].reverse()) {
        try { d() } catch {}
      }
    },
  }
}

export function describeTool(tool) {
  // turn dsh shorthand properties into JSON Schema
  let params = tool.parameters || {}
  if (!params.type) {
    params = { type: 'object', properties: params, additionalProperties: false }
  }
  return {
    name: tool.name,
    description: tool.description || '',
    parameters: params,
  }
}

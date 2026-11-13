/**
 * cordis-mini —— 冒充 DSH 的 Cordis 宿主，只实现 dsh 插件实际会用到的那几个服务。
 *
 * 设计原则：
 *   1. 不追 Cordis 全部语义，只追「插件作者真的会调」的那部分。
 *   2. 服务缺失时不崩，给空实现并记一条 warn —— 让插件降级跑，而不是起不来。
 *   3. 所有注册动作都往 host 上报，宿主（AstrBot）才能把它们变成自己的东西。
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
  // cordis 里 ctx.logger 也能当函数调：ctx.logger('name') 返回子 logger
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
    // ---- 生命期 ----
    effect(fn) {
      try {
        const d = fn()
        if (typeof d === 'function') effects.push(d)
      } catch (e) {
        logger({ level: 'warn', scope: 'effect', text: 'effect 执行失败：' + e.message })
      }
      return () => {}
    },
    on() { return () => {} },
    emit() {},

    // ---- 工具 ----
    tools: {
      register(tool) {
        if (!tool || !tool.name) throw new Error('tool 缺 name')
        if (typeof tool.execute !== 'function') throw new Error(`tool ${tool.name} 缺 execute`)
        tools.set(tool.name, tool)
        onTool?.(describeTool(tool))
        return () => tools.delete(tool.name)
      },
      get(name) { return tools.get(name) },
      list() { return [...tools.values()].map(describeTool) },
    },

    // ---- 系统提示注入 ----
    systemPrompt: {
      context(item) {
        if (item && typeof item === 'object') {
          contexts.push(item)
          onContext?.({ name: item.name || 'anonymous', order: item.order ?? 1000 })
        }
        return () => {}
      },
    },

    // ---- Web 路由（宿主若有 HTTP 再挂，没有就只记着）----
    webServer: {
      register(r) {
        routes.push(r)
        onRoute?.({ kind: r?.kind, path: r?.path })
        return () => {}
      },
    },

    // ---- 杂项：插件偶尔会摸，摸不到会崩，所以都垫上 ----
    logger: createLogger(logger, 'plugin'),
    console: { log: (...a) => logger({ level: 'info', scope: 'plugin', text: a.map(stringify).join(' ') }) },
    storage: {
      _m: new Map(),
      get(k, d) { return this._m.has(k) ? this._m.get(k) : d },
      set(k, v) { this._m.set(k, v); return v },
      delete(k) { return this._m.delete(k) },
    },
  }

  // ctx.plugin()：dsh 插件有时会内联加载子插件
  ctx.plugin = (mod) => {
    try {
      if (typeof mod === 'function') mod(ctx)
      else if (mod && typeof mod.apply === 'function') mod.apply(ctx)
    } catch (e) {
      logger({ level: 'error', scope: 'plugin', text: '子插件加载失败：' + e.message })
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
          logger({ level: 'warn', scope: 'systemPrompt', text: `${it.name} 求值失败：${e.message}` })
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
  // 把 dsh 的「简写 properties」翻译成 JSON Schema
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

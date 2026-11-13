/**
 * 假 dsh-tools：把插件常用的那几个导出做成能用的。
 * 真货在 @deepseek-ai/dsh-tools 里，我们只负责让插件不炸且行为正确。
 */
function schemaOf(parameters) {
  if (!parameters) return { type: 'object', properties: {}, additionalProperties: false }
  if (parameters.type) return parameters
  return { type: 'object', properties: parameters, additionalProperties: false }
}

export function defineTool(o = {}) {
  return {
    ...o,
    parameters: schemaOf(o.parameters),
    output: o.output ?? {
      schema: { type: 'string' },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
  }
}

export function defineCommand(o = {}) {
  return { kind: 'command', ...o }
}

export function text(v) {
  return [{ type: 'text', text: String(v) }]
}

export class Context {}
export class Service {}
export const Schema = {
  object: (properties = {}) => ({ type: 'object', properties, additionalProperties: false }),
  string: (o = {}) => ({ type: 'string', ...o }),
  number: (o = {}) => ({ type: 'number', ...o }),
  boolean: (o = {}) => ({ type: 'boolean', ...o }),
  array: (items, o = {}) => ({ type: 'array', items, ...o }),
}
export const Schemastery = Schema

export default { defineTool, defineCommand, text, Context, Service, Schema }

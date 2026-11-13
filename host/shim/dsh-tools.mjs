/**
 * Fake dsh-tools: make the exports plugins commonly use actually work.
 * The real ones live in @deepseek-ai/dsh-tools; here we only need plugins not
 * to crash and to behave correctly.
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

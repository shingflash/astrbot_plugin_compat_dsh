/**
 * Fake cordis: exports only the names plugins import from 'cordis'.
 * Real Cordis is a full DI container; here ctx is built by the host directly,
 * so this module only needs to be importable.
 */
export class Context {
  constructor(scope = {}) {
    return scope
  }
}
export class Service {}
export class Schema {}
export const Schemastery = {}
export function defineTool(o) {
  return o
}
export function h() {}
export default Context

/**
 * 假 cordis：只导那些插件会从 'cordis' 里 import 的名字。
 * 真 Cordis 是完整的依赖注入容器，我们这套里 ctx 由 host 直接构造，这里只负责「能被 import」。
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

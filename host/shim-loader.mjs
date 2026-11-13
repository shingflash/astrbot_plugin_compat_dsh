/**
 * shim-loader —— 强行兼容的核心：在 import 解析阶段把这些包名劫走。
 * 插件以为自己 import 了 cordis / dsh-tools，实际上拿到的是我们的假货。
 */
const SHIM = new URL('./shim/', import.meta.url)

const EXACT = {
  cordis: 'cordis.mjs',
  '@deepseek-ai/dsh-tools': 'dsh-tools.mjs',
  'deepseek-harness': 'dsh-tools.mjs',
  '@deepseek-ai/dsh-agent': 'dsh-tools.mjs',
  '@deepseek-ai/dsh-llm': 'dsh-tools.mjs',
}

export async function resolve(specifier, context, nextResolve) {
  if (EXACT[specifier]) {
    return { url: new URL(EXACT[specifier], SHIM).href, shortCircuit: true }
  }
  if (specifier.startsWith('cordis/')) {
    const sub = specifier.slice('cordis/'.length)
    return { url: new URL(sub.endsWith('.mjs') ? sub : sub + '.mjs', SHIM).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

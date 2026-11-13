/**
 * shim-loader - the core of the shim route: hijack these package names during
 * import resolution. Plugins think they import cordis / dsh-tools, but they get
 * our fakes.
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

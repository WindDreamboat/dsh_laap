/**
 * 构建浏览器端 client bundle（lib/client.js）。
 *
 * DSH 的浏览器插件不直接作为 ESM 加载，而是包裹成 module-loader factory：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 * 其中 react / react/jsx-runtime / @deepseek-ai/cordis 等通过注入的 require
 * 从宿主模块表解析（PLATFORM_MODULES），绝不能打进 bundle。
 *
 * 外部插件没有 monorepo 的 tsdown 预设，这里用 esbuild 直接产出等价的 CJS 包裹体。
 * 用法：node scripts/build-client.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

/** 优先用本包依赖里的 esbuild；回退到 pnpm 提升位置（tsx 传递依赖）。 */
function loadEsbuild() {
  try {
    return createRequire(resolve(root, 'package.json'))('esbuild')
  } catch { /* fall through */ }
  const candidates = [
    resolve(root, 'node_modules/.pnpm/node_modules/esbuild'),
  ]
  for (const cand of candidates) {
    try {
      return createRequire(resolve(cand, 'package.json'))(cand)
    } catch { /* try next */ }
  }
  throw new Error('build-client: 找不到 esbuild，请先安装：pnpm add -D esbuild')
}

const esbuild = loadEsbuild()

const PKG_ID = 'dsh-laap'

// 宿主模块表提供的共享模块（见 dsh client/web/src/platform.ts PLATFORM_MODULES）：
// react 全家、@deepseek-ai/cordis 等一律 external，由 factory(require) 注入。
const EXTERNAL = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
]

const result = await esbuild.build({
  entryPoints: [resolve(root, 'src/ui-client.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  jsx: 'automatic',
  target: 'es2020',
  external: EXTERNAL,
  legalComments: 'none',
  write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
})

const body = result.outputFiles[0].text

const wrapped = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {`,
  `var module = { exports: {} };`,
  `var exports = module.exports;`,
  body.trimEnd(),
  `return module.exports;`,
  `} });`,
  '',
].join('\n')

const outPath = resolve(root, 'lib/client.js')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, wrapped, 'utf8')
console.log(`client bundle written: lib/client.js (${(wrapped.length / 1024).toFixed(1)} KB)`)

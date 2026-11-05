import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const ID = '@wilshi/dsh-agentos-context'

/**
 * CSS Modules 内联（照上游 deepseek-harness/packages/client/tsdown.client.ts
 * 的 dsh-css-modules-inline 切片）：`.module.css` 经 lightningcss 产出哈希类名
 * 映射，并在 factory 执行时注入带 data-plugin-css 标记的 <style>。虚拟 id 以
 * `.mjs` 结尾避开 tsdown 的 css-guard（否则会要求 @tsdown/css 的抽取式管线，
 * 而 ModuleLoader 单文件契约没有配套 css 加载机制）。
 */
const CSS_VIRTUAL_PREFIX = '\0oc-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const cssSourceFiles = new Map<string, string>()

function styleInjectionModule(fileId: string, css: string, classMap: Record<string, string>): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\') {',
    '  let tag = document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\');',
    '  if (tag === null) { tag = document.createElement(\'style\'); tag.dataset.plugin = '+JSON.stringify(ID)+'; tag.dataset.pluginCss = tagId; tag.dataset.pluginUsers = \'0\'; document.head.appendChild(tag); }',
    '  tag.textContent = css;',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

const cssModulesInline = {
  name: 'oc-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
    const virtualId = CSS_VIRTUAL_PREFIX + basename(abs) + CSS_VIRTUAL_SUFFIX
    const existing = cssSourceFiles.get(virtualId)
    if (existing !== undefined && existing !== abs) throw new Error(`CSS module basename collision: ${basename(abs)}`)
    cssSourceFiles.set(virtualId, abs)
    return virtualId
  },
  async load(this: { addWatchFile(id: string): void }, virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = cssSourceFiles.get(virtualId)
    if (fileId === undefined) throw new Error(`Unknown CSS virtual module: ${virtualId}`)
    this.addWatchFile(fileId)
    const source = await readFile(fileId)
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    const exportEntries = Object.entries(cssExports ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    for (const [local, exp] of exportEntries) classMap[local] = exp.name
    return styleInjectionModule(fileId, code.toString(), classMap)
  },
}

export default defineConfig([
  {
    name: ID,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    outputOptions: { inlineDynamicImports: true },
    // fork 源已是编译产物；外部依赖全部外置，由宿主 node_modules 解析
    external: [/^@melandlabs\//, 'better-sqlite3', 'sqlite-vec', /^@deepseek-ai\//, /^node:/],
  },
  {
    name: ID + '/client',
    entry: { client: 'src-client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    plugins: [cssModulesInline],
    external: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
    ],
    noExternal: (id: string) => id.startsWith('@deepseek-ai/') ? undefined : true,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(ID) + ', factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
])
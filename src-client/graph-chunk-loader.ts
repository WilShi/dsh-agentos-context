/**
 * 图谱 chunk 懒加载器（简化版 better-sidebar chunk-loader）：
 * 首次打开图谱视图时注入 /opencontext-api/bundle/graph.js（ETag/304 由 host 管），
 * 脚本向 globalThis.__dshChunks__.graph 注册 factory；chunk 无 external
 * （cytoscape 全量内联），factory 的 require 仅作防御性存根。
 * 并发共享一次加载；失败清缓存允许重试。
 */
import type cytoscapeType from 'cytoscape'

declare global {
  interface Window {
    __dshChunks__?: Record<string, ((require: (spec: string) => unknown) => unknown) | undefined>
  }
}

let task: Promise<typeof cytoscapeType> | undefined

export function loadGraphChunk(): Promise<typeof cytoscapeType> {
  task ??= (async () => {
    const registry = (window.__dshChunks__ ??= {})
    if (typeof registry.graph !== 'function') {
      await new Promise<void>((resolve, reject) => {
        const el = document.createElement('script')
        el.async = true
        el.src = '/opencontext-api/bundle/graph.js'
        el.addEventListener('load', () => { el.remove(); resolve() }, { once: true })
        el.addEventListener('error', () => {
          el.remove()
          reject(new Error('图谱组件加载失败（/opencontext-api/bundle/graph.js）'))
        }, { once: true })
        document.head.append(el)
      })
    }
    const factory = window.__dshChunks__?.graph
    if (typeof factory !== 'function') {
      throw new Error('图谱 chunk 脚本未注册 factory')
    }
    const stubRequire = (spec: string): unknown => {
      throw new Error(`graph chunk: unexpected external require('${spec}')`)
    }
    const exports = factory(stubRequire) as { default?: typeof cytoscapeType } & typeof cytoscapeType
    return (exports.default ?? exports) as typeof cytoscapeType
  })()
  task.catch(() => { task = undefined })
  return task
}

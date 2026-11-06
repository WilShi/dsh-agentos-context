/**
 * TEST-ONLY chunk server: not wired into the shipped entry (the official
 * /plugins/<id>/client.js route serves the client bundle). Kept for the legacy
 * chunk loader used by tests and the prototype page (HOST-REVIEW L3).
 *
 * Lazy chunk route: /opencontext-api/bundle/<name>.js（照 better-sidebar
 * src/bundle-route.ts）。官方 /plugins/<id>/client.js 路由服务不了任意文件名，
 * 插件自己服务拆分 chunk（lib/client-<name>.js）；client 在首次打开图谱视图时
 * 注入 script（见 src-client/graph-chunk-loader.ts）。
 *
 * 缓存契约：一律 `cache-control: no-cache` + ETag（内容哈希，按 mtime/size 记
 * 忆化），命中 If-None-Match 回 304 —— 浏览器每次都 revalidate，但未变更的
 * 大 chunk 不重传。只服务白名单 chunk 名（防路径穿越）。
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

interface BundleRouteContext extends Context {
  readonly webServer: {
    register(route: {
      readonly kind: 'prefix'
      readonly path: string
      readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
  }
}

/** The chunk names the client may request (mirror of src-client/graph-chunk-loader.ts). */
const CHUNK_NAMES = ['graph']

/** Directory of this host-half module（打包后 lib/ —— chunk 就在旁边）。 */
const LIB_DIR = dirname(fileURLToPath(import.meta.url))

/** sha1 content hash shortened to 12 hex chars（与 client-modules 的 rev 同形）。 */
function shortHash(input: Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

const etags = new Map<string, { mtimeMs: number; size: number; etag: string }>()

async function etagOf(name: string, chunkDir: string): Promise<string | undefined> {
  const path = join(chunkDir, `client-${name}.js`)
  const key = `${chunkDir}:${name}`
  try {
    const info = await stat(path)
    const memo = etags.get(key)
    if (memo !== undefined && memo.mtimeMs === info.mtimeMs && memo.size === info.size) return memo.etag
    const etag = `"${shortHash(await readFile(path))}"`
    etags.set(key, { mtimeMs: info.mtimeMs, size: info.size, etag })
    return etag
  } catch {
    return undefined
  }
}

export function createBundleRouteHandler(chunkDir: string = LIB_DIR) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const name = /^\/opencontext-api\/bundle\/([a-z0-9-]+)\.js$/.exec(pathname)?.[1]
    if (name === undefined || !CHUNK_NAMES.includes(name)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const etag = await etagOf(name, chunkDir)
    if (etag === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'cache-control': 'no-cache', etag })
      res.end()
      return
    }
    try {
      const body = await readFile(join(chunkDir, `client-${name}.js`))
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        etag,
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  }
}

/** Cordis sub-plugin: index.js does `ctx.plugin(createBundleRoutePlugin())`. */
export function createBundleRoutePlugin() {
  return {
    name: 'dsh-opencontext-bundle-route',
    inject: ['webServer'],
    apply(ctx: BundleRouteContext) {
      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix' as const,
        path: '/opencontext-api/bundle',
        handler: createBundleRouteHandler(),
      }), 'dsh-opencontext: bundle route')
    },
  }
}

/** Keep Node/Electron's native Web Streams constructor after legacy dependencies load. */
import { ReadableStream as NativeReadableStream } from 'node:stream/web'

/**
 * Some transitive OpenContext/document-parser dependencies install the
 * web-streams-polyfill constructor on globalThis. Node's built-in fetch then
 * rejects streams created with that foreign constructor. Restore the native
 * identity after those modules initialize so unrelated DSH RPC routes keep
 * working in both the browser-host and Electron surfaces.
 */
export function restoreNativeReadableStream() {
  if (globalThis.ReadableStream === NativeReadableStream) return false
  Object.defineProperty(globalThis, 'ReadableStream', {
    value: NativeReadableStream,
    configurable: true,
    enumerable: false,
    writable: true,
  })
  return true
}

/** Load a dependency and undo any global ReadableStream replacement it performs. */
export async function importWithNativeReadableStream(loader) {
  try {
    return await loader()
  } finally {
    restoreNativeReadableStream()
  }
}

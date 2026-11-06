/** Bounded, local-only document-to-text extraction for knowledge uploads. */
import { Buffer } from 'node:buffer'
import { importWithNativeReadableStream, restoreNativeReadableStream } from './web-runtime-compat.js'

export const MAX_TEXT_DOCUMENT_BYTES = 4 * 1024 * 1024
export const MAX_BINARY_DOCUMENT_BYTES = 25 * 1024 * 1024
export const DOCUMENT_PARSE_TIMEOUT_MS = 60_000

const OFFICE_FORMATS = new Map([
  ['docx', { fileType: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
  ['xlsx', { fileType: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
  ['pptx', { fileType: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }],
  ['pdf', { fileType: 'pdf', mimeType: 'application/pdf' }],
  ['odt', { fileType: 'odt', mimeType: 'application/vnd.oasis.opendocument.text' }],
  ['ods', { fileType: 'ods', mimeType: 'application/vnd.oasis.opendocument.spreadsheet' }],
  ['odp', { fileType: 'odp', mimeType: 'application/vnd.oasis.opendocument.presentation' }],
  ['odg', { fileType: 'odg', mimeType: 'application/vnd.oasis.opendocument.graphics' }],
  ['rtf', { fileType: 'rtf', mimeType: 'application/rtf' }],
  ['epub', { fileType: 'epub', mimeType: 'application/epub+zip' }],
])

export const SUPPORTED_BINARY_DOCUMENT_EXTENSIONS = Object.freeze([...OFFICE_FORMATS.keys()])

let officeParserPromise

/**
 * `officeparser` is an OPTIONAL peer: this build does not depend on it, so a
 * slim install stays small (no tesseract / onnxruntime / sharp / pdfjs).
 * Text uploads never touch it; only binary documents need it.
 */
const OFFICE_PARSER_MISSING_MESSAGE = '未安装 officeparser，二进制文档解析不可用；纯文本（≤ 4 MB）仍可上传。安装：pnpm add officeparser'

function isMissingOfficeParser(error) {
  return error?.code === 'ERR_MODULE_NOT_FOUND'
    || error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    || error?.code === 'MODULE_NOT_FOUND'
}

function parserUnavailableError(cause) {
  return Object.assign(fail('DOCUMENT_PARSER_UNAVAILABLE', OFFICE_PARSER_MISSING_MESSAGE), { cause })
}

let domShimRestore = null
function ensureOfficeParserEnvironment() {
  if (domShimRestore !== null) return
  const addedShims = []
  // PDF.js evaluates DOMMatrix during module initialization. The Electron host
  // runs without DOM globals, so provide only the affine operations needed for
  // text extraction. Never replace a native implementation when one exists,
  // and always remove the shim again after parsing (HOST-REVIEW L5).
  if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor(init) {
        if (Array.isArray(init) && init.length >= 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init
        else if (init && typeof init === 'object') ({ a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f } = init)
        else { this.a = this.d = 1; this.b = this.c = this.e = this.f = 0 }
      }
      get m11() { return this.a }
      get m12() { return this.b }
      get m21() { return this.c }
      get m22() { return this.d }
      get m41() { return this.e }
      get m42() { return this.f }
      multiply(other) {
        return new globalThis.DOMMatrix([
          this.a * other.a + this.c * other.b,
          this.b * other.a + this.d * other.b,
          this.a * other.c + this.c * other.d,
          this.b * other.c + this.d * other.d,
          this.a * other.e + this.c * other.f + this.e,
          this.b * other.e + this.d * other.f + this.f,
        ])
      }
      inverse() {
        const determinant = this.a * this.d - this.b * this.c
        if (determinant === 0) return new globalThis.DOMMatrix()
        return new globalThis.DOMMatrix([
          this.d / determinant, -this.b / determinant,
          -this.c / determinant, this.a / determinant,
          (this.c * this.f - this.d * this.e) / determinant,
          (this.b * this.e - this.a * this.f) / determinant,
        ])
      }
      transformPoint(point) {
        const x = point?.x ?? 0, y = point?.y ?? 0
        return { x: x * this.a + y * this.c + this.e, y: x * this.b + y * this.d + this.f }
      }
    }
    addedShims.push('DOMMatrix')
  }
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = class ImageData {
      constructor(data, width, height) { this.data = data; this.width = width; this.height = height }
    }
    addedShims.push('ImageData')
  }
  domShimRestore = () => {
    for (const key of addedShims) delete globalThis[key]
    domShimRestore = null
  }
}
/** Remove the parser-only globals again (safe no-op when nothing was installed). */
export function restoreOfficeParserEnvironment() { if (domShimRestore !== null) domShimRestore() }

async function officeParser() {
  ensureOfficeParserEnvironment()
  // The slim entry keeps OCR/Tesseract and remote CDN loaders out of the
  // shipped host bundle. Knowledge uploads intentionally parse local text
  // only, so this is both the least-privileged and install-safe variant.
  //
  // The module is optional at install time: a missing package must surface as
  // an actionable "text still works" error, never as a raw module-not-found
  // that turns the whole upload into a 500.
  officeParserPromise ??= importWithNativeReadableStream(() => import('officeparser/slim'))
    .then((module) => module.OfficeParser)
    .catch((error) => {
      // Never cache a failed load: the operator can install the optional peer
      // and retry the upload without restarting the host.
      officeParserPromise = undefined
      throw isMissingOfficeParser(error) ? parserUnavailableError(error) : error
    })
  const Parser = await officeParserPromise
  restoreNativeReadableStream()
  return Parser
}

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw fail('ABORTED', '操作已取消')
}

function extensionOf(filename) {
  const match = /\.([^.\\/]+)$/u.exec(filename)
  return match?.[1]?.toLowerCase() ?? ''
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0) throw fail('INVALID_INPUT', '文档内容无效')
  const maxEncodedLength = Math.ceil(MAX_BINARY_DOCUMENT_BYTES / 3) * 4
  if (value.length > maxEncodedLength || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw fail('LIMIT_EXCEEDED', '文档内容无效或超过 25 MB 限制')
  }
  const bytes = Buffer.from(value, 'base64')
  // The regex above already rejects non-canonical alphabet/padding; a full
  // toString('base64') round-trip used to duplicate up to 33 MB per upload.
  if (bytes.length === 0 || bytes.length > MAX_BINARY_DOCUMENT_BYTES) {
    throw fail('LIMIT_EXCEEDED', '文档内容无效或超过 25 MB 限制')
  }
  return bytes
}

function normalizeExtractedText(value) {
  const text = String(value ?? '').replace(/\r\n?/gu, '\n').replace(/\0/gu, '').trim()
  if (!text) throw fail('DOCUMENT_PARSE_FAILED', '文档中没有可提取的文字')
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_DOCUMENT_BYTES) {
    throw fail('LIMIT_EXCEEDED', '文档解析后的文字超过 4 MB 限制')
  }
  return text
}

function combinedSignal(signal) {
  const timeout = AbortSignal.timeout(DOCUMENT_PARSE_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Convert a client upload into the plain text consumed by the existing
 * OpenContext knowledge store. Binary bytes and parser internals are never
 * persisted; only bounded extracted text and non-sensitive source metadata remain.
 */
export async function prepareKnowledgeDocument(input, options = {}) {
  const filename = typeof input?.filename === 'string' ? input.filename.trim() : ''
  const mimeType = typeof input?.mimeType === 'string' ? input.mimeType.trim() : 'application/octet-stream'
  if (!filename || filename.length > 512 || /[\0-\x1f]/u.test(filename)) throw fail('INVALID_INPUT', '文档名称无效')

  if (typeof input.content === 'string' && input.dataBase64 === undefined) {
    const content = normalizeExtractedText(input.content)
    return { content, mimeType: mimeType || 'text/plain', sourceBytes: Buffer.byteLength(content, 'utf8'), sourceFormat: 'text', warningCodes: [] }
  }

  if (typeof input.dataBase64 !== 'string' || input.content !== undefined) throw fail('INVALID_INPUT', '文档内容无效')
  const extension = extensionOf(filename)
  const format = OFFICE_FORMATS.get(extension)
  if (!format) throw fail('DOCUMENT_FORMAT_UNSUPPORTED', '不支持该文档格式')
  const bytes = decodeBase64(input.dataBase64)
  const signal = combinedSignal(options.signal)
  throwIfAborted(signal)

  try {
    const Parser = await officeParser()
    const ast = await Parser.parseOffice(bytes, {
      fileType: format.fileType,
      abortSignal: signal,
      extractAttachments: false,
      ocr: false,
      includeRawContent: false,
      ignorePageGeometry: true,
      ignoreSlideMasters: true,
      decompressionLimits: {
        maxUncompressedBytes: 64 * 1024 * 1024,
        maxZipEntries: 5_000,
        maxTableCells: 200_000,
      },
    })
    throwIfAborted(signal)
    const rendered = await ast.to('text', {
      abortSignal: signal,
      includeFormatting: false,
      includeImages: 'none',
      includeCharts: true,
    })
    throwIfAborted(signal)
    const warningCodes = [...new Set([...(ast.warnings ?? []), ...(rendered.messages ?? [])]
      .map((warning) => typeof warning?.code === 'string' ? warning.code : '')
      .filter(Boolean))].slice(0, 50)
    restoreNativeReadableStream()
    return {
      content: normalizeExtractedText(rendered.value),
      mimeType: format.mimeType,
      sourceBytes: bytes.length,
      sourceFormat: format.fileType,
      warningCodes,
    }
  } catch (error) {
    restoreNativeReadableStream()
    if (signal.aborted || error?.name === 'AbortError' || error?.code === 'ABORTED') throw fail('ABORTED', '操作已取消或解析超时')
    // The optional parser being absent is its own actionable outcome, not a
    // corrupt-document failure; keep the message that tells the user what to do.
    if (error?.code === 'DOCUMENT_PARSER_UNAVAILABLE') throw error
    if (error?.code === 'LIMIT_EXCEEDED' || error?.code === 'DOCUMENT_PARSE_FAILED') throw error
    throw fail('DOCUMENT_PARSE_FAILED', '文档无法解析，可能已损坏、加密或格式与扩展名不一致')
  } finally {
    restoreOfficeParserEnvironment()
  }
}

// @vitest-environment happy-dom
/**
 * Host warnings are localized by stable code; hosts older than warningDetails
 * keep sending plain strings and must still render (in their own language).
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextWorkbench } from '../src-client/ContextWorkbench.tsx'
import { enT, resetTranslator, setActiveTranslator } from '../src-client/i18n.ts'
import type { ContextApi } from '../src-client/context-api.ts'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  resetTranslator()
  document.body.innerHTML = ''
})

function api(bootstrapOverrides: Record<string, unknown>): ContextApi {
  const listeners = new Set<() => void>()
  return {
    bootstrap: vi.fn(async () => ({
      displayName: 'agentOS context',
      scopes: [{ id: 'p', label: 'Project', count: 0 }],
      defaultScope: 'p',
      sessionScope: 'p',
      features: { ontology: true, recall: true, capture: true },
      memoryLayers: ['working', 'episodic', 'semantic', 'procedural'],
      legacyScopeScanLimit: 100000,
      warnings: [],
      ...bootstrapOverrides,
    })),
    memories: vi.fn(async () => []),
    memory: vi.fn(),
    versions: vi.fn(async () => []),
    entities: vi.fn(async () => []),
    graph: vi.fn(async () => ({ nodes: [], edges: [], stats: { nodeCount: 0, edgeCount: 0, truncated: false } })),
    reviews: vi.fn(async () => []),
    schema: vi.fn(async () => ({ version: 1, memoryLayers: [], types: [], relations: [] })),
    changes: vi.fn(async () => []),
    usage: vi.fn(),
    documents: vi.fn(async () => []),
    searchDocuments: vi.fn(async () => []),
    documentChunks: vi.fn(),
    uploadDocument: vi.fn(),
    deleteDocument: vi.fn(),
    reindexDocument: vi.fn(),
    deleteDocuments: vi.fn(),
    saveMemory: vi.fn(),
    reviseMemory: vi.fn(),
    transitionMemory: vi.fn(),
    retireMemory: vi.fn(),
    createEntity: vi.fn(),
    mergeEntities: vi.fn(),
    createRelation: vi.fn(),
    reviewRelation: vi.fn(),
    checkRelation: vi.fn(),
    setUsagePolicy: vi.fn(),
    subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
    getRevision: () => 0,
    refresh: () => {},
    dispose() { listeners.clear() },
  } as unknown as ContextApi
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
    await Promise.resolve()
    await Promise.resolve()
  })
  return host
}

const readFailedZh = '旧记忆暂不可读，当前只显示可用的新记忆；未更改旧数据库。'
const readFailedEn = 'Legacy memories cannot be read right now; only the available new memories are shown. The legacy database was not modified.'

describe('host warnings follow the client locale', () => {
  it('renders warningDetails in English instead of the host Chinese text', async () => {
    setActiveTranslator(enT)
    const host = await render(
      <ContextWorkbench
        api={api({
          warnings: [readFailedZh],
          warningDetails: [{ code: 'LEGACY_READ_FAILED', message: readFailedZh }],
        })}
        onClose={() => {}}
      />,
    )
    expect(host.textContent).toContain(readFailedEn)
    expect(host.textContent).not.toContain(readFailedZh)
  })

  it('interpolates the scan cap for LEGACY_SCAN_TRUNCATED', async () => {
    setActiveTranslator(enT)
    const host = await render(
      <ContextWorkbench
        api={api({
          warnings: ['旧记忆超过 100000 条，范围统计已截断。'],
          warningDetails: [{
            code: 'LEGACY_SCAN_TRUNCATED',
            message: '旧记忆超过 100000 条，范围统计已截断。',
            params: { cap: 100000 },
          }],
        })}
        onClose={() => {}}
      />,
    )
    expect(host.textContent).toContain('There are more than 100000 legacy memories')
  })

  it('falls back to the plain warnings of an older host', async () => {
    setActiveTranslator(enT)
    const host = await render(
      <ContextWorkbench api={api({ warnings: [readFailedZh] })} onClose={() => {}} />,
    )
    expect(host.textContent).toContain(readFailedZh)
  })

  it('renders Chinese warning copy under the default locale', async () => {
    resetTranslator()
    const host = await render(
      <ContextWorkbench
        api={api({
          warnings: [readFailedZh],
          warningDetails: [{ code: 'LEGACY_READ_FAILED', message: readFailedZh }],
        })}
        onClose={() => {}}
      />,
    )
    expect(host.textContent).toContain(readFailedZh)
  })
})

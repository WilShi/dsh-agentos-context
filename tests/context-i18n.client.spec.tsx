// @vitest-environment happy-dom
/**
 * i18n gate: the plugin's English dictionary must fully cover the Chinese one
 * and the rendered surfaces must not fall back to Chinese copy under `en`.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextWorkbench } from '../src-client/ContextWorkbench.tsx'
import { ConfigCard } from '../src-client/ConfigCard.tsx'
import {
  createTranslator,
  enT,
  interpolate,
  resetTranslator,
  setActiveTranslator,
  zhT,
} from '../src-client/i18n.ts'
import { en, zh } from '../src-client/locales.ts'
import type { ContextApi } from '../src-client/context-api.ts'
import type { OcApi } from '../src-client/api.ts'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const CJK = /[\u4e00-\u9fff]/

afterEach(() => {
  resetTranslator()
  document.body.innerHTML = ''
})

function memoryApi(): ContextApi {
  let revision = 0
  const listeners = new Set<() => void>()
  return {
    bootstrap: vi.fn(async () => ({
      displayName: 'agentOS context',
      scopes: [{ id: 'p', label: 'Project', count: 1 }],
      defaultScope: 'p',
      sessionScope: 'p',
      features: { ontology: true, recall: true, capture: true },
      memoryLayers: ['working', 'episodic', 'semantic', 'procedural'],
      legacyScopeScanLimit: 100000,
      warnings: [],
    })),
    memories: vi.fn(async () => []),
    memory: vi.fn(),
    versions: vi.fn(async () => []),
    entities: vi.fn(async () => []),
    graph: vi.fn(async () => ({
      nodes: [],
      edges: [],
      stats: { nodeCount: 0, edgeCount: 0, truncated: false },
    })),
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
    getRevision: () => revision,
    refresh: () => {
      revision += 1
      for (const listener of listeners) listener()
    },
    dispose() {
      listeners.clear()
    },
  } as unknown as ContextApi
}

function configApi(): OcApi {
  return {
    listModels: vi.fn(async () => null),
    describeCredential: vi.fn(async () => ({ configured: false, writable: true })),
    verifyKey: vi.fn(async () => ({ ok: true })),
    setCredential: vi.fn(async () => true),
  } as unknown as OcApi
}

function configScope() {
  const snapshot = {
    status: 'ready',
    writable: true,
    revision: 1,
    value: {},
    user: undefined,
  }
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  }
}

async function render(node: React.ReactNode): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
    await Promise.resolve()
    await Promise.resolve()
  })
  return { host, root }
}

describe('agentOS context dictionaries', () => {
  it('ships a complete English dictionary with no leftover Chinese', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
    for (const key of zhKeys) {
      expect(zh[key as keyof typeof zh].length).toBeGreaterThan(0)
      expect(en[key as keyof typeof en].length).toBeGreaterThan(0)
    }
    const translated = zhKeys.filter(key => zh[key as keyof typeof zh] !== en[key as keyof typeof en])
    expect(translated.length).toBeGreaterThan(300)
    for (const key of enKeys) {
      expect(CJK.test(en[key as keyof typeof en]), 'en still contains Chinese: ' + key).toBe(false)
    }
  })

  it('interpolates parameters and falls back to the key or Chinese default', () => {
    expect(zhT('knowledge.search.limit', { count: 5 })).toBe('5 条')
    expect(enT('knowledge.search.limit', { count: 5 })).toBe('5')
    expect(zhT('unknown.key')).toBe('unknown.key')
    expect(interpolate('a {x} b {y}', { x: 1 })).toBe('a 1 b {y}')
    const partial = createTranslator({ 'common.save': 'Save' })
    expect(partial('common.save')).toBe('Save')
    expect(partial('common.cancel')).toBe('common.cancel')
    // Default locale is Chinese; unknown locales fall back to the Chinese dictionary.
    resetTranslator()
    expect(zhT('nav')).toBe('记忆')
    expect(enT('nav')).toBe('Memory')
  })

  it('renders the memory settings card in English without Chinese fallbacks', async () => {
    setActiveTranslator(enT)
    const { host, root } = await render(
      <ConfigCard api={configApi()} contextApi={memoryApi()} scope={configScope() as never} />,
    )
    const text = host.textContent ?? ''
    expect(text).toContain('Gateway key')
    expect(text).toContain('Memory automation')
    expect(text).toContain('Open memory workbench')
    expect(text).not.toMatch(CJK)
    await act(async () => root.unmount())
  })

  it('renders the workbench tabs and header in English', async () => {
    setActiveTranslator(enT)
    const { host, root } = await render(
      <ContextWorkbench api={memoryApi()} onClose={() => {}} />,
    )
    const text = host.textContent ?? ''
    for (const label of ['Memory', 'Knowledge', 'Graph', 'Review', 'Settings'])
      expect(text).toContain(label)
    expect(text).not.toMatch(CJK)
    await act(async () => root.unmount())
  })

  it('falls back to Chinese when no locale seat is installed', async () => {
    resetTranslator()
    const { host, root } = await render(
      <ContextWorkbench api={memoryApi()} onClose={() => {}} />,
    )
    for (const label of ['记忆', '知识库', '图谱', '待确认', '设置'])
      expect(host.textContent).toContain(label)
    await act(async () => root.unmount())
  })
})

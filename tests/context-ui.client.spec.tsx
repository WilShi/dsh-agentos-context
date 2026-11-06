// @vitest-environment happy-dom
/* oxlint-disable typescript/no-explicit-any -- Integration doubles cover private Cordis, browser, WebGL, and generated remote faces. */
/* oxlint-disable typescript/no-unsafe-argument -- Partial integration doubles intentionally supply only scenario-owned fields. */
/* oxlint-disable typescript/no-unsafe-assignment -- Partial integration doubles intentionally supply only scenario-owned fields. */
/* oxlint-disable typescript/no-unsafe-call -- Partial generated-remote doubles expose Vitest mocks rather than concrete services. */
/* oxlint-disable typescript/no-unsafe-member-access -- Private registration faces are inspected through partial integration doubles. */
/* oxlint-disable typescript/restrict-plus-operands -- WebGL matrix doubles use the same numeric coercion as the production API. */
/* oxlint-disable typescript/unbound-method -- Vitest verifies mock method references without invoking their production receivers. */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextWorkbench } from '../src-client/ContextWorkbench.tsx'
import { ContextMemoryPane } from '../src-client/ContextMemoryPane.tsx'
import { MemoryView } from '../src-client/MemoryView.tsx'
import { ConfigCard } from '../src-client/ConfigCard.tsx'
import { ContextKnowledge } from '../src-client/ContextKnowledge.tsx'
import { ContextSettingsSection } from '../src-client/ContextSettingsSection.tsx'
import { ContextModal } from '../src-client/ContextModal.tsx'
import {
  pointCloudNodeRadius,
  pointCloudPermanentLabel,
  pointCloudPositions,
} from '../src-client/ContextGraph3D.tsx'
import { ALL_SCOPES_ID } from '../src-client/context-all-scopes.ts'
import { apply as applyClient } from '../src-client/index.tsx'
import type { ContextApi } from '../src-client/context-api.ts'
import type {
  ContextBootstrap,
  ContextGraph,
  ContextMemory,
  ContextRelation,
  ContextSchema,
  UsagePolicy,
} from '../src-client/context-types.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const memoryLayers: ContextBootstrap['memoryLayers'] = [
  'working',
  'episodic',
  'semantic',
  'procedural',
]
const baseMemory: ContextMemory = {
  id: 'm1',
  revision: 1,
  scopeId: 'p',
  content: 'source-backed memory',
  kind: 'fact',
  layer: 'semantic',
  importance: 0.7,
  expiresAt: null,
  promotedFrom: null,
  lifecycle: 'active',
  epistemic: 'unverified',
  sourceId: 's1',
  source: {
    id: 's1',
    scopeId: 'p',
    content: 'source-backed memory',
    kind: 'manual',
    actorRole: 'human',
    complete: true,
    recordedAt: 1,
    lineageId: 'l1',
  },
  recordedAt: 1,
  validFrom: null,
  validTo: null,
  metadata: {},
}
function api(): ContextApi {
  let rev = 0
  const listeners = new Set<() => void>()
  return {
    bootstrap: vi.fn(async () => ({
      displayName: 'agentOS context',
      scopes: [{ id: 'p', label: 'Project', count: 1 }],
      defaultScope: 'p',
      sessionScope: 'p',
      features: { ontology: true, recall: true, capture: true },
      memoryLayers,
      legacyScopeScanLimit: 100000,
      warnings: [],
    })),
    memories: vi.fn(async () => [baseMemory]),
    memory: vi.fn(async () => baseMemory),
    versions: vi.fn(async () => [baseMemory]),
    entities: vi.fn(async () => []),
    graph: vi.fn(async () => ({
      nodes: [],
      edges: [],
      stats: { nodeCount: 0, edgeCount: 0, truncated: false },
    })),
    reviews: vi.fn(async () => []),
    schema: vi.fn(async () => ({
      version: 1,
      memoryLayers: [
        { id: 'working', label: 'working' },
        { id: 'episodic', label: 'episodic' },
        { id: 'semantic', label: 'semantic' },
        { id: 'procedural', label: 'procedural' },
      ],
      types: [{ id: 'Project', label: 'Project' }],
      relations: [],
    })),
    changes: vi.fn(async () => []),
    usage: vi.fn(async () => ({
      items: [
        {
          id: 'u1',
          sessionId: 'session-1',
          scopeId: 'p',
          phase: 'planned',
          items: [{ id: 'm1', revision: 1, content: 'source-backed memory' }],
        },
      ],
      policy: {
        revision: 0,
        scopeId: 'p',
        paused: false,
        excludedIds: [],
        preferredIds: [],
      },
    })),
    documents: vi.fn(async () => [
      {
        id: 'd1',
        scopeId: 'p',
        filename: 'guide.md',
        mimeType: 'text/markdown',
        uploadedAt: 1,
        chunks: 2,
        metadata: {},
      },
    ]),
    searchDocuments: vi.fn(async () => [
      {
        id: 'c1',
        documentId: 'd1',
        documentName: 'guide.md',
        content: 'matching paragraph',
        chunkIndex: 0,
        score: 0.9,
        metadata: {},
      },
    ]),
    uploadDocument: vi.fn(async () => ({ documentId: 'd1', chunks: 2 })),
    documentChunks: vi.fn(async () => ({ document:{ id:'d1',scopeId:'p',filename:'guide.md',mimeType:'text/markdown',uploadedAt:1,chunks:2,metadata:{} },chunks:[{ id:'c1',scopeId:'p',documentId:'d1',content:'first indexed chunk',chunkIndex:0,metadata:{} }] })),
    reindexDocument: vi.fn(async () => ({ reindexed:true,chunks:2 })),
    deleteDocuments: vi.fn(async (_scope:string,ids:string[]) => ({ deleted:ids.length,requested:ids.length })),
    deleteDocument: vi.fn(async () => true),
    saveMemory: vi.fn(async () => baseMemory),
    reviseMemory: vi.fn(async () => baseMemory),
    transitionMemory: vi.fn(async () => baseMemory),
    retireMemory: vi.fn(async () => ({ ...baseMemory, lifecycle: 'retired' })),
    createEntity: vi.fn(),
    mergeEntities: vi.fn(),
    createRelation: vi.fn(),
    reviewRelation: vi.fn(),
    checkRelation: vi.fn(async () => ({ ok: true, errors: [] })),
    setUsagePolicy: vi.fn(async () => ({
      revision: 1,
      scopeId: 'p',
      paused: true,
      excludedIds: [],
      preferredIds: [],
    })),
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    getRevision: () => rev,
    refresh: () => {
      rev++
      for (const listener of listeners) listener()
    },
    dispose() {
      listeners.clear()
    },
  } as ContextApi
}
let root: Root | null = null
afterEach(async () => {
  if (root !== null) await act(async () => { root?.unmount() })
  root = null
  document.body.innerHTML = ''
})
async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  const currentRoot = createRoot(host)
  root = currentRoot
  await act(async () => {
    currentRoot.render(node)
    await Promise.resolve()
    await Promise.resolve()
  })
  return host
}
function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const prototype = element instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLSelectElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set as
    | ((this: typeof element, value: string) => void)
    | undefined
  if (setter === undefined) throw new Error('test fixture element has no value setter')
  setter.call(element, value)
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? 'change' : 'input', {
      bubbles: true,
    }),
  )
}
function itemAt<T>(items: ArrayLike<T>, index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`test fixture item ${index} is missing`)
  return item
}
const button = (rootNode: ParentNode, label: string) =>
  [...rootNode.querySelectorAll('button')].find(
    item => item.textContent === label,
  ) as HTMLButtonElement
describe('native context surfaces', () => {
  it('workbench renders five real-data tabs and source-backed memory', async () => {
    const host = await render(
      <ContextWorkbench api={api()} onClose={() => {}} />,
    )
    for (const name of ['记忆', '知识库', '图谱', '待确认', '设置'])
      expect(host.textContent).toContain(name)
    expect(host.textContent).toContain('source-backed memory')
    expect(host.textContent).not.toContain('DEMO-042')
  })
  it('defaults the workbench to an aggregate all-scopes view ordered by newest memory', async () => {
    const a = api(),
      older = {
        ...baseMemory,
        id: 'old',
        scopeId: 'p',
        content: 'old scope memory',
        recordedAt: 10,
      },
      newer = {
        ...baseMemory,
        id: 'new',
        scopeId: 'q',
        content: 'newest scope memory',
        recordedAt: 20,
      }
    a.bootstrap = vi.fn(async () => ({
      displayName: 'agentOS context',
      scopes: [
        { id: 'p', label: 'P', count: 1 },
        { id: 'q', label: 'Q', count: 1 },
      ],
      defaultScope: 'p',
      sessionScope: 'p',
      features: { ontology: true, recall: true, capture: true },
      memoryLayers,
      legacyScopeScanLimit: 500,
      warnings: [],
    }))
    a.memories = vi.fn(async (scope: string) =>
      scope === 'p' ? [older] : [newer],
    )
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    const select = host.querySelector(
      'select[aria-label="记忆范围"]',
    ) as HTMLSelectElement
    expect(select.value).toBe('agentos-context:all-scopes')
    expect(itemAt(select.options, 0).textContent).toContain('全部范围 · 2 条')
    expect(host.textContent).toContain('正在显示“全部范围”中的 2 条记录')
    expect(host.textContent).toContain('newest scope memory')
    expect(host.textContent).toContain('old scope memory')
    expect(a.memories).toHaveBeenCalledWith(
      'p',
      expect.objectContaining({ limit: 500 }),
      expect.anything(),
    )
    expect(a.memories).toHaveBeenCalledWith(
      'q',
      expect.objectContaining({ limit: 500 }),
      expect.anything(),
    )
    const cards = [...host.querySelectorAll('[aria-label="记忆列表"] button')]
    expect(itemAt(cards, 0).textContent).toContain('newest scope memory')
  })
  it('conversation Memory tab defaults to all scopes and offers graph plus the complete workbench', async () => {
    const a = api()
    a.bootstrap = vi.fn(async () => ({
      displayName: 'agentOS context',
      scopes: [
        { id: 'local:new', label: 'local:new', count: 1 },
        {
          id: 'local:D:\\DSH Desktop',
          label: 'local:D:\\DSH Desktop',
          count: 927,
        },
      ],
      defaultScope: 'local:new',
      sessionScope: 'local:new',
      features: { ontology: true, recall: true, capture: true },
      memoryLayers,
      legacyScopeScanLimit: 100000,
      warnings: [],
    }))
    a.memories = vi.fn(async (scope: string, options?: { query?: string }) => {
      const memory = {
        ...baseMemory,
        scopeId: scope,
        content:
          scope === 'local:D:\\DSH Desktop'
            ? '质量保障 existing OpenContext history'
            : '产品交付 new scope memory',
      }
      return options?.query && !memory.content.toLocaleLowerCase().includes(options.query)
        ? []
        : [memory]
    })
    const openView = vi.fn()
    const host = await render(
      React.createElement(MemoryView, {
        contextApi: a,
        sessionId: 'session-1',
        openView,
      } as any),
    )
    expect(
      host.querySelector('[data-context-surface="conversation"]'),
    ).not.toBeNull()
    const scope = host.querySelector(
      'select[aria-label="记忆范围"]',
    ) as HTMLSelectElement
    expect(scope.value).toBe('agentos-context:all-scopes')
    expect(itemAt(scope.options, 0).textContent).toContain('全部范围 · 928 条')
    expect(host.textContent).toContain('自动记忆与实时同步已开启')
    expect(host.textContent).toContain('new scope memory')
    expect(host.textContent).toContain('existing OpenContext history')
    expect(a.memories).toHaveBeenCalledWith(
      'local:new',
      expect.objectContaining({ limit: 500 }),
      expect.anything(),
    )
    expect(a.memories).toHaveBeenCalledWith(
      'local:D:\\DSH Desktop',
      expect.objectContaining({ limit: 500 }),
      expect.anything(),
    )
    expect(a.graph).not.toHaveBeenCalled()
    const search = host.querySelector(
      'input[aria-label="搜索记忆"]',
    ) as HTMLInputElement
    await act(async () =>{  setValue(search, 'OpenContext') })
    expect(host.textContent).toContain('existing OpenContext history')
    expect(host.textContent).not.toContain('new scope memory')
    expect(host.textContent).toContain('1 / 928 条')
    expect(a.memories).toHaveBeenCalledWith(
      'local:D:\\DSH Desktop',
      expect.objectContaining({ query: 'opencontext', limit: 500 }),
      expect.anything(),
    )
    await act(async () =>{  setValue(search, '产品交付') })
    expect(host.textContent).toContain('产品交付 new scope memory')
    expect(host.textContent).not.toContain('质量保障 existing OpenContext history')
    expect(a.memories).toHaveBeenCalledWith(
      'local:new',
      expect.objectContaining({ query: '产品交付', limit: 500 }),
      expect.anything(),
    )
    await act(async () =>{
      (host.querySelector(
        'button[aria-label="清除记忆搜索"]',
      ) as HTMLButtonElement).click() },
    )
    expect(host.textContent).toContain('new scope memory')
    await act(async () => {
      button(host, '图谱').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.graph).toHaveBeenCalledWith(
      'local:new',
      expect.objectContaining({ limit: 1500 }),
      expect.anything(),
    )
    expect(a.graph).toHaveBeenCalledWith(
      'local:D:\\DSH Desktop',
      expect.objectContaining({ limit: 1500 }),
      expect.anything(),
    )
    await act(async () => {
      button(host, '打开完整工作台').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('完整记忆工作台')
    for (const name of ['记忆', '知识库', '图谱', '待确认', '设置'])
      expect(dialog.textContent).toContain(name)
    expect(dialog.textContent).toContain('new scope memory')
    expect(document.documentElement.dataset.agentosMemoryActive).toBe('true')
  })
  it('memory details open on demand instead of reserving a permanent split column', async () => {
    const host = await render(
      <ContextWorkbench
        api={api()}
        onClose={() => {}}
        surface="conversation"
      />,
    )
    expect(host.querySelector('[aria-label="记忆详情"]')).toBeNull()
    const memoryButton = [...host.querySelectorAll('button')].find(item =>
      item.textContent?.includes('source-backed memory'),
    ) as HTMLButtonElement
    await act(async () =>{  memoryButton.click() })
    expect(host.querySelector('[aria-label="记忆详情"]')).not.toBeNull()
    await act(async () =>{  button(host, '关闭').click() })
    expect(host.querySelector('[aria-label="记忆详情"]')).toBeNull()
  })
  it('defaults to every lifecycle and distinguishes active, candidate, expired and disabled memory', async () => {
    const a = api(),
      now = Date.now(),
      records = {
        active: { ...baseMemory, id: 'active', content: 'active memory', lifecycle: 'active', expiresAt: null },
        candidate: { ...baseMemory, id: 'candidate', content: 'candidate memory', lifecycle: 'candidate', expiresAt: null },
        expired: { ...baseMemory, id: 'expired', content: 'expired memory', lifecycle: 'retired', expiresAt: now - 10_000 },
        retired: { ...baseMemory, id: 'retired', content: 'disabled memory', lifecycle: 'retired', expiresAt: null },
      } as const
    a.memories = vi.fn(async (_scope: string, options: any) =>
      options.lifecycle === 'active'
        ? [records.active]
        : options.lifecycle === 'candidate'
          ? [records.candidate]
          : [records.expired, records.retired],
    )
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    await act(async () => new Promise(resolve => setTimeout(resolve, 20)))
    const lifecycle = host.querySelector('select[aria-label="状态筛选"]') as HTMLSelectElement
    expect(lifecycle.value).toBe('all')
    for (const text of ['active memory', 'candidate memory', 'expired memory', 'disabled memory'])
      expect(host.textContent).toContain(text)
    for (const label of ['有效', '候选', '已过期', '已停用'])
      expect(host.textContent).toContain(label)
    await act(async () => {
      setValue(lifecycle, 'expired')
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(host.textContent).toContain('expired memory')
    expect(host.textContent).not.toContain('disabled memory')
    await act(async () => {
      setValue(lifecycle, 'retired')
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(host.textContent).toContain('disabled memory')
    expect(host.textContent).not.toContain('expired memory')
  })
  it('planned trace is not labelled as entered into the model request', async () => {
    const host = await render(
      <ContextMemoryPane
        api={api()}
        sessionId={'session-1' as any}
        onClose={() => {}}
        onManage={() => {}}
      />,
    )
    expect(host.textContent).toContain('已进入请求 0')
    expect(host.textContent).toContain('待处理记录 1')
    const pending = [...host.querySelectorAll('button')].find(
      x => x.textContent === '待处理记录 1',
    )!
    await act(async () =>{  pending.click() })
    expect(
      [...host.querySelectorAll('span')].some(
        x => x.textContent === '计划使用',
      ),
    ).toBe(true)
  })
  it('session switch discards delayed prior-session pane data', async () => {
    const a = api()
    let resolveOld: (value: ContextBootstrap) => void
    const old = new Promise<ContextBootstrap>((resolve) => {
      resolveOld = resolve
    })
    const boot = (scope: string): ContextBootstrap => ({
      displayName: 'agentOS context',
      scopes: [{ id: scope, label: scope, count: 1 }],
      defaultScope: scope,
      sessionScope: scope,
      features: { ontology: true, recall: true, capture: true },
      memoryLayers,
      legacyScopeScanLimit: 500,
      warnings: [],
    })
    const bootstrap = vi.fn((id?: string) =>
      id === 'old' ? old : Promise.resolve(boot('new-scope')),
    )
    a.bootstrap = bootstrap
    a.usage = vi.fn(async (scope: string, _id: string) => ({
      items: [],
      policy: {
        revision: 0,
        scopeId: scope,
        paused: false,
        excludedIds: [],
        preferredIds: [],
      },
    }))
    a.memories = vi.fn(async scope => [
      { ...baseMemory, scopeId: scope, content: scope + ' memory' },
    ])
    const host = await render(
      <ContextMemoryPane
        api={a}
        sessionId={'old' as any}
        onClose={() => {}}
        onManage={() => {}}
      />,
    )
    await act(async () => {
      root?.render(
        <ContextMemoryPane
          api={a}
          sessionId={'new' as any}
          onClose={() => {}}
          onManage={() => {}}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toContain('范围：new-scope')
    const relatedTab = [...host.querySelectorAll('button')].find(
      x => x.textContent === '已存记忆 1',
    )!
    await act(async () =>{  relatedTab.click() })
    expect(host.textContent).toContain('new-scope memory')
    await act(async () => {
      resolveOld!(boot('old-scope'))
      await old
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toContain('new-scope memory')
    expect(host.textContent).not.toContain('old-scope memory')
  })
  it('old-session policy completion cannot refresh or repaint after a session switch', async () => {
    const a = api(),
      boot = (scope: string): ContextBootstrap => ({
        displayName: 'agentOS context',
        scopes: [{ id: scope, label: scope, count: 0 }],
        defaultScope: scope,
        sessionScope: scope,
        features: { ontology: true, recall: true, capture: false },
        memoryLayers,
        legacyScopeScanLimit: 500,
        warnings: [],
      })
    const bootstrap = vi.fn(async (id?: string) =>
      boot(id === 'old' ? 'old-scope' : 'new-scope'),
    )
    a.bootstrap = bootstrap
    a.usage = vi.fn(async (scope: string) => ({
      items: [],
      policy: {
        revision: 0,
        scopeId: scope,
        paused: false,
        excludedIds: [],
        preferredIds: [],
      },
    }))
    a.memories = vi.fn(async () => [])
    let finish: (value: any) => void
    const mutation = new Promise<UsagePolicy>((resolve) => {
      finish = resolve
    })
    a.setUsagePolicy = vi.fn(async () => await mutation)
    const host = await render(
      <ContextMemoryPane
        api={a}
        sessionId={'old' as any}
        onClose={() => {}}
        onManage={() => {}}
      />,
    )
    const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
      await Promise.resolve()
      root?.render(
        <ContextMemoryPane
          api={a}
          sessionId={'new' as any}
          onClose={() => {}}
          onManage={() => {}}
        />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toContain('范围：new-scope')
    const callsBefore = bootstrap.mock.calls.length
    await act(async () => {
      finish!({
        revision: 1,
        scopeId: 'old-scope',
        paused: true,
        excludedIds: [],
        preferredIds: [],
      })
      await mutation
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(bootstrap.mock.calls.length).toBe(callsBefore)
    expect(host.textContent).toContain('范围：new-scope')
    expect(host.textContent).not.toContain('范围：old-scope')
  })
  it('trace unavailable is explicit instead of an empty success', async () => {
    const a = api()
    a.usage = vi.fn(async () => {
      throw Object.assign(new Error('missing'), { code: 'TRACE_UNAVAILABLE' })
    })
    const host = await render(
      <ContextMemoryPane
        api={a}
        sessionId={'session-1' as any}
        onClose={() => {}}
        onManage={() => {}}
      />,
    )
    expect(host.textContent).toContain('引用记录暂不可用')
  })
  it('scope switch removes prior-scope records before the new response settles', async () => {
    const a = api(),
      qMemory = {
        ...baseMemory,
        id: 'q1',
        scopeId: 'q',
        content: 'q-only memory',
      },
      pMemory = { ...baseMemory, content: 'p-only memory' }
    a.bootstrap = vi.fn(async () => ({
      displayName: 'agentOS context',
      scopes: [
        { id: 'p', label: 'P', count: 1 },
        { id: 'q', label: 'Q', count: 1 },
      ],
      defaultScope: 'p',
      sessionScope: null,
      features: { ontology: true, recall: true, capture: true },
      memoryLayers,
      legacyScopeScanLimit: 500,
      warnings: [],
    }))
    let release!: () => void
    const pending = new Promise<(typeof baseMemory)[]>((resolve) => {
      release = () =>{  resolve([qMemory]) }
    })
    a.memories = vi.fn(async scope =>
      scope === 'p' ? [pMemory] : await pending,
    )
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    const select = host.querySelector(
      'select[aria-label="记忆范围"]',
    ) as HTMLSelectElement
    await act(async () => {
      setValue(select, 'p')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toContain('p-only memory')
    await act(async () => {
      setValue(select, 'q')
      await Promise.resolve()
    })
    expect(host.textContent).not.toContain('p-only memory')
    expect(host.textContent).toContain('正在读取记忆')
    await act(async () => {
      release()
      await pending
      await Promise.resolve()
    })
    expect(host.textContent).toContain('q-only memory')
  })
  it('loads the real graph tab on demand', async () => {
    const a = api()
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    const tab = [...host.querySelectorAll('button')].find(
      x => x.textContent === '图谱',
    )!
    await act(async () => {
      tab.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.graph).toHaveBeenCalled()
    expect(host.textContent).toContain('当前范围还没有已建立的对象关系')
  })
  it('loads and searches the real knowledge library on demand', async () => {
    const a = api()
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    const tab = [...host.querySelectorAll('button')].find(
      x => x.textContent === '知识库',
    )!
    await act(async () => {
      tab.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.documents).toHaveBeenCalledWith('p', 200, expect.anything())
    expect(host.textContent).toContain('guide.md')
    const formats = [...host.querySelectorAll('details')].find(
      item => item.querySelector('summary')?.textContent === '支持格式与大小限制',
    ) as HTMLDetailsElement
    expect(formats).toBeTruthy()
    expect(formats.open).toBe(false)
    const input = host.querySelector(
      'input[aria-label="搜索知识库"]',
    ) as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'matching')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const search = [...host.querySelectorAll('button')].find(
      x => x.textContent === '检索',
    )!
    await act(async () => {
      search.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.searchDocuments).toHaveBeenCalledWith(
      'p',
      'matching',
      expect.anything(),
      expect.anything(),
    )
    expect(host.textContent).toContain('matching paragraph')
  })
  it('writes workbench uploads to the shared global knowledge scope', async () => {
    const a = api()
    a.bootstrap = vi.fn(async () => ({ ...(await api().bootstrap()),scopes:[{ id:'p',label:'Project',count:1 },{ id:'dsh-default',label:'全局记忆',count:0,knowledgeCount:1 }],globalScope:'dsh-default' }))
    a.documents = vi.fn(async scopeId => scopeId === 'p' ? [{ id:'legacy-doc',scopeId:'p',filename:'legacy.md',mimeType:'text/markdown',uploadedAt:1,chunks:1,metadata:{} }] : [])
    a.uploadDocument = vi.fn(async () => ({ documentId:'global-doc',chunks:1,semanticIndexed:false,semanticPending:true }))
    const host=await render(<ContextWorkbench api={a} onClose={()=>{}}/>)
    await act(async()=>{button(host,'知识库').click();await Promise.resolve();await Promise.resolve()})
    const input=host.querySelector('input[type="file"]') as HTMLInputElement,file=new File(['global knowledge'],'global.txt',{ type:'text/plain' })
    Object.defineProperty(input,'files',{ configurable:true,value:[file] })
    await act(async()=>{input.dispatchEvent(new Event('change',{ bubbles:true }));await new Promise(resolve=>setTimeout(resolve,20))})
    expect(a.documents).toHaveBeenCalledWith('p',200,expect.anything())
    expect(a.documents).toHaveBeenCalledWith('dsh-default',200,expect.anything())
    expect(host.textContent).toContain('legacy.md')
    expect(a.uploadDocument).toHaveBeenCalledWith(expect.objectContaining({ scopeId:'dsh-default',filename:'global.txt' }),expect.anything())
    expect(host.textContent).toContain('关键词检索已可用')
    expect(host.textContent).toContain('知识库在所有工作区共享')
  })
  it('supports hybrid tuning chunk inspection reindex and scoped batch deletion',async()=>{const a=api(),host=await render(<ContextKnowledge api={a} scopeId="p"/>);const mode=host.querySelector('select[aria-label="检索方式"]') as HTMLSelectElement,filter=host.querySelector('select[aria-label="限定文档"]') as HTMLSelectElement,count=host.querySelector('select[aria-label="结果数量"]') as HTMLSelectElement,threshold=host.querySelector('input[aria-label="最低相关度"]') as HTMLInputElement,query=host.querySelector('input[aria-label="搜索知识库"]') as HTMLInputElement;await act(async()=>{for(const [element,value] of [[mode,'keyword'],[filter,'d1'],[count,'5'],[threshold,'0.4'],[query,'matching']] as const){Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),'value')!.set!.call(element,value);element.dispatchEvent(new Event(element===query?'input':'change',{ bubbles:true }))}});await act(async()=>{button(host,'检索').click();await Promise.resolve();await Promise.resolve()});expect(a.searchDocuments).toHaveBeenCalledWith('p','matching',{ limit:5,threshold:.4,searchMode:'keyword',documentIds:['d1'] },expect.anything());await act(async()=>{ button(host,'清除结果').click() });await act(async()=>{button(host,'查看分块').click();await Promise.resolve();await Promise.resolve()});expect(a.documentChunks).toHaveBeenCalledWith('p','d1',expect.anything());expect(document.querySelector('[role="dialog"]')!.textContent).toContain('first indexed chunk');await act(async()=>{ button(document.querySelector('[role="dialog"]')!,'完成').click() });await act(async()=>{button(host,'重建索引').click();await Promise.resolve();await Promise.resolve()});expect(a.reindexDocument).toHaveBeenCalledWith('p','d1',expect.anything());const checkbox=host.querySelector('input[aria-label="选择 guide.md"]') as HTMLInputElement;await act(async()=>{checkbox.click()});await act(async()=>{ button(host,'删除所选（1）').click() });const dialog=document.querySelector('[role="dialog"]')!;await act(async()=>{button(dialog,'确认删除 1 篇').click();await Promise.resolve();await Promise.resolve()});expect(a.deleteDocuments).toHaveBeenCalledWith('p',['d1'],expect.anything())})
  it('uploads supported binary documents as standard Base64', async () => {
    const a = api()
    const host = await render(<ContextKnowledge api={a} scopeId="p" />)
    const input = host.querySelector('input[type="file"]') as HTMLInputElement
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const file = new File([bytes], 'sample.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(a.uploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'p',
        filename: 'sample.pdf',
        mimeType: 'application/pdf',
        dataBase64: 'JVBERg==',
      }),
      expect.anything(),
    )
    expect(host.textContent).toContain('已上传 sample.pdf')
    expect(host.textContent).toContain('暂不支持旧版 DOC、XLS、PPT')
  })
  it('uploads multiple knowledge files, continues after a failure and summarizes every outcome', async () => {
    const a = api()
    a.documents = vi.fn(async () => [])
    a.uploadDocument = vi.fn(async (input: { filename: string }) => {
      if (input.filename === 'broken.txt') throw new Error('模拟上传失败')
      return {
        documentId: input.filename,
        chunks: input.filename === 'pending.txt' ? 2 : 1,
        semanticIndexed: input.filename !== 'pending.txt',
        semanticPending: input.filename === 'pending.txt',
      }
    })
    const host = await render(<ContextKnowledge api={a} scopeId="p" />)
    const input = host.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.multiple).toBe(true)
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [
        new File(['ready'], 'ready.txt', { type: 'text/plain' }),
        new File(['broken'], 'broken.txt', { type: 'text/plain' }),
        new File(['pending'], 'pending.txt', { type: 'text/plain' }),
      ],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    expect(a.uploadDocument).toHaveBeenCalledTimes(3)
    expect(host.textContent).toContain('已处理 3/3')
    expect(host.textContent).toContain('成功 2 篇，失败 1 篇')
    expect(host.textContent).toContain('1 篇等待补建语义索引')
    expect(host.textContent).toContain('broken.txt：模拟上传失败')
  })
  it('accepts files dropped on the visible knowledge upload area', async () => {
    const a = api()
    a.documents = vi.fn(async () => [])
    const host = await render(<ContextKnowledge api={a} scopeId="p" />)
    const dropArea = host.querySelector('[aria-label="拖放上传知识库文件"]') as HTMLElement
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [new File(['dropped'], 'dropped.md', { type: 'text/markdown' })] },
    })
    await act(async () => {
      dropArea.dispatchEvent(drop)
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(drop.defaultPrevented).toBe(true)
    expect(a.uploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'dropped.md', content: 'dropped' }),
      expect.anything(),
    )
  })
  it('registers one first-level memory settings surface over a remote DSH connection without a duplicate plugin card', async () => {
    const registered: any[] = []
    const disposers: (() => void)[] = []
    const connection = {
      isLoopback: false,
      rpc: { call: vi.fn(async () => ({ ok: true, value: {} })) },
    }
    const snapshot = {
      status: 'ready',
      value: {},
      base: {},
      user: {},
      revision: 1,
      writable: true,
      mode: 'host',
    }
    const scope = {
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      set: vi.fn(),
      unset: vi.fn(),
      mutate: vi.fn(async () => true),
    }
    const ctx: any = {
      get: (key: string) => (key === 'connection' ? connection : undefined),
      remote: { $on: () => () => {}, credentials: {} },
      configForms: { get: () => scope },
      locale: {
        register: () => () => {},
        bind: () => (key: string) => key === 'nav' ? '记忆' : key,
      },
      slots: {
        inject: (_name: string, loader: () => unknown) => loader(),
        register: (options: any, component: any) => (
          registered.push({ options, component }),
          () => {}
        ),
      },
      effect: (factory: () => () => void) => {
        const dispose = factory()
        disposers.push(dispose)
        return dispose
      },
    }
    applyClient(ctx)
    const entry = registered.find(
      row => row.options.name === 'settings.section',
    )
    expect(entry.options.id).toBe('agentos-context')
    expect(entry.options.label()).toBe('记忆')
    expect(entry.options.locale).toBe('agentos-context')
    expect(entry.options.order).toBe(35)
    expect(
      registered.some(row => row.options.name === 'settings.plugin.item'),
    ).toBe(false)
    const face = entry.options.inject()
    const legacy = {
      ...face.api,
      describeCredential: vi.fn(async () => ({
        configured: false,
        writable: true,
      })),
      listModels: vi.fn(async () => ({
        keyConfigured: false,
        models: [],
        auto: null,
        configured: null,
      })),
    }
    const host = await render(
      <ContextSettingsSection {...face} api={legacy} close={() => {}} />,
    )
    expect(host.textContent).toContain('agentOS context')
    expect(host.textContent).toContain('记忆自动化')
    expect(host.textContent).toContain('打开记忆工作台')
    disposers.reverse().forEach((dispose) =>{  dispose() })
  })
  it('saves user-entered content through the shared API', async () => {
    const a = api()
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    const add = [...host.querySelectorAll('button')].find(
      x => x.textContent === '记住一条',
    )!
    await act(async () =>{  add.click() })
    const input = document.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(input, 'actual user entry')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirm = [...document.querySelectorAll('button')].find(
      x => x.textContent === '确认',
    )!
    await act(async () => {
      confirm.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: 'p', content: 'actual user entry' }),
      expect.anything(),
    )
  })
  it('exposes global memory and copies a workspace memory into its durable scope', async () => {
    const a = api()
    a.bootstrap = vi.fn(async () => ({
      displayName: 'agentOS context',
      scopes: [
        { id: 'p', label: 'Project', count: 1 },
        { id: 'dsh-default', label: '全局记忆', count: 0 },
      ],
      defaultScope: 'p',
      sessionScope: 'p',
      globalScope: 'dsh-default',
      features: { ontology: true, recall: true, capture: true },
      memoryLayers,
      legacyScopeScanLimit: 100000,
      warnings: [],
    }))
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    const scope = host.querySelector(
      'select[aria-label="记忆范围"]',
    ) as HTMLSelectElement
    expect(scope.value).toBe('agentos-context:all-scopes')
    expect(
      [...scope.options].some(option =>
        option.textContent?.includes('全局记忆'),
      ),
    ).toBe(true)
    expect(host.textContent).toContain(
      '汇总显示旧 OpenContext 与所有工作区的新记忆',
    )
    const memoryButton = [...host.querySelectorAll('button')].find(item =>
      item.textContent?.includes('source-backed memory'),
    ) as HTMLButtonElement
    await act(async () =>{  memoryButton.click() })
    await act(async () => {
      button(host, '复制到全局').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'dsh-default',
        content: 'source-backed memory',
        layer: 'semantic',
        expiresAt: null,
        metadata: expect.objectContaining({
          promotedFromScope: 'p',
          promotedFromMemoryId: 'm1',
        }),
      }),
      expect.anything(),
    )
    expect(host.textContent).toContain('已复制到全局记忆')
  })
  it('filters by layer and sends layer placement on save and manual transition', async () => {
    const a = api()
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    const filter = host.querySelector(
      'select[aria-label="层级筛选"]',
    ) as HTMLSelectElement
    await act(async () => {
      setValue(filter, 'working')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.memories).toHaveBeenLastCalledWith(
      'p',
      expect.objectContaining({ layer: 'working' }),
      expect.anything(),
    )
    await act(async () =>{  button(host, '记住一条').click() })
    let dialog = document.querySelector('[role="dialog"]')!
    const textarea = dialog.querySelector('textarea')!
    await act(async () => {
      setValue(textarea, 'layered entry')
      setValue(
        dialog.querySelector('select[aria-label="记忆层级"]')!,
        'procedural',
      )
      setValue(dialog.querySelector('#context-memory-importance')!, '0.85')
    })
    await act(async () => {
      button(dialog, '确认').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({ layer: 'procedural', importance: 0.85 }),
      expect.anything(),
    )
    const memoryButton = [...host.querySelectorAll('button')].find(item =>
      item.textContent?.includes('source-backed memory'),
    ) as HTMLButtonElement
    await act(async () => {
      memoryButton.click()
      await Promise.resolve()
    })
    await act(async () => {
      button(host, '迁移层级').click()
      await Promise.resolve()
    })
    dialog = document.querySelector('[role="dialog"]')!
    await act(async () => {
      setValue(
        dialog.querySelector('select[aria-label="记忆层级"]')!,
        'episodic',
      )
      setValue(dialog.querySelector('#context-memory-importance')!, '0.6')
      setValue(dialog.querySelector('textarea')!, 'task retention')
      button(dialog, '确认').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.transitionMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'm1',
        layer: 'episodic',
        importance: 0.6,
        reason: 'task retention',
      }),
      expect.anything(),
    )
  })
  it('modal focuses inside and restores the opener on close', async () => {
    const host = await render(
      <ContextMemoryPane
        api={api()}
        sessionId={'session-1' as any}
        onClose={() => {}}
        onManage={() => {}}
      />,
    )
    const opener = [...host.querySelectorAll('button')].find(
      x => x.textContent === '记住一条',
    ) as HTMLButtonElement
    opener.focus()
    await act(async () => {
      opener.click()
      await new Promise<void>(resolve =>
        requestAnimationFrame(() =>{  resolve() }),
      )
    })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog.contains(document.activeElement)).toBe(true)
    const cancel = [...dialog.querySelectorAll('button')].find(
      x => x.textContent === '取消',
    ) as HTMLButtonElement
    await act(async () => {
      cancel.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(opener)
  })
  it('settings card uses the new name and opens the shared workbench in a modal', async () => {
    const context = api()
    const legacy = {
      describeCredential: vi.fn(async () => ({
        configured: false,
        writable: true,
      })),
      setCredential: vi.fn(),
      verifyKey: vi.fn(async () => ({ ok: false, code: 'KEY_MISSING' })),
      listModels: vi.fn(async () => ({
        keyConfigured: false,
        models: [],
        auto: null,
        configured: null,
      })),
    }
    const snapshot = {
      status: 'ready',
      value: {},
      base: {},
      user: {},
      revision: 1,
      writable: true,
      mode: 'host',
    }
    const scope = {
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      set: vi.fn(),
      unset: vi.fn(),
      mutate: vi.fn(async () => {}),
    }
    const host = await render(
      <ConfigCard
        api={legacy as any}
        contextApi={context}
        scope={scope as any}
      />,
    )
    expect(host.textContent).toContain('agentOS context')
    const open = [...host.querySelectorAll('button')].find(
      x => x.textContent === '打开记忆工作台',
    )!
    await act(async () => {
      open.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      document.querySelector('[aria-label="agentOS context 记忆工作台"]')
        ?.textContent,
    ).toContain('source-backed memory')
    expect(
      document.querySelector('[role=dialog]')?.getAttribute('aria-label'),
    ).toBe('完整记忆工作台')
  })
  it('review tab uses pending server relations and required reasons', async () => {
    const a = api()
    a.entities = vi.fn(async () => [
      { id: 'a', revision: 1, scopeId: 'p', name: 'Alpha', type: 'Project', aliases: [], recordedAt: 1 },
      { id: 'b', revision: 1, scopeId: 'p', name: 'Beta', type: 'Project', aliases: [], recordedAt: 1 },
    ])
    a.schema = vi.fn(async (): Promise<ContextSchema> => ({
      version: 1,
      memoryLayers: [],
      types: [{ id: 'Project', label: '项目' }],
      relations: [{ id: 'depends_on', label: '依赖', domain: ['Project'], range: ['Project'] }],
    }))
    a.reviews = vi.fn(async (): Promise<ContextRelation[]> => [
      {
        id: 'r1',
        revision: 1,
        scopeId: 'p',
        subjectId: 'a',
        predicate: 'depends_on',
        objectId: 'b',
        sourceId: 's1',
        quote: 'direct quote',
        status: 'pending',
        validFrom: null,
        validTo: null,
        recordedAt: 1,
      },
    ])
    a.reviewRelation = vi.fn(async (input): Promise<ContextRelation> => ({
      ...(await a.reviews(input.scopeId))[0]!,
      revision: input.expectedRevision + 1,
      status: input.decision === 'confirm' ? 'confirmed' : 'rejected',
    }))
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    const tab = [...host.querySelectorAll('button')].find(
      x => x.textContent === '待确认',
    )!
    await act(async () => {
      tab.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toContain('direct quote')
    expect(host.textContent).toContain('Alpha · 项目')
    expect(host.textContent).toContain('Beta · 项目')
    expect(host.textContent).toContain('依赖')
    const technical = host.querySelector('details') as HTMLDetailsElement
    expect(technical.open).toBe(false)
    expect(technical.querySelector('summary')?.textContent).toBe('技术信息')
    const textarea = host.querySelector('textarea')!
    await act(async () => {
      button(host, '原文一致').click()
    })
    expect(textarea.value).toBe('原文与关系方向一致。')
    const confirm = [...host.querySelectorAll('button')].find(
      x => x.textContent === '确认关系',
    )!
    await act(async () => {
      confirm.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.reviewRelation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'r1',
        expectedRevision: 1,
        decision: 'confirm',
        reason: '原文与关系方向一致。',
      }),
      expect.anything(),
    )
  })
  it('settings tab renders the server schema rather than demo controls', async () => {
    const a = api()
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    const tab = [...host.querySelectorAll('button')].find(
      x => x.textContent === '设置',
    )!
    await act(async () => {
      tab.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.schema).toHaveBeenCalled()
    expect(host.textContent).toContain('本体版本 1')
    expect(host.textContent).not.toContain('DEMO-042')
  })
  it('uses locked credential and gateway metadata returned by the Host', async () => {
    const legacy = {
      describeCredential: vi.fn(async () => ({ configured: true, writable: true })),
      setCredential: vi.fn(),
      verifyKey: vi.fn(),
      listModels: vi.fn(async () => ({
        keyConfigured: true,
        models: [],
        auto: null,
        configured: null,
        apiKeyEnv: 'CUSTOM_EMBEDDING_KEY',
        embeddingBaseUrl: 'https://gateway.example.test/v1',
      })),
    }
    const snapshot = {
      status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true, mode: 'host',
    }
    const host = await render(<ConfigCard
      api={legacy}
      contextApi={api()}
      scope={{
        subscribe: () => () => {}, getSnapshot: () => snapshot,
        set: vi.fn(), unset: vi.fn(), mutate: vi.fn(async () => {}),
      } as any}
    />)
    await vi.waitFor(() => {
      expect(legacy.describeCredential).toHaveBeenCalledWith('CUSTOM_EMBEDDING_KEY')
    })
    await act(async () => { button(host, '高级设置 ▾').click() })
    expect(host.textContent).toContain('CUSTOM_EMBEDDING_KEY')
    expect(host.textContent).toContain('https://gateway.example.test/v1')
  })
  it('no-key state keeps the automatic-memory opt-out enabled and defaults it on with local fallback', async () => {
    const snapshot = {
        status: 'ready',
        value: { workingMemoryHours: 168 },
        base: {},
        user: {},
        revision: 1,
        writable: true,
        mode: 'host',
      },
      scope = {
        subscribe: () => () => {},
        getSnapshot: () => snapshot,
        set: vi.fn(),
        unset: vi.fn(),
        mutate: vi.fn(async () => {}),
      }
    const legacy = {
      describeCredential: vi.fn(async () => ({
        configured: false,
        writable: true,
      })),
      setCredential: vi.fn(),
      verifyKey: vi.fn(),
      listModels: vi.fn(async () => ({
        keyConfigured: false,
        models: [],
        auto: null,
        configured: null,
      })),
    }
    const host = await render(
      <ConfigCard
        api={legacy}
        contextApi={api()}
        scope={scope as any}
      />,
    )
    const toggle = host.querySelector(
      '#oc-capture-prompts',
    ) as HTMLInputElement
    expect(toggle.disabled).toBe(false)
    expect(toggle.checked).toBe(true)
    expect(host.textContent).toContain('短期本地工作记忆')
    expect(host.textContent).toContain('168 小时有效')
    const advanced = [...host.querySelectorAll('button')].find(x =>
      x.textContent?.includes('高级设置'),
    )!
    await act(async () =>{  advanced.click() })
    expect(host.textContent).toContain('受主机锁定')
    expect(host.querySelector('#oc-key-ref')).toBeNull()
    expect(host.querySelector('#oc-base-url')).toBeNull()
  })
  it('settings changes are staged and saved with the snapshot revision', async () => {
    const context = api(),
      legacy = {
        describeCredential: vi.fn(async () => ({
          configured: true,
          writable: true,
        })),
        setCredential: vi.fn(),
        verifyKey: vi.fn(),
        listModels: vi.fn(async () => ({
          keyConfigured: true,
          models: [],
          auto: null,
          configured: null,
        })),
      }
    const snapshot = {
        status: 'ready',
        value: { ontologyEnabled: true },
        base: {},
        user: {},
        revision: 7,
        writable: true,
        mode: 'host',
      },
      scope = {
        subscribe: () => () => {},
        getSnapshot: () => snapshot,
        set: vi.fn(),
        unset: vi.fn(),
        mutate: vi.fn(async () => {}),
      }
    const host = await render(
      <ConfigCard
        api={legacy}
        contextApi={context}
        scope={scope as any}
      />,
    )
    const toggle = host.querySelector(
      '#oc-ontology-enabled',
    ) as HTMLInputElement
    await act(async () => {
      toggle.click()
    })

    expect(scope.mutate).not.toHaveBeenCalled()
    const save = [...host.querySelectorAll('button')].find(
      x => x.textContent === '保存设置',
    )!
    await act(async () => {
      save.click()
      await Promise.resolve()
    })
    expect(scope.mutate).toHaveBeenCalledWith(
      expect.arrayContaining([
        { op: 'set', path: ['ontologyEnabled'], value: false },
      ]),
      7,
    )
  })
  it('configures optional user agent and app memory identities without inventing defaults', async () => {
    const context = api(),
      legacy = {
        describeCredential: vi.fn(async () => ({
          configured: false,
          writable: true,
        })),
        setCredential: vi.fn(),
        verifyKey: vi.fn(),
        listModels: vi.fn(async () => ({
          keyConfigured: false,
          models: [],
          auto: null,
          configured: null,
        })),
      },
      snapshot = {
        status: 'ready',
        value: {},
        base: {},
        user: {},
        revision: 3,
        writable: true,
        mode: 'host',
      },
      scope = {
        subscribe: () => () => {},
        getSnapshot: () => snapshot,
        set: vi.fn(),
        unset: vi.fn(),
        mutate: vi.fn(async () => {}),
      }
    const host = await render(
      <ConfigCard
        api={legacy}
        contextApi={context}
        scope={scope as any}
      />,
    )
    await act(async () =>{  button(host, '高级设置 ▾').click() })
    const user = host.querySelector(
        '[aria-label="用户记忆标识"]',
      ) as HTMLInputElement,
      agent = host.querySelector(
        '[aria-label="Agent 记忆标识"]',
      ) as HTMLInputElement,
      app = host.querySelector(
        '[aria-label="应用记忆标识"]',
      ) as HTMLInputElement
    expect(user.value + agent.value + app.value).toBe('')
    await act(async () => {
      setValue(user, '022296')
      setValue(agent, 'coding')
      setValue(app, 'desktop')
    })
    await act(async () => {
      button(host, '保存设置').click()
      await Promise.resolve()
    })
    expect(scope.mutate).toHaveBeenCalledWith(
      expect.arrayContaining([
        { op: 'set', path: ['scopeUserId'], value: '022296' },
        { op: 'set', path: ['scopeAgentId'], value: 'coding' },
        { op: 'set', path: ['scopeAppId'], value: 'desktop' },
      ]),
      3,
    )
  })
  it('unavailable settings do not render actionable default controls', async () => {
    const snapshot = {
        status: 'unavailable',
        value: undefined,
        base: {},
        user: {},
        revision: undefined,
        writable: false,
        mode: 'memory',
      },
      scope = {
        subscribe: () => () => {},
        getSnapshot: () => snapshot,
        set: vi.fn(),
        unset: vi.fn(),
        mutate: vi.fn(),
      }
    const legacy = {
      describeCredential: vi.fn(async () => ({
        configured: false,
        writable: false,
      })),
      setCredential: vi.fn(),
      verifyKey: vi.fn(),
      listModels: vi.fn(async () => ({
        keyConfigured: false,
        models: [],
        auto: null,
        configured: null,
      })),
    }
    const host = await render(
      <ConfigCard
        api={legacy}
        contextApi={api()}
        scope={scope as any}
      />,
    )
    expect(host.textContent).toContain('当前设置文档不可用')
    expect(host.querySelector('#oc-ontology-enabled')).toBeNull()
  })
  it('updates the real session policy through the switch', async () => {
    const a = api()
    const host = await render(
      <ContextMemoryPane
        api={a}
        sessionId={'session-1' as any}
        onClose={() => {}}
        onManage={() => {}}
      />,
    )
    const toggle = host.querySelector('[role=switch]') as HTMLButtonElement
    await act(async () => {
      toggle.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.setUsagePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        scopeId: 'p',
        paused: true,
      }),
      expect.anything(),
    )
  })
  it('revises and retires a selected memory with optimistic revisions and reasons', async () => {
    const a = api()
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    const selectMemory = () =>
      [...host.querySelectorAll('button')].find(item =>
        item.textContent?.includes('source-backed memory'),
      ) as HTMLButtonElement
    await act(async () =>{  selectMemory().click() })
    await act(async () =>{  button(host, '修订').click() })
    let dialog = document.querySelector('[role="dialog"]')!
    const fields = [
      ...dialog.querySelectorAll('textarea'),
    ] as HTMLTextAreaElement[]
    await act(async () => {
      setValue(itemAt(fields, 0), 'revised memory')
      setValue(itemAt(fields, 1), 'facts changed')
    })
    await act(async () => {
      button(dialog, '确认').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.reviseMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'p',
        id: 'm1',
        expectedRevision: 1,
        content: 'revised memory',
        reason: 'facts changed',
      }),
      expect.anything(),
    )
    await act(async () =>{  selectMemory().click() })
    await act(async () =>{  button(host, '停止召回').click() })
    dialog = document.querySelector('[role="dialog"]')!
    await act(async () =>{
      setValue(dialog.querySelector('textarea')!, 'no longer current') },
    )
    await act(async () => {
      button(dialog, '确认').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.retireMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'm1',
        expectedRevision: 1,
        reason: 'no longer current',
      }),
      expect.anything(),
    )
  })
  it('creates typed entities with normalized aliases', async () => {
    const a = api()
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    await act(async () =>{  button(host, '对象').click() })
    await act(async () =>{  button(host, '创建对象').click() })
    const dialog = document.querySelector('[role="dialog"]')!
    const inputs = [...dialog.querySelectorAll('input')] as HTMLInputElement[]
    await act(async () => {
      setValue(itemAt(inputs, 0), '支付系统')
      setValue(itemAt(inputs, 1), 'Pay， payments, Pay')
    })
    expect(button(dialog, '确认').disabled).toBe(false)
    await act(async () => {
      button(dialog, '确认').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.createEntity).toHaveBeenCalledWith(
      {
        scopeId: 'p',
        name: '支付系统',
        type: 'Project',
        aliases: ['Pay', 'payments', 'Pay'],
      },
      expect.anything(),
    )
  })
  it('submits source-backed relations and merges two versioned entities', async () => {
    const a = api(),
      entities = [
        {
          id: 'e1',
          revision: 3,
          scopeId: 'p',
          name: 'Alpha',
          type: 'Project',
          aliases: [],
          recordedAt: 1,
        },
        {
          id: 'e2',
          revision: 4,
          scopeId: 'p',
          name: 'Beta',
          type: 'Project',
          aliases: [],
          recordedAt: 1,
        },
      ]
    a.entities = vi.fn(async () => entities)
    a.schema = vi.fn(async (): Promise<ContextSchema> => ({
      version: 1,
      memoryLayers: [],
      types: [{ id: 'Project', label: 'Project' }],
      relations: [
        {
          id: 'belongs_to',
          label: '属于',
          domain: ['Project'],
          range: ['Project'],
        },
      ],
    }))
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    await act(async () =>{  button(host, '对象').click() })
    await act(async () =>{  button(host, '建立关系').click() })
    let dialog = document.querySelector('[role="dialog"]')!
    let selects = [...dialog.querySelectorAll('select')] as HTMLSelectElement[]
    await act(async () => {
      setValue(itemAt(selects, 0), 'e1')
      setValue(itemAt(selects, 1), 'belongs_to')
      setValue(itemAt(selects, 2), 'e2')
      setValue(itemAt(selects, 3), 'm1')
      setValue(dialog.querySelector('textarea')!, 'source-backed memory')
    })
    await act(async () => {
      button(dialog, '确认').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.createRelation).toHaveBeenCalledWith(
      {
        scopeId: 'p',
        subjectId: 'e1',
        predicate: 'belongs_to',
        objectId: 'e2',
        sourceMemoryId: 'm1',
        quote: 'source-backed memory',
      },
      expect.anything(),
    )
    expect(host.textContent).toContain('关系已提交到“待确认”')
    await act(async () =>{  button(host, '对齐别名').click() })
    dialog = document.querySelector('[role="dialog"]')!
    selects = [...dialog.querySelectorAll('select')] as HTMLSelectElement[]
    await act(async () => {
      setValue(itemAt(selects, 0), 'e1')
      setValue(itemAt(selects, 1), 'e2')
      setValue(dialog.querySelector('textarea')!, 'same project')
    })
    await act(async () => {
      button(dialog, '确认').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.mergeEntities).toHaveBeenCalledWith(
      {
        scopeId: 'p',
        keepId: 'e1',
        mergeId: 'e2',
        keepRevision: 3,
        mergeRevision: 4,
        reason: 'same project',
      },
      expect.anything(),
    )
  })
  it('validates unsupported and oversized uploads and reports parser failures', async () => {
    const a = api()
    a.uploadDocument = vi.fn(async () => {
      throw new Error('文档无法解析')
    })
    const host = await render(<ContextKnowledge api={a} scopeId="p" />),
      input = host.querySelector('input[type="file"]') as HTMLInputElement
    const choose = async (file: File) => {
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [file],
      })
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 20))
      })
    }
    await choose(
      new File(['legacy'], 'legacy.doc', { type: 'application/msword' }),
    )
    expect(host.textContent).toContain('不支持该文件格式')
    expect(a.uploadDocument).not.toHaveBeenCalled()
    const tooLarge = new File(['x'], 'huge.txt', { type: 'text/plain' })
    Object.defineProperty(tooLarge, 'size', { value: 4 * 1024 * 1024 + 1 })
    await choose(tooLarge)
    expect(host.textContent).toContain('文本文件超过 4 MB')
    expect(a.uploadDocument).not.toHaveBeenCalled()
    await choose(
      new File([new Uint8Array([1, 2, 3])], 'broken.pdf', {
        type: 'application/pdf',
      }),
    )
    expect(host.textContent).toContain('文档无法解析')
    expect(a.uploadDocument).toHaveBeenCalledTimes(1)
  })
  it('cancels an in-flight file read when the knowledge scope changes', async () => {
    const a = api()
    let release!: (value: string) => void
    const text = new Promise<string>((resolve) => {
      release = resolve
    })
    const fake = {
      name: 'slow.txt',
      type: 'text/plain',
      size: 8,
      text: () => text,
    } as File
    const host = await render(<ContextKnowledge api={a} scopeId="p" />),
      input = host.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [fake],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      root?.render(<ContextKnowledge api={a} scopeId="q" />)
      await Promise.resolve()
    })
    await act(async () => {
      release('old scope payload')
      await text
      await Promise.resolve()
    })
    expect(a.uploadDocument).not.toHaveBeenCalled()
  })
  it('requires delete confirmation and supports cancellation', async () => {
    const a = api()
    const host = await render(<ContextKnowledge api={a} scopeId="p" />)
    await act(async () =>{  button(host, '删除').click() })
    let dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('guide.md')
    await act(async () =>{  button(dialog, '取消').click() })
    expect(a.deleteDocument).not.toHaveBeenCalled()
    await act(async () =>{  button(host, '删除').click() })
    dialog = document.querySelector('[role="dialog"]')!
    await act(async () => {
      button(dialog, '确认删除').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.deleteDocument).toHaveBeenCalledWith('p', 'd1', expect.anything())
    expect(host.textContent).toContain('已删除 guide.md')
  })
  it('allows rejecting an unsourced relation but never confirming it', async () => {
    const a = api()
    a.reviews = vi.fn(async (): Promise<ContextRelation[]> => [
      {
        id: 'r1',
        revision: 2,
        scopeId: 'p',
        subjectId: 'a',
        predicate: 'depends_on',
        objectId: 'b',
        sourceId: null,
        quote: null,
        status: 'pending',
        validFrom: null,
        validTo: null,
        recordedAt: 1,
      },
    ])
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    await act(async () => {
      button(host, '待确认').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const reason = host.querySelector('textarea')!
    await act(async () =>{  setValue(reason, 'no source evidence') })
    expect(button(host, '确认关系').disabled).toBe(true)
    expect(button(host, '驳回').disabled).toBe(false)
    await act(async () => {
      button(host, '驳回').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.reviewRelation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'r1',
        expectedRevision: 2,
        decision: 'reject',
        reason: 'no source evidence',
      }),
      expect.anything(),
    )
  })
  it('filters the graph by root, pending state and time and exposes details in a right-side graph drawer', async () => {
    const a = api()
    a.graph = vi.fn(async () => ({
      nodes: [
        {
          id: 'e1',
          type: 'entity',
          subtype: 'Project',
          label: 'Alpha',
          scopeId: 'p',
          timestamp: 1,
        },
        {
          id: 'e2',
          type: 'entity',
          subtype: 'Project',
          label: 'Beta',
          scopeId: 'p',
        },
      ],
      edges: [
        {
          id: 'r1',
          source: 'e1',
          target: 'e2',
          type: 'depends_on',
          status: 'confirmed',
          quote: 'evidence',
        },
      ],
      stats: { nodeCount: 2, edgeCount: 1, truncated: false },
    }))
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />),
      scope = host.querySelector<HTMLSelectElement>('select[aria-label="记忆范围"]')!
    await act(async () => {
      setValue(scope, 'p')
      button(host, '图谱').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const advanced = host.querySelector('details') as HTMLDetailsElement
    expect(advanced.open).toBe(false)
    expect(advanced.querySelector('summary')?.textContent).toBe('范围与时间')
    const center = host.querySelector(
        'input[aria-label="图谱中心对象"]',
      ) as HTMLInputElement,
      depth = host.querySelector(
        'select[aria-label="展开层数"]',
      ) as HTMLSelectElement,
      pending = host.querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement,
      dates = [
        ...host.querySelectorAll('input[type="datetime-local"]'),
      ] as HTMLInputElement[]
    await act(async () => {
      setValue(center, 'e1')
      setValue(depth, '3')
      pending.click()
      setValue(itemAt(dates, 0), '2026-09-22T10:00')
      setValue(itemAt(dates, 1), '2026-09-21T09:00')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.graph).toHaveBeenLastCalledWith(
      'p',
      expect.objectContaining({
        rootId: 'e1',
        depth: 3,
        includePending: true,
        knownAt: expect.any(Number),
        validAt: expect.any(Number),
      }),
      expect.anything(),
    )
    const node = host.querySelector('#context-graph-node') as HTMLSelectElement,
      edge = host.querySelector('#context-graph-edge') as HTMLSelectElement
    await act(async () =>{  setValue(node, 'e1') })
    let drawer = host.querySelector('[aria-label="图谱详情"]')!
    expect(drawer.textContent).toContain('Alpha')
    expect(
      host
        .querySelector('[data-context-graph-mode] svg')
        ?.parentElement?.contains(drawer),
    ).toBe(true)
    await act(async () =>{  setValue(edge, 'r1') })
    drawer = host.querySelector('[aria-label="图谱详情"]')!
    expect(drawer.textContent).toContain('evidence')
    expect(drawer.textContent).toContain('Alpha')
    expect(drawer.textContent).toContain('Beta')
    const close = drawer.querySelector(
      'button[aria-label="关闭图谱详情"]',
    ) as HTMLButtonElement
    expect(close).toBeTruthy()
    await act(async () =>{  close.click() })
    expect(host.querySelector('[aria-label="图谱详情"]')).toBeNull()
  })
  it('defaults to the 3D point cloud, remembers choices and falls back cleanly when WebGL is unavailable', async () => {
    window.localStorage.removeItem('agentos-context.graph-dimension-v2')
    const storage = vi.spyOn(window.localStorage, 'setItem'),
      consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}),
      a = api()
    a.graph = vi.fn(async () => ({
      nodes: [{ id: 'e1', type: 'entity', subtype: 'Project', label: 'Alpha', scopeId: 'p', timestamp: 1 }],
      edges: [],
      stats: { nodeCount: 1, edgeCount: 0, truncated: false },
    }))
    try {
      const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
      await act(async () => {
        button(host, '图谱').click()
        await Promise.resolve()
        await Promise.resolve()
      })
      await act(async () => {
        button(host, '3D 点云').click()
        await new Promise(resolve => setTimeout(resolve, 30))
      })
      expect(storage).toHaveBeenCalledWith('agentos-context.graph-dimension-v2', '3d')
      expect(storage).toHaveBeenCalledWith('agentos-context.graph-dimension-v2', '2d')
      expect(host.querySelector('[data-context-graph-dimension]')?.getAttribute('data-context-graph-dimension')).toBe('2d')
      expect(host.textContent).toContain('三维图谱暂不可用，已自动切换为 2D')
    } finally {
      storage.mockRestore()
      consoleError.mockRestore()
      window.localStorage.removeItem('agentos-context.graph-dimension-v2')
    }
  })
  it('loads and renders a complete thousand-node graph and locates search results', async () => {
    window.localStorage.setItem('agentos-context.graph-dimension-v2', '2d')
    const a = api()
    a.graph = vi.fn(async (): Promise<ContextGraph> => ({
      nodes: Array.from({ length: 1000 }, (_, index) => ({
        id: `memory-${index}`,
        type: 'memory',
        layer: 'semantic',
        label: `Memory ${index}`,
        scopeId: 'p',
        timestamp: index,
      })),
      edges: [],
      stats: {
        nodeCount: 1000,
        edgeCount: 0,
        totalNodeCount: 1000,
        truncated: false,
      },
    }))
    try {
      const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
      await act(async () => {
        button(host, '图谱').click()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(a.graph).toHaveBeenCalledWith(
        'p',
        expect.objectContaining({ limit: 1500 }),
        expect.anything(),
      )
      expect(host.textContent).toContain('已加载 1000 个节点')
      // 0.8.0 caps the rendered node count to keep large graphs responsive
      // (the full graph is still loaded and searchable).
      expect(host.querySelectorAll('g[role="button"]').length).toBeLessThanOrEqual(240)
      expect(host.querySelectorAll('g[role="button"] > circle').length).toBeGreaterThanOrEqual(240)
      // one glyph per rendered node plus the collision-placed compact labels
      expect(host.querySelectorAll('g[role="button"] > text').length).toBeLessThanOrEqual(260)
      const search = host.querySelector(
        'input[aria-label="筛选图谱节点"]',
      ) as HTMLInputElement
      await act(async () => {
        setValue(search, 'Memory 999')
        await Promise.resolve()
      })
      expect(host.textContent).toContain('1 个匹配')
      await act(async () => {
        search.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        )
        await Promise.resolve()
      })
      expect(host.querySelector('[aria-label="图谱详情"]')?.textContent).toContain(
        'Memory 999',
      )
      await act(async () =>{  button(host, '全屏探索').click() })
      expect(host.textContent).toContain('退出全屏')
      await act(async () =>{  button(host, '退出全屏').click() })
      expect(host.textContent).toContain('全屏探索')
      expect(host.textContent).not.toContain('退出全屏')
    } finally {
      window.localStorage.removeItem('agentos-context.graph-dimension-v2')
    }
  })
  it('clears graph fullscreen after a native fullscreen exit without a DOM fullscreen event', async () => {
    const documentRoot = document.documentElement
    const originalFullscreen = documentRoot.getAttribute('data-fullscreen')
    window.localStorage.setItem('agentos-context.graph-dimension-v2', '2d')
    try {
      documentRoot.removeAttribute('data-fullscreen')
      const host = await render(<ContextWorkbench api={api()} onClose={() => {}} />)
      await act(async () => { button(host, '图谱').click() })
      await act(async () => { button(host, '全屏探索').click() })
      expect(host.textContent).toContain('退出全屏')
      await act(async () => {
        documentRoot.dataset.fullscreen = 'true'
        await new Promise(complete => setTimeout(complete, 0))
      })
      expect(host.textContent).toContain('退出全屏')
      await act(async () => {
        documentRoot.removeAttribute('data-fullscreen')
        await new Promise(complete => setTimeout(complete, 0))
      })
      expect(host.textContent).toContain('全屏探索')
      expect(host.textContent).not.toContain('退出全屏')
    } finally {
      await act(async () => {
        if (originalFullscreen === null) documentRoot.removeAttribute('data-fullscreen')
        else documentRoot.setAttribute('data-fullscreen', originalFullscreen)
        await new Promise(complete => setTimeout(complete, 0))
      })
      window.localStorage.removeItem('agentos-context.graph-dimension-v2')
    }
  })
  it('does not activate graph fullscreen for another fullscreen element', async () => {
    const originalElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
    try {
      const host = await render(<ContextWorkbench api={api()} onClose={() => {}} />)
      await act(async () => { button(host, '图谱').click() })
      await act(async () => {
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.body })
        document.dispatchEvent(new Event('fullscreenchange'))
      })
      expect(host.textContent).toContain('全屏探索')
      expect(host.textContent).not.toContain('退出全屏')
    } finally {
      if (originalElement) Object.defineProperty(document, 'fullscreenElement', originalElement)
      else Reflect.deleteProperty(document, 'fullscreenElement')
    }
  })
  it('disconnects the graph fullscreen observer and DOM listener on unmount', async () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const removeListener = vi.spyOn(document, 'removeEventListener')
    try {
      const host = await render(<ContextWorkbench api={api()} onClose={() => {}} />)
      await act(async () => { button(host, '图谱').click() })
      const graphCall = observe.mock.calls.findIndex(([target, options]) =>
        target === document.documentElement && options?.attributeFilter?.includes('data-fullscreen'),
      )
      expect(graphCall).toBeGreaterThanOrEqual(0)
      const observer = observe.mock.contexts[graphCall]
      await act(async () => { root?.unmount() })
      root = null
      expect(disconnect.mock.contexts).toContain(observer)
      expect(removeListener).toHaveBeenCalledWith('fullscreenchange', expect.any(Function))
    } finally {
      observe.mockRestore()
      disconnect.mockRestore()
      removeListener.mockRestore()
    }
  })
  it('keeps CSS fullscreen usable without a native fullscreen transition', async () => {
    const documentRoot = document.documentElement
    const originalFullscreen = documentRoot.getAttribute('data-fullscreen')
    window.localStorage.setItem('agentos-context.graph-dimension-v2', '2d')
    try {
      documentRoot.removeAttribute('data-fullscreen')
      const host = await render(<ContextWorkbench api={api()} onClose={() => {}} />)
      await act(async () => { button(host, '图谱').click() })
      await act(async () => { button(host, '全屏探索').click() })
      await act(async () => { await new Promise(complete => setTimeout(complete, 0)) })
      expect(host.textContent).toContain('退出全屏')
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(host.textContent).toContain('全屏探索')
      expect(host.textContent).not.toContain('退出全屏')
    } finally {
      await act(async () => {
        if (originalFullscreen === null) documentRoot.removeAttribute('data-fullscreen')
        else documentRoot.setAttribute('data-fullscreen', originalFullscreen)
        await new Promise(complete => setTimeout(complete, 0))
      })
      window.localStorage.removeItem('agentos-context.graph-dimension-v2')
    }
  })
  it('highlights a selected neighborhood and exposes a Shift-click shortest path', async () => {
    window.localStorage.setItem('agentos-context.graph-dimension-v2', '2d')
    const a = api()
    a.graph = vi.fn(async () => ({
      nodes: ['a', 'b', 'c'].map(id => ({
        id,
        type: 'entity',
        subtype: 'Project',
        label: id.toUpperCase(),
        scopeId: 'p',
      })),
      edges: [
        { id: 'ab', source: 'a', target: 'b', type: 'depends_on' },
        { id: 'bc', source: 'b', target: 'c', type: 'depends_on' },
      ],
      stats: { nodeCount: 3, edgeCount: 2, truncated: false },
    }))
    try {
      const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
      await act(async () => {
        button(host, '图谱').click()
        await Promise.resolve()
        await Promise.resolve()
      })
      const nodes = [...host.querySelectorAll<SVGGElement>('g[role="button"]')]
      const first = nodes.find(node => node.getAttribute('aria-label')?.endsWith('，A'))!
      const last = nodes.find(node => node.getAttribute('aria-label')?.endsWith('，C'))!
      await act(async () => {
        first.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        last.dispatchEvent(
          new MouseEvent('click', { bubbles: true, shiftKey: true }),
        )
      })
      expect(host.textContent).toContain('已显示最短路径：3 个节点、2 条关系')
    } finally {
      window.localStorage.removeItem('agentos-context.graph-dimension-v2')
    }
  })
  it('uses compact point nodes at the exact 30-node graph boundary', async () => {
    window.localStorage.setItem('agentos-context.graph-dimension-v2', '2d')
    const a = api()
    a.graph = vi.fn(async () => ({
      nodes: Array.from({ length: 30 }, (_, index) => ({
        id: `node-${index}`,
        type: 'entity',
        subtype: 'Project',
        label: `Node ${index}`,
        scopeId: 'p',
      })),
      edges: [],
      stats: { nodeCount: 30, edgeCount: 0, truncated: false },
    }))
    try {
      const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
      await act(async () => {
        button(host, '图谱').click()
        await Promise.resolve()
        await Promise.resolve()
      })
      const nodes = [...host.querySelectorAll<SVGGElement>('g[role="button"]')]
      expect(nodes).toHaveLength(30)
      expect(nodes.every(node => node.querySelector('circle') !== null)).toBe(true)
      expect(nodes.every(node => node.querySelector('rect') === null)).toBe(true)
      // Compact mode renders one glyph per node; readable labels are the
      // subset the collision-aware placement can fit (≤20).
      expect(nodes.filter(node => node.querySelector('text') !== null)).toHaveLength(30)
      const placedLabels = nodes
        .map(node => node.querySelector('text')?.textContent ?? '')
        .filter(label => label.trim().length > 3)
      expect(placedLabels.length).toBeLessThanOrEqual(20)
    } finally {
      window.localStorage.removeItem('agentos-context.graph-dimension-v2')
    }
  })
  it('builds stable clustered positions from real graph records', () => {
    const base = {
      nodes: [
        { id: 'memory-a', type: 'memory', label: 'A', scopeId: 'p', communityId: 'delivery' },
        { id: 'memory-b', type: 'memory', label: 'B', scopeId: 'p', communityId: 'delivery' },
        { id: 'entity-a', type: 'entity', label: 'Project', scopeId: 'p', communityId: 'delivery' },
      ],
      edges: [{ id: 'edge-a', source: 'memory-a', target: 'entity-a', type: 'about', status: 'confirmed' }],
    } as any
    const first = pointCloudPositions(base)
    const second = pointCloudPositions({
      ...base,
      nodes: [...base.nodes, { id: 'memory-c', type: 'memory', label: 'C', scopeId: 'p', communityId: 'delivery' }],
    })
    expect(first.positions.get('memory-a')).toEqual(second.positions.get('memory-a'))
    expect(first.positions.get('memory-a')).not.toEqual(first.positions.get('memory-b'))
    expect(first.degree.get('memory-a')).toBe(1)
    expect(first.degree.get('memory-b')).toBe(0)
  })
  it('keeps small aggregate 3D graphs labelled and visually balanced', () => {
    const community = {
      id: 'community:scope:p',
      type: 'community',
      label: '默认工作区',
      scopeId: 'p',
      community: { size: 272 },
    } as any
    expect(pointCloudPermanentLabel(community, 3)).toBe('默认工作区 · 272 项')
    expect(
      pointCloudPermanentLabel(
        { ...community, label: '工作区 · very-long-workspace-name' },
        3,
      ),
    ).toMatch(/^工作区 · .+… · 272 项$/u)
    expect(pointCloudNodeRadius(community, 3)).toBeLessThan(
      pointCloudNodeRadius(community, 12),
    )
    expect(pointCloudPermanentLabel(community, 9)).toBeNull()
    expect(
      pointCloudPermanentLabel(
        { id: 'm', type: 'memory', label: '记忆', scopeId: 'p' } as any,
        3,
      ),
    ).toBeNull()
  })
  it('Escape closes only the graph drawer and keeps the outer workbench open', async () => {
    const a = api(),
      close = vi.fn()
    a.graph = vi.fn(async () => ({
      nodes: [
        {
          id: 'e1',
          type: 'entity',
          subtype: 'Project',
          label: 'Alpha',
          scopeId: 'p',
          timestamp: 1,
        },
      ],
      edges: [],
      stats: { nodeCount: 1, edgeCount: 0, truncated: false },
    }))
    await render(
      <ContextModal open onClose={close} title="完整记忆工作台" closeLabel="关闭">
        <ContextWorkbench api={a} onClose={close} />
      </ContextModal>,
    )
    const surface = document
    await act(async () => {
      button(surface, '图谱').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const node = surface.querySelector('#context-graph-node') as HTMLSelectElement
    await act(async () =>{  setValue(node, 'e1') })
    expect(surface.querySelector('[aria-label="图谱详情"]')).not.toBeNull()
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    )
    expect(surface.querySelector('[aria-label="图谱详情"]')).toBeNull()
    expect(close).not.toHaveBeenCalled()
    expect(surface.body.textContent).toContain('完整记忆工作台')
  })
  it('large graphs open in node view and switch to collapsed communities, expand detail and back', async () => {
    const a = api(),
      nodes = Array.from({ length: 12 }, (_, i) => ({
        id: 'n' + i,
        type: 'entity',
        subtype: 'Project',
        label: 'Node ' + i,
        scopeId: 'p',
      })),
      communities = [
        {
          id: 'community:a',
          label: 'Alpha group',
          summary: 'Alpha summary',
          nodeIds: nodes.slice(0, 6).map(x => x.id),
          size: 6,
          edgeCount: 5,
          externalEdgeCount: 1,
          topNodeIds: ['n0', 'n1'],
          typeCounts: { entity: 6 },
          scopeId: 'p',
        },
        {
          id: 'community:b',
          label: 'Beta group',
          summary: 'Beta summary',
          nodeIds: nodes.slice(6).map(x => x.id),
          size: 6,
          edgeCount: 5,
          externalEdgeCount: 1,
          topNodeIds: ['n6', 'n7'],
          typeCounts: { entity: 6 },
          scopeId: 'p',
        },
      ]
    a.graph = vi.fn(async () => ({
      nodes: nodes.map((node, i) => ({
        ...node,
        communityId: i < 6 ? 'community:a' : 'community:b',
      })),
      edges: [{ id: 'cross', source: 'n0', target: 'n6', type: 'depends_on' }],
      communities,
      communityEdges: [
        {
          id: 'ce',
          source: 'community:a',
          target: 'community:b',
          count: 1,
          types: ['depends_on'],
        },
      ],
      stats: {
        nodeCount: 12,
        edgeCount: 1,
        truncated: false,
        communityCount: 2,
      },
    }))
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    await act(async () => {
      button(host, '图谱').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const surface = host.querySelector('[data-context-graph-view]')!
    // 0.8.0 opens the node view by default; compact communities stay one click away.
    expect(surface.getAttribute('data-context-graph-view')).toBe('nodes')
    await act(async () => { button(host, '社区视图').click() })
    expect(surface.getAttribute('data-context-graph-view')).toBe('communities')
    expect(host.textContent).toContain('2 个社区')
    const community = [...host.querySelectorAll('g[role="button"]')].find(
      node => node.getAttribute('aria-label')?.startsWith('社区'),
    ) as SVGGElement
    // 0.8.0: selecting a community drills into its scope in the node view.
    await act(async () =>
      community.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    expect(surface.getAttribute('data-context-graph-view')).toBe('nodes')
    expect(surface.getAttribute('data-context-graph-view')).toBe('nodes')
  })
  it('offers the community view for the aggregate scope and drills into a scope community', async () => {
    const a = api(),
      nodes = Array.from({ length: 12 }, (_, index) => ({
        id: `n-${index}`,
        type: 'entity',
        subtype: 'Project',
        label: `Node ${index}`,
        scopeId: 'p',
        communityId: `community:${Math.floor(index / 3)}`,
      })),
      communities = Array.from({ length: 4 }, (_, index) => ({
        id: `community:${index}`,
        label: `Group ${index}`,
        summary: `Summary ${index}`,
        size: 3,
        nodeIds: nodes.slice(index * 3, index * 3 + 3).map(node => node.id),
        edgeCount: 0,
        externalEdgeCount: 0,
        topNodeIds: [`n-${index * 3}`],
        typeCounts: { entity: 3 },
        scopeId: 'p',
      }))
    a.bootstrap = vi.fn(async () => ({
      displayName: 'agentOS context',
      scopes: [{ id: 'p', label: 'P', count: 1 }, { id: 'q', label: 'Q', count: 1 }],
      defaultScope: 'p',
      sessionScope: 'p',
      features: { ontology: true, recall: true, capture: true },
      memoryLayers,
      legacyScopeScanLimit: 100000,
      warnings: [],
    }))
    a.graph = vi.fn(async (scopeId: string) => ({
      nodes: nodes.map(node => ({ ...node, scopeId })),
      edges: [],
      communities: communities.map(community => ({ ...community, scopeId })),
      communityEdges: [],
      stats: { nodeCount: 12, edgeCount: 0, truncated: false, communityCount: 4 },
    }))
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />),
      scope = host.querySelector<HTMLSelectElement>('select[aria-label="记忆范围"]')!
    await act(async () => {
      setValue(scope, 'p')
      button(host, '图谱').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.querySelector('[data-context-graph-view]')?.getAttribute('data-context-graph-view')).toBe('nodes')
    await act(async () => {
      setValue(scope, ALL_SCOPES_ID)
      await Promise.resolve()
      await Promise.resolve()
    })
    const surface = host.querySelector('[data-context-graph-view]')!
    // 0.8.0 no longer auto-prefers communities for the aggregate scope.
    expect(surface.getAttribute('data-context-graph-view')).toBe('nodes')
    await act(async () => { button(host, '社区视图').click() })
    expect(surface.getAttribute('data-context-graph-view')).toBe('communities')
    const scopeCommunity = [...host.querySelectorAll('g[role="button"]')].find(
      node => node.getAttribute('aria-label')?.startsWith('社区'),
    ) as SVGGElement
    // 0.8.0: selecting a scope community drills straight into that scope's nodes.
    await act(async () =>
      scopeCommunity.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    expect(surface.getAttribute('data-context-graph-view')).toBe('nodes')
  })
  it('keeps node view as the automatic default when communities do not compress the graph enough', async () => {
    const a = api(),
      nodes = Array.from({ length: 12 }, (_, i) => ({
        id: 'n' + i,
        type: 'entity',
        subtype: 'Project',
        label: 'Node ' + i,
        scopeId: 'p',
        communityId: 'community:' + Math.floor(i / 3),
      })),
      communities = Array.from({ length: 4 }, (_, i) => ({
        id: 'community:' + i,
        label: 'Group ' + i,
        summary: 'Summary ' + i,
        nodeIds: nodes.slice(i * 3, i * 3 + 3).map(node => node.id),
        size: 3,
        edgeCount: 2,
        externalEdgeCount: 1,
        topNodeIds: ['n' + i * 3],
        typeCounts: { entity: 3 },
        scopeId: 'p',
      }))
    a.graph = vi.fn(async () => ({
      nodes,
      edges: [],
      communities,
      communityEdges: [],
      stats: {
        nodeCount: 12,
        edgeCount: 0,
        truncated: false,
        communityCount: 4,
      },
    }))
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />),
      scope = host.querySelector<HTMLSelectElement>('select[aria-label="记忆范围"]')!
    await act(async () => {
      setValue(scope, 'p')
      button(host, '图谱').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const surface = host.querySelector('[data-context-graph-view]')!
    expect(surface.getAttribute('data-context-graph-view')).toBe('nodes')
    await act(async () =>{  button(host, '社区视图').click() })
    expect(surface.getAttribute('data-context-graph-view')).toBe('communities')
  })
  it('strips evidence framing tags from visible graph labels without changing graph identity', async () => {
    const a = api()
    a.graph = vi.fn(async (): Promise<ContextGraph> => ({
      nodes: [
        {
          id: 'e1',
          type: 'memory',
          layer: 'semantic',
          label: '<path>D:\\projects\\alpha</path>',
          scopeId: 'p',
          timestamp: 1,
        },
      ],
      edges: [],
      stats: { nodeCount: 1, edgeCount: 0, truncated: false },
    }))
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    await act(async () => {
      button(host, '图谱').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    const node = host.querySelector('#context-graph-node') as HTMLSelectElement
    await act(async () =>{  setValue(node, 'e1') })
    expect(host.textContent).toContain('D:\\projects\\alpha')
    expect(host.textContent).not.toContain('<path>')
    expect(node.value).toBe('e1')
  })
  it('validates ontology relation direction and displays server feedback', async () => {
    const a = api(),
      entities = [
        {
          id: 'e1',
          revision: 1,
          scopeId: 'p',
          name: 'Alpha',
          type: 'Project',
          aliases: [],
          recordedAt: 1,
        },
        {
          id: 'e2',
          revision: 1,
          scopeId: 'p',
          name: 'Beta',
          type: 'Project',
          aliases: [],
          recordedAt: 1,
        },
      ]
    a.entities = vi.fn(async () => entities)
    a.schema = vi.fn(async (): Promise<ContextSchema> => ({
      version: 2,
      memoryLayers: [],
      types: [{ id: 'Project', label: '项目' }],
      relations: [
        {
          id: 'depends_on',
          label: '依赖',
          domain: ['Project'],
          range: ['Project'],
        },
      ],
    }))
    a.checkRelation = vi.fn(async () => ({
      ok: false,
      errors: [
        {
          field: 'predicate',
          code: 'INVALID_RELATION_DIRECTION',
          message: '关系方向不符合定义',
        },
      ],
    }))
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    await act(async () => {
      button(host, '设置').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      button(host, '校验').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(a.checkRelation).toHaveBeenCalledWith(
      {
        scopeId: 'p',
        subjectId: 'e1',
        predicate: 'depends_on',
        objectId: 'e2',
      },
      expect.anything(),
    )
    expect(host.textContent).toContain('关系方向不符合定义')
  })
  it('supports arrow, Home and End keyboard navigation across tabs', async () => {
    const host = await render(
        <ContextWorkbench api={api()} onClose={() => {}} />,
      ),
      tabs = [...host.querySelectorAll('[role="tab"]')] as HTMLButtonElement[],
      firstTab = itemAt(tabs, 0),
      lastTab = itemAt(tabs, 4)
    firstTab.focus()
    await act(async () => {
      firstTab.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      )
      await new Promise<void>(resolve =>
        requestAnimationFrame(() =>{  resolve() }),
      )
    })
    expect(lastTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(lastTab)
    await act(async () => {
      lastTab.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      )
      await new Promise<void>(resolve =>
        requestAnimationFrame(() =>{  resolve() }),
      )
    })
    expect(firstTab.getAttribute('aria-selected')).toBe('true')
  })
  it('shows bootstrap failure and recovers through the visible retry action', async () => {
    const a = api()
    a.bootstrap = vi
      .fn()
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValueOnce({
        displayName: 'agentOS context',
        scopes: [{ id: 'p', label: 'Project', count: 1 }],
        defaultScope: 'p',
        sessionScope: 'p',
        features: { ontology: true, recall: true, capture: true },
        legacyScopeScanLimit: 100,
        warnings: [],
      })
    const host = await render(<ContextWorkbench api={a} onClose={() => {}} />)
    expect(host.textContent).toContain('host unavailable')
    await act(async () => {
      button(host, '重试').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toContain('source-backed memory')
    expect(a.bootstrap).toHaveBeenCalledTimes(2)
  })
  it('traps Tab focus inside the modal and restores the opener', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'open'
    document.body.append(opener)
    opener.focus()
    const close = vi.fn()
    const host = await render(
      <ContextModal
        open
        onClose={close}
        title="Focus test"
        closeLabel="关闭"
        footer={<button>last</button>}
      >
        <input aria-label="first" />
      </ContextModal>,
    )
    await act(
      async () =>
        new Promise<void>(resolve => requestAnimationFrame(() =>{  resolve() })),
    )
    const dialog = document.querySelector('[role="dialog"]')!,
      focusable = [...dialog.querySelectorAll<HTMLElement>('input,button')]
    for (const element of focusable)
      Object.defineProperty(element, 'offsetParent', {
        configurable: true,
        value: host,
      })
    const first = itemAt(focusable, 0),
      last = itemAt(focusable, focusable.length - 1)
    last.focus()
    last.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    )
    expect(document.activeElement).toBe(first)
    first.focus()
    first.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
      }),
    )
    expect(document.activeElement).toBe(last)
  })
})

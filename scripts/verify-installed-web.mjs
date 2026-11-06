import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'

const [electron, desktopCli, dshHome, profile = 'agentos-clean', outputDir = 'artifacts/validation', seedOpenContextHomeArg, launchMode = 'web'] = process.argv.slice(2)
const seedOpenContextHome = seedOpenContextHomeArg && seedOpenContextHomeArg !== '-' ? seedOpenContextHomeArg : undefined
if (!electron || !desktopCli || !dshHome) {
  throw new Error('Usage: node scripts/verify-installed-web.mjs <electron> <desktop-cli> <dsh-home> [profile] [output-dir] [seed-opencontext-home] [web|desktop]')
}
assert.ok(launchMode === 'web' || launchMode === 'desktop', `unsupported launch mode: ${launchMode}`)

const webPort = 0
const debugPort = await new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      reject(new Error('failed to reserve a DevTools port'))
      return
    }
    const port = address.port
    server.close(error => error ? reject(error) : resolve(port))
  })
})
const resolvedDshHome = path.resolve(dshHome)
const destination = path.resolve(outputDir)
await mkdir(destination, { recursive: true })
const chromeData = await mkdtemp(path.join(os.tmpdir(), 'agentos-context-chrome-'))
const openContextHome = await mkdtemp(path.join(os.tmpdir(), 'agentos-context-data-'))
if (seedOpenContextHome) {
  await cp(path.resolve(seedOpenContextHome), openContextHome, { recursive: true, force: true })
}
const contextDbPath = path.join(openContextHome, 'agentos-context', 'context.db')
await mkdir(path.dirname(contextDbPath), { recursive: true })
const { createContextStore } = await import('../src/context/store.js')
const seedStore = createContextStore({ dbPath: contextDbPath })
try {
  console.error(`[agentos-context-e2e] launch mode=${launchMode} debugPort=${debugPort}`)
  const scopeId = 'local:default'
  const groups = ['产品交付', '质量保障']
  for (const group of groups) {
    const entities = []
    for (let index = 0; index < 4; index++) {
      entities.push(seedStore.createEntity({ scopeId, name: `${group}对象${index + 1}`, type: 'Project', aliases: [] }))
    }
    for (let index = 0; index < 5; index++) {
      seedStore.saveMemory({
        scopeId,
        content: `${group}社区验证记忆 ${index + 1}`,
        kind: 'fact',
        entityIds: [entities[index % entities.length].id, entities[(index + 1) % entities.length].id],
        source: { content: `${group}社区验证记忆 ${index + 1}`, kind: 'validation', actorRole: 'human', complete: true },
      })
    }
  }
  for (let index = 0; index < 260; index++) {
    seedStore.saveMemory({
      scopeId: 'local:scale-validation',
      content: `大规模图谱验证记忆 ${String(index + 1).padStart(3, '0')}`,
      kind: 'fact',
      source: {
        content: `大规模图谱验证记忆 ${String(index + 1).padStart(3, '0')}`,
        kind: 'validation',
        actorRole: 'human',
        complete: true,
      },
    })
  }
} finally {
  seedStore.close()
}
let web
let chrome
let webStdout = ''
let webStderr = ''
let announcedUrl

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(200)
  }
  throw new Error(`${label} did not become ready`, { cause: lastError })
}

async function stop(child) {
  if (!child || child.exitCode !== null) return
  child.kill()
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(5_000),
  ])
}

try {
  const childEnvironment = {
    ...process.env,
    DSH_HOME: resolvedDshHome,
    OPENCONTEXT_HOME: openContextHome,
    AGENTOS_CONTEXT_DB_PATH: path.join(openContextHome, 'agentos-context', 'context.db'),
  }
  for (const key of Object.keys(childEnvironment)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete childEnvironment[key]
  }
  if (launchMode === 'web') childEnvironment.ELECTRON_RUN_AS_NODE = '1'
  const electronFlags = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeData}`,
    '--enable-webgl',
    '--ignore-gpu-blocklist',
  ]
  const developmentElectron = path.basename(electron).toLowerCase() === 'electron.exe'
  web = spawn(
    electron,
    launchMode === 'desktop'
      ? developmentElectron
        ? [...electronFlags, desktopCli, '--profile', profile]
        : ['--profile', profile, ...electronFlags]
      : [desktopCli, '--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', String(webPort)],
    {
      env: childEnvironment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  web.stdout.on('data', chunk => {
    webStdout += chunk
    const match = webStdout.match(/dsh web:\s+(https?:\/\/\S+)/)
    if (match) announcedUrl = match[1]
  })
  web.stderr.on('data', chunk => { webStderr += chunk })
  let chromeStderr = ''
  let pageUrl
  let cleanUrl
  let rootStatus = 200
  let html = ''
  let target
  if (launchMode === 'web') {
    pageUrl = await waitFor(() => {
      if (web.exitCode !== null) throw new Error(`web host exited ${web.exitCode}: ${webStderr}`)
      return announcedUrl
    }, 90_000, 'isolated DSH readiness URL')
    const exchangeResponse = await waitFor(async () => {
      if (web.exitCode !== null) throw new Error(`web host exited ${web.exitCode}: ${webStderr}`)
      const response = await fetch(pageUrl, { redirect: 'manual' })
      return response.status === 303 || response.status === 200 ? response : null
    }, 45_000, 'isolated DSH web host')
    if (exchangeResponse.status === 303) {
      const cookie = exchangeResponse.headers.get('set-cookie')?.split(';', 1)[0]
      assert.ok(cookie, 'launch-token exchange did not issue a session cookie')
      cleanUrl = new URL(exchangeResponse.headers.get('location') ?? '/', pageUrl).href
      const rootResponse = await fetch(cleanUrl, { headers: { cookie }, redirect: 'manual' })
      rootStatus = rootResponse.status
      assert.equal(rootStatus, 200, 'authenticated index request failed')
      html = await rootResponse.text()
    } else {
      cleanUrl = pageUrl
      rootStatus = exchangeResponse.status
      html = await exchangeResponse.text()
    }
    assert.match(html, /<html|<!doctype/i)
    const chromePath = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`
    chrome = spawn(chromePath, [
      '--headless=new', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${chromeData}`,
      '--window-size=1440,1000', pageUrl,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    chrome.stderr.on('data', chunk => { chromeStderr += chunk })
  }
  target = await waitFor(async () => {
    if (web.exitCode !== null) throw new Error(`${launchMode} host exited ${web.exitCode}: ${webStderr}`)
    if (chrome?.exitCode !== null && chrome !== undefined) throw new Error(`Chrome exited ${chrome.exitCode}: ${chromeStderr}`)
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    if (!response.ok) return null
    const pages = await response.json()
    return pages.find(page => page.type === 'page'
      && page.webSocketDebuggerUrl
      && (launchMode !== 'desktop' || /^https?:\/\//u.test(page.url)))
  }, launchMode === 'desktop' ? 240_000 : 90_000, `${launchMode} DevTools target`)
  console.error(`[agentos-context-e2e] DevTools target ready: ${target.url}`)
  if (launchMode === 'desktop') {
    pageUrl = target.url
    cleanUrl = target.url
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  const browserErrors = []
  const failedResponses = []
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (!message.id) {
      if (message.method === 'Runtime.exceptionThrown') {
        browserErrors.push(message.params?.exceptionDetails?.text ?? 'uncaught browser exception')
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        browserErrors.push(message.params.entry.text)
      }
      if (message.method === 'Network.responseReceived' && message.params?.response?.status >= 400) {
        failedResponses.push({
          status: message.params.response.status,
          url: String(message.params.response.url).replace(/([?&]token=)[^&]+/, '$1<redacted>'),
        })
      }
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timeout)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    const detail = method === 'Runtime.evaluate' && typeof params.expression === 'string'
      ? ` (${params.expression.replace(/\s+/gu, ' ').slice(0, 140)})`
      : ''
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`DevTools command timed out: ${method}${detail}`))
    }, 60_000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'browser evaluation failed')
    return result.result?.value
  }
  const waitForValue = (expression, timeoutMs, label) => waitFor(async () => {
    const value = await evaluate(expression)
    return value || null
  }, timeoutMs, label)
  const capture = async (filename) => {
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const output = path.join(destination, filename)
    await writeFile(output, Buffer.from(shot.data, 'base64'))
    return output
  }
  const auditTopDialog = async (label, filename, compact = false) => {
    const state = await evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      const dialog = dialogs.at(-1)
      if (!dialog) return null
      const rect = dialog.getBoundingClientRect()
      const visibleControls = [...dialog.querySelectorAll('button,input,select,textarea')].filter((node) => {
        const box = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      })
      return {
        viewport: { width: innerWidth, height: innerHeight },
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        clientWidth: dialog.clientWidth,
        scrollWidth: dialog.scrollWidth,
        clientHeight: dialog.clientHeight,
        scrollHeight: dialog.scrollHeight,
        clippedControls: visibleControls.map((node) => {
          const box = node.getBoundingClientRect()
          return { text: (node.textContent || node.getAttribute('aria-label') || '').trim().slice(0, 50), type: node.getAttribute('type'), left: box.left, right: box.right, width: box.width }
        }).filter((item) => item.left < rect.left - 1 || item.right > rect.right + 1 || (!['checkbox', 'file'].includes(item.type) && item.width < 24)),
      }
    })()`)
    assert.ok(state, `${label}: dialog is missing`)
    const available = state.viewport.width - 48
    const minimum = compact ? Math.min(480, available) : Math.min(680, available)
    assert.ok(state.rect.width >= minimum - 2, `${label}: dialog remained compressed: ${JSON.stringify(state)}`)
    assert.ok(state.rect.left >= -1 && state.rect.right <= state.viewport.width + 1, `${label}: dialog is outside the viewport: ${JSON.stringify(state)}`)
    assert.ok(state.rect.top >= -1 && state.rect.bottom <= state.viewport.height + 1, `${label}: dialog is outside the viewport vertically: ${JSON.stringify(state)}`)
    assert.ok(state.scrollWidth <= state.clientWidth + 1, `${label}: dialog has horizontal overflow: ${JSON.stringify(state)}`)
    assert.deepEqual(state.clippedControls, [], `${label}: dialog controls are clipped: ${JSON.stringify(state.clippedControls)}`)
    return { label, ...state, screenshot: await capture(filename) }
  }
  const auditWorkbenchPanel = async (tabId, filename) => {
    const state = await evaluate(`(() => {
      const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
      const panel = document.getElementById(${JSON.stringify('agentos-context-panel-')} + ${JSON.stringify(tabId)})
      if (!root || !panel) return null
      const rootRect = root.getBoundingClientRect()
      const panelRect = panel.getBoundingClientRect()
      const controls = [...panel.querySelectorAll('button,input,select,textarea')].filter((node) => {
        const box = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      })
      return {
        viewport: { width: innerWidth, height: innerHeight },
        root: { left: rootRect.left, right: rootRect.right, width: rootRect.width, clientWidth: root.clientWidth, scrollWidth: root.scrollWidth },
        panel: { left: panelRect.left, right: panelRect.right, width: panelRect.width, clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth },
        clippedControls: controls.map((node) => {
          const box = node.getBoundingClientRect()
          return { text: (node.textContent || node.getAttribute('aria-label') || '').trim().slice(0, 50), type: node.getAttribute('type'), left: box.left, right: box.right, width: box.width }
        }).filter((item) => item.left < panelRect.left - 1 || item.right > panelRect.right + 1 || (!['checkbox', 'file'].includes(item.type) && item.width < 24)),
      }
    })()`)
    assert.ok(state, `${tabId}: workbench panel is missing`)
    assert.ok(state.root.left >= -1 && state.root.right <= state.viewport.width + 1, `${tabId}: workbench is outside the viewport: ${JSON.stringify(state)}`)
    assert.ok(state.root.scrollWidth <= state.root.clientWidth + 1, `${tabId}: workbench has horizontal overflow: ${JSON.stringify(state)}`)
    assert.ok(state.panel.scrollWidth <= state.panel.clientWidth + 1, `${tabId}: panel has horizontal overflow: ${JSON.stringify(state)}`)
    assert.deepEqual(state.clippedControls, [], `${tabId}: panel controls are clipped: ${JSON.stringify(state.clippedControls)}`)
    return { tabId, ...state, screenshot: await capture(filename) }
  }
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Log.enable')
  await call('Network.enable')
  console.error('[agentos-context-e2e] CDP domains enabled')
  const page = await waitFor(async () => {
    const result = await call('Runtime.evaluate', {
      expression: `({ready:document.readyState,title:document.title,text:(document.body?.innerText||'').slice(0,12000),scripts:[...document.scripts].map(x=>x.src).filter(Boolean),hasApp:!!document.querySelector('#root,main,[role="main"]')})`,
      returnByValue: true,
    })
    const value = result.result?.value
    return value?.ready === 'complete' && value?.text ? value : null
  }, 45_000, 'rendered DSH page')
  console.error('[agentos-context-e2e] rendered page ready')
  if (launchMode === 'desktop') html = await evaluate('document.documentElement.outerHTML')
  await waitForValue(`(() => {
    if (!location.protocol.startsWith('http')) return false
    return [...document.querySelectorAll('button')].some((node) =>
      node.getAttribute('aria-label') === '设置'
      || node.getAttribute('aria-label') === '账号菜单'
      || node.textContent.trim() === '设置'
      || ['继续', '稍后配置', '稍后再说', '稍后设置'].includes(node.textContent.trim())
      || ['稍后配置', '稍后再说', '稍后设置'].includes(node.getAttribute('aria-label')))
  })()`, 180_000, 'desktop application shell')
  console.error('[agentos-context-e2e] application shell mounted')
  const disclaimerDismissed = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '继续')
    button?.click()
    return !!button
  })()`)
  if (disclaimerDismissed) {
    await waitForValue(`![...document.querySelectorAll('button')].some((node) => node.textContent.trim() === '继续')`, 10_000, 'preview disclaimer dismissal')
  }
  const onboardingDismissed = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) =>
      ['稍后配置', '稍后再说', '稍后设置'].includes(node.textContent.trim())
      || ['稍后配置', '稍后再说', '稍后设置'].includes(node.getAttribute('aria-label')))
    button?.click()
    return !!button
  })()`)
  if (onboardingDismissed) {
    await waitForValue(`![...document.querySelectorAll('button')].some((node) =>
      ['稍后配置', '稍后再说', '稍后设置'].includes(node.textContent.trim())
      || ['稍后配置', '稍后再说', '稍后设置'].includes(node.getAttribute('aria-label')))`, 10_000, 'API-key onboarding dismissal')
  }
  try {
    await waitForValue(`[...document.querySelectorAll('button')].some((node) =>
      node.getAttribute('aria-label') === '设置'
      || node.getAttribute('aria-label') === '账号菜单'
      || node.textContent.trim() === '设置')`, 120_000, 'desktop shell after startup screen')
  } catch (error) {
    const startupState = await evaluate(`({
      title: document.title,
      url: location.href.replace(/([?&]token=)[^&]+/, '$1<redacted>'),
      text: (document.body?.innerText || '').slice(0, 12000),
      buttons: [...document.querySelectorAll('button')].map((node) => ({ text: node.textContent.trim(), aria: node.getAttribute('aria-label'), disabled: node.disabled })).slice(0, 100),
    })`)
    const startupScreenshot = await capture('agentos-context-startup-timeout.png')
    throw new Error(`desktop shell startup state: ${JSON.stringify({ ...startupState, screenshot: startupScreenshot })}`, { cause: error })
  }
  console.error('[agentos-context-e2e] desktop shell ready')

  // Startup dialogs can mount one after another after the shell-ready marker.
  // Drain every known non-destructive dismissal before exercising navigation.
  await delay(500)
  let lateOnboardingDismissed = false
  for (let attempt = 0; attempt < 6; attempt++) {
    const lateStartupDismissed = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) =>
        ['继续', '稍后配置', '稍后再说', '稍后设置'].includes(node.textContent.trim())
        || (node.getAttribute('aria-label') === '关闭'
          && node.closest('[role="dialog"]')?.textContent.includes('开始使用')))
      button?.click()
      return !!button
    })()`)
    lateOnboardingDismissed ||= lateStartupDismissed
    await delay(lateStartupDismissed ? 350 : 150)
  }
  const blockingStartupDialog = await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].some((node) =>
    ['继续', '稍后配置', '稍后再说', '稍后设置'].includes(node.textContent.trim())
    || (node.getAttribute('aria-label') === '关闭'
      && node.closest('[role="dialog"]')?.textContent.includes('开始使用')))`)
  assert.equal(blockingStartupDialog, false, 'a startup dialog still blocks navigation')
  const homeScreenshot = await capture('agentos-context-clean-profile.png')
  const automaticCaptureToken = `agentos-auto-capture-${Date.now()}`
  const workspaceOpened = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')].filter((node) =>
      !node.closest('[role="dialog"]') && node.textContent.trim() === '默认工作区')
    const button = buttons.at(-1)
    button?.click()
    return !!button
  })()`)
  assert.equal(workspaceOpened, true, 'default workspace was not available for automatic-capture validation')
  await waitForValue(`[...document.querySelectorAll('button')].some((node) =>
    !node.closest('[role="dialog"]')
      && (node.textContent.trim() === '新会话' || node.getAttribute('aria-label') === '新建会话')
      && !node.disabled)`, 30_000, 'new-session action')
  const previousConversationId = await evaluate(`document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? null`)
  const sessionCreated = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')].filter((node) =>
      !node.closest('[role="dialog"]')
        && (node.textContent.trim() === '新会话' || node.getAttribute('aria-label') === '新建会话')
        && !node.disabled)
    const button = buttons.at(-1)
    button?.click()
    return !!button
  })()`)
  assert.equal(sessionCreated, true, 'new session could not be created for automatic-capture validation')
  await waitForValue(`(() => {
    const id = document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session')
    return id && id !== ${JSON.stringify(previousConversationId)} ? id : null
  })()`, 30_000, 'new conversation selection')
  await waitForValue(`!!document.querySelector('[data-composer-input][contenteditable="true"]')`, 30_000, 'conversation composer')
  await evaluate(`document.querySelector('[data-composer-input][contenteditable="true"]')?.focus()`)
  await call('Input.insertText', { text: automaticCaptureToken })
  await waitForValue(`document.querySelector('[data-composer-input][contenteditable="true"]')?.textContent.includes(${JSON.stringify(automaticCaptureToken)})`, 10_000, 'automatic-capture prompt text')
  const promptSubmitted = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) =>
      node.getAttribute('aria-label') === '发送消息' && !node.disabled)
    button?.click()
    return !!button
  })()`)
  assert.equal(promptSubmitted, true, 'automatic-capture prompt could not be submitted')
  const automaticCaptureState = await waitForValue(`(async () => {
    async function rpc(endpoint, payload) {
      const method = 'agentos-context/v1/' + endpoint
      const response = await fetch('/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'agentos-context-auto-' + crypto.randomUUID(),
          method,
          payload,
        }),
      })
      const body = await response.json()
      if (!response.ok || body?.result?.ok === false) return null
      return body?.result?.value ?? body?.result?.data ?? body?.result
    }
    const scopes = await rpc('scopes', {})
    for (const scope of scopes?.items ?? []) {
      const listed = await rpc('memories', { scopeId: scope.id, query: ${JSON.stringify(automaticCaptureToken)}, limit: 20 })
      const item = listed?.items?.find((memory) => memory.content.includes(${JSON.stringify(automaticCaptureToken)}))
      if (item) return {
        id: item.id,
        scopeId: item.scopeId,
        content: item.content,
        layer: item.layer,
        sourceKind: item.source?.kind,
      }
    }
    return null
  })()`, 90_000, 'automatic prompt capture')
  assert.equal(automaticCaptureState.content.includes(automaticCaptureToken), true, 'captured prompt content changed unexpectedly')
  const seededChineseSearchState = await evaluate(`(async () => {
    async function rpc(endpoint, payload) {
      const method = 'agentos-context/v1/' + endpoint
      const response = await fetch('/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'agentos-context-seeded-search-' + crypto.randomUUID(),
          method,
          payload,
        }),
      })
      const body = await response.json()
      if (!response.ok || body?.result?.ok === false) {
        return { error: body?.result?.error ?? body }
      }
      return body?.result?.value ?? body?.result?.data ?? body?.result
    }
    const scopes = await rpc('scopes', {})
    const rows = []
    for (const scope of scopes?.items ?? []) {
      const product = await rpc('memories', { scopeId: scope.id, query: '产品交付', limit: 500 })
      const quality = await rpc('memories', { scopeId: scope.id, query: '质量保障', limit: 500 })
      rows.push({
        id: scope.id,
        count: scope.count,
        product: product?.items?.map((item) => item.content) ?? [],
        quality: quality?.items?.map((item) => item.content) ?? [],
        productError: product?.error ?? null,
        qualityError: quality?.error ?? null,
      })
    }
    return { scopes: rows }
  })()`)
  const seededProductRows = seededChineseSearchState.scopes.flatMap((scope) => scope.product)
  const seededQualityRows = seededChineseSearchState.scopes.flatMap((scope) => scope.quality)
  assert.equal(
    seededProductRows.length,
    5,
    `seeded Chinese product memories are not searchable: ${JSON.stringify(seededChineseSearchState)}`,
  )
  assert.equal(
    seededQualityRows.length,
    5,
    `seeded Chinese quality memories are not searchable: ${JSON.stringify(seededChineseSearchState)}`,
  )
  let conversationTabReady = false
  for (let attempt = 0; attempt < 75; attempt++) {
    conversationTabReady = await evaluate(`[...document.querySelectorAll('button')].some((node) =>
      !node.closest('[role="dialog"]') && node.textContent.trim() === '记忆')`)
    if (conversationTabReady) break
    await delay(200)
  }
  const runningStop = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) =>
      node.getAttribute('aria-label') === '停止生成' && !node.disabled)
    button?.click()
    return !!button
  })()`)
  if (runningStop) await delay(500)
  if (!conversationTabReady) {
    const completedConversationSelected = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) =>
        !node.closest('[role="dialog"]') && node.textContent.includes(${JSON.stringify(automaticCaptureToken)}))
      button?.click()
      return !!button
    })()`)
    if (completedConversationSelected) {
      for (let attempt = 0; attempt < 25; attempt++) {
        conversationTabReady = await evaluate(`[...document.querySelectorAll('button')].some((node) =>
          !node.closest('[role="dialog"]') && node.textContent.trim() === '记忆')`)
        if (conversationTabReady) break
        await delay(200)
      }
    }
  }
  const memoryViewOpened = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) =>
      !node.closest('[role="dialog"]') && node.textContent.trim() === '记忆')
    button?.click()
    return !!button
  })()`)
  let conversationMemorySearchScreenshot = null
  let conversationMemoryGraphScreenshot = null
  const conversationMemoryState = {
    tested: memoryViewOpened,
    reason: memoryViewOpened ? null : 'profile did not complete a conversation before the Memory-tab check',
  }
  if (memoryViewOpened) {
    await waitForValue(`!!document.querySelector('section[aria-label="记忆概览"] input[aria-label="搜索记忆"]')`, 30_000, 'conversation Memory list search')
    const conversationChromeState = await evaluate(`({
      composerVisible: [...document.querySelectorAll('[data-composer-seat]')].some((node) => getComputedStyle(node).display !== 'none'),
      layoutHandleVisible: [...document.querySelectorAll('[data-agentos-memory-layout-handle="true"]')].some((node) => getComputedStyle(node).display !== 'none'),
      aggregateScope: document.querySelector('section[aria-label="记忆概览"] select[aria-label="记忆范围"]')?.value,
    })`)
    assert.deepEqual(conversationChromeState, {
      composerVisible: false,
      layoutHandleVisible: false,
      aggregateScope: 'agentos-context:all-scopes',
    }, `conversation Memory chrome is incorrect: ${JSON.stringify(conversationChromeState)}`)
    await evaluate(`(() => {
      const input = document.querySelector('section[aria-label="记忆概览"] input[aria-label="搜索记忆"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(automaticCaptureToken)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await waitForValue(`document.querySelector('section[aria-label="记忆概览"] [aria-label="记忆列表"]')?.textContent.includes(${JSON.stringify(automaticCaptureToken)})`, 30_000, 'automatic memory in conversation list')
    const automaticCaptureScreenshot = await capture('agentos-context-conversation-auto-memory.png')
    await evaluate(`(() => {
      const input = document.querySelector('section[aria-label="记忆概览"] input[aria-label="搜索记忆"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '产品交付')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    try {
      await waitForValue(`(() => {
        const list = document.querySelector('section[aria-label="记忆概览"] [aria-label="记忆列表"]')
        return list?.textContent.includes('产品交付') && !list.textContent.includes('质量保障')
      })()`, 10_000, 'conversation Memory list filtering')
    } catch (error) {
      const state = await evaluate(`(() => {
        const surface = document.querySelector('section[aria-label="记忆概览"]')
        const input = surface?.querySelector('input[aria-label="搜索记忆"]')
        const list = surface?.querySelector('[aria-label="记忆列表"]')
        return {
          query: input?.value ?? null,
          scope: surface?.querySelector('select[aria-label="记忆范围"]')?.value ?? null,
          listText: (list?.textContent ?? '').trim().slice(0, 4000),
        }
      })()`)
      const screenshot = await capture('agentos-context-conversation-memory-search-timeout.png')
      throw new Error(`conversation Memory filter state: ${JSON.stringify({ ...state, screenshot })}`, { cause: error })
    }
    conversationMemorySearchScreenshot = await capture('agentos-context-conversation-memory-search.png')
    await evaluate(`(() => {
      const surface = document.querySelector('section[aria-label="记忆概览"]')
      const button = [...surface.querySelectorAll('button')].find((node) => node.textContent.trim() === '图谱')
      button?.click()
      return !!button
    })()`)
    await waitForValue(`(() => {
      const surface = document.querySelector('section[aria-label="记忆概览"]')
      return surface?.querySelector('[data-context-graph-mode="overview"]') && !surface.textContent.includes('正在读取关系图谱')
    })()`, 30_000, 'conversation Memory graph')
    conversationMemoryGraphScreenshot = await capture('agentos-context-conversation-memory-graph.png')
    await evaluate(`(() => {
      const surface = document.querySelector('section[aria-label="记忆概览"]')
      const button = [...surface.querySelectorAll('button')].find((node) => node.textContent.trim() === '返回对话')
      button?.click()
      return !!button
    })()`)
    await waitForValue(`!document.querySelector('section[aria-label="记忆概览"]')`, 10_000, 'return from conversation Memory view')
    conversationMemoryState.automaticCaptureScreenshot = automaticCaptureScreenshot
    conversationMemoryState.chrome = conversationChromeState
  }

  const openedSettings = await evaluate(`(async () => {
    const findSettings = () => [...document.querySelectorAll('button, [role="menuitem"]')].find((node) =>
      node.getAttribute('aria-label') === '设置' || node.textContent.trim().startsWith('设置'))
    let button = findSettings()
    if (!button) {
      const accountMenu = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '账号菜单')
      accountMenu?.click()
      await new Promise((resolve) => setTimeout(resolve, 250))
      button = findSettings()
    }
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.equal(openedSettings, true, 'settings trigger was not found')
  const settingsNav = await waitForValue(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return null
    return [...dialog.querySelectorAll('nav button')].map((node) => node.textContent.trim())
  })()`, 30_000, 'settings navigation')
  assert.ok(settingsNav.includes('记忆'), 'dedicated memory settings entry is missing')
  assert.ok(settingsNav.includes('内置插件') || settingsNav.includes('插件'), 'plugin settings entry is missing')

  await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const button = [...dialog.querySelectorAll('nav button')].find((node) =>
      ['内置插件', '插件'].includes(node.textContent.trim()))
    button?.click()
    return !!button
  })()`)
  await waitForValue(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return dialog && !dialog.textContent.includes('正在加载')
  })()`, 30_000, 'plugin settings list')
  const duplicatePluginCard = await evaluate(`!!document.querySelector('[data-opencontext-config-card]')`)
  assert.equal(duplicatePluginCard, false, 'legacy OpenContext plugin card must not be registered')

  await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const button = [...dialog.querySelectorAll('nav button')].find((node) => node.textContent.trim() === '记忆')
    button?.click()
    return !!button
  })()`)
  await waitForValue(`!!document.querySelector('[data-opencontext-config-card]')`, 30_000, 'agentOS context memory settings')
  const configScreenshot = await capture('agentos-context-memory-settings.png')
  await evaluate(`(() => {
    const card = document.querySelector('[data-opencontext-config-card]')
    const button = [...card.querySelectorAll('button')].find((node) => node.textContent.trim() === '打开记忆工作台')
    button?.click()
    return !!button
  })()`)
  await waitForValue(`!!document.querySelector('section[aria-label="agentOS context 记忆工作台"]')`, 30_000, 'memory workbench')
  const tabIds = await evaluate(`[...document.querySelectorAll('[id^="agentos-context-tab-"]')].map((node) => node.id)`)
  assert.deepEqual(tabIds, [
    'agentos-context-tab-memories',
    'agentos-context-tab-knowledge',
    'agentos-context-tab-graph',
    'agentos-context-tab-review',
    'agentos-context-tab-settings',
  ])
  await waitForValue(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const select = root?.querySelector('select[aria-label="记忆范围"]')
    const panel = document.getElementById('agentos-context-panel-memories')
    return select?.value === 'agentos-context:all-scopes'
      && select.options[0]?.textContent.includes('全部范围')
      && panel
      && !panel.textContent.includes('正在读取')
  })()`, 30_000, 'default aggregate memory scope')
  const allScopesScreenshot = await capture('agentos-context-all-scopes.png')
  await waitForValue(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    return [...(root?.querySelectorAll('select option') ?? [])].some((node) => node.value === 'local:default')
  })()`, 30_000, 'seeded graph validation scope availability')
  const seededScopeSelection = await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const option = [...(root?.querySelectorAll('select option') ?? [])].find((node) => node.value === 'local:default')
    const select = option?.parentElement
    if (!(select instanceof HTMLSelectElement)) return {
      ok: false,
      root: !!root,
      options: [...(root?.querySelectorAll('select option') ?? [])].map((node) => ({ value: node.value, text: node.textContent })),
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'local:default')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true }
  })()`)
  assert.equal(seededScopeSelection.ok, true, `seeded graph validation scope is missing from the workbench: ${JSON.stringify(seededScopeSelection)}`)
  await waitForValue(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const select = [...(root?.querySelectorAll('select') ?? [])].find((node) =>
      [...node.options].some((option) => option.value === 'local:default'))
    return select?.value === 'local:default'
  })()`, 10_000, 'seeded graph validation scope selection')
  await waitForValue(`(() => {
    const panel = document.querySelector('#agentos-context-panel-memories')
    return panel && !panel.textContent.includes('正在读取')
  })()`, 30_000, 'memory data')

  const legacyCompatibility = seedOpenContextHome
    ? await evaluate(`(async () => {
      async function rpc(endpoint, payload) {
        const method = 'agentos-context/v1/' + endpoint
        const response = await fetch('/api/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: 'agentos-context-legacy-' + endpoint.replaceAll('/', '-'),
            method,
            payload,
          }),
        })
        const body = await response.json()
        const result = body?.result
        if (!response.ok || result?.ok === false) {
          throw new Error(result?.error?.message || ('legacy RPC failed: ' + response.status))
        }
        return result?.value ?? result?.data ?? result
      }
      const bootstrap = await rpc('bootstrap', {})
      const scopes = bootstrap?.scopes ?? []
      const expected = scopes.find((row) => row.id === 'local:D:\\\\DSH Desktop')
      const legacyScope = expected ?? scopes
        .filter((row) => row.id !== 'local:default' && row.count > 0)
        .sort((left, right) => right.count - left.count)[0]
      if (!legacyScope) return { scopes, error: 'no populated legacy scope' }
      const listed = await rpc('memories', { scopeId: legacyScope.id, limit: 500 })
      const searched = await rpc('memories', { scopeId: legacyScope.id, query: '情绪监控', limit: 20 })
      return {
        scopes,
        scopeId: legacyScope.id,
        scopeCount: legacyScope.count,
        listedCount: listed?.items?.length ?? 0,
        searchCount: searched?.items?.length ?? 0,
        firstSearchText: searched?.items?.[0]?.content ?? null,
      }
    })()`)
    : null
  if (legacyCompatibility !== null) {
    assert.equal(legacyCompatibility.scopeId, 'local:D:\\DSH Desktop', `old DSH scope was not detected: ${JSON.stringify(legacyCompatibility)}`)
    assert.ok(legacyCompatibility.scopeCount >= 900, `old memory count is unexpectedly low: ${JSON.stringify(legacyCompatibility)}`)
    assert.ok(legacyCompatibility.listedCount > 0, `old memories cannot be listed: ${JSON.stringify(legacyCompatibility)}`)
    assert.ok(legacyCompatibility.searchCount > 0, `Chinese old-memory search returned no results: ${JSON.stringify(legacyCompatibility)}`)
  }

  const memoryText = `agentOS context E2E ${Date.now()}`
  await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const button = [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === '记住一条')
    button?.click()
    return !!button
  })()`)
  await waitForValue(`document.querySelectorAll('[role="dialog"]').length > 1`, 10_000, 'save-memory dialog')
  const dialogAudits = []
  dialogAudits.push(await auditTopDialog('save-memory', 'agentos-context-dialog-save.png'))
  await evaluate(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    const dialog = dialogs[dialogs.length - 1]
    const input = dialog.querySelector('textarea')
    const layer = dialog.querySelector('select[aria-label="记忆层级"]')
    const importance = dialog.querySelector('#context-memory-importance')
    const textSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    textSetter.call(input, ${JSON.stringify(memoryText)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    selectSetter.call(layer, 'working')
    layer.dispatchEvent(new Event('change', { bubbles: true }))
    inputSetter.call(importance, '0.85')
    importance.dispatchEvent(new Event('input', { bubbles: true }))
    const submit = [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确认')
    submit?.click()
    return !!input && !!layer && !!importance && !!submit
  })()`)
  await waitForValue(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const item = [...root.querySelectorAll('button')].find((node) => node.textContent.includes(${JSON.stringify(memoryText)}))
    return item?.textContent.includes('工作记忆') && item?.textContent.includes('重要度 85%')
  })()`, 30_000, 'saved working memory with importance')

  const revisedMemoryText = `${memoryText} revised`
  await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const item = [...root.querySelectorAll('button')].find((node) => node.textContent.includes(${JSON.stringify(memoryText)}))
    item?.click()
    return !!item
  })()`)
  await waitForValue(`[...document.querySelectorAll('section[aria-label="agentOS context 记忆工作台"] button')].some((node) => node.textContent.trim() === '修订')`, 10_000, 'memory detail')
  await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const button = [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === '修订')
    button?.click()
    return !!button
  })()`)
  await waitForValue(`document.querySelectorAll('[role="dialog"]').length > 1`, 10_000, 'revise-memory dialog')
  dialogAudits.push(await auditTopDialog('revise-memory', 'agentos-context-dialog-revise.png'))
  await evaluate(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    const dialog = dialogs[dialogs.length - 1]
    const inputs = [...dialog.querySelectorAll('textarea')]
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(inputs[0], ${JSON.stringify(revisedMemoryText)})
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    setter.call(inputs[1], 'E2E revision')
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    const submit = [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确认')
    submit?.click()
    return inputs.length === 2 && !!submit
  })()`)
  await waitForValue(`document.body.innerText.includes(${JSON.stringify(revisedMemoryText)})`, 30_000, 'revised memory')

  await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const item = [...root.querySelectorAll('button')].find((node) => node.textContent.includes(${JSON.stringify(revisedMemoryText)}))
    item?.click()
    return !!item
  })()`)
  await waitForValue(`[...document.querySelectorAll('section[aria-label="agentOS context 记忆工作台"] button')].some((node) => node.textContent.trim() === '迁移层级')`, 10_000, 'transition-memory action')
  await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const button = [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === '迁移层级')
    button?.click()
    return !!button
  })()`)
  await waitForValue(`document.querySelectorAll('[role="dialog"]').length > 1`, 10_000, 'transition-memory dialog')
  dialogAudits.push(await auditTopDialog('transition-memory', 'agentos-context-dialog-transition.png'))
  await evaluate(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    const dialog = dialogs[dialogs.length - 1]
    const layer = dialog.querySelector('select[aria-label="记忆层级"]')
    const reason = dialog.querySelector('textarea')
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    const textSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    selectSetter.call(layer, 'procedural')
    layer.dispatchEvent(new Event('change', { bubbles: true }))
    textSetter.call(reason, 'E2E layer transition')
    reason.dispatchEvent(new Event('input', { bubbles: true }))
    const submit = [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确认')
    submit?.click()
    return !!layer && !!reason && !!submit
  })()`)
  await waitForValue(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const item = [...root.querySelectorAll('button')].find((node) => node.textContent.includes(${JSON.stringify(revisedMemoryText)}))
    return item?.textContent.includes('程序记忆') && item?.textContent.includes('重要度 85%')
  })()`, 30_000, 'transitioned procedural memory with importance')

  const openWorkbenchEditor = async (label, auditLabel, filename) => {
    const baseDialogCount = await evaluate(`document.querySelectorAll('[role="dialog"]').length`)
    const available = await waitForValue(`(() => {
      const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
      return [...(root?.querySelectorAll('button') ?? [])].some((node) => node.textContent.trim() === ${JSON.stringify(label)})
    })()`, 10_000, `${label} workbench action`)
    assert.equal(available, true, `${label}: workbench action did not become available`)
    const opened = await evaluate(`(() => {
      const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
      const button = [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === ${JSON.stringify(label)})
      button?.click()
      return !!button
    })()`)
    assert.equal(opened, true, `${label}: workbench action is missing`)
    await waitForValue(`document.querySelectorAll('[role="dialog"]').length > ${baseDialogCount}`, 10_000, `${auditLabel} dialog`)
    dialogAudits.push(await auditTopDialog(auditLabel, filename))
    const cancelled = await evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      const dialog = dialogs.at(-1)
      const button = [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '取消')
      button?.click()
      return !!button
    })()`)
    assert.equal(cancelled, true, `${label}: cancel action is missing`)
    await waitForValue(`document.querySelectorAll('[role="dialog"]').length === ${baseDialogCount}`, 10_000, `${auditLabel} dialog close`)
  }
  const objectModeOpened = await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const button = [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === '对象')
    button?.click()
    return !!button
  })()`)
  assert.equal(objectModeOpened, true, 'object mode action is missing')
  await waitForValue(`[...document.querySelectorAll('section[aria-label="agentOS context 记忆工作台"] button')].some((node) => node.textContent.trim() === '创建对象')`, 10_000, 'object mode')
  await openWorkbenchEditor('创建对象', 'create-entity', 'agentos-context-dialog-create-entity.png')
  await openWorkbenchEditor('建立关系', 'create-relation', 'agentos-context-dialog-create-relation.png')
  await openWorkbenchEditor('对齐别名', 'merge-entities', 'agentos-context-dialog-merge-entities.png')
  const memoryModeOpened = await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const button = [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === '记忆')
    button?.click()
    return !!button
  })()`)
  assert.equal(memoryModeOpened, true, 'memory mode action is missing')

  await evaluate(`document.getElementById('agentos-context-tab-knowledge')?.click()`)
  await waitForValue(`(() => {
    const panel = document.getElementById('agentos-context-panel-knowledge')
    return panel?.textContent.includes('知识库文档') && !panel.textContent.includes('正在读取知识库') && !panel.querySelector('[role="alert"]')
  })()`, 30_000, 'knowledge tab data')
  const knowledgeFormatsState = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-knowledge')
    const details = [...(panel?.querySelectorAll('details') ?? [])].find((node) => node.querySelector('summary')?.textContent.trim() === '支持格式与大小限制')
    return details ? { present: true, open: details.open, text: details.textContent.trim() } : { present: false }
  })()`)
  assert.equal(knowledgeFormatsState.present, true, 'knowledge format guidance is missing')
  assert.equal(knowledgeFormatsState.open, false, 'knowledge format guidance should not occupy the first screen by default')
  const knowledgeScreenshot = await capture('agentos-context-knowledge.png')
  const knowledgeFixtureName = `agentos-context-e2e-${Date.now()}.txt`
  const knowledgeFixtureToken = `agentos-knowledge-proof-${Date.now()}`
  const knowledgeFixturePath = path.join(destination, knowledgeFixtureName)
  await writeFile(
    knowledgeFixturePath,
    `Release validation evidence: ${knowledgeFixtureToken}. This document proves upload, indexing, retrieval, evidence inspection, and deletion through the real page.\n`,
    'utf8',
  )
  const documentRoot = await call('DOM.getDocument', { depth: 2, pierce: true })
  const knowledgeFileInput = await call('DOM.querySelector', {
    nodeId: documentRoot.root.nodeId,
    selector: '#agentos-context-panel-knowledge input[aria-label="选择知识库文件"]',
  })
  assert.ok(knowledgeFileInput.nodeId, 'knowledge file input is missing')
  await call('DOM.setFileInputFiles', {
    nodeId: knowledgeFileInput.nodeId,
    files: [knowledgeFixturePath],
  })
  await waitForValue(`(() => {
    const panel = document.getElementById('agentos-context-panel-knowledge')
    return panel?.textContent.includes(${JSON.stringify(knowledgeFixtureName)})
      && panel.textContent.includes('已上传')
      && !panel.querySelector('[role="alert"]')
  })()`, 60_000, 'knowledge document upload')
  const knowledgeUploadedScreenshot = await capture('agentos-context-knowledge-uploaded.png')
  const knowledgeQueryEntered = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-knowledge')
    const input = panel?.querySelector('input[aria-label="搜索知识库"]')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(knowledgeFixtureToken)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  assert.equal(knowledgeQueryEntered, true, 'knowledge search input is unavailable')
  await waitForValue(`(() => {
    const panel = document.getElementById('agentos-context-panel-knowledge')
    const button = [...(panel?.querySelectorAll('button') ?? [])].find((node) => node.textContent.trim() === '检索')
    return button && !button.disabled
  })()`, 10_000, 'knowledge search readiness')
  const knowledgeSearchStarted = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-knowledge')
    const button = [...(panel?.querySelectorAll('button') ?? [])].find((node) => node.textContent.trim() === '检索')
    button.click()
    return !!button
  })()`)
  assert.equal(knowledgeSearchStarted, true, 'knowledge search controls are unavailable')
  await waitForValue(`(() => {
    const results = document.querySelector('#agentos-context-panel-knowledge [aria-label="知识库检索结果"]')
    return results?.textContent.includes(${JSON.stringify(knowledgeFixtureName)})
      && results.textContent.includes(${JSON.stringify(knowledgeFixtureToken)})
  })()`, 60_000, 'knowledge retrieval result')
  const knowledgeSearchScreenshot = await capture('agentos-context-knowledge-search.png')
  const knowledgeEvidenceOpened = await evaluate(`(() => {
    const results = document.querySelector('#agentos-context-panel-knowledge [aria-label="知识库检索结果"]')
    const button = [...(results?.querySelectorAll('button') ?? [])].find((node) => node.textContent.trim() === '查看证据')
    button?.click()
    return !!button
  })()`)
  assert.equal(knowledgeEvidenceOpened, true, 'knowledge evidence action is missing')
  await waitForValue(`[...document.querySelectorAll('[role="dialog"]')].some((node) =>
    [...node.querySelectorAll('h1,h2,h3')].some((heading) => heading.textContent.trim().startsWith('检索证据'))
      && node.textContent.includes(${JSON.stringify(knowledgeFixtureName)})
      && node.textContent.includes(${JSON.stringify(knowledgeFixtureToken)}))`, 10_000, 'knowledge evidence dialog')
  const knowledgeEvidenceScreenshot = await capture('agentos-context-knowledge-evidence.png')
  await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((node) =>
      [...node.querySelectorAll('h1,h2,h3')].some((heading) => heading.textContent.trim().startsWith('检索证据')))
    const button = [...(dialog?.querySelectorAll('button') ?? [])].find((node) => node.textContent.trim() === '完成')
    button?.click()
    return !!button
  })()`)
  await waitForValue(`![...document.querySelectorAll('[role="dialog"]')].some((node) =>
    [...node.querySelectorAll('h1,h2,h3')].some((heading) => heading.textContent.trim().startsWith('检索证据')))`, 10_000, 'knowledge evidence dialog close')
  const knowledgeResultsCleared = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-knowledge')
    const button = [...(panel?.querySelectorAll('button') ?? [])].find((node) => node.textContent.trim() === '清除结果')
    button?.click()
    return !!button
  })()`)
  assert.equal(knowledgeResultsCleared, true, 'knowledge clear-results action is missing')
  await waitForValue(`!!document.querySelector('#agentos-context-panel-knowledge [aria-label="知识库文档列表"]')`, 10_000, 'knowledge document list')
  const knowledgeDeleteOpened = await evaluate(`(() => {
    const list = document.querySelector('#agentos-context-panel-knowledge [aria-label="知识库文档列表"]')
    const item = [...(list?.querySelectorAll('article') ?? [])].find((node) => node.textContent.includes(${JSON.stringify(knowledgeFixtureName)}))
    const button = [...(item?.querySelectorAll('button') ?? [])].find((node) => node.textContent.trim() === '删除')
    button?.click()
    return !!button
  })()`)
  assert.equal(knowledgeDeleteOpened, true, 'knowledge delete action is missing')
  await waitForValue(`[...document.querySelectorAll('[role="dialog"]')].some((node) => node.textContent.includes('删除知识库文档') && node.textContent.includes(${JSON.stringify(knowledgeFixtureName)}))`, 10_000, 'knowledge delete dialog')
  const knowledgeDeleteConfirmed = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((node) => node.textContent.includes('删除知识库文档'))
    const button = [...(dialog?.querySelectorAll('button') ?? [])].find((node) => node.textContent.trim() === '确认删除')
    button?.click()
    return !!button
  })()`)
  assert.equal(knowledgeDeleteConfirmed, true, 'knowledge delete confirmation is missing')
  await waitForValue(`(() => {
    const panel = document.getElementById('agentos-context-panel-knowledge')
    return panel?.textContent.includes('已删除 ${knowledgeFixtureName}')
      && !panel.querySelector('[role="dialog"]')
      && !panel.querySelector('[role="alert"]')
  })()`, 30_000, 'knowledge document deletion')
  const knowledgeInteractionState = {
    uploaded: true,
    retrieved: true,
    evidenceInspected: true,
    deleted: true,
    filename: knowledgeFixtureName,
  }

  await evaluate(`document.getElementById('agentos-context-tab-graph')?.click()`)
  await waitForValue(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    return panel && !panel.textContent.includes('正在读取关系图谱')
  })()`, 30_000, 'graph tab data')
  const graphRangeState = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const center = panel?.querySelector('input[aria-label="图谱中心对象"]')
    const details = center?.closest('details')
    return details ? { present: true, open: details.open, summary: details.querySelector('summary')?.textContent.trim() } : { present: false }
  })()`)
  assert.equal(graphRangeState.present, true, 'graph range controls are not grouped')
  assert.equal(graphRangeState.open, false, 'graph range controls should be collapsed by default')
  assert.equal(graphRangeState.summary, '范围与时间')
  const graphExploreState = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const search = panel?.querySelector('input[aria-label="筛选图谱节点"]')
    const filters = [...(panel?.querySelectorAll('details') ?? [])].find((node) => node.querySelector('summary')?.textContent.includes('筛选与布局'))
    return {
      search: !!search,
      searchPlaceholder: search?.getAttribute('placeholder') ?? null,
      filters: !!filters,
      filtersOpen: filters?.open ?? null,
      loadedStatus: [...(panel?.querySelectorAll('[role="status"]') ?? [])].map((node) => node.textContent.trim()).find((text) => text.includes('已加载')) ?? null,
      hasNodeType: [...(filters?.querySelectorAll('label') ?? [])].some((node) => node.textContent.includes('节点类型')),
      hasEdgeType: [...(filters?.querySelectorAll('label') ?? [])].some((node) => node.textContent.includes('关系类型')),
      hasOrigin: [...(filters?.querySelectorAll('label') ?? [])].some((node) => node.textContent.includes('数据来源')),
      hasScope: [...(filters?.querySelectorAll('label') ?? [])].some((node) => node.textContent.includes('记忆范围')),
    }
  })()`)
  assert.equal(graphExploreState.search, true, `graph search is missing: ${JSON.stringify(graphExploreState)}`)
  assert.equal(graphExploreState.filters, true, `graph filters are missing: ${JSON.stringify(graphExploreState)}`)
  assert.equal(graphExploreState.filtersOpen, false, 'graph filters should be compact by default')
  assert.ok(graphExploreState.loadedStatus?.includes('完整加载'), `graph completeness state is unclear: ${JSON.stringify(graphExploreState)}`)
  assert.ok(graphExploreState.hasNodeType && graphExploreState.hasEdgeType && graphExploreState.hasOrigin && graphExploreState.hasScope, `graph filters are incomplete: ${JSON.stringify(graphExploreState)}`)
  const graph2dActivated = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const button = [...(panel?.querySelectorAll('button') ?? [])].find((node) => node.textContent.trim() === '2D 实用')
    button?.click()
    return !!button
  })()`)
  assert.equal(graph2dActivated, true, '2D graph action is missing')
  await waitForValue(`document.querySelector('[data-context-graph-dimension]')?.getAttribute('data-context-graph-dimension') === '2d'`, 10_000, '2D graph mode')
  const graphRpcState = await evaluate(`(async () => {
    const method = 'agentos-context/v1/graph'
    const response = await fetch('/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'agentos-context-browser-validation',
        method,
        payload: { scopeId: 'local:default', depth: 2, includePending: false, limit: 160 },
      }),
    })
    const body = await response.json()
    const graph = body?.result?.value ?? body?.result?.data ?? body?.result
    return {
      status: response.status,
      ok: body?.result?.ok ?? null,
      nodes: graph?.nodes?.length ?? null,
      edges: graph?.edges?.length ?? null,
      communities: graph?.communities?.length ?? null,
      communitySizes: graph?.communities?.map((row) => row.size) ?? null,
      firstEdge: graph?.edges?.[0] ? { id: graph.edges[0].id, source: graph.edges[0].source, target: graph.edges[0].target } : null,
    }
  })()`)
  const communityState = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const surface = panel?.querySelector('[data-context-graph-view]')
    const community = [...(panel?.querySelectorAll('g[role="button"]') ?? [])].find((node) => node.getAttribute('aria-label')?.startsWith('社区'))
    return {
      view: surface?.getAttribute('data-context-graph-view') ?? null,
      communityCount: [...(panel?.querySelectorAll('g[role="button"]') ?? [])].filter((node) => node.getAttribute('aria-label')?.startsWith('社区')).length,
      hasNodeSwitch: [...(panel?.querySelectorAll('button') ?? [])].some((node) => node.textContent.trim() === '节点视图'),
      firstCommunityLabel: community?.getAttribute('aria-label') ?? null,
      graphNodeLabels: [...(panel?.querySelectorAll('g[role="button"]') ?? [])].map((node) => node.getAttribute('aria-label')),
      text: panel?.innerText ?? null,
    }
  })()`)
  const expectedAutomaticGraphView = graphRpcState.communities * 4 <= graphRpcState.nodes
    || (graphRpcState.nodes > 180 && graphRpcState.communities < graphRpcState.nodes * 0.75)
    ? 'communities'
    : 'nodes'
  assert.equal(communityState.view, expectedAutomaticGraphView, `graph chose the wrong automatic view: ${JSON.stringify({ graphRpcState, communityState })}`)
  assert.equal(communityState.hasNodeSwitch, true, `community controls are incomplete: ${JSON.stringify(communityState)}`)
  if (communityState.view !== 'communities') {
    const communityViewOpened = await evaluate(`(() => {
      const panel = document.getElementById('agentos-context-panel-graph')
      const button = [...panel.querySelectorAll('button')].find((node) => node.textContent.trim() === '社区视图')
      button?.click()
      return !!button
    })()`)
    assert.equal(communityViewOpened, true, 'manual community view action is missing')
    await waitForValue(`document.querySelector('[data-context-graph-view]')?.getAttribute('data-context-graph-view') === 'communities'`, 10_000, 'manual community graph view')
  }
  const visibleCommunityCount = await evaluate(`[...document.querySelectorAll('#agentos-context-panel-graph g[role="button"]')].filter((node) => node.getAttribute('aria-label')?.startsWith('社区')).length`)
  assert.ok(visibleCommunityCount > 0, `manual community view did not render communities: ${JSON.stringify({ graphRpcState, communityState })}`)
  await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const community = [...panel.querySelectorAll('g[role="button"]')].find((node) => node.getAttribute('aria-label')?.startsWith('社区'))
    community?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return !!community
  })()`)
  await waitForValue(`(() => {
    const drawer = document.querySelector('[aria-label="图谱详情"]')
    return drawer?.textContent.includes('社区详情') && drawer.textContent.includes('主要对象') && drawer.textContent.includes('节点构成')
  })()`, 10_000, 'community detail drawer')
  const communityScreenshot = await capture('agentos-context-graph-community-detail.png')
  await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const button = [...panel.querySelectorAll('button')].find((node) => node.textContent.trim() === '节点视图')
    button?.click()
    return !!button
  })()`)
  await waitForValue(`document.querySelector('[data-context-graph-view]')?.getAttribute('data-context-graph-view') === 'nodes'`, 10_000, 'node graph view')
  const nodeGraphScreenshot = await capture('agentos-context-graph-nodes.png')
  const dense2dState = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const nodes = [...panel.querySelectorAll('g[role="button"]')]
    return {
      nodes: nodes.length,
      compactNodes: nodes.filter((node) => !!node.querySelector(':scope > circle')).length,
      visibleLabels: nodes.filter((node) => !!node.querySelector(':scope > text')).length,
    }
  })()`)
  assert.equal(dense2dState.compactNodes, dense2dState.nodes, `dense 2D graph still renders overlapping cards: ${JSON.stringify(dense2dState)}`)
  assert.ok(dense2dState.visibleLabels <= 20, `dense 2D graph renders too many labels: ${JSON.stringify(dense2dState)}`)
  const graphState = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const select = panel?.querySelector('#context-graph-node')
    return {
      text: panel?.innerText ?? '',
      nodes: [...(select?.options ?? [])].map((option) => ({ value: option.value, text: option.textContent.trim() })),
    }
  })()`)
  const graphMemory = graphState.nodes.find((node) => node.text.includes(revisedMemoryText))
  assert.ok(graphMemory, `transitioned memory is absent from graph nodes: ${JSON.stringify(graphState)}`)
  await evaluate(`(() => {
    const select = document.querySelector('#context-graph-node')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, ${JSON.stringify(graphMemory.value)})
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await waitForValue(`(() => {
    const detail = document.querySelector('[aria-label="图谱详情"]')
    return detail?.textContent.includes('程序记忆') && detail.textContent.includes('85%')
  })()`, 10_000, 'graph reflects transitioned memory')
  const pendingToggleSize = await evaluate(`(() => {
    const input = [...document.querySelectorAll('input[type="checkbox"]')].find((node) => node.parentElement?.textContent.includes('显示待确认关系'))
    const box = input?.getBoundingClientRect()
    return box ? { width: box.width, height: box.height } : null
  })()`)
  assert.ok(pendingToggleSize && pendingToggleSize.width <= 20 && pendingToggleSize.height <= 20, `graph pending toggle is oversized: ${JSON.stringify(pendingToggleSize)}`)
  const graphScreenshot = await capture('agentos-context-graph.png')
  const graph3dActivated = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const button = [...panel.querySelectorAll('button')].find((node) => node.textContent.trim() === '3D 点云')
    button?.click()
    return !!button
  })()`)
  assert.equal(graph3dActivated, true, '3D graph action is missing')
  await waitForValue(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    return panel?.querySelector('[data-context-graph-dimension]')?.getAttribute('data-context-graph-dimension') === '3d' && !!panel.querySelector('canvas')
  })()`, 20_000, '3D WebGL graph')
  const graph3dState = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const canvas = panel?.querySelector('canvas')
    const box = canvas?.getBoundingClientRect()
    if (canvas && box) {
      canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }))
      canvas.dispatchEvent(new PointerEvent('click', { bubbles: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }))
    }
    return {
      dimension: panel?.querySelector('[data-context-graph-dimension]')?.getAttribute('data-context-graph-dimension') ?? null,
      canvas: !!canvas,
      canvasWidth: canvas?.width ?? 0,
      canvasHeight: canvas?.height ?? 0,
      preference: localStorage.getItem('agentos-context.graph-dimension-v2'),
      drawer: !!panel?.querySelector('[aria-label="图谱详情"]'),
      fallback: panel?.textContent.includes('三维图谱暂不可用') ?? false,
    }
  })()`)
  assert.equal(graph3dState.dimension, '3d')
  assert.equal(graph3dState.canvas, true)
  assert.ok(graph3dState.canvasWidth > 0 && graph3dState.canvasHeight > 0, `3D canvas has no rendered size: ${JSON.stringify(graph3dState)}`)
  assert.equal(graph3dState.preference, '3d')
  assert.equal(graph3dState.drawer, true, '3D graph lost the selected-node details drawer')
  assert.equal(graph3dState.fallback, false, `3D graph unexpectedly fell back: ${JSON.stringify(graph3dState)}`)
  const graph3dControls = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const labels = [...(panel?.querySelectorAll('button[aria-label]') ?? [])].map((node) => node.getAttribute('aria-label'))
    const layout = [...(panel?.querySelectorAll('label') ?? [])].find((node) => node.textContent.includes('图谱布局'))?.querySelector('select')
    const hiddenNodes = panel?.querySelectorAll('[data-context-graph-node]').length ?? 0
    return {
      fitAll: labels.includes('适配全部节点'),
      focus: labels.includes('聚焦已选节点和邻居'),
      zoomIn: labels.includes('放大三维图谱'),
      zoomOut: labels.includes('缩小三维图谱'),
      layout: !!layout,
      layoutValue: layout?.value ?? null,
      hiddenNodes,
      navigatorNodes: Math.max(0, (panel?.querySelector('#context-graph-node')?.options.length ?? 1) - 1),
    }
  })()`)
  assert.ok(graph3dControls.fitAll && graph3dControls.focus && graph3dControls.zoomIn && graph3dControls.zoomOut, `3D camera controls are incomplete: ${JSON.stringify(graph3dControls)}`)
  assert.equal(graph3dControls.layout, true, '3D layout selector is missing')
  assert.equal(graph3dControls.hiddenNodes, graph3dControls.navigatorNodes, `3D renderer silently lost nodes: ${JSON.stringify(graph3dControls)}`)
  const layoutChanged = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const select = [...panel.querySelectorAll('label')].find((node) => node.textContent.includes('图谱布局'))?.querySelector('select')
    if (!select) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'structure')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert.equal(layoutChanged, true, '3D layout could not be changed')
  await waitForValue(`document.querySelector('[data-context-graph-layout]')?.getAttribute('data-context-graph-layout') === 'structure'`, 20_000, '3D structure layout')
  assert.ok(graphRpcState.firstEdge, `seeded graph has no relationship for path validation: ${JSON.stringify(graphRpcState)}`)
  const pathInteraction = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const buttons = [...panel.querySelectorAll('[data-context-graph-node]')]
    const source = buttons.find((node) => node.getAttribute('data-context-graph-node') === ${JSON.stringify(graphRpcState.firstEdge?.source)})
    const target = buttons.find((node) => node.getAttribute('data-context-graph-node') === ${JSON.stringify(graphRpcState.firstEdge?.target)})
    source?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
    return { source: !!source, target: !!target }
  })()`)
  assert.ok(pathInteraction.source && pathInteraction.target, `3D accessible nodes cannot select a real edge path: ${JSON.stringify({ pathInteraction, firstEdge: graphRpcState.firstEdge })}`)
  await waitForValue(`document.getElementById('agentos-context-panel-graph')?.textContent.includes('已显示最短路径：2 个节点、1 条关系')`, 10_000, '3D shortest path interaction')
  await evaluate(`document.querySelector('[aria-label="关闭图谱详情"]')?.click()`)
  await waitForValue(`!document.querySelector('[aria-label="图谱详情"]')`, 10_000, 'close graph detail before canvas picking')
  const canvasHitState = await evaluate(`(async () => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const canvas = panel?.querySelector('canvas')
    const box = canvas?.getBoundingClientRect()
    if (!canvas || !box) return { hit: false, reason: 'no-canvas' }
    for (let y = 12; y < box.height - 12; y += 14) {
      for (let x = 12; x < box.width - 12; x += 14) {
        const init = { bubbles: true, clientX: box.left + x, clientY: box.top + y, pointerId: 1, pointerType: 'mouse' }
        canvas.dispatchEvent(new PointerEvent('pointermove', init))
        await new Promise((resolve) => setTimeout(resolve, 0))
        const tooltip = panel.querySelector('[data-context-graph-tooltip]')
        if (!tooltip) continue
        canvas.dispatchEvent(new PointerEvent('pointerdown', init))
        canvas.dispatchEvent(new PointerEvent('pointerup', init))
        await new Promise((resolve) => setTimeout(resolve, 40))
        return { hit: true, x, y, tooltip: tooltip.textContent.trim(), drawer: !!panel.querySelector('[aria-label="图谱详情"]') }
      }
    }
    return { hit: false, reason: 'no-node-hit' }
  })()`)
  assert.equal(canvasHitState.hit, true, `3D canvas node hit area was not reachable: ${JSON.stringify(canvasHitState)}`)
  assert.equal(canvasHitState.drawer, true, `3D canvas hit did not open details: ${JSON.stringify(canvasHitState)}`)
  const graph3dScreenshot = await capture('agentos-context-graph-3d.png')
  const fullscreen3dOpened = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const button = [...panel.querySelectorAll('button')].find((node) => node.textContent.trim() === '全屏探索')
    button?.click()
    return !!button
  })()`)
  assert.equal(fullscreen3dOpened, true, '3D fullscreen action is missing')
  const fullscreen3dState = await waitForValue(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const canvas = panel?.querySelector('canvas')
    const box = canvas?.getBoundingClientRect()
    const exit = [...(panel?.querySelectorAll('button') ?? [])].find((node) => node.textContent.trim() === '退出全屏')
    return exit && box?.width > innerWidth * 0.65 && box?.height > innerHeight * 0.65
      ? { width: box.width, height: box.height }
      : null
  })()`, 10_000, '3D fullscreen canvas')
  const graph3dFullscreenScreenshot = await capture('agentos-context-graph-3d-fullscreen.png')
  await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const button = [...panel.querySelectorAll('button')].find((node) => node.textContent.trim() === '退出全屏')
    button?.click()
    return !!button
  })()`)
  await waitForValue(`[...document.querySelectorAll('#agentos-context-panel-graph button')].some((node) => node.textContent.trim() === '全屏探索')`, 10_000, 'leave 3D fullscreen')

  const allScopeGraphSelected = await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const select = [...(root?.querySelectorAll('select') ?? [])].find((node) => [...node.options].some((option) => option.value === 'agentos-context:all-scopes'))
    if (!select) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'agentos-context:all-scopes')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert.equal(allScopeGraphSelected, true, 'all-scope graph could not be selected')
  try {
    await waitForValue(`(() => {
      const panel = document.getElementById('agentos-context-panel-graph')
      const surface = panel?.querySelector('[data-context-graph-scope="agentos-context:all-scopes"]')
      const status = [...(surface?.querySelectorAll('[role="status"]') ?? [])].map((node) => node.textContent.trim()).find((text) => text.includes('已加载'))
      return !!surface && !surface.textContent.includes('正在读取关系图谱') && !!status
    })()`, 120_000, 'all-scope graph load')
  } catch (error) {
    const state = await evaluate(`(() => {
      const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
      const panel = document.getElementById('agentos-context-panel-graph')
      const surface = panel?.querySelector('[data-context-graph-scope]')
      return {
        scopeSelects: [...(root?.querySelectorAll('select') ?? [])].filter((node) => [...node.options].some((option) => option.value === 'agentos-context:all-scopes')).map((node) => ({ value: node.value, label: node.getAttribute('aria-label') })),
        renderedScope: surface?.getAttribute('data-context-graph-scope') ?? null,
        renderedView: surface?.getAttribute('data-context-graph-view') ?? null,
        statuses: [...(surface?.querySelectorAll('[role="status"]') ?? [])].map((node) => node.textContent.trim()),
        text: (panel?.textContent ?? '').trim().slice(0, 4000),
      }
    })()`)
    const screenshot = await capture('agentos-context-graph-all-scopes-timeout.png')
    throw new Error(`all-scope graph state: ${JSON.stringify({ ...state, screenshot })}`, { cause: error })
  }
  const allScopeAutomaticView = await evaluate(`document.querySelector('#agentos-context-panel-graph [data-context-graph-scope="agentos-context:all-scopes"]')?.getAttribute('data-context-graph-view')`)
  assert.equal(allScopeAutomaticView, 'communities', 'large all-scope graph should open in the less cluttered community view')
  const allScopeCommunityGraphScreenshot = await capture('agentos-context-graph-all-scopes-community-3d.png')
  await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const button = [...panel.querySelectorAll('button')].find((node) => node.textContent.trim() === '节点视图')
    button?.click()
    return !!button
  })()`)
  await waitForValue(`document.querySelector('#agentos-context-panel-graph [data-context-graph-scope="agentos-context:all-scopes"]')?.getAttribute('data-context-graph-view') === 'nodes'`, 20_000, 'all-scope node graph')
  const allScopeGraphState = await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    return {
      nodes: panel?.querySelectorAll('[data-context-graph-node]').length ?? 0,
      status: [...(panel?.querySelectorAll('[role="status"]') ?? [])].map((node) => node.textContent.trim()).find((text) => text.includes('已加载')) ?? null,
      canvas: !!panel?.querySelector('canvas'),
      layout: panel?.querySelector('[data-context-graph-layout]')?.getAttribute('data-context-graph-layout') ?? null,
    }
  })()`)
  assert.ok(allScopeGraphState.nodes > 500, `all-scope graph is still presentation-capped: ${JSON.stringify(allScopeGraphState)}`)
  assert.equal(allScopeGraphState.canvas, true)
  const allScopeGraphScreenshot = await capture('agentos-context-graph-all-scopes-3d.png')
  await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const select = [...root.querySelectorAll('select')].find((node) => [...node.options].some((option) => option.value === 'local:default'))
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'local:default')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await waitForValue(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const select = [...root.querySelectorAll('select')].find((node) => [...node.options].some((option) => option.value === 'local:default'))
    const panel = document.getElementById('agentos-context-panel-graph')
    const surface = panel?.querySelector('[data-context-graph-scope="local:default"]')
    const status = [...(surface?.querySelectorAll('[role="status"]') ?? [])].map((node) => node.textContent.trim()).find((text) => text.includes('已加载'))
    return select?.value === 'local:default' && !!surface && !surface.textContent.includes('正在读取关系图谱') && !!status
  })()`, 30_000, 'restore seeded graph scope')
  await evaluate(`(() => {
    const panel = document.getElementById('agentos-context-panel-graph')
    const button = [...panel.querySelectorAll('button')].find((node) => node.textContent.trim() === '2D 实用')
    button?.click()
    return !!button
  })()`)
  await waitForValue(`!document.getElementById('agentos-context-panel-graph')?.querySelector('canvas')`, 10_000, '3D renderer cleanup')

  await evaluate(`document.getElementById('agentos-context-tab-review')?.click()`)
  await waitForValue(`document.getElementById('agentos-context-panel-review')?.textContent.includes('当前没有待确认关系')`, 30_000, 'review tab data')
  const reviewScreenshot = await capture('agentos-context-review.png')

  await evaluate(`document.getElementById('agentos-context-tab-settings')?.click()`)
  await waitForValue(`document.getElementById('agentos-context-panel-settings')?.textContent.includes('当前能力')`, 30_000, 'settings tab data')
  const settingsScreenshot = await capture('agentos-context-settings.png')

  await evaluate(`document.getElementById('agentos-context-tab-memories')?.click()`)
  await waitForValue(`(() => {
    const panel = document.getElementById('agentos-context-panel-memories')
    return panel && !panel.textContent.includes('\u6b63\u5728\u8bfb\u53d6\u8bb0\u5fc6')
  })()`, 30_000, 'memory reload after tab traversal')
  const workbenchScreenshot = await capture('agentos-context-workbench-wide.png')
  const viewportMatrix = []
  const layoutTabs = [
    ['memories', '记忆'],
    ['knowledge', '知识库'],
    ['graph', '图谱'],
    ['review', '待确认'],
    ['settings', '设置'],
  ]
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 817, height: 826 },
    { width: 760, height: 900 },
  ]) {
    await call('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false })
    await delay(350)
    for (const [tabId, label] of layoutTabs) {
      await evaluate(`document.getElementById(${JSON.stringify('agentos-context-tab-' + tabId)})?.click()`)
      await waitForValue(`!!document.getElementById(${JSON.stringify('agentos-context-panel-' + tabId)})`, 10_000, `${label} tab at ${viewport.width}px`)
      await delay(150)
      viewportMatrix.push(await auditWorkbenchPanel(tabId, `agentos-context-${tabId}-${viewport.width}x${viewport.height}.png`))
    }
  }
  await evaluate(`document.getElementById('agentos-context-tab-memories')?.click()`)
  await delay(300)
  const responsive = await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const box = root?.getBoundingClientRect()
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      rootWidth: box?.width ?? 0,
      rootClientWidth: root?.clientWidth ?? 0,
      rootScrollWidth: root?.scrollWidth ?? 0,
    }
  })()`)
  assert.ok(responsive.rootWidth > 0 && responsive.rootWidth <= responsive.viewport, 'memory workbench exceeds the narrow viewport')
  assert.ok(responsive.documentWidth <= responsive.viewport, 'document has horizontal overflow in the narrow viewport')
  assert.ok(responsive.rootScrollWidth <= responsive.rootClientWidth, 'memory workbench has internal horizontal overflow')
  const narrowScreenshot = await capture('agentos-context-workbench-narrow.png')

  await call('Emulation.clearDeviceMetricsOverride')
  await evaluate(`document.getElementById('agentos-context-tab-memories')?.click()`)
  await waitForValue(`!!document.getElementById('agentos-context-panel-memories')`, 10_000, 'memory cleanup tab')
  await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const item = [...root.querySelectorAll('button')].find((node) => node.textContent.includes(${JSON.stringify(revisedMemoryText)}))
    item?.click()
    return !!item
  })()`)
  await waitForValue(`[...document.querySelectorAll('section[aria-label="agentOS context 记忆工作台"] button')].some((node) => node.textContent.trim() === '停止召回')`, 10_000, 'retire-memory action')
  await evaluate(`(() => {
    const root = document.querySelector('section[aria-label="agentOS context 记忆工作台"]')
    const button = [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === '停止召回')
    button?.click()
    return !!button
  })()`)
  await waitForValue(`document.querySelectorAll('[role="dialog"]').length > 1`, 10_000, 'retire-memory dialog')
  dialogAudits.push(await auditTopDialog('retire-memory', 'agentos-context-dialog-retire.png'))
  await evaluate(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    const dialog = dialogs[dialogs.length - 1]
    const input = dialog.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, 'E2E cleanup')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const submit = [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim() === '确认')
    submit?.click()
    return !!input && !!submit
  })()`)
  await waitForValue(`(() => {
    const panel = document.getElementById('agentos-context-panel-memories')
    const item = [...(panel?.querySelectorAll('button') ?? [])].find((node) => node.textContent.includes(${JSON.stringify(revisedMemoryText)}))
    return item?.textContent.includes('已停用') ?? false
  })()`, 30_000, 'retired memory remains visible in all-status view')
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="状态筛选"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'active')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await waitForValue(`(() => {
    const panel = document.getElementById('agentos-context-panel-memories')
    return panel && ![...panel.querySelectorAll('button')].some((node) => node.textContent.includes(${JSON.stringify(revisedMemoryText)}))
  })()`, 30_000, 'retired memory excluded from active-only view')

  assert.equal(failedResponses.length, 0, `browser requests failed: ${JSON.stringify(failedResponses)}`)
  assert.equal(browserErrors.length, 0, `browser errors occurred: ${JSON.stringify(browserErrors)}`)
  assert.equal(webStderr.includes('[webserver-400]'), false, 'host logged an HTTP bridge failure')
  const report = {
    ok: true,
    profile,
    isolatedOpenContextHome: true,
    seededOpenContextHome: Boolean(seedOpenContextHome),
    isolatedContextStore: true,
    pageUrl: pageUrl.replace(/([?&]token=)[^&]+/, '$1<redacted>'),
    cleanUrl,
    launchMode,
    httpStatus: rootStatus,
    htmlBytes: Buffer.byteLength(html),
    title: page.title,
    hasApp: page.hasApp,
    bodyText: page.text,
    scripts: page.scripts,
    settingsNav,
    onboardingDismissed,
    lateOnboardingDismissed,
    disclaimerDismissed,
    tabIds,
    memoryMutation: {
      saved: true,
      revised: true,
      transitioned: true,
      retired: true,
      layer: 'procedural',
      importance: 0.85,
      text: revisedMemoryText,
    },
    automaticCapture: automaticCaptureState,
    seededChineseSearch: seededChineseSearchState,
    tabData: { knowledge: true, graph: true, review: true, settings: true },
    interactionStates: {
      conversationMemoryState,
      knowledgeFormatsState,
      knowledgeInteractionState,
      graphRangeState,
      graphExploreState,
      graphRpcState,
      communityState,
      expectedAutomaticGraphView,
      dense2dState,
      graph3dState,
      graph3dControls,
      fullscreen3dState,
      pathInteraction,
      canvasHitState,
      allScopeGraphState,
      allScopeAutomaticView,
    },
    legacyCompatibility,
    responsive,
    viewportMatrix,
    dialogAudits,
    screenshots: {
      allScopes: allScopesScreenshot,
      home: homeScreenshot,
      conversationMemorySearch: conversationMemorySearchScreenshot,
      conversationMemoryGraph: conversationMemoryGraphScreenshot,
      config: configScreenshot,
      knowledge: knowledgeScreenshot,
      knowledgeUploaded: knowledgeUploadedScreenshot,
      knowledgeSearch: knowledgeSearchScreenshot,
      knowledgeEvidence: knowledgeEvidenceScreenshot,
      graph: graphScreenshot,
      graph3d: graph3dScreenshot,
      graph3dFullscreen: graph3dFullscreenScreenshot,
      allScopeGraph3d: allScopeGraphScreenshot,
      allScopeCommunityGraph3d: allScopeCommunityGraphScreenshot,
      community: communityScreenshot,
      nodeGraph: nodeGraphScreenshot,
      review: reviewScreenshot,
      settings: settingsScreenshot,
      workbench: workbenchScreenshot,
      narrow: narrowScreenshot,
    },
    failedResponses,
    browserErrors,
    webWarnings: webStderr.trim().split(/\r?\n/).filter(Boolean),
  }
  await writeFile(path.join(destination, 'agentos-context-clean-profile.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  socket.close()
} catch (error) {
  console.error('--- isolated web stdout ---\n' + webStdout)
  console.error('--- isolated web stderr ---\n' + webStderr)
  throw error
} finally {
  await stop(chrome)
  await stop(web)
  await rm(chromeData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  await rm(openContextHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

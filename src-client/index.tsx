/**
 * agentOS context client plugin — native DSH slot registrations.
 *
 * Settings workbench and conversation Memory view share authenticated Connection RPC state;
 * their navigation labels follow the active DSH locale.
 * The graph is rendered with native SVG/CSS, without a separate bundle route。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createOcApi, type OcApi } from './api.ts'
import { createContextApi, type ContextApi } from './context-api.ts'
import type { OpenContextSection } from './ConfigCard.tsx'
import { ContextSettingsSection } from './ContextSettingsSection.tsx'
import { en, zh, type AgentosContextLocaleKey } from './locales.ts'
import { MemoryView } from './MemoryView.tsx'

export const name = 'dsh-agentos-context'
const NS = 'agentos-context'
export const inject = [
  'slots',
  'locale',
  'remote',
  'remote.credentials',
  'configForms',
  'connection',
]

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Navigation copy for the memory settings and Conversation view. */
    'agentos-context': AgentosContextLocaleKey
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agentos-context: dictionaries')
  const t = ctx.locale.bind(NS)
  const styleTags = [
    ...document.querySelectorAll<HTMLStyleElement>(
      'style[data-plugin="@wilshi/dsh-agentos-context"]',
    ),
  ]
  for (const tag of styleTags)
    tag.dataset.pluginUsers = String(
      (Number(tag.dataset.pluginUsers) || 0) + 1,
    )
  ctx.effect(() => () => {
    for (const tag of styleTags) {
      const users = Math.max(0, (Number(tag.dataset.pluginUsers) || 1) - 1)
      if (users === 0) tag.remove()
      else tag.dataset.pluginUsers = String(users)
    }
  })
  const connection: ConnectionHandle | undefined = ctx.get('connection')
  if (typeof connection?.rpc?.call !== 'function')
    throw new Error('agentOS context requires a DSH Connection RPC client')
  const api: OcApi = createOcApi(ctx.remote, connection.rpc)
  const contextApi: ContextApi = createContextApi(connection.rpc)
  ctx.effect(() => () => contextApi.dispose())
  const scope = ctx.configForms.get<OpenContextSection>('dsh-opencontext') as ConfigForm<OpenContextSection>

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'agentos-context',
        order: 35,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({
          api,
          contextApi,
          scope,
          subscribeCredentialsUpdated: (listener: (ref: string) => void) =>
            ctx.remote.$on('credentials/reference-updated', listener),
        }),
      },
      ContextSettingsSection,
    ),
  )

  // conversation.view「记忆」tab（trajectory 先例：order 20 排在内建视图后）
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'opencontext-memory',
        order: 20,
        label: () => t('nav'),
        locale: NS,
        inject: (_sessionId: SessionId) => ({ contextApi }),
      },
      MemoryView,
    ),
  )
}

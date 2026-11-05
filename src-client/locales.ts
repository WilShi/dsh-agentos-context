/** English navigation copy for the agentOS context surfaces. */
export const en = {
  nav: 'Memory',
} as const

/** Locale keys owned by the agentOS context client plugin. */
export type AgentosContextLocaleKey = keyof typeof en

/** Chinese navigation copy for the agentOS context surfaces. */
export const zh: Record<AgentosContextLocaleKey, string> = {
  nav: '记忆',
}

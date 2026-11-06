import { ConfigCard, type ConfigCardFace } from './ConfigCard.tsx'
import { setActiveTranslator, zhT, type AgentosT } from './i18n.ts'

export interface ContextSettingsSectionProps extends ConfigCardFace {
  close: () => void
  /** Locale seat injected by the DSH slot registration (`locale: 'agentos-context'`). */
  t?: AgentosT
}

/** Dedicated first-level memory settings page; no duplicate legacy plugin card. */
export function ContextSettingsSection(props: ContextSettingsSectionProps) {
  // Publish the active seat for nested surfaces and helper modules, then keep the
  // Chinese default when the component is rendered outside a DSH locale.
  setActiveTranslator(props.t ?? zhT)
  return <ConfigCard {...props} />
}

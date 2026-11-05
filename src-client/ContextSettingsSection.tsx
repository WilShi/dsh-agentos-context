import { ConfigCard, type ConfigCardFace } from './ConfigCard.tsx'

export interface ContextSettingsSectionProps extends ConfigCardFace {
  close: () => void
}

/** Dedicated first-level memory settings page; no duplicate legacy plugin card. */
export function ContextSettingsSection(props: ContextSettingsSectionProps) {
  return <ConfigCard {...props} />
}

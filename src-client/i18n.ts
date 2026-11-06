/**
 * Locale plumbing for the agentOS context client.
 *
 * The plugin registers its typed zh/en dictionary with the DSH locale service
 * (`ctx.locale.register`) and the slot system hands each registered surface the
 * namespace-bound `t` seat; the roots publish that seat here through
 * `setActiveTranslator`. Nested surfaces (workbench tabs, modals, graph panels)
 * and pure helper modules then share one `t(key, params?)` entry point instead
 * of threading a translate prop through every component.
 *
 * Copy is Chinese by default: before a DSH locale is installed (unit tests,
 * previews) lookups resolve against `zh`, matching the plugin's historical
 * behavior. An unknown locale falls back to Chinese as well because that is the
 * only complete dictionary the plugin owns.
 */
import { en, zh, type AgentosContextLocaleKey } from './locales.ts'

export type { AgentosContextLocaleKey }
export type AgentosT = (key: AgentosContextLocaleKey, params?: Record<string, unknown>) => string

/** Fill `{name}` placeholders; unknown placeholders stay verbatim. */
export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

/** Build a namespace translate over one dictionary. */
export function createTranslator(dictionary: Record<string, string>): AgentosT {
  return (key, params) => interpolate(dictionary[key] ?? key, params)
}

/** Chinese/default translator; also the fallback when no locale is installed. */
export const zhT = createTranslator(zh)
/** English translator used by the DSH `en` locale. */
export const enT = createTranslator(en)

let activeTranslator: AgentosT = zhT

/** Publish the surface's locale seat (called by slot-registered roots on render). */
export function setActiveTranslator(translator: AgentosT): void {
  activeTranslator = translator
}

/** Restore the default Chinese translator (tests / unmounted roots). */
export function resetTranslator(): void {
  activeTranslator = zhT
}

/** Current translator, for code that must resolve the seat lazily. */
export function activeT(): AgentosT {
  return activeTranslator
}

/** Translate through the active locale. */
export const t: AgentosT = (key, params) => activeTranslator(key, params)

/**
 * Lazy label map backed by dictionary keys: preserves the existing
 * `labelMap[key]` call sites while resolving the active locale at access time.
 */
export function localized<T extends string>(prefix: string): Record<T, string> & Record<string, string | undefined> {
  return new Proxy({} as Record<T, string> & Record<string, string | undefined>, {
    get: (_target, key) =>
      typeof key === 'string' ? t(`${prefix}.${key}` as AgentosContextLocaleKey) : undefined,
  })
}

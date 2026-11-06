/**
 * Inline stand-ins for the internal `@deepseek-ai/dsh-client-ui-primitives`
 * package (removed from the public DSH 0.2.1-rc.5 client surface).
 *
 * Only the four components this plugin actually uses are provided here:
 * Button / Tag / Switch / Modal. Keep the public props compatible with the
 * upstream primitives so the 9 import sites do not change shape. Styles are
 * injected once and follow the host's `--dsw-*` semantic tokens with sensible
 * dark-theme fallbacks.
 */
import {
  useEffect,
  useId,
  useRef,
  type ComponentPropsWithoutRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { t } from './i18n.ts'

let styleInstalled = false

const CSS = `
.oc-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;max-width:100%;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(120,150,180,.4));background:transparent;color:var(--dsw-alias-label-primary,#e2f4ff);font:inherit;line-height:1.4;padding:6px 12px;cursor:pointer;transition:background .15s ease,border-color .15s ease,opacity .15s ease;white-space:nowrap}
.oc-btn:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3,#1b2940) 72%,transparent)}
.oc-btn:focus-visible{outline:2px solid var(--dsw-alias-accent,#8acded);outline-offset:1px}
.oc-btn:disabled{opacity:.5;cursor:not-allowed}
.oc-btn-sm{padding:3px 8px;font-size:12px;border-radius:7px}
.oc-btn-primary{border-color:var(--dsw-alias-accent,#6999b8);background:var(--dsw-alias-bg-layer-2,#15344b);color:var(--dsw-alias-label-primary,#e6f7ff)}
.oc-btn-primary:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#15344b) 78%,#8acded)}
.oc-btn-outline{border-color:var(--dsw-alias-border-l2,rgba(120,150,180,.4));background:transparent;color:var(--dsw-alias-label-secondary,#c4dcee)}
.oc-btn-outline:hover{color:var(--dsw-alias-label-primary,#e6f7ff)}
.oc-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary,#b7cadb);padding:5px 8px}
.oc-btn-ghost:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3,#1b2940) 64%,transparent);color:var(--dsw-alias-label-primary,#e6f7ff)}
.oc-btn-toolbar{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary,#b7cadb);padding:4px 7px;font-size:12px}
.oc-btn-toolbar:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3,#1b2940) 64%,transparent);color:var(--dsw-alias-label-primary,#e6f7ff)}
.oc-tag{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:1px 8px;border-radius:999px;border:1px solid transparent;font-size:12px;line-height:1.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.oc-tag-neutral{background:var(--dsw-alias-bg-layer-3,rgba(120,150,180,.16));color:var(--dsw-alias-label-secondary,#b7cadb);border-color:var(--dsw-alias-border-l2,rgba(120,150,180,.22))}
.oc-tag-info{background:color-mix(in srgb,#3f9dd8 18%,transparent);color:#9ed7ff;border-color:color-mix(in srgb,#3f9dd8 40%,transparent)}
.oc-tag-success{background:color-mix(in srgb,#49c08a 18%,transparent);color:#9ff0c6;border-color:color-mix(in srgb,#49c08a 40%,transparent)}
.oc-tag-warning{background:color-mix(in srgb,#d8a13f 20%,transparent);color:#ffdfa3;border-color:color-mix(in srgb,#d8a13f 44%,transparent)}
.oc-tag-danger{background:color-mix(in srgb,#d9534f 20%,transparent);color:#ffc9c4;border-color:color-mix(in srgb,#d9534f 44%,transparent)}
.oc-tag-outline{background:transparent;color:var(--dsw-alias-label-secondary,#b7cadb);border-color:var(--dsw-alias-border-l2,rgba(120,150,180,.4))}
.oc-switch{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;color:var(--dsw-alias-label-secondary,#b7cadb);font:inherit}
.oc-switch input{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.oc-switch-track{position:relative;width:34px;height:18px;flex:none;border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(120,150,180,.28));border:1px solid var(--dsw-alias-border-l2,rgba(120,150,180,.3));transition:background .18s ease,border-color .18s ease}
.oc-switch-knob{position:absolute;top:1px;left:1px;width:14px;height:14px;border-radius:50%;background:#dfeaf4;transition:transform .18s ease}
.oc-switch input:checked + .oc-switch-track{background:color-mix(in srgb,#4f9fd8 62%,transparent);border-color:#8acded}
.oc-switch input:checked + .oc-switch-track .oc-switch-knob{transform:translateX(16px);background:#f3fbff}
.oc-switch input:focus-visible + .oc-switch-track{outline:2px solid #8acded;outline-offset:2px}
.oc-switch[data-disabled="true"]{opacity:.55;cursor:not-allowed}
.oc-modal-root{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(3,6,12,.66);backdrop-filter:blur(2px)}
.oc-modal-root[data-backdrop-blur="false"]{backdrop-filter:none}
.oc-modal{box-sizing:border-box;display:flex;flex-direction:column;max-height:min(820px,calc(100vh - 48px));width:min(720px,calc(100vw - 48px));border-radius:18px;border:1px solid var(--dsw-alias-border-l2,rgba(120,160,200,.3));background:var(--dsw-alias-bg-layer-1,#0b1624);color:var(--dsw-alias-label-primary,#e8f4ff);box-shadow:0 28px 90px rgba(0,0,0,.55);overflow:hidden}
.oc-modal-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 10px}
.oc-modal-heading{flex:1 1 auto;min-width:0}
.oc-modal-title{margin:0;font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,#e8f4ff)}
.oc-modal-desc{margin:6px 0 0;color:var(--dsw-alias-label-secondary,#9fb7ce);font-size:13px;line-height:1.55}
.oc-modal-close{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#93a9bd);font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px}
.oc-modal-close:hover{background:var(--dsw-alias-bg-layer-3,rgba(120,150,180,.18));color:var(--dsw-alias-label-primary,#e8f4ff)}
.oc-modal-body{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 20px 18px}
.oc-modal-foot{display:flex;justify-content:flex-end;gap:10px;padding:12px 20px 16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(120,160,200,.16))}
.oc-modal:focus{outline:none}
@media (prefers-reduced-motion:reduce){.oc-btn,.oc-switch-track,.oc-switch-knob{transition:none}}
`

function installStyles(): void {
  if (styleInstalled || typeof document === 'undefined') return
  try {
    if (document.querySelector('style[data-oc-ui-primitives]') !== null) {
      styleInstalled = true
      return
    }
    const tag = document.createElement('style')
    tag.dataset.ocUiPrimitives = ''
    tag.textContent = CSS
    document.head.appendChild(tag)
    styleInstalled = true
  } catch {
    // 无 DOM（单测/SSR）时跳过样式注入，组件仍以浏览器默认样式渲染。
  }
}

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'toolbar'
export interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  /**
   * Redeclared explicitly: this plugin ships compiled, and some consumer trees
   * type-check without @types/react, where ComponentPropsWithoutRef resolves to
   * an empty type and native attributes would disappear from the public props.
   */
  children?: ReactNode
  className?: string
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  id?: string
  title?: string
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void
}

export function Button({ variant = 'outline', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  installStyles()
  const classes = ['oc-btn', 'oc-btn-' + variant, size === 'sm' ? 'oc-btn-sm' : '', className]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join(' ')
  return <button type={type} className={classes} {...rest} />
}

export type TagTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'outline'
export interface TagProps extends ComponentPropsWithoutRef<'span'> {
  tone?: TagTone
  /** Redeclared for @types/react-free consumer trees (see ButtonProps). */
  children?: ReactNode
  className?: string
  title?: string
}

export function Tag({ tone = 'neutral', className, children, ...rest }: TagProps) {
  installStyles()
  const classes = ['oc-tag', 'oc-tag-' + tone, className]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join(' ')
  return <span className={classes} {...rest}>{children}</span>
}

export interface SwitchProps {
  checked: boolean
  disabled?: boolean
  label?: ReactNode
  className?: string
  id?: string
  onChange: (checked: boolean) => void
}

export function Switch({ checked, disabled = false, label, className, id, onChange }: SwitchProps) {
  installStyles()
  const generated = useId()
  const inputId = id ?? generated
  const classes = ['oc-switch', className].filter((value) => typeof value === 'string' && value.length > 0).join(' ')
  return (
    <label className={classes} data-disabled={disabled ? 'true' : 'false'}>
      {label !== undefined ? <span>{label}</span> : null}
      <input
        id={inputId}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        onChange={(event) => {
          if (!disabled) onChange(event.target.checked)
        }}
      />
      <span className="oc-switch-track" aria-hidden="true"><span className="oc-switch-knob" /></span>
    </label>
  )
}

/**
 * Open-dialog stack (bottom → top). Escape and Tab are handled by the topmost
 * dialog only, so nested dialogs no longer close together. Each entry is the
 * `useId()` of one mounted Modal.
 */
const modalStack: string[] = []

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Focusable descendants of one dialog, in DOM order. */
function focusableWithin(panel: HTMLElement | null): HTMLElement[] {
  if (panel === null) return []
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    element =>
      element.getAttribute('aria-hidden') !== 'true' &&
      // Compare the attribute rather than the `tabIndex` property: some DOM
      // shims report -1 for native buttons, which would empty the trap.
      element.getAttribute('tabindex') !== '-1',
  )
}

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
  contentClassName?: string
  closeLabel?: string
  headless?: boolean
  shortcutModal?: boolean
  backdropBlur?: boolean
  onKeyDownCapture?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  contentClassName,
  closeLabel = t('common.close'),
  headless = false,
  shortcutModal,
  backdropBlur = true,
  onKeyDownCapture,
}: ModalProps) {
  installStyles()
  const modalId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Keep the latest handler without making it an effect dependency: callers pass
  // inline closures, and re-running the effect would restore/re-take focus on
  // every parent render.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined
    const previousActive =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    modalStack.push(modalId)
    const panel = panelRef.current
    const initial = focusableWithin(panel)[0] ?? panel
    try {
      initial?.focus({ preventScroll: true })
    } catch {
      // Non-focusable panel (headless body without tabs): keep the host focus.
    }
    const onKey = (event: KeyboardEvent): void => {
      // Only the topmost dialog reacts; the bottom one stays inert.
      if (modalStack[modalStack.length - 1] !== modalId) return
      if (event.key === 'Escape') {
        // stopImmediatePropagation: every open Modal listens in capture on the
        // same document, so stopPropagation alone would still reach the others.
        event.preventDefault()
        event.stopImmediatePropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const panelNode = panelRef.current
      if (panelNode === null) return
      const items = focusableWithin(panelNode)
      if (items.length === 0) {
        event.preventDefault()
        panelNode.focus({ preventScroll: true })
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      const inside = active !== null && panelNode.contains(active)
      if (event.shiftKey ? active === first || !inside : active === last || !inside) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      const index = modalStack.lastIndexOf(modalId)
      if (index >= 0) modalStack.splice(index, 1)
      // Return focus to the opener when it is still connected.
      if (previousActive !== null && document.contains(previousActive)) {
        try {
          previousActive.focus({ preventScroll: true })
        } catch {
          // The opener disappeared between open and close.
        }
      }
    }
  }, [open, modalId])

  if (!open) return null
  const panelClass = ['oc-modal', className].filter((value) => typeof value === 'string' && value.length > 0).join(' ')
  const bodyClass = ['oc-modal-body', contentClassName].filter((value) => typeof value === 'string' && value.length > 0).join(' ')
  const closeOnBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }
  return (
    <div
      className="oc-modal-root"
      data-backdrop-blur={backdropBlur ? 'true' : 'false'}
      data-shortcut-modal={shortcutModal ? 'true' : 'false'}
      onMouseDown={closeOnBackdrop}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={panelClass}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onMouseDown={(event) => { event.stopPropagation() }}
        onKeyDownCapture={onKeyDownCapture}
      >
        {headless ? null : (
          <div className="oc-modal-head">
            <div className="oc-modal-heading">
              {title !== undefined ? <h2 className="oc-modal-title">{title}</h2> : null}
              {description !== undefined ? <p className="oc-modal-desc">{description}</p> : null}
            </div>
            <button type="button" className="oc-modal-close" aria-label={closeLabel} onClick={onClose}>×</button>
          </div>
        )}
        <div className={bodyClass}>{children}</div>
        {headless || footer === undefined ? null : <div className="oc-modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

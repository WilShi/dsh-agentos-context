import type { ComponentProps } from 'react'
import { Modal } from './ui-primitives.tsx'
import styles from './ContextModal.module.css'

type ModalProps = ComponentProps<typeof Modal>
type AdaptedModalProps<T> = T extends ModalProps
  ? Omit<T, 'className' | 'description'> & {
    className?: string | undefined
    description?: string | undefined
    size?: 'compact' | 'standard'
  }
  : never
type Props = AdaptedModalProps<ModalProps>
export function ContextModal(props: Props) {
  const size = props.size ?? 'standard'
  const dialogClassName = [
    styles.dialog,
    size === 'compact' ? styles.compact : styles.standard,
    props.className,
  ]
    .filter(Boolean)
    .join(' ')
  const scrollClassName = [styles.content, props.contentClassName]
    .filter(Boolean)
    .join(' ')
  const shared = {
    open: props.open,
    onClose: props.onClose,
    title: props.title,
    className: dialogClassName,
    contentClassName: scrollClassName,
    ...(props.description !== undefined
      ? { description: props.description }
      : {}),
    ...(props.children !== undefined ? { children: props.children } : {}),
    ...(props.footer !== undefined ? { footer: props.footer } : {}),
    ...(props.shortcutModal !== undefined
      ? { shortcutModal: props.shortcutModal }
      : {}),
    ...(props.onKeyDownCapture !== undefined
      ? { onKeyDownCapture: props.onKeyDownCapture }
      : {}),
    ...(props.backdropBlur !== undefined
      ? { backdropBlur: props.backdropBlur }
      : {}),
  }
  return props.headless ? (
    <Modal {...shared} headless />
  ) : (
    <Modal {...shared} headless={false} closeLabel={props.closeLabel} />
  )
}

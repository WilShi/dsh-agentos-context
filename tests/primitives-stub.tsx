import React from 'react'
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string
  size?: string
  icon?: React.ReactNode
}
type TagProps = React.HTMLAttributes<HTMLSpanElement> & { tone?: string }
type SwitchProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}
interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  closeLabel: string
  description?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
}
export function Button({ variant:_v,size:_s,icon,children,...props }:ButtonProps){return <button {...props}>{icon}{children}</button>}
export function Tag({ tone:_t,children,...props }:TagProps){return <span {...props}>{children}</span>}
export function Switch({ checked,onChange,label,disabled,...props }:SwitchProps){return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={()=>{onChange(!checked)}} {...props}/>}
export function Modal({ open,onClose,title,closeLabel,description,children,footer }:ModalProps){
  const dialog=React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(()=>{
    const element=dialog.current
    if(!open||element===null)return
    const previous=document.activeElement
    const focusable=()=>[...element.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')]
    ;(focusable()[0]??element).focus()
    const keydown=(event:KeyboardEvent)=>{
      if(event.key!=='Tab')return
      const items=focusable(),first=items[0]??element,last=items.at(-1)??element
      if(!element.contains(document.activeElement)||(event.shiftKey?document.activeElement===first:document.activeElement===last)){
        event.preventDefault()
        ;(event.shiftKey?last:first).focus()
      }
    }
    document.addEventListener('keydown',keydown)
    return()=>{
      document.removeEventListener('keydown',keydown)
      if(previous instanceof HTMLElement&&previous.isConnected)previous.focus()
    }
  },[open])
  if(!open)return null
  return <div ref={dialog} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><button aria-label={closeLabel} onClick={onClose}/><h2>{title}</h2>{description&&<p>{description}</p>}{children}{footer}</div>
}

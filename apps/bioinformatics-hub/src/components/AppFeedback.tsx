import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle, Warning, X } from '@phosphor-icons/react'
import { GlassPanel } from './GlassPanel'

type Props = {
  error: string
  notice: string
  onDismissError: () => void
  onDismissNotice: () => void
}

const NOTICE_DURATION_MS = 2600

export function AppFeedback({ error, notice, onDismissError, onDismissNotice }: Props) {
  const titleId = useId()
  const messageId = useId()
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!error) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onDismissError()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [error, onDismissError])

  useEffect(() => {
    if (!notice || error) return
    const timer = window.setTimeout(onDismissNotice, NOTICE_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [error, notice, onDismissNotice])

  if (typeof document === 'undefined') return null

  return createPortal(
    <>
      {error && (
        <div className="feedback-scrim">
          <div
            className="feedback-dialog-shell"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={messageId}
          >
            <GlassPanel nativeMaterial className="feedback-dialog" padding="clamp(20px, 4vw, 30px)" cornerRadius={30} elasticity={0}>
              <div className="feedback-dialog-content">
                <span className="feedback-icon fail" aria-hidden="true"><Warning weight="fill" /></span>
                <div className="feedback-copy">
                  <p className="eyebrow">ATTENTION</p>
                  <h2 id={titleId}>需要处理</h2>
                  <p id={messageId}>{error}</p>
                </div>
                <button ref={closeButtonRef} className="btn primary feedback-dismiss" type="button" onClick={onDismissError}>知道了</button>
              </div>
            </GlassPanel>
          </div>
        </div>
      )}
      {!error && notice && (
        <div className="feedback-toast-shell" role="status" aria-live="polite" aria-atomic="true">
          <GlassPanel nativeMaterial className="feedback-toast" padding="14px 16px" cornerRadius={22} elasticity={0}>
            <div className="feedback-toast-content">
              <CheckCircle weight="fill" aria-hidden="true" />
              <span>{notice}</span>
              <button className="feedback-toast-close" type="button" onClick={onDismissNotice} aria-label="关闭提示"><X /></button>
            </div>
          </GlassPanel>
        </div>
      )}
    </>,
    document.body,
  )
}

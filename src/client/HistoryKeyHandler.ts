import { useEffect, useRef } from 'react'
import { extractHistoryEntries, type ConversationHistorySource } from '../core/history-extraction.ts'
import { HistoryNavigator } from '../core/history-navigation.ts'

interface HistoryKeyHandlerProps {
  readonly session: ConversationHistorySource
  readonly inputActions: {
    setDraft(text: string): void
  }
}

function isDshComposerTextarea(target: EventTarget | null): target is HTMLTextAreaElement {
  if (!(target instanceof HTMLTextAreaElement)) return false
  if (!target.matches('textarea[data-phase]')) return false
  if (target.closest('[data-composer-seat]') === null) return false
  return target.parentElement?.querySelector('[data-input-mirror]') !== null
}

function restoreCaretAtEnd(textarea: HTMLTextAreaElement, text: string): void {
  requestAnimationFrame(() => {
    if (!textarea.isConnected) return
    try {
      textarea.setSelectionRange(text.length, text.length)
      textarea.scrollTop = textarea.scrollHeight
    } catch (error) {
      console.error('[dsh-air] failed to restore composer caret', error)
    }
  })
}

/** Handle sent-message history keys for one conversation session. */
export function HistoryKeyHandler({ session, inputActions }: HistoryKeyHandlerProps): null {
  const navigatorRef = useRef<HistoryNavigator | null>(null)
  const entries = extractHistoryEntries(session)

  if (navigatorRef.current === null) navigatorRef.current = new HistoryNavigator(entries)
  else navigatorRef.current.replaceHistory(entries)

  useEffect(() => {
    const navigator = navigatorRef.current
    if (navigator === null) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      if (!isDshComposerTextarea(event.target)) return

      const textarea = event.target
      if (textarea.disabled || textarea.readOnly) return

      const result = navigator.navigate(event.key === 'ArrowUp' ? 'up' : 'down', {
        draft: textarea.value,
        selectionStart: textarea.selectionStart ?? textarea.value.length,
        selectionEnd: textarea.selectionEnd ?? textarea.value.length,
      })
      if (!result.handled) return

      event.preventDefault()
      inputActions.setDraft(result.text)
      restoreCaretAtEnd(textarea, result.text)
    }

    // Bubble phase is intentional: DSH's own React handler gets first chance to
    // consume ArrowUp/ArrowDown for slash/reference menus via preventDefault().
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [inputActions])

  return null
}

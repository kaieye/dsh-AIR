import { useEffect, useRef } from 'react'
import type {
  ConversationSnapshot,
  SessionId,
  UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  draftSnapshotForNode,
  type DraftSnapshot,
} from '../core/draft-snapshot.ts'
import {
  draftHistoryStorageKey,
  findRichSnapshot,
  parseDraftHistory,
} from '../core/draft-persistence.ts'
import { ForkEditController } from './ForkEditController.ts'

interface ForkEditEnhancerProps {
  readonly sessionId: SessionId
  readonly session: ConversationSnapshot
  readonly forkEdit: ForkEditController
}

function storedSnapshot(sessionId: SessionId, fallback: DraftSnapshot): DraftSnapshot {
  try {
    const entries = parseDraftHistory(window.localStorage.getItem(draftHistoryStorageKey(sessionId)))
    return entries.find((entry) => entry.id === fallback.id)
      ?? findRichSnapshot(entries, fallback)
      ?? fallback
  } catch {
    return fallback
  }
}

function editBranchIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = '<path d="M3 2.5v4A2.5 2.5 0 0 0 5.5 9H8m-5-6.5 2 2m-2-2-2 2M9.2 12.8l.35-1.75 3.9-3.9a.85.85 0 0 1 1.2 1.2l-3.9 3.9-1.55.55Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>'
  return svg
}

/** Adds an edit-aware branch action beside DSH's existing copy action. */
export function ForkEditEnhancer({ sessionId, session, forkEdit }: ForkEditEnhancerProps): JSX.Element {
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const scope = root.closest('[data-conversation-scroll]') ?? document.body
    const installed = new Set<HTMLButtonElement>()

    const enhance = (): void => {
      for (const row of scope.querySelectorAll<HTMLElement>('[data-chat-flow-kind="user"][data-chat-anchor-key]')) {
        if (row.querySelector('[data-dsh-air-fork-edit]') !== null) continue
        const key = row.dataset.chatAnchorKey
        if (key === undefined) continue
        const routed = session.chat.nodes.get(key)
        if (routed?.kind !== 'user') continue
        const data = routed.data as UserMessageNode
        const fallback = draftSnapshotForNode(data)
        if (fallback === null) continue
        const firstAction = row.querySelector<HTMLButtonElement>('button')
        const actions = firstAction?.parentElement
        if (firstAction === null || actions == null) continue

        const button = document.createElement('button')
        button.type = 'button'
        button.className = firstAction.className
        button.dataset.dshAirForkEdit = 'true'
        button.title = '分支并编辑此问题'
        button.setAttribute('aria-label', '分支并编辑此问题')
        button.append(editBranchIcon())
        button.addEventListener('click', async (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (button.disabled) return
          button.disabled = true
          button.setAttribute('aria-busy', 'true')
          const snapshot = storedSnapshot(sessionId, fallback)
          try {
            await forkEdit.forkAndEdit(sessionId, data.seq, snapshot)
          } finally {
            button.disabled = false
            button.removeAttribute('aria-busy')
          }
        })
        actions.append(button)
        installed.add(button)
      }
    }

    enhance()
    const observer = new MutationObserver(enhance)
    observer.observe(scope, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      for (const button of installed) button.remove()
    }
  }, [forkEdit, session, sessionId])

  return <span ref={rootRef} hidden aria-hidden="true" />
}

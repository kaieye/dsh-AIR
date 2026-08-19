// @vitest-environment jsdom
// Scratch integration probe for HistoryKeyHandler's ArrowUp/ArrowDown handling.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HistoryKeyHandler } from '../src/client/HistoryKeyHandler.tsx'
import type { LargePasteController } from '../src/client/LargePasteController.ts'
import type { DraftSnapshot } from '../src/core/draft-snapshot.ts'
import { snapshot } from './helpers/btw-harness.ts'
import { HistoryNavigator } from '../src/core/history-navigation.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

function userNode(seq: number, text: string): unknown {
  return {
    kind: 'user',
    seq,
    time: seq * 1000,
    content: [{ type: 'text', text }],
    source: null,
  }
}

function mountComposer(historyTexts: string[], draft = '') {
  // Composer DOM lives OUTSIDE the React root (sibling in the real app).
  const host = document.createElement('div')
  host.innerHTML = `
    <div data-composer-seat>
      <div class="grow">
        <textarea data-phase="plain"></textarea>
        <div data-input-mirror></div>
      </div>
    </div>
  `
  document.body.appendChild(host)
  const textarea = host.querySelector('textarea') as HTMLTextAreaElement
  textarea.value = draft

  const container = document.createElement('div')
  document.body.appendChild(container)

  const sessionId = 's1' as SessionId
  const session = snapshot(sessionId, {
    nodes: historyTexts.map((text, i) => userNode(i + 1, text)) as unknown as ConversationSnapshot['nodes'],
  })
  const input = {
    draft,
    draftRev: 0,
    phase: 'plain' as const,
    imageIds: [],
    occurrences: [],
  }
  const inputActions = { setDraft: vi.fn<(text: string) => void>() }
  const setDraft = inputActions.setDraft

  const restored: string[] = []
  const paste = {
    restoreSnapshot: vi.fn(async (sid: SessionId, snap: DraftSnapshot) => {
      restored.push(snap.text)
      return true
    }),
    restoreLocalSnapshot: vi.fn(async () => true),
    payloadOf: () => undefined,
  } as unknown as LargePasteController

  const root = createRoot(container)
  return { root, host, container, textarea, sessionId, session, input, inputActions, paste, restored, setDraft }
}

function dispatchKey(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

describe('HistoryKeyHandler ArrowUp integration probe', () => {
  let cleanup: Array<() => void> = []

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await act(async () => fn())
    document.body.innerHTML = ''
  })

  it('recalls newest sent message on ArrowUp in an empty composer', async () => {
    const m = mountComposer(['first', 'second', 'third'])
    cleanup.push(() => m.root.unmount())

    const navigateSpy = vi.spyOn(HistoryNavigator.prototype, 'navigate')

    const reachedDocument: string[] = []
    const docSpy = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') reachedDocument.push('up')
      if (e.key === 'ArrowDown') reachedDocument.push('down')
    }
    document.addEventListener('keydown', docSpy)
    cleanup.push(() => document.removeEventListener('keydown', docSpy))

    await act(async () => {
      m.root.render(
        <HistoryKeyHandler
          session={m.session as never}
          input={m.input as never}
          inputActions={m.inputActions as never}
          paste={m.paste}
        />,
      )
    })

    m.textarea.focus()
    await act(async () => {
      dispatchKey(m.textarea, { key: 'ArrowUp' })
    })

    console.log('[probe] isConnected =', m.textarea.isConnected)
    console.log('[probe] reachedDocument =', reachedDocument)
    console.log('[probe] navigate calls =', navigateSpy.mock.calls)
    console.log('[probe] restored =', m.restored)

    expect(m.restored).toEqual(['third'])
  })
})

// @vitest-environment jsdom
// Scratch: full-path probe — HistoryKeyHandler + REAL LargePasteController.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HistoryKeyHandler } from '../src/client/HistoryKeyHandler.tsx'
import { LargePasteController } from '../src/client/LargePasteController.ts'
import { snapshot } from './helpers/btw-harness.ts'

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

interface FakeInputState {
  draft: string
  draftRev: number
  occurrences: never[]
  imageIds: unknown[]
}

describe('full path with real LargePasteController', () => {
  let cleanup: Array<() => void> = []
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await act(async () => fn())
    document.body.innerHTML = ''
  })

  it('ArrowUp recalls via real paste.restoreSnapshot -> input.setDraft', async () => {
    const sessionId = 's1' as SessionId
    const host = document.createElement('div')
    host.innerHTML = `
      <div data-composer-seat>
        <div class="grow">
          <textarea data-phase="plain"></textarea>
          <div data-input-mirror></div>
        </div>
      </div>`
    document.body.appendChild(host)
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement

    const rootHost = document.createElement('div')
    document.body.appendChild(rootHost)

    const session = snapshot(sessionId, {
      nodes: [userNode(1, 'first'), userNode(2, 'second'), userNode(3, 'third')] as unknown as ConversationSnapshot['nodes'],
    })

    // Fake input machine state + the shell `setDraft` write path.
    const machine: FakeInputState = { draft: '', draftRev: 0, occurrences: [], imageIds: [] }
    const setDraftCalls: string[] = []
    const fakeInput = {
      state: {
        getSnapshot: () => machine,
        subscribe: () => () => {},
      },
      setDraft(text: string) {
        machine.draft = text
        machine.draftRev += 1
        setDraftCalls.push(text)
      },
      addImages: () => true,
      removeImage: () => {},
      notify: () => {},
    }
    const scoped = { get: () => undefined }
    const ctx = {
      sessions: {
        scope: (id: SessionId) => (id === sessionId ? scoped : undefined),
      },
      conversation: {
        input: {
          for: (s: unknown) => (s === scoped ? fakeInput : undefined),
        },
      },
    } as unknown as ConstructorParameters<typeof LargePasteController>[0]

    const paste = new LargePasteController(ctx)

    const input = {
      draft: '',
      draftRev: 0,
      phase: 'plain' as const,
      imageIds: [] as unknown[],
      occurrences: [] as never[],
    }
    const inputActions = { setDraft: vi.fn() }

    const root = createRoot(rootHost)
    cleanup.push(() => root.unmount())
    await act(async () => {
      root.render(
        <HistoryKeyHandler
          session={session as never}
          input={input as never}
          inputActions={inputActions as never}
          paste={paste}
        />,
      )
    })

    textarea.focus()
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    })

    console.log('[probe] setDraftCalls =', setDraftCalls)
    expect(setDraftCalls).toEqual(['third'])
  })
})

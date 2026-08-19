// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  HostObservable,
  SessionProvideInfo,
  SlotRendererHost,
  StoredEntry,
} from '@deepseek-ai/dsh-client-ui-slots'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createBtwConversationSurface } from '../src/client/BtwNativeConversation.tsx'
import { btwInitialPrompt } from '../src/core/btw-boundary.ts'
import { snapshot } from './helpers/btw-harness.ts'

declare global {
  // React 18 uses this flag to enable act() environment warnings in non-RTL setups.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

function observable<T>(value: T): HostObservable<T> {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
  }
}

function ConversationProbe(props: Record<string, unknown>): JSX.Element {
  const useSession = props.useSession as <T>(selector: (value: ConversationSnapshot) => T) => T
  const useInput = props.useInput as <T>(selector: (value: { queue: ConversationSnapshot['queue'] }) => T) => T
  const renderSlot = props.renderSlot as (key: string, owner: object) => React.ReactNode
  const userText = useSession((state) => {
    const user = state.nodes.find((node) => node.kind === 'user') as unknown as { content?: readonly { text?: string }[] } | undefined
    return user?.content?.find((part) => typeof part.text === 'string')?.text ?? ''
  })
  const queuedText = useInput((state) => state.queue[0]?.text ?? '')

  return (
    <section
      data-probe-session={String(props.sessionId)}
      data-user-text={userText}
      data-queue-text={queuedText}
    >
      {renderSlot('conversation.input.dock', {})}
    </section>
  )
}

function DockProbe({ label }: { label: string }): JSX.Element {
  return <span>{label}</span>
}

describe('BTW native conversation renderer bridge', () => {
  it('renders the host conversation tree against the child without changing global selection', async () => {
    const envelope = btwInitialPrompt('visible child question', 'hidden parent context')
    const childSnapshot = snapshot('child', {
      nodes: [{ kind: 'user', seq: 1, content: [{ type: 'text', text: envelope }] } as never],
      queue: [{
        id: 'queue-1',
        messageId: 'message-1',
        placement: 'queued',
        content: [{ type: 'text', text: envelope }],
        preview: envelope,
        text: envelope,
      }] as unknown as ConversationSnapshot['queue'],
    })
    const childInfo: SessionProvideInfo = {
      sessionId: 'child',
      hooks: {
        session: observable(childSnapshot),
        input: observable({ queue: childSnapshot.queue }),
      },
      props: { inputActions: {} },
    }
    const conversationSpec = { kind: 'single', scope: 'session-maybe' } as const
    const dockSpec = { kind: 'list', scope: 'session' } as const
    const conversationEntry: StoredEntry = {
      component: ConversationProbe,
      options: {},
      children: { 'conversation.input.dock': dockSpec },
      registrant: 'host-conversation',
    }
    const nestedPanel: StoredEntry = {
      component: () => <DockProbe label="nested BTW panel" />,
      options: { id: 'dsh-air-btw-panel' },
      registrant: 'dsh-air',
    }
    const ordinaryDock: StoredEntry = {
      component: () => <DockProbe label="ordinary native dock" />,
      options: { id: 'ordinary-dock' },
      registrant: 'host-dock',
    }
    const entries = new Map<string, readonly StoredEntry[]>([
      ['conversation', [conversationEntry]],
      ['conversation.input.dock', [nestedPanel, ordinaryDock]],
    ])
    const specs = new Map<string, { kind: 'single' | 'list'; scope: 'session-maybe' | 'session' }>([
      ['conversation', conversationSpec],
      ['conversation.input.dock', dockSpec],
    ])
    const selected = observable({ current: 'parent', byId: {} })
    const baseHost: SlotRendererHost = {
      subscribe: () => () => {},
      getVersion: () => 0,
      entriesOf: (key) => entries.get(key) ?? [],
      entriesOfSlot: (key) => entries.get(key) ?? [],
      reportEntryError: vi.fn(),
      specOf: (key) => specs.get(key),
      isLive: () => true,
      storeOf: () => undefined,
      sessions: {
        list: selected,
        provideInfo: observable({ sessionId: 'parent', hooks: {}, props: {} }),
      },
      workspaces: {
        list: observable({ items: [] }),
      },
      locale: undefined,
    }
    const ctx = {
      slots: { hostFace: () => baseHost },
      sessions: { provideInfo: (id: SessionId) => id === 'child' ? childInfo : undefined },
    } as unknown as Context

    const surface = createBtwConversationSurface(ctx)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(surface.render('child' as SessionId))
    })

    try {
      expect(container.innerHTML).toContain('data-probe-session="child"')
      expect(container.innerHTML).toContain('data-user-text="visible child question"')
      expect(container.innerHTML).toContain('data-queue-text="visible child question"')
      expect(container.textContent).toContain('ordinary native dock')
      expect(container.textContent).not.toContain('nested BTW panel')
      expect(container.textContent).not.toContain('Side conversation boundary')
      expect(selected.getSnapshot().current).toBe('parent')
    } finally {
      await act(async () => {
        root.unmount()
      })
    }
  })
})

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNode,
  ConversationSnapshot,
  ISessions,
  IWorkspaces,
  SessionBinding,
  SessionFace,
  SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { vi } from 'vitest'
import { BtwController } from '../../src/client/BtwController.ts'

/** Build a minimal valid ConversationSnapshot. */
export function snapshot(sessionId: string, options: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: sessionId as SessionId,
    views: {} as ConversationSnapshot['views'],
    chat: {} as ConversationSnapshot['chat'],
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: false,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'cold',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    ...options,
  }
}

export function assistantNode(seq: number, text: string, interrupted = false): ConversationNode {
  return {
    kind: 'assistant',
    seq,
    time: 0,
    turn: 1,
    step: 1,
    blocks: [{ kind: 'text', text }],
    ...(interrupted ? { interrupted: true } : {}),
    source: null,
  } as unknown as ConversationNode
}

export class FakeSession {
  readonly sessionId: SessionId
  readonly prompts: Array<{ text: string; mode: 'queue' | 'steer' }> = []
  readonly promptContents: Array<Parameters<SessionFace['prompt']>[0]> = []
  readonly operations: string[] = []
  readonly promptDeferred = vi.fn<SessionFace['prompt']>()
  readonly updateQueue = vi.fn<SessionFace['updateQueue']>()
  readonly cancel = vi.fn<SessionFace['cancel']>()
  private readonly listeners = new Set<() => void>()

  constructor(private value: ConversationSnapshot) {
    this.sessionId = value.sessionId
    this.promptDeferred.mockResolvedValue({ ok: true, value: { accepted: true } })
    this.updateQueue.mockImplementation(async (itemId, action) => {
      this.operations.push(`${action.kind}:${itemId}`)
      this.setSnapshot({
        ...this.value,
        queue: this.value.queue.filter((item) => item.id !== itemId),
      })
      return { ok: true, value: { accepted: true } }
    })
    this.cancel.mockImplementation(async () => {
      this.operations.push('cancel')
      this.setSnapshot({ ...this.value, running: false })
      return { ok: true, value: { accepted: true } }
    })
  }

  getSnapshot = (): ConversationSnapshot => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async prompt(content: Parameters<SessionFace['prompt']>[0], mode: 'queue' | 'steer') {
    this.promptContents.push(content)
    this.prompts.push({ text: content.find((part) => part.type === 'text')?.text ?? '', mode })
    return this.promptDeferred(content, mode)
  }

  setSnapshot(next: ConversationSnapshot): void {
    this.value = next
    for (const listener of [...this.listeners]) listener()
  }
}

export interface BtwHarness {
  controller: BtwController
  parent: FakeSession
  child: FakeSession
  sessions: ISessions
  workspaces: IWorkspaces
  getCurrent: () => SessionId | undefined
}

/** A minimal sessions/workspaces double driving one BtwController. */
export function harness(options: { parent?: ConversationSnapshot; child?: ConversationSnapshot } = {}): BtwHarness {
  // Most panel tests use the ordinary completed-prefix path. Tests may provide
  // a live first-turn parent to exercise the runtime `create()` compatibility
  // path instead.
  const parent = new FakeSession(options.parent ?? snapshot('parent', {
    nodes: [{ kind: 'assistant', seq: 1 } as never],
    turnEnds: new Map([[1, 1]]),
  }))
  const child = new FakeSession(options.child ?? snapshot('child'))
  let current: SessionId | undefined = 'parent' as SessionId
  const listListeners = new Set<() => void>()
  const publishList = (): void => {
    for (const listener of [...listListeners]) listener()
  }
  const sessions = {
    list: {
      getSnapshot: () => ({ current }),
      subscribe: (listener: () => void) => {
        listListeners.add(listener)
        return () => listListeners.delete(listener)
      },
    },
    binding: vi.fn((id: SessionId) => ({ session: id === 'parent' ? parent : child }) as unknown as SessionBinding),
    create: vi.fn(async () => 'child' as SessionId),
    fork: vi.fn(async () => 'child' as SessionId),
    open: vi.fn((id: SessionId) => {
      current = id
      publishList()
    }),
    clear: vi.fn(() => {
      current = undefined
      publishList()
    }),
  } as unknown as ISessions
  const workspaces = {
    list: {
      getSnapshot: () => ({
        items: [{ workspaceId: 'workspace', sessionIds: ['parent'] }],
      }),
    },
    archiveSession: vi.fn(async () => {}),
  } as unknown as IWorkspaces
  const controller = new BtwController()
  controller.bind({ sessions, workspaces } as unknown as Context)
  return { controller, parent, child, sessions, workspaces, getCurrent: () => current }
}

/** SSR/client-safe stand-in for the host's per-session selector hook. */
export function fakeUseSession(snap: ConversationSnapshot) {
  return <S,>(selector: (snapshot: ConversationSnapshot) => S): S => selector(snap)
}

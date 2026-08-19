// @vitest-environment node
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type {
  ConversationNode,
  ConversationSnapshot,
  ISessions,
  IWorkspaces,
  SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ForkEditController } from '../src/client/ForkEditController.ts'
import { LargePasteController } from '../src/client/LargePasteController.ts'
import type { DraftSnapshot } from '../src/core/draft-snapshot.ts'

const kScope = Symbol('dsh.client.scope')

interface InputStateLike {
  readonly draft: string
  readonly draftRev: number
  readonly occurrences: readonly unknown[]
  readonly imageIds: readonly unknown[]
}

interface InputShell {
  readonly state: { getSnapshot(): InputStateLike }
  setDraft(text: string): void
  addImages?(ids: readonly unknown[]): boolean
  removeImage?(id: unknown): void
  notify?(level: 'info' | 'error', text: string): void
}

function makeInputShell(): InputShell {
  const state = { draft: '', draftRev: 0, occurrences: [] as unknown[], imageIds: [] as unknown[] }
  return {
    state: { getSnapshot: () => ({ ...state }) },
    setDraft: (text: string) => { state.draft = text },
    addImages: () => true,
    removeImage: () => {},
    notify: () => {},
  }
}

interface Notice {
  readonly sessionId: SessionId
  readonly level: 'info' | 'error'
  readonly text: string
}

interface Harness {
  controller: ForkEditController
  fork: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  archiveSession: ReturnType<typeof vi.fn>
  connectWorkspace: ReturnType<typeof vi.fn>
  draftOf: (sessionId: SessionId) => string
  setDraft: (sessionId: SessionId, text: string) => void
  notices: Notice[]
}

function harness(
  source: ConversationSnapshot,
  byId: Record<string, { cwd?: string; displayTitle?: string; parentId?: string }> = {},
  options: {
    forkImpl?: () => Promise<SessionId>
    createImpl?: () => Promise<SessionId>
    /** Sessions whose composer is not materialized (input.for returns undefined). */
    unavailable?: readonly SessionId[]
    /** Workspace accounting: which workspace owns which session ids. */
    workspaceItems?: readonly { workspaceId: string; sessionIds: readonly SessionId[] }[]
  } = {},
): Harness {
  const app = new Context()
  const notices: Notice[] = []
  const shells = new Map<SessionId, InputShell>()
  const scopes = new Map<SessionId, Context>()
  const unavailable = new Set(options.unavailable ?? [])

  const scopeFor = (id: SessionId): Context => {
    let scoped = scopes.get(id)
    if (scoped === undefined) {
      scoped = app.extend()
      ;(scoped as unknown as Record<symbol, unknown>)[kScope] = id
      scopes.set(id, scoped)
    }
    return scoped
  }

  const shellFor = (id: SessionId): InputShell => {
    let shell = shells.get(id)
    if (shell === undefined) {
      shell = makeInputShell()
      shells.set(id, shell)
    }
    return shell
  }

  const fork = vi.fn(options.forkImpl ?? (async () => 'child' as SessionId))
  const create = vi.fn(options.createImpl ?? (async () => 'child' as SessionId))
  const open = vi.fn()
  const archiveSession = vi.fn(async () => {})
  const connectWorkspace = vi.fn(async () => 'child' as SessionId)

  app.reflect.provide('sessions', {
    scope: (id: SessionId) => scopeFor(id),
    binding: () => ({ session: { getSnapshot: () => source } }),
    list: { getSnapshot: () => ({ byId, current: 'src' }) },
    fork,
    open,
    create,
  } as unknown as ISessions)
  app.reflect.provide('workspaces', {
    archiveSession,
    connectWorkspace,
    list: {
      getSnapshot: () => ({
        items: options.workspaceItems ?? [],
        archivedSessionIds: [],
        state: 'idle',
        phase: 'ready',
        error: null,
        baselinesReady: true,
        recentWorkspaceId: undefined,
      }),
    },
  } as unknown as IWorkspaces)
  app.reflect.provide('conversation', {
    input: {
      for: (actx: unknown) => {
        const id = (actx as Record<symbol, unknown>)[kScope] as SessionId
        if (unavailable.has(id)) return undefined
        const shell = shellFor(id)
        return {
          ...shell,
          notify: (level: 'info' | 'error', text: string) => notices.push({ sessionId: id, level, text }),
        }
      },
    },
  })

  const ctx = app as unknown as Context
  const controller = new ForkEditController(ctx, new LargePasteController(ctx))
  return {
    controller,
    fork,
    create,
    open,
    archiveSession,
    connectWorkspace,
    draftOf: (sessionId: SessionId) => shellFor(sessionId).state.getSnapshot().draft,
    setDraft: (sessionId: SessionId, text: string) => shellFor(sessionId).setDraft(text),
    notices,
  }
}

const baseSnapshot = (options: Partial<ConversationSnapshot> = {}): ConversationSnapshot => ({
  sessionId: 'src' as SessionId,
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
})

const node = (kind: 'user' | 'steering' | 'assistant', seq: number): ConversationNode => ({
  kind,
  seq,
  time: 0,
  content: [],
  source: null,
}) as unknown as ConversationNode

function snapshotOf(text: string): DraftSnapshot {
  return { version: 1, id: 'node:10', text, attachments: [], mentions: [], pastes: [] }
}

describe('ForkEditController.forkAndEdit', () => {
  it('forks at the previous completed turn and restores the prompt into the child', async () => {
    const source = baseSnapshot({
      nodes: [node('assistant', 5), node('user', 10), node('assistant', 12)],
      turnEnds: new Map([[1, 5], [2, 12]]),
    })
    const h = harness(source, { src: { cwd: '/ws', displayTitle: 'Source' } })

    const ok = await h.controller.forkAndEdit('src' as SessionId, 10, snapshotOf('edit me'))

    expect(ok).toBe(true)
    expect(h.fork).toHaveBeenCalledWith({ sessionId: 'src', atSeq: 5, increaseTitle: true })
    expect(h.create).not.toHaveBeenCalled()
    expect(h.draftOf('child' as SessionId)).toBe('edit me')
    expect(h.open).toHaveBeenCalledWith('child')
    expect(h.notices).toEqual([])
  })

  it('creates a new session attached to the source workspace for the first prompt', async () => {
    const source = baseSnapshot({
      nodes: [node('user', 1), node('assistant', 5)],
      turnEnds: new Map([[1, 5]]),
    })
    // The source session is accounted under a workspace, so the fresh session
    // must be connected to that workspace to open as an editable hero.
    const h = harness(source, { src: { cwd: '/ws', displayTitle: 'Source' } }, {
      workspaceItems: [{ workspaceId: 'ws1', sessionIds: ['src' as SessionId] }],
    })

    const ok = await h.controller.forkAndEdit('src' as SessionId, 1, snapshotOf('first'))

    expect(ok).toBe(true)
    expect(h.fork).not.toHaveBeenCalled()
    expect(h.connectWorkspace).toHaveBeenCalledWith('ws1')
    expect(h.create).not.toHaveBeenCalled()
    expect(h.draftOf('child' as SessionId)).toBe('first')
    expect(h.open).toHaveBeenCalledWith('child')
  })

  it('falls back to create({ cwd }) when the source session has no workspace', async () => {
    const source = baseSnapshot({
      nodes: [node('user', 1), node('assistant', 5)],
      turnEnds: new Map([[1, 5]]),
    })
    const h = harness(source, { src: { cwd: '/ws', displayTitle: 'Source' } })

    const ok = await h.controller.forkAndEdit('src' as SessionId, 1, snapshotOf('first'))

    expect(ok).toBe(true)
    expect(h.connectWorkspace).not.toHaveBeenCalled()
    expect(h.create).toHaveBeenCalledWith({ cwd: '/ws' })
    expect(h.draftOf('child' as SessionId)).toBe('first')
    expect(h.open).toHaveBeenCalledWith('child')
  })

  it('rejects a mid-turn steer without forking and shows a specific notice', async () => {
    const source = baseSnapshot({
      nodes: [node('user', 1), node('assistant', 5), node('user', 8), node('steering', 9), node('assistant', 12)],
      turnEnds: new Map([[1, 5], [2, 12]]),
    })
    const h = harness(source)

    const ok = await h.controller.forkAndEdit('src' as SessionId, 9, snapshotOf('steer'))

    expect(ok).toBe(false)
    expect(h.fork).not.toHaveBeenCalled()
    expect(h.create).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
    expect(h.notices).toEqual([
      { sessionId: 'src', level: 'error', text: '选中的问题是同一回合中的插入指令（steer），无法独立创建分支。' },
    ])
  })

  it('rejects a prompt in an in-progress turn without forking', async () => {
    const source = baseSnapshot({
      nodes: [node('user', 1), node('assistant', 5), node('user', 8)],
      turnEnds: new Map([[1, 5]]),
    })
    const h = harness(source)

    const ok = await h.controller.forkAndEdit('src' as SessionId, 8, snapshotOf('running'))

    expect(ok).toBe(false)
    expect(h.fork).not.toHaveBeenCalled()
    expect(h.notices[0]?.text).toContain('仍在进行中')
  })

  it('keeps the original session selected and restores the prompt into an empty source composer on failure', async () => {
    const source = baseSnapshot({
      nodes: [node('assistant', 5), node('user', 10), node('assistant', 12)],
      turnEnds: new Map([[1, 5], [2, 12]]),
    })
    const h = harness(source, { src: { displayTitle: 'Source' } }, {
      forkImpl: async () => { throw new Error('fork-unavailable') },
    })

    const ok = await h.controller.forkAndEdit('src' as SessionId, 10, snapshotOf('old prompt'))

    expect(ok).toBe(false)
    expect(h.open).not.toHaveBeenCalled()
    // The prompt is put back into the source composer so the edit is not lost.
    expect(h.draftOf('src' as SessionId)).toBe('old prompt')
    expect(h.notices[0]?.text).toContain('分支并编辑失败：fork-unavailable')
  })

  it('does not clobber a non-empty source draft on failure', async () => {
    const source = baseSnapshot({
      nodes: [node('assistant', 5), node('user', 10), node('assistant', 12)],
      turnEnds: new Map([[1, 5], [2, 12]]),
    })
    const h = harness(source, { src: { displayTitle: 'Source' } }, {
      forkImpl: async () => { throw new Error('boom') },
    })
    h.setDraft('src' as SessionId, 'my in-progress draft')

    const ok = await h.controller.forkAndEdit('src' as SessionId, 10, snapshotOf('old prompt'))

    expect(ok).toBe(false)
    expect(h.draftOf('src' as SessionId)).toBe('my in-progress draft')
  })

  it('archives a created child when restore fails', async () => {
    const source = baseSnapshot({
      nodes: [node('assistant', 5), node('user', 10), node('assistant', 12)],
      turnEnds: new Map([[1, 5], [2, 12]]),
    })
    const h = harness(source, { src: { displayTitle: 'Source' } }, {
      forkImpl: async () => 'child' as SessionId,
      unavailable: ['child' as SessionId],
    })

    const ok = await h.controller.forkAndEdit('src' as SessionId, 10, snapshotOf('old prompt'))

    expect(ok).toBe(false)
    expect(h.open).not.toHaveBeenCalled()
    expect(h.archiveSession).toHaveBeenCalledWith('child')
  })

  it('deduplicates concurrent operations for the same source prompt', async () => {
    const source = baseSnapshot({
      nodes: [node('assistant', 5), node('user', 10), node('assistant', 12)],
      turnEnds: new Map([[1, 5], [2, 12]]),
    })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness(source, { src: { displayTitle: 'Source' } }, {
      forkImpl: async () => {
        await gate
        return 'child' as SessionId
      },
    })

    const first = h.controller.forkAndEdit('src' as SessionId, 10, snapshotOf('first'))
    const second = h.controller.forkAndEdit('src' as SessionId, 10, snapshotOf('second'))
    release()

    expect(await first).toBe(true)
    expect(await second).toBe(false)
    expect(h.fork).toHaveBeenCalledTimes(1)
  })
})

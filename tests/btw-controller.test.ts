import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationSnapshot,
  ISessions,
  IWorkspaces,
  SessionBinding,
  SessionFace,
  SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { BtwController } from '../src/client/BtwController.ts'

function queuedMessage(id: string, placement: 'queued' | 'steering' | 'context' = 'queued'): ConversationSnapshot['queue'][number] {
  const messageId = id as ConversationSnapshot['queue'][number]['id']
  return {
    id: messageId,
    messageId,
    placement,
    content: [{ type: 'text', text: id }],
    preview: id,
    text: id,
  }
}

function snapshot(sessionId: string, options: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
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

class FakeSession {
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

function harness(options: { parent?: ConversationSnapshot; child?: ConversationSnapshot } = {}) {
  // `ISessions.fork()` only accepts a completed turn. The default represents
  // the ordinary, forkable parent assumed by tests that call `start()`.
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
    binding: vi.fn((id: SessionId) => ({ session: id === 'parent' ? parent : child })),
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

describe('BtwController', () => {
  it('rejects a blank parent before creating a durable child', async () => {
    const { controller, sessions } = harness({ parent: snapshot('parent', { blank: true, composerPhase: 'blank' }) })

    await expect(controller.start('parent' as SessionId)).rejects.toThrow('还没有消息')
    expect(sessions.fork).not.toHaveBeenCalled()
    expect(controller.getSnapshot().phase).toBe('closed')
  })

  it('keeps the parent status live while the side drawer is open', async () => {
    const { controller, parent } = harness()
    await controller.start('parent' as SessionId)

    expect(controller.getSnapshot().parentStatus).toBe('finished')

    parent.setSnapshot(snapshot('parent', {
      running: true,
      pending: [{ kind: 'approval' } as never],
    }))
    expect(controller.getSnapshot()).toMatchObject({
      parent: parent.getSnapshot(),
      parentStatus: 'needs-approval',
    })

    parent.setSnapshot(snapshot('parent', {
      pending: [{ kind: 'question' } as never],
    }))
    expect(controller.getSnapshot().parentStatus).toBe('needs-input')
  })

  it('starts BTW from an interrupted first turn without stopping the main reply', async () => {
    const parentSnapshot = snapshot('parent', {
      blank: false,
      running: true,
      nodes: [{
        kind: 'user',
        seq: 4,
        time: 0,
        content: [{ type: 'text', text: 'Investigate the checkout failure' }],
        source: null,
      } as never],
      partial: {
        turn: 1,
        step: 1,
        blocks: [{ kind: 'text', text: 'I am checking the payment path' }],
      } as ConversationSnapshot['partial'],
      turnEnds: new Map(),
    })
    const { controller, parent, child, sessions, getCurrent } = harness({ parent: parentSnapshot })

    await controller.invoke('parent' as SessionId, 'Could the retry policy be involved?')

    expect(sessions.fork).not.toHaveBeenCalled()
    expect((sessions as unknown as { create: ReturnType<typeof vi.fn> }).create)
      .toHaveBeenCalledWith({ workspaceId: 'workspace' })
    expect(parent.cancel).not.toHaveBeenCalled()
    expect(getCurrent()).toBe('parent')
    expect(child.prompts).toHaveLength(1)
    expect(child.prompts[0]?.text).toContain('Investigate the checkout failure')
    expect(child.prompts[0]?.text).toContain('I am checking the payment path')
    expect(child.prompts[0]?.text).toContain('User question after the boundary:\nCould the retry policy be involved?')
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      parentSessionId: 'parent',
      childSessionId: 'child',
      baselineSeq: -1,
      parentStatus: 'running',
    })
  })

  it('falls back to a fresh snapshot child when the Host rejects a completed-prefix fork', async () => {
    const parentSnapshot = snapshot('parent', {
      nodes: [
        {
          kind: 'user',
          seq: 1,
          time: 0,
          content: [{ type: 'text', text: 'Review the existing implementation' }],
          source: null,
        } as never,
        {
          kind: 'assistant',
          seq: 4,
          time: 0,
          turn: 1,
          step: 1,
          blocks: [{ kind: 'text', text: 'The implementation currently forks completed turns.' }],
        } as never,
      ],
      turnEnds: new Map([[1, 5]]),
    })
    const { controller, child, sessions } = harness({ parent: parentSnapshot })
    vi.mocked(sessions.fork).mockRejectedValueOnce(
      new Error('session fork failed: fork-unavailable: session "parent" has no completed turn to fork from'),
    )

    await controller.invoke('parent' as SessionId, 'How should the compatibility fallback work?')

    expect(sessions.fork).toHaveBeenCalledWith({ sessionId: 'parent', atSeq: 5 })
    expect((sessions as unknown as { create: ReturnType<typeof vi.fn> }).create)
      .toHaveBeenCalledWith({ workspaceId: 'workspace' })
    expect(child.prompts[0]?.text).toContain('Review the existing implementation')
    expect(child.prompts[0]?.text).toContain('The implementation currently forks completed turns.')
    expect(child.prompts[0]?.text).toContain('User question after the boundary:\nHow should the compatibility fallback work?')
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', childSessionId: 'child', baselineSeq: -1, error: null })
  })

  it('archives a fork that resolves before its session binding is available', async () => {
    const { controller, sessions, workspaces, parent } = harness()
    vi.mocked(sessions.binding).mockImplementation((id) => id === 'parent' ? ({
      sessionId: 'parent' as SessionId,
      ctx: {} as SessionBinding['ctx'],
      session: parent as unknown as SessionFace,
    }) : undefined)

    await expect(controller.start('parent' as SessionId)).rejects.toThrow('无法连接到它')

    expect(workspaces.archiveSession).toHaveBeenCalledWith('child')
    expect(controller.getSnapshot().phase).toBe('closed')
  })

  it('forks at the latest completed turn and primes the child without leaving it selected', async () => {
    const parent = snapshot('parent', {
      running: true,
      nodes: [{ kind: 'assistant', seq: 9 } as never],
      turnEnds: new Map([[1, 5]]),
    })
    const { controller, sessions, getCurrent } = harness({ parent })

    await controller.start('parent' as SessionId)

    expect(sessions.fork).toHaveBeenCalledWith({ sessionId: 'parent', atSeq: 5 })
    expect(sessions.open).toHaveBeenNthCalledWith(1, 'child')
    expect(sessions.open).toHaveBeenNthCalledWith(2, 'parent')
    expect(getCurrent()).toBe('parent')
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', childSessionId: 'child', baselineSeq: 5 })
  })

  it('forks the completed prefix and injects only the running tail into the first BTW prompt', async () => {
    const parentSnapshot = snapshot('parent', {
      running: true,
      nodes: [
        {
          kind: 'user',
          seq: 1,
          time: 0,
          content: [{ type: 'text', text: 'completed request' }],
          source: null,
        } as never,
        {
          kind: 'assistant',
          seq: 4,
          time: 0,
          turn: 1,
          step: 1,
          blocks: [{ kind: 'text', text: 'completed answer' }],
        } as never,
        {
          kind: 'user',
          seq: 6,
          time: 0,
          content: [{ type: 'text', text: 'open request' }],
          source: null,
        } as never,
      ],
      partial: {
        turn: 2,
        step: 1,
        blocks: [{ kind: 'text', text: 'open partial answer' }],
      } as ConversationSnapshot['partial'],
      turnEnds: new Map([[1, 5]]),
    })
    const { controller, child, sessions } = harness({ parent: parentSnapshot })

    await controller.invoke('parent' as SessionId, 'side question')

    expect(sessions.fork).toHaveBeenCalledWith({ sessionId: 'parent', atSeq: 5 })
    expect((sessions as unknown as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled()
    expect(child.prompts[0]?.text).toContain('open request')
    expect(child.prompts[0]?.text).toContain('open partial answer')
    expect(child.prompts[0]?.text).not.toContain('completed request')
    expect(child.prompts[0]?.text).not.toContain('completed answer')
    expect(controller.getSnapshot().baselineSeq).toBe(5)
  })

  it('sends the boundary only on the first BTW turn and allows queued follow-ups', async () => {
    const { controller, child } = harness()
    await controller.start('parent' as SessionId)

    await controller.send(' first question ')
    child.setSnapshot(snapshot('child', { running: true }))
    await controller.send('second question')

    expect(child.prompts).toHaveLength(2)
    expect(child.prompts[0]?.mode).toBe('queue')
    expect(child.prompts[0]?.text).toContain('User question after the boundary:\nfirst question')
    expect(child.prompts[1]).toEqual({ text: 'second question', mode: 'queue' })
    expect(controller.getSnapshot().turns.map((turn) => turn.question)).toEqual(['first question', 'second question'])
  })

  it('wraps the first prompt sent through the native child composer seam', async () => {
    const { controller, child } = harness()
    await controller.start('parent' as SessionId)

    await child.prompt([{ type: 'text', text: 'native question' }], 'queue')
    await child.prompt([{ type: 'text', text: 'native follow-up' }], 'steer')

    expect(child.prompts[0]).toMatchObject({ mode: 'queue' })
    expect(child.prompts[0]?.text).toContain('User question after the boundary:\nnative question')
    expect(child.prompts[1]).toEqual({ text: 'native follow-up', mode: 'steer' })
  })

  it('retries the native first-turn boundary after a rejected prompt', async () => {
    const { controller, child } = harness()
    child.promptDeferred
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'internal', message: 'rejected', details: {} },
      })
      .mockResolvedValueOnce({ ok: true, value: { accepted: true } })
    await controller.start('parent' as SessionId)

    const first = await child.prompt([{ type: 'text', text: 'first attempt' }], 'queue')
    const second = await child.prompt([{ type: 'text', text: 'retry question' }], 'queue')

    expect(first.ok).toBe(false)
    expect(second.ok).toBe(true)
    expect(child.prompts[0]?.text).toContain('User question after the boundary:\nfirst attempt')
    expect(child.prompts[1]?.text).toContain('User question after the boundary:\nretry question')
  })

  it('serializes concurrent native first prompts and retries the boundary after rejection', async () => {
    let resolveFirst!: (value: Awaited<ReturnType<SessionFace['prompt']>>) => void
    const { controller, child } = harness()
    child.promptDeferred
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ ok: true, value: { accepted: true } })
    await controller.start('parent' as SessionId)

    const first = child.prompt([{ type: 'text', text: 'first concurrent question' }], 'queue')
    const second = child.prompt([{ type: 'text', text: 'second concurrent question' }], 'steer')

    expect(child.promptDeferred).toHaveBeenCalledOnce()
    expect(child.prompts).toHaveLength(1)

    resolveFirst({
      ok: false,
      error: { code: 'internal', message: 'rejected', details: {} },
    })

    expect((await first).ok).toBe(false)
    expect((await second).ok).toBe(true)
    expect(child.promptDeferred).toHaveBeenCalledTimes(2)
    expect(child.prompts[0]?.text).toContain('User question after the boundary:\nfirst concurrent question')
    expect(child.prompts[1]?.text).toContain('User question after the boundary:\nsecond concurrent question')
    expect(child.prompts[1]?.mode).toBe('steer')
  })

  it('serializes concurrent native first prompts and sends the follower without another boundary after acceptance', async () => {
    let resolveFirst!: (value: Awaited<ReturnType<SessionFace['prompt']>>) => void
    const { controller, child } = harness()
    child.promptDeferred
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ ok: true, value: { accepted: true } })
    await controller.start('parent' as SessionId)

    const first = child.prompt([{ type: 'text', text: 'accepted first question' }], 'queue')
    const second = child.prompt([{ type: 'text', text: 'plain follower' }], 'queue')

    expect(child.promptDeferred).toHaveBeenCalledOnce()
    expect(child.prompts).toHaveLength(1)

    resolveFirst({ ok: true, value: { accepted: true } })

    expect((await first).ok).toBe(true)
    expect((await second).ok).toBe(true)
    expect(child.promptDeferred).toHaveBeenCalledTimes(2)
    expect(child.prompts[0]?.text).toContain('User question after the boundary:\naccepted first question')
    expect(child.prompts[1]).toEqual({ text: 'plain follower', mode: 'queue' })
  })

  it('restores the child prompt method when BTW closes', async () => {
    const { controller, child } = harness()
    const originalPrompt = child.prompt
    await controller.start('parent' as SessionId)

    expect(child.prompt).not.toBe(originalPrompt)
    await controller.close()

    expect(child.prompt).toBe(originalPrompt)
    await child.prompt([{ type: 'text', text: 'after close' }], 'queue')
    expect(child.prompts.at(-1)).toEqual({ text: 'after close', mode: 'queue' })
  })

  it('preserves native image parts and delivery mode while wrapping the text part', async () => {
    const { controller, child } = harness()
    await controller.start('parent' as SessionId)
    const image = {
      type: 'image',
      mediaType: 'image/png',
      data: 'base64-data',
      name: 'diagram.png',
    } as Parameters<SessionFace['prompt']>[0][number]

    await child.prompt([image, { type: 'text', text: 'explain this image' }], 'steer')

    expect(child.promptContents[0]?.[0]).toEqual(image)
    expect(child.promptContents[0]?.[1]).toMatchObject({ type: 'text' })
    expect(child.prompts[0]?.text).toContain('User question after the boundary:\nexplain this image')
    expect(child.prompts[0]?.mode).toBe('steer')
  })

  it('adds a hidden boundary text part to an image-only first native prompt', async () => {
    const { controller, child } = harness()
    await controller.start('parent' as SessionId)
    const image = {
      type: 'image',
      mediaType: 'image/png',
      data: 'base64-data',
    } as Parameters<SessionFace['prompt']>[0][number]

    await child.prompt([image], 'queue')

    expect(child.promptContents[0]?.[0]).toEqual(image)
    expect(child.promptContents[0]?.[1]).toMatchObject({ type: 'text' })
    expect(child.prompts[0]?.text).toContain('User question after the boundary:\n')
  })

  it('safely replaces an existing BTW when the slash command is invoked again from its parent', async () => {
    const { controller, child, sessions, workspaces } = harness()
    await controller.invoke('parent' as SessionId, 'first question')

    await controller.invoke('parent' as SessionId, 'replacement question')

    expect(sessions.fork).toHaveBeenCalledTimes(2)
    expect(workspaces.archiveSession).toHaveBeenCalledOnce()
    expect(child.prompts).toHaveLength(2)
    expect(child.prompts[0]?.text).toContain('User question after the boundary:\nfirst question')
    expect(child.prompts[1]?.text).toContain('User question after the boundary:\nreplacement question')
    expect(controller.getSnapshot().turns.map((turn) => turn.question)).toEqual(['replacement question'])
  })

  it('keeps an existing BTW visible when replacement cleanup fails', async () => {
    const { controller, sessions, workspaces } = harness()
    await controller.start('parent' as SessionId)
    vi.mocked(workspaces.archiveSession).mockRejectedValueOnce(new Error('archive rejected'))

    await expect(controller.invoke('parent' as SessionId, 'replacement question')).rejects.toThrow('archive rejected')

    expect(sessions.fork).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      childSessionId: 'child',
      error: 'archive rejected',
    })
  })

  it('rejects starting a nested BTW from its child session', async () => {
    const { controller, sessions } = harness()
    await controller.start('parent' as SessionId)

    await expect(controller.invoke('child' as SessionId, 'nested question')).rejects.toThrow('已有一个 BTW 会话')

    expect(sessions.fork).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().phase).toBe('ready')
  })

  it('keeps the host selected on the parent and renders the drawer only there', async () => {
    const { controller, getCurrent } = harness()
    await controller.start('parent' as SessionId)

    expect(getCurrent()).toBe('parent')
    expect(controller.isVisibleFor('parent' as SessionId)).toBe(true)
    expect(controller.isVisibleFor('child' as SessionId)).toBe(false)
    expect((controller as unknown as Record<string, unknown>).toggleSession).toBeUndefined()
  })

  it('returns from the selected child and archives it after safe cleanup', async () => {
    const { controller, sessions, workspaces, getCurrent } = harness()
    await controller.start('parent' as SessionId)
    sessions.open('child' as SessionId)
    expect(getCurrent()).toBe('child')

    await controller.close()

    expect(workspaces.archiveSession).toHaveBeenCalledWith('child')
    expect(getCurrent()).toBe('parent')
    expect(controller.getSnapshot().phase).toBe('closed')
  })

  it('discards local state without another archive when the Host removes the child', async () => {
    const { controller, child, sessions, workspaces, getCurrent } = harness()
    await controller.start('parent' as SessionId)
    sessions.open('child' as SessionId)

    child.setSnapshot(snapshot('child', { removed: true }))

    expect(getCurrent()).toBe('parent')
    expect(workspaces.archiveSession).not.toHaveBeenCalled()
    expect(controller.getSnapshot().phase).toBe('closed')
  })

  it('does not publish a removed child that is already gone when the fork resolves', async () => {
    const { controller, child, sessions, workspaces } = harness({ child: snapshot('child', { removed: true }) })

    await controller.start('parent' as SessionId)

    expect(controller.getSnapshot().phase).toBe('closed')
    expect(workspaces.archiveSession).not.toHaveBeenCalled()
    expect(sessions.open).not.toHaveBeenCalledWith('child')
    expect(child.getSnapshot().removed).toBe(true)
  })

  it('coalesces concurrent close requests into one archive operation', async () => {
    const { controller, workspaces } = harness()
    await controller.start('parent' as SessionId)

    const first = controller.close()
    const second = controller.close()

    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(workspaces.archiveSession).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().phase).toBe('closed')
  })

  it('retains the drawer on the parent when child archival fails', async () => {
    const { controller, sessions, workspaces, getCurrent } = harness()
    vi.mocked(workspaces.archiveSession).mockRejectedValueOnce(new Error('archive rejected'))
    await controller.start('parent' as SessionId)
    sessions.open('child' as SessionId)

    await controller.close()

    expect(getCurrent()).toBe('parent')
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      childSessionId: 'child',
      error: 'archive rejected',
    })
  })

  it('does not resurrect the drawer when a prompt resolves after close', async () => {
    let resolvePrompt!: (value: { ok: true; value: { accepted: true } }) => void
    const { controller, child } = harness()
    child.promptDeferred.mockImplementation(() => new Promise((resolve) => { resolvePrompt = resolve }))
    await controller.start('parent' as SessionId)

    const sending = controller.send('slow question')
    const closing = controller.close()
    child.setSnapshot(snapshot('child', { running: true }))
    resolvePrompt({ ok: true, value: { accepted: true } })
    await Promise.all([sending, closing])

    expect(child.cancel).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().phase).toBe('closed')
    expect(controller.getSnapshot().transcript).toEqual([])
  })

  it('removes queued child prompts before cancellation so close cannot restart them', async () => {
    const queued = queuedMessage('queued-1')
    const steering = queuedMessage('steering-1', 'steering')
    const { controller, child } = harness({
      child: snapshot('child', { running: true, queue: [queued, steering] }),
    })
    await controller.start('parent' as SessionId)

    await controller.close()

    expect(child.updateQueue).toHaveBeenCalledTimes(1)
    expect(child.updateQueue).toHaveBeenCalledWith(queued.id, { kind: 'remove' })
    expect(child.operations).toEqual([`remove:${queued.id}`, 'cancel'])
    expect(controller.getSnapshot().phase).toBe('closed')
  })

  it('retains the drawer when queued work cannot be removed', async () => {
    const queued = queuedMessage('queued-1')
    const { controller, child, workspaces } = harness({
      child: snapshot('child', { running: true, queue: [queued] }),
    })
    child.updateQueue.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal', message: 'remove rejected', details: {} },
    })
    await controller.start('parent' as SessionId)

    await controller.close()

    expect(child.cancel).not.toHaveBeenCalled()
    expect(workspaces.archiveSession).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'active',
      childSessionId: 'child',
      error: 'remove rejected',
    })
  })

  it('treats a queue row claimed during close as converged and cancels the active turn', async () => {
    const queued = queuedMessage('queued-1')
    const { controller, child } = harness({
      child: snapshot('child', { running: true, queue: [queued] }),
    })
    child.updateQueue.mockResolvedValueOnce({
      ok: false,
      error: { code: 'queue-item-not-found', message: 'already claimed', details: { itemId: queued.id } },
    })
    await controller.start('parent' as SessionId)

    await controller.close()

    expect(child.cancel).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().phase).toBe('closed')
  })

  it('retains the drawer when accepted cancellation never reaches observable quiescence', async () => {
    vi.useFakeTimers()
    try {
      const { controller, child, workspaces } = harness({ child: snapshot('child', { running: true }) })
      // Bypass the fake's normal running=false update to model an accepted
      // cancellation whose quiescent status frame never reaches the client.
      child.cancel.mockResolvedValueOnce({ ok: true, value: { accepted: true } })
      await controller.start('parent' as SessionId)

      const closing = controller.close()
      await vi.advanceTimersByTimeAsync(1_600)
      await closing

      expect(controller.getSnapshot()).toMatchObject({
        phase: 'active',
        childSessionId: 'child',
        error: '无法确认 BTW 子会话已停止；请稍后重试。',
      })
      expect(workspaces.archiveSession).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the drawer visible when cancellation fails during close', async () => {
    const { controller, child, workspaces } = harness({ child: snapshot('child', { running: true }) })
    child.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'cancel rejected', details: {} } })
    await controller.start('parent' as SessionId)

    await controller.close()

    expect(controller.getSnapshot()).toMatchObject({
      phase: 'active',
      childSessionId: 'child',
      error: 'cancel rejected',
    })
    expect(workspaces.archiveSession).not.toHaveBeenCalled()
  })

  it('cancels a late child created after close during fork', async () => {
    let resolveFork!: (id: SessionId) => void
    const { controller, child, sessions } = harness({ child: snapshot('child', { running: true }) })
    vi.mocked(sessions.fork).mockImplementationOnce(() => new Promise((resolve) => { resolveFork = resolve }))

    const starting = controller.start('parent' as SessionId)
    const closing = controller.close()
    resolveFork('child' as SessionId)
    await Promise.all([starting, closing])

    expect(child.cancel).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().phase).toBe('closed')
  })

  it('closes safely when the user navigates to an unrelated session', async () => {
    const { controller, sessions, workspaces, getCurrent } = harness({ child: snapshot('child', { running: true }) })
    await controller.start('parent' as SessionId)

    sessions.open('other' as SessionId)
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe('closed'))

    expect(workspaces.archiveSession).toHaveBeenCalledWith('child')
    expect(getCurrent()).toBe('other')
    expect(controller.getSnapshot().phase).toBe('closed')
  })


  it('returns to the parent when navigation cleanup cannot cancel the child', async () => {
    const { controller, child, sessions, getCurrent } = harness({ child: snapshot('child', { running: true }) })
    child.cancel.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'still running', details: {} } })
    await controller.start('parent' as SessionId)

    sessions.open('other' as SessionId)
    await vi.waitFor(() => expect(controller.getSnapshot().error).toBe('still running'))

    expect(controller.getSnapshot().phase).toBe('active')
    expect(getCurrent()).toBe('parent')
  })
})

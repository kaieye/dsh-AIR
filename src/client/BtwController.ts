import type { Context } from '@deepseek-ai/cordis'
import {
  type ConversationSnapshot,
  type ISessions,
  type IWorkspaces,
  type SessionFace,
  type SessionId,
  type WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { btwInitialPrompt, btwInterruptedContext } from '../core/btw-boundary.ts'
import { deriveBtwParentStatus, type BtwParentStatus } from '../core/btw-status.ts'
import {
  BTW_ALREADY_OPEN,
  BTW_BUSY,
  BTW_CLOSE_FAILED,
  BTW_CLOSE_UNQUIESCENT,
  BTW_CLOSING,
  BTW_DISPOSED,
  BTW_FORK_UNREACHABLE,
  BTW_LIVE_FORK_UNAVAILABLE,
  BTW_MAIN_THREAD_UNAVAILABLE,
  BTW_NOT_READY,
  BTW_NO_STARTED_CONVERSATION,
  BTW_OPERATION_FAILED,
  BTW_SESSIONS_UNAVAILABLE,
  BTW_WORKSPACES_UNAVAILABLE,
} from '../core/btw-messages.ts'
import {
  type BtwTurnRecord,
  projectBtwTranscript,
  type BtwTranscriptEntry,
} from '../core/btw-transcript.ts'

export type BtwPhase = 'closed' | 'forking' | 'ready' | 'sending' | 'active' | 'closing'

export interface BtwSnapshot {
  readonly phase: BtwPhase
  readonly parentSessionId: SessionId | null
  readonly childSessionId: SessionId | null
  readonly parent: ConversationSnapshot | null
  readonly parentStatus: BtwParentStatus
  readonly child: ConversationSnapshot | null
  readonly baselineSeq: number
  readonly turns: readonly BtwTurnRecord[]
  readonly transcript: readonly BtwTranscriptEntry[]
  readonly error: string | null
}

const CLOSE_QUIESCENCE_TIMEOUT_MS = 1_500
const CLOSE_SETTLE_MS = 100
const CLOSE_POLL_MS = 20

type SessionPrompt = SessionFace['prompt']
type PromptContent = Parameters<SessionPrompt>[0]
type PromptMode = Parameters<SessionPrompt>[1]
type PromptResult = ReturnType<SessionPrompt>

const CLOSED: BtwSnapshot = {
  phase: 'closed',
  parentSessionId: null,
  childSessionId: null,
  parent: null,
  parentStatus: 'closed',
  child: null,
  baselineSeq: -1,
  turns: [],
  transcript: [],
  error: null,
}

class BtwSnapshotStore {
  private value: BtwSnapshot
  private readonly listeners = new Set<() => void>()

  constructor(value: BtwSnapshot) {
    this.value = value
  }

  getSnapshot = (): BtwSnapshot => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(value: BtwSnapshot): void {
    if (value === this.value) return
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }
}

function maxNodeSeq(snapshot: ConversationSnapshot | null, fallback: number): number {
  if (snapshot === null) return fallback
  let max = fallback
  for (const node of snapshot.nodes) {
    if (Number.isFinite(node.seq)) max = Math.max(max, node.seq)
  }
  return max
}

/**
 * Freeze the fork at the latest completed parent turn, excluding live output.
 *
 * `ISessions.fork()` accepts only a completed-turn prefix. A user node (or an
 * assistant node from an interrupted/open turn) is not a valid fallback: the
 * Host rejects that request with `fork-unavailable`.
 */
function forkBoundarySeq(snapshot: ConversationSnapshot): number | null {
  let latestTurnEnd = -1
  for (const seq of snapshot.turnEnds.values()) {
    if (Number.isFinite(seq)) latestTurnEnd = Math.max(latestTurnEnd, seq)
  }
  return latestTurnEnd >= 0 ? latestTurnEnd : null
}

function hasOpenTail(snapshot: ConversationSnapshot, afterSeq: number): boolean {
  return snapshot.running
    || snapshot.partial !== null
    || snapshot.runningCalls.length > 0
    || maxNodeSeq(snapshot, afterSeq) > afterSeq
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return BTW_OPERATION_FAILED
}

function isForkUnavailable(error: unknown): boolean {
  return errorMessage(error).includes('fork-unavailable')
}

interface SessionCreateCapability {
  create(opts?: {
    workspaceId?: WorkspaceId
    cwd?: string
    sessionId?: SessionId
  }): Promise<SessionId>
}

/**
 * Owns the one active BTW child for the browser plugin.
 *
 * The main DSH session remains selected. Completed history uses the public
 * `sessions.fork()` API; an interrupted first turn uses the concrete runtime
 * `create()` capability plus a reference-only snapshot. This controller adds
 * the temporary/drawer presentation and hides inherited/boundary messages.
 */
export class BtwController {
  private readonly store = new BtwSnapshotStore(CLOSED)
  private sessions: ISessions | undefined
  private workspaces: IWorkspaces | undefined
  private child: SessionFace | null = null
  private parent: SessionFace | null = null
  private childOff: (() => void) | null = null
  private parentOff: (() => void) | null = null
  private listOff: (() => void) | null = null
  private childInFlight: Promise<SessionId> | null = null
  private sendQueue: Promise<void> | null = null
  private closeInFlight: Promise<void> | null = null
  private boundarySent = false
  private boundaryAdmission: Promise<void> | null = null
  private releaseBoundaryAdmission: (() => void) | null = null
  private restoreChildPrompt: (() => void) | null = null
  private readonly promptAdmissions = new Set<Promise<unknown>>()
  /** Parent suffix captured at start and prepended before the first boundary. */
  private firstPromptContext: string | null = null
  private turnId = 0
  private disposed = false
  /** Invalidates child-creation/prompt continuations after the drawer is closed. */
  private lifecycle = 0

  /** Bind the service once the client context is available. */
  bind(ctx: Context): void {
    this.sessions = ctx.sessions
    this.workspaces = ctx.workspaces
    this.listOff?.()
    const list = ctx.sessions.list as ISessions['list'] & { subscribe?: (listener: () => void) => () => void }
    this.listOff = list.subscribe?.(() => this.onSelectionChanged()) ?? null
  }

  getSnapshot = (): BtwSnapshot => this.store.getSnapshot()

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** True when the active panel belongs to the supplied parent session. */
  isOpenFor(parentSessionId: SessionId): boolean {
    const snapshot = this.getSnapshot()
    return snapshot.parentSessionId === parentSessionId && snapshot.phase !== 'closed'
  }

  /** True when the drawer belongs to the currently rendered main session. */
  isVisibleFor(sessionId: SessionId): boolean {
    const snapshot = this.getSnapshot()
    return snapshot.phase !== 'closed' && snapshot.parentSessionId === sessionId
  }

  isChildSession(sessionId: SessionId): boolean {
    return this.getSnapshot().childSessionId === sessionId
  }

  /**
   * Open BTW from a creation-time parent snapshot. When a question is
   * supplied, send it after the child is ready.
   */
  async invoke(parentSessionId: SessionId, question = ''): Promise<void> {
    const active = this.getSnapshot()
    if (active.phase !== 'closed') {
      if (active.parentSessionId !== parentSessionId) {
        throw new Error(BTW_ALREADY_OPEN)
      }

      // Match the reference slash-command lifecycle: invoking /side again
      // from its parent replaces the retained side branch instead of appending
      // another turn to it. Follow-ups belong in the drawer's own composer.
      await this.close()
      const retained = this.getSnapshot()
      if (retained.phase !== 'closed') {
        throw new Error(retained.error ?? BTW_CLOSE_FAILED)
      }
    }

    await this.start(parentSessionId)
    if (question.trim() !== '' && this.isOpenFor(parentSessionId)) await this.send(question)
  }

  /** Start the drawer without sending an empty prompt. */
  async start(parentSessionId: SessionId): Promise<void> {
    if (this.disposed) throw new Error(BTW_DISPOSED)
    const sessions = this.sessions
    if (sessions === undefined) throw new Error(BTW_SESSIONS_UNAVAILABLE)

    const existing = this.getSnapshot()
    if (existing.phase !== 'closed') {
      if (existing.parentSessionId !== parentSessionId) {
        throw new Error(BTW_ALREADY_OPEN)
      }
      if (existing.phase === 'closing') throw new Error(BTW_CLOSING)
      return
    }

    const parentBinding = sessions.binding(parentSessionId)
    const parent = parentBinding?.session
    if (parent === undefined) throw new Error(BTW_MAIN_THREAD_UNAVAILABLE)
    const parentSnapshot = parent.getSnapshot()
    if (parentSnapshot.blank || parentSnapshot.composerPhase === 'blank') {
      throw new Error(BTW_NO_STARTED_CONVERSATION)
    }

    const completedBoundarySeq = forkBoundarySeq(parentSnapshot)
    const baselineSeq = completedBoundarySeq ?? -1

    const lifecycle = ++this.lifecycle
    this.boundarySent = false
    this.firstPromptContext = hasOpenTail(parentSnapshot, baselineSeq)
      ? btwInterruptedContext(parentSnapshot, baselineSeq)
      : null
    this.parent = parent
    this.parentOff = parent.subscribe(() => this.onParentChanged())
    this.store.set({
      ...CLOSED,
      phase: 'forking',
      parentSessionId,
      parent: parentSnapshot,
      parentStatus: deriveBtwParentStatus(parentSnapshot),
      baselineSeq,
    })

    const provisioning = completedBoundarySeq === null
      ? this.createInterruptedChild(sessions, parentSessionId)
      : this.forkWithSnapshotFallback(
          sessions,
          parentSessionId,
          completedBoundarySeq,
          parentSnapshot,
          lifecycle,
        )
    this.childInFlight = provisioning

    try {
      const childId = await provisioning
      if (this.childInFlight === provisioning) this.childInFlight = null
      if (lifecycle !== this.lifecycle || this.getSnapshot().phase === 'closed' || this.getSnapshot().phase === 'closing') return

      const binding = sessions.binding(childId)
      if (binding === undefined) {
        const message = BTW_FORK_UNREACHABLE
        try {
          await this.workspaces?.archiveSession(childId)
        } catch (cleanupError) {
          throw new Error(`${message} 自动清理失败：${errorMessage(cleanupError)}`)
        }
        throw new Error(message)
      }
      this.attachChild(childId, binding.session)
      if (lifecycle !== this.lifecycle || this.getSnapshot().phase === 'closed') return
      this.store.set({ ...this.getSnapshot(), phase: 'ready', error: null })
      this.primeChildWindow(sessions, childId)
    } catch (error) {
      if (this.childInFlight === provisioning) this.childInFlight = null
      if (lifecycle !== this.lifecycle) return
      const message = errorMessage(error)
      this.reset(message)
      throw new Error(message)
    }
  }

  /**
   * Send one user-visible question into the child fork. Public prompts accept
   * queued turns, so a second question may be submitted while the model is
   * still answering the first one. The small local chain only serializes the
   * admission RPCs and prevents two first-turn boundaries from racing.
   */
  async send(question: string): Promise<void> {
    const trimmed = question.trim()
    if (trimmed === '') return
    if (this.sendQueue === null) {
      // Start the first admission synchronously so callers can cancel a prompt
      // immediately after `send()` returns (and so DOM handlers do not lose the
      // prompt to a microtask race).
      const operation = this.sendNow(trimmed)
      this.sendQueue = operation.catch(() => {})
      return operation
    }
    const operation = this.sendQueue.then(() => this.sendNow(trimmed))
    this.sendQueue = operation.catch(() => {})
    return operation
  }

  /** Stop the child turn without changing the selected main session. */
  async cancel(): Promise<void> {
    const child = this.child
    if (child === null) return
    const result = await child.cancel()
    if (!result.ok) {
      this.publish({ error: result.error.message })
      throw new Error(result.error.message)
    }
  }

  /**
   * Close the web panel safely. Queued work is drained, cancellation reaches
   * observable quiescence, and the durable child is archived before the drawer
   * is discarded. Any failed cleanup step leaves an actionable drawer visible.
   */
  close(): Promise<void> {
    const current = this.getSnapshot()
    if (current.phase === 'closed') return Promise.resolve()
    if (this.closeInFlight !== null) return this.closeInFlight

    let resolveClose!: () => void
    let rejectClose!: (error: unknown) => void
    const inFlight = new Promise<void>((resolve, reject) => {
      resolveClose = resolve
      rejectClose = reject
    })
    this.closeInFlight = inFlight
    void this.performClose().then(
      () => {
        if (this.closeInFlight === inFlight) this.closeInFlight = null
        resolveClose()
      },
      (error: unknown) => {
        if (this.closeInFlight === inFlight) this.closeInFlight = null
        rejectClose(error)
      },
    )
    return inFlight
  }

  private async performClose(): Promise<void> {
    const closeLifecycle = ++this.lifecycle
    this.publish({ phase: 'closing', error: null })
    const sessions = this.sessions
    try {
      let forkedChildId: SessionId | null = null
      // Child provisioning can resolve after the user presses close. Wait for it,
      // adopt the child, and cancel it instead of leaving an orphaned session.
      const provisioning = this.childInFlight
      if (provisioning !== null) {
        const childId = await provisioning
        forkedChildId = childId
        if (closeLifecycle !== this.lifecycle) return
        if (this.child === null && sessions !== undefined) {
          const binding = sessions.binding(childId)
          if (binding !== undefined) this.attachChild(childId, binding.session)
        }
      }

      // Prompt acceptance can resolve after close begins. Wait for every
      // already-admitted send before inspecting the authoritative child inbox.
      // Calls chained after the phase changed to `closing` fail before reaching
      // the host, but are awaited too so reset cannot race their continuations.
      let admissions = this.sendQueue
      let hadAdmissions = admissions !== null || this.promptAdmissions.size > 0
      while (admissions !== null) {
        await admissions
        if (closeLifecycle !== this.lifecycle) return
        if (this.sendQueue === admissions) break
        admissions = this.sendQueue
      }

      while (this.promptAdmissions.size > 0) {
        hadAdmissions = true
        await Promise.allSettled([...this.promptAdmissions])
        if (closeLifecycle !== this.lifecycle) return
      }

      const child = this.child
      if (child !== null) {
        await this.quiesceChild(child, closeLifecycle, hadAdmissions)
      }
      if (closeLifecycle !== this.lifecycle) return

      const retained = this.getSnapshot()
      const childId = retained.childSessionId ?? forkedChildId
      if (childId !== null) {
        // Archiving the currently selected child would clear selection into the
        // New Session view, so restore the parent first. An unrelated navigation
        // remains untouched while its cleanup runs in the background.
        const selected = sessions?.list.getSnapshot().current
        if (sessions !== undefined && selected === childId && retained.parentSessionId !== null) {
          sessions.open(retained.parentSessionId)
        }
        const workspaces = this.workspaces
        if (workspaces === undefined) throw new Error(BTW_WORKSPACES_UNAVAILABLE)
        await workspaces.archiveSession(childId)
      }
      if (closeLifecycle !== this.lifecycle) return
      this.reset(null)
    } catch (error) {
      if (closeLifecycle !== this.lifecycle) return
      const child = this.child
      // Rejected provisioning created no live child, so there is nothing left to
      // protect after the user already requested close.
      if (child === null) {
        this.reset(null)
        return
      }
      this.publish({
        phase: child.getSnapshot().running ? 'active' : 'ready',
        error: errorMessage(error),
      })
      // If a navigation-triggered close could not stop the child, return to
      // the main session so the retained error drawer is actually visible.
      const retained = this.getSnapshot()
      const selected = sessions?.list.getSnapshot().current
      if (sessions !== undefined && retained.parentSessionId !== null && selected !== retained.parentSessionId && selected !== retained.childSessionId) {
        sessions.open(retained.parentSessionId)
      }
    }
  }

  /**
   * Drain public queue rows before cancelling, then observe the child until no
   * unresolved FIFO work or active turn remains. `session.cancel` deliberately
   * preserves queued work, so cancellation alone is not a safe close barrier.
   *
   * The runtime has no atomic drain-and-cancel operation or snapshot seq to
   * await. A short bounded settle window catches queue/status frames emitted by
   * a prompt RPC that resolved just before cleanup; timeout retains the drawer.
   */
  private async quiesceChild(child: SessionFace, closeLifecycle: number, settleAfterAdmission: boolean): Promise<void> {
    const deadline = Date.now() + CLOSE_QUIESCENCE_TIMEOUT_MS
    const resolvedQueueItems = new Set<ConversationSnapshot['queue'][number]['id']>()
    let lastCancelledSnapshot: ConversationSnapshot | null = null
    let forceCancel = false
    let quietSince: number | null = null

    for (;;) {
      if (closeLifecycle !== this.lifecycle) return
      let snapshot = child.getSnapshot()

      for (const item of snapshot.queue) {
        if (item.placement !== 'queued' || resolvedQueueItems.has(item.id)) continue
        const result = await child.updateQueue(item.id, { kind: 'remove' })
        if (closeLifecycle !== this.lifecycle) return
        if (!result.ok && result.error.code !== 'queue-item-not-found') {
          throw new Error(result.error.message)
        }
        resolvedQueueItems.add(item.id)
        // A not-found row may have been claimed between the snapshot and RPC.
        // Cancel even if the corresponding running frame has not arrived yet.
        if (!result.ok) forceCancel = true
      }

      snapshot = child.getSnapshot()
      if ((snapshot.running || forceCancel) && lastCancelledSnapshot !== snapshot) {
        const result = await child.cancel()
        if (closeLifecycle !== this.lifecycle) return
        if (!result.ok) throw new Error(result.error.message)
        lastCancelledSnapshot = snapshot
        forceCancel = false
      }

      const latest = child.getSnapshot()
      const hasUnresolvedQueue = latest.queue.some((item) => (
        item.placement === 'queued' && !resolvedQueueItems.has(item.id)
      ))
      const quiescent = !latest.running && !hasUnresolvedQueue && !forceCancel
      if (quiescent) {
        if (!settleAfterAdmission) return
        quietSince ??= Date.now()
        if (Date.now() - quietSince >= CLOSE_SETTLE_MS) return
      } else {
        quietSince = null
      }

      if (Date.now() >= deadline) {
        throw new Error(BTW_CLOSE_UNQUIESCENT)
      }
      await sleep(CLOSE_POLL_MS)
    }
  }

  dispose(): void {
    this.disposed = true
    void this.close().finally(() => {
      this.listOff?.()
      this.listOff = null
      this.sessions = undefined
      this.workspaces = undefined
    })
  }

  /**
   * DSH only opens a Session history window while that session is selected.
   * Briefly select the child and restore the previous selection in the same
   * synchronous turn: this starts the public runtime's history/live stream
   * without leaving the browser on the BTW branch.
   */
  private primeChildWindow(sessions: ISessions, childId: SessionId): void {
    const previous = sessions.list.getSnapshot().current
    sessions.open(childId)

    // A synchronous host listener is allowed to redirect navigation. Do not
    // overwrite such a newer choice while restoring the pre-BTW selection.
    if (sessions.list.getSnapshot().current !== childId) return
    if (previous === undefined) sessions.clear()
    else sessions.open(previous)
  }

  private sendNow(trimmed: string): Promise<void> {
    const current = this.getSnapshot()
    const child = this.child
    if (child === null || current.childSessionId === null || current.parentSessionId === null) {
      throw new Error(BTW_NOT_READY)
    }
    if (current.phase === 'forking' || current.phase === 'sending' || current.phase === 'closing') {
      throw new Error(BTW_BUSY)
    }

    const afterSeq = maxNodeSeq(child.getSnapshot(), current.baselineSeq)
    const turn: BtwTurnRecord = {
      id: ++this.turnId,
      question: trimmed,
      afterSeq,
      status: 'sending',
    }
    const turns = [...current.turns, turn]
    this.publish({ phase: 'sending', turns, error: null })

    const lifecycle = this.lifecycle
    let turnErrorPublished = false
    return child.prompt([{ type: 'text', text: trimmed }], 'queue').then((result) => {
      if (lifecycle !== this.lifecycle || this.child !== child || this.getSnapshot().childSessionId !== current.childSessionId) return
      if (!result.ok) {
        const message = result.error.message
        this.markTurnError(turns, turn.id, message)
        turnErrorPublished = true
        throw new Error(message)
      }
      this.publish({
        phase: child.getSnapshot().running ? 'active' : 'ready',
        turns: turns.map((item) => item.id === turn.id ? { ...item, status: 'sent' } : item),
        error: null,
      })
    }).catch((error: unknown) => {
      if (lifecycle !== this.lifecycle || this.child !== child || this.getSnapshot().childSessionId !== current.childSessionId) return
      if (!turnErrorPublished) this.markTurnError(turns, turn.id, errorMessage(error))
      throw error
    })
  }

  private attachChild(childId: SessionId, child: SessionFace): void {
    this.childOff?.()
    this.restoreChildPrompt?.()
    this.restoreChildPrompt = null
    this.child = child
    this.installChildPromptBoundary(childId, child)
    this.childOff = child.subscribe(() => this.onChildChanged())
    const current = this.getSnapshot()
    const childSnapshot = child.getSnapshot()
    if (childSnapshot.removed) {
      this.onChildChanged()
      return
    }
    this.store.set({
      ...current,
      childSessionId: childId,
      child: childSnapshot,
      transcript: projectBtwTranscript({
        baselineSeq: current.baselineSeq,
        nodes: childSnapshot.nodes,
        partial: childSnapshot.partial,
        runningCalls: childSnapshot.runningCalls,
        turns: current.turns,
      }),
    })
  }

  /**
   * Put the model-only boundary at the single session.prompt seam used by both
   * the native composer and the controller's compatibility send() method.
   */
  private installChildPromptBoundary(childId: SessionId, child: SessionFace): void {
    const ownPrompt = Object.getOwnPropertyDescriptor(child, 'prompt')
    const original = child.prompt.bind(child) as SessionPrompt
    const proxy: SessionPrompt = (content, mode) => this.promptWithBoundary(childId, child, original, content, mode)

    Object.defineProperty(child, 'prompt', {
      configurable: true,
      enumerable: ownPrompt?.enumerable ?? false,
      writable: true,
      value: proxy,
    })

    this.restoreChildPrompt = () => {
      if (child.prompt !== proxy) return
      if (ownPrompt === undefined) delete (child as { prompt?: SessionPrompt }).prompt
      else Object.defineProperty(child, 'prompt', ownPrompt)
    }
  }

  private promptWithBoundary(
    childId: SessionId,
    child: SessionFace,
    original: SessionPrompt,
    content: PromptContent,
    mode: PromptMode,
  ): PromptResult {
    const current = this.getSnapshot()
    if (this.child !== child || current.childSessionId !== childId || this.boundarySent) {
      return this.trackPrompt(original(content, mode))
    }

    if (content.length === 0) return this.trackPrompt(original(content, mode))
    if (this.boundaryAdmission !== null) {
      return this.boundaryAdmission.then(() => this.promptWithBoundary(childId, child, original, content, mode))
    }

    let wrappedText = false
    const wrapped: PromptContent = content.map((part) => {
      if (wrappedText || part.type !== 'text' || part.text.trim() === '') return part
      wrappedText = true
      return { ...part, text: btwInitialPrompt(part.text, this.firstPromptContext ?? undefined) }
    })
    if (!wrappedText) {
      wrapped.push({
        type: 'text',
        text: btwInitialPrompt('', this.firstPromptContext ?? undefined),
      })
    }

    let releaseBoundary!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseBoundary = resolve
    })
    this.boundaryAdmission = gate
    this.releaseBoundaryAdmission = releaseBoundary
    const lifecycle = this.lifecycle

    let operation: PromptResult
    try {
      operation = this.trackPrompt(original(wrapped, mode))
    } catch (error) {
      if (this.boundaryAdmission === gate) {
        this.boundaryAdmission = null
        this.releaseBoundaryAdmission = null
      }
      releaseBoundary()
      throw error
    }

    return operation.then(
      (result) => {
        if (result.ok && lifecycle === this.lifecycle && this.child === child) this.boundarySent = true
        if (this.boundaryAdmission === gate) {
          this.boundaryAdmission = null
          this.releaseBoundaryAdmission = null
        }
        releaseBoundary()
        return result
      },
      (error: unknown) => {
        if (this.boundaryAdmission === gate) {
          this.boundaryAdmission = null
          this.releaseBoundaryAdmission = null
        }
        releaseBoundary()
        throw error
      },
    )
  }

  private trackPrompt(operation: PromptResult): PromptResult {
    this.promptAdmissions.add(operation)
    void operation.finally(() => this.promptAdmissions.delete(operation)).catch(() => {})
    return operation
  }

  /**
   * Prefer the real completed-prefix fork. A late Host rejection can still
   * happen when its log view disagrees with the browser projection; recover by
   * creating an empty child and carrying the captured parent snapshot in the
   * first prompt instead of reviving the old "wait for completion" limit.
   */
  private async forkWithSnapshotFallback(
    sessions: ISessions,
    parentSessionId: SessionId,
    baselineSeq: number,
    parentSnapshot: ConversationSnapshot,
    lifecycle: number,
  ): Promise<SessionId> {
    try {
      return await sessions.fork({ sessionId: parentSessionId, atSeq: baselineSeq })
    } catch (error) {
      if (!isForkUnavailable(error) || lifecycle !== this.lifecycle) throw error

      this.firstPromptContext = btwInterruptedContext(parentSnapshot, -1)
      const current = this.getSnapshot()
      if (current.parentSessionId === parentSessionId && current.phase === 'forking') {
        this.store.set({ ...current, baselineSeq: -1 })
      }
      return this.createInterruptedChild(sessions, parentSessionId)
    }
  }

  /** Create a same-workspace child through the concrete runtime capability. */
  private async createInterruptedChild(sessions: ISessions, parentSessionId: SessionId): Promise<SessionId> {
    const create = (sessions as unknown as Partial<SessionCreateCapability>).create
    if (typeof create !== 'function') throw new Error(BTW_LIVE_FORK_UNAVAILABLE)

    const workspace = this.workspaces?.list.getSnapshot().items.find((item) => (
      item.sessionIds.includes(parentSessionId)
    ))
    if (workspace !== undefined) {
      return create.call(sessions, { workspaceId: workspace.workspaceId })
    }

    const cwd = sessions.list.getSnapshot().byId[parentSessionId]?.cwd
    if (cwd !== undefined && cwd.trim() !== '') return create.call(sessions, { cwd })
    return create.call(sessions, {})
  }

  private onParentChanged(): void {
    const parent = this.parent
    if (parent === null || this.getSnapshot().phase === 'closed') return
    const parentSnapshot = parent.getSnapshot()
    this.publish({ parent: parentSnapshot, parentStatus: deriveBtwParentStatus(parentSnapshot) })
  }

  private onSelectionChanged(): void {
    const current = this.getSnapshot()
    if (current.phase === 'closed' || current.phase === 'closing') return
    const selected = this.sessions?.list.getSnapshot().current
    if (selected === current.parentSessionId || selected === current.childSessionId) return
    // A normal session switch should not leave a running side task detached
    // from all UI. Cancellation is best-effort, but close retains failures.
    void this.close()
  }

  private onChildChanged(): void {
    const current = this.getSnapshot()
    const child = this.child
    if (child === null || current.phase === 'closed') return
    const childSnapshot = child.getSnapshot()
    if (childSnapshot.removed) {
      // The Host has already closed/removed this child. Mirror the reference
      // closed-side path by discarding browser-local state without issuing a
      // second cancel/archive request, and avoid leaving a removed child
      // selected in the standard conversation view.
      ++this.lifecycle
      const selected = this.sessions?.list.getSnapshot().current
      if (selected === current.childSessionId && current.parentSessionId !== null) {
        this.sessions?.open(current.parentSessionId)
      }
      this.reset(null)
      return
    }
    if (current.phase === 'closing') {
      this.publish({ child: childSnapshot })
      return
    }
    const phase: BtwPhase = current.phase === 'sending'
      ? 'sending'
      : childSnapshot.running
        ? 'active'
        : current.phase === 'active'
          ? 'ready'
          : current.phase
    this.publish({ phase, child: childSnapshot, error: childSnapshot.promptError?.error.message ?? current.error })
  }

  private publish(patch: Partial<Omit<BtwSnapshot, 'transcript'>> & { turns?: readonly BtwTurnRecord[] }): void {
    const current = this.getSnapshot()
    const turns = patch.turns ?? current.turns
    const child = Object.prototype.hasOwnProperty.call(patch, 'child') ? patch.child ?? null : current.child
    const parent = Object.prototype.hasOwnProperty.call(patch, 'parent') ? patch.parent ?? null : current.parent
    const next: BtwSnapshot = {
      ...current,
      ...patch,
      child,
      parent,
      turns,
      transcript: projectBtwTranscript({
        baselineSeq: current.baselineSeq,
        nodes: child?.nodes ?? [],
        partial: child?.partial ?? null,
        runningCalls: child?.runningCalls ?? [],
        turns,
      }),
    }
    this.store.set(next)
  }

  private markTurnError(turns: readonly BtwTurnRecord[], turnId: number, message: string): void {
    this.publish({
      phase: 'ready',
      turns: turns.map((item) => item.id === turnId ? { ...item, status: 'error', error: message } : item),
      error: message,
    })
  }

  private reset(error: string | null): void {
    this.childOff?.()
    this.childOff = null
    this.restoreChildPrompt?.()
    this.restoreChildPrompt = null
    this.parentOff?.()
    this.parentOff = null
    this.child = null
    this.parent = null
    this.childInFlight = null
    this.sendQueue = null
    this.boundarySent = false
    this.releaseBoundaryAdmission?.()
    this.boundaryAdmission = null
    this.releaseBoundaryAdmission = null
    this.promptAdmissions.clear()
    this.firstPromptContext = null
    this.store.set(error === null ? CLOSED : { ...CLOSED, error })
  }
}

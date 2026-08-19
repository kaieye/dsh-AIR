import type { Context } from '@deepseek-ai/cordis'
import type {
  InputTriggerCandidate,
  InputTriggerPick,
  InputTriggerSource,
  PickOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { DraftMentionSnapshot, DraftSnapshot } from '../core/draft-snapshot.ts'
import {
  markerForPaste,
  pasteLabel,
  PASTE_REFERENCE_SOURCE,
  readPastePayload,
  writePastePayload,
} from '../core/paste-chip.ts'

interface InputStateLike {
  readonly draft: string
  readonly draftRev: number
  readonly occurrences: readonly {
    readonly occurrenceId: number
    readonly source: string
    readonly ref: string
    readonly offset: number
  }[]
  readonly imageIds: readonly unknown[]
}

interface SessionInputLike {
  readonly state: { getSnapshot(): InputStateLike }
  setDraft(text: string): void
  addImages?(ids: readonly unknown[]): boolean
  removeImage?(id: unknown): void
  notify?(level: 'info' | 'error', text: string): void
}

interface ConversationImageController {
  resolveImage(sessionId: SessionId, attachment: unknown): Promise<string>
  createDraftImages(files: readonly File[]): readonly { id: unknown; file: File; previewUrl: string }[]
}

function scopeOf(ctx: Context, sessionId: SessionId): Context | undefined {
  return (ctx.sessions as unknown as { scope(id: SessionId): Context | undefined }).scope(sessionId)
}

function inputFor(ctx: Context, sessionId: SessionId): SessionInputLike | undefined {
  const scoped = scopeOf(ctx, sessionId)
  if (scoped === undefined) return undefined
  return ctx.conversation.input.for(scoped) as unknown as SessionInputLike
}

function isRestorableReference(mention: DraftMentionSnapshot): boolean {
  // Transcript-only inference knows the glyph, not the owning serializer. A
  // guessed source would create an invalid chip, so only live-captured source
  // routing keys are reinserted.
  return mention.source !== '/' && mention.source !== '@'
}

/** Browser-owned paste/reference registry and the public input-machine bridge. */
export class LargePasteController {
  private readonly live = new Map<string, string>()
  private readonly restoreEpoch = new Map<SessionId, number>()

  constructor(private readonly ctx: Context) {}

  registerSource(): InputTriggerSource {
    return {
      trigger: '@',
      name: PASTE_REFERENCE_SOURCE,
      order: 10_000,
      async candidates(_session, _request): Promise<readonly InputTriggerCandidate[]> {
        return []
      },
      onPick(_pick: InputTriggerPick): PickOutcome {
        return undefined
      },
      codec: {
        clipboardText: (ref: string) => this.payloadOf(ref) ?? markerForPaste(ref),
        serialize: async (ref: string, signal: AbortSignal): Promise<string> => {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          const payload = this.payloadOf(ref)
          if (payload === undefined) throw new Error('大段粘贴内容已失效，请重新粘贴。')
          return payload
        },
      },
    }
  }

  payloadOf(id: string): string | undefined {
    return this.live.get(id) ?? (typeof window === 'undefined' ? undefined : readPastePayload(id))
  }

  notify(sessionId: SessionId, level: 'info' | 'error', text: string): void {
    inputFor(this.ctx, sessionId)?.notify?.(level, text)
  }

  /** True when the composer holds no text, chips, or images (safe to restore into). */
  composerEmpty(sessionId: SessionId): boolean {
    const state = inputFor(this.ctx, sessionId)?.state.getSnapshot()
    if (state === undefined) return false
    return state.draft.trim() === ''
      && state.occurrences.length === 0
      && (state.imageIds?.length ?? 0) === 0
  }

  expand(sessionId: SessionId, occurrenceId: number): boolean {
    const input = inputFor(this.ctx, sessionId)
    const state = input?.state.getSnapshot()
    if (input === undefined || state === undefined) return false
    const occurrence = state.occurrences.find((item) => item.occurrenceId === occurrenceId && item.source === PASTE_REFERENCE_SOURCE)
    const payload = occurrence === undefined ? undefined : this.payloadOf(occurrence.ref)
    if (occurrence === undefined || payload === undefined) return false
    input.setDraft(state.draft.slice(0, occurrence.offset) + payload + state.draft.slice(occurrence.offset + 1))
    return true
  }

  remove(sessionId: SessionId, occurrenceId: number): boolean {
    const input = inputFor(this.ctx, sessionId)
    const state = input?.state.getSnapshot()
    if (input === undefined || state === undefined) return false
    const occurrence = state.occurrences.find((item) => item.occurrenceId === occurrenceId && item.source === PASTE_REFERENCE_SOURCE)
    if (occurrence === undefined) return false
    input.setDraft(state.draft.slice(0, occurrence.offset) + state.draft.slice(occurrence.offset + 1))
    return true
  }

  /** Rebuild paste and live-captured mention/reference chips, right-to-left. */
  private async restoreReferences(sessionId: SessionId, snapshot: DraftSnapshot): Promise<void> {
    const input = inputFor(this.ctx, sessionId)
    const scoped = scopeOf(this.ctx, sessionId)
    if (input === undefined || scoped === undefined) return
    const jobs = [
      ...snapshot.pastes.map((paste) => ({ kind: 'paste' as const, start: paste.start, end: paste.end, paste })),
      ...snapshot.mentions.filter(isRestorableReference).map((mention) => ({
        kind: 'mention' as const,
        start: mention.offset,
        end: mention.offset + mention.clipboardText.length,
        mention,
      })),
    ].sort((a, b) => b.start - a.start)

    for (const job of jobs) {
      const state = input.state.getSnapshot()
      if (job.kind === 'paste') {
        if (state.draft.slice(job.start, job.end) !== job.paste.payload) continue
        this.live.set(job.paste.id, job.paste.payload)
        writePastePayload({ id: job.paste.id, text: job.paste.payload, createdAt: Date.now() })
        scoped.bail(scoped, 'slash/input-insert-reference', {
          reference: {
            source: PASTE_REFERENCE_SOURCE,
            ref: job.paste.id,
            label: pasteLabel(job.paste.payload),
            clipboardText: job.paste.payload,
          },
          span: { start: job.start, end: job.end, draftRev: state.draftRev },
        })
        continue
      }
      if (state.draft.slice(job.start, job.end) !== job.mention.clipboardText) continue
      scoped.bail(scoped, 'slash/input-insert-reference', {
        reference: {
          source: job.mention.source,
          ref: job.mention.ref,
          label: job.mention.label,
          clipboardText: job.mention.clipboardText,
        },
        span: { start: job.start, end: job.end, draftRev: state.draftRev },
      })
    }
  }

  /** Rehydrate durable images into browser-owned attachment ids when recalled. */
  private async restoreImages(
    sessionId: SessionId,
    sourceSessionId: SessionId,
    snapshot: DraftSnapshot,
    epoch = this.restoreEpoch.get(sessionId),
  ): Promise<number> {
    if (snapshot.attachments.length === 0) return 0
    const conversation = this.ctx.conversation as unknown as ConversationImageController
    const input = inputFor(this.ctx, sessionId)
    if (input === undefined || typeof conversation.resolveImage !== 'function' || typeof conversation.createDraftImages !== 'function') {
      input?.notify?.('info', `${snapshot.attachments.length} 个历史附件无法恢复，请重新选择。`)
      return snapshot.attachments.length
    }
    let missing = 0
    for (const item of snapshot.attachments) {
      try {
        const url = await conversation.resolveImage(sourceSessionId, item.attachment)
        const response = await fetch(url)
        if (!response.ok) throw new Error(`image ${response.status}`)
        const blob = await response.blob()
        if (epoch !== undefined && this.restoreEpoch.get(sessionId) !== epoch) return missing
        const file = new File([blob], item.attachment.name ?? 'restored-image', { type: item.attachment.mediaType })
        const descriptors = conversation.createDraftImages([file])
        const ids = descriptors.map((descriptor) => descriptor.id)
        if (ids.length === 0 || input.addImages?.(ids) === false) throw new Error('image admission failed')
      } catch {
        missing += 1
      }
    }
    if (missing > 0 && (epoch === undefined || this.restoreEpoch.get(sessionId) === epoch)) {
      input.notify?.('info', `${missing} 个历史附件无法恢复，请重新选择。`)
    }
    return missing
  }

  /** Restore text first, then references and durable images. */
  async restoreSnapshot(
    sessionId: SessionId,
    snapshot: DraftSnapshot,
    sourceSessionId = sessionId,
  ): Promise<boolean> {
    const input = inputFor(this.ctx, sessionId)
    if (input === undefined) return false
    const epoch = (this.restoreEpoch.get(sessionId) ?? 0) + 1
    this.restoreEpoch.set(sessionId, epoch)
    for (const imageId of [...input.state.getSnapshot().imageIds]) input.removeImage?.(imageId)
    input.setDraft(snapshot.text)
    await Promise.resolve()
    if (this.restoreEpoch.get(sessionId) !== epoch) return false
    await this.restoreReferences(sessionId, snapshot)
    if (this.restoreEpoch.get(sessionId) !== epoch) return false
    await this.restoreImages(sessionId, sourceSessionId, snapshot, epoch)
    return this.restoreEpoch.get(sessionId) === epoch
  }

  /** Restore an unsent local draft, including its still-browser-owned image ids. */
  async restoreLocalSnapshot(
    sessionId: SessionId,
    snapshot: DraftSnapshot,
    imageIds: readonly unknown[],
  ): Promise<boolean> {
    const input = inputFor(this.ctx, sessionId)
    if (input === undefined) return false
    const epoch = (this.restoreEpoch.get(sessionId) ?? 0) + 1
    this.restoreEpoch.set(sessionId, epoch)
    for (const imageId of [...input.state.getSnapshot().imageIds]) input.removeImage?.(imageId)
    input.setDraft(snapshot.text)
    await Promise.resolve()
    if (this.restoreEpoch.get(sessionId) !== epoch) return false
    await this.restoreReferences(sessionId, snapshot)
    if (imageIds.length > 0 && input.addImages?.(imageIds) === false) {
      input.notify?.('info', `${imageIds.length} 个草稿附件无法恢复，请重新选择。`)
    }
    return this.restoreEpoch.get(sessionId) === epoch
  }
}

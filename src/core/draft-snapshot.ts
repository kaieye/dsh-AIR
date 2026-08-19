import type { ConversationHistorySource } from './history-extraction.ts'

/** Kept deliberately below the first visually disruptive paste size. */
export const LARGE_PASTE_THRESHOLD = 2_000

export interface DurableImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** Versioned, browser-local representation of one restorable composer entry. */
export interface DraftSnapshot {
  readonly version: 1
  /** Stable source identity (node seq, or a queue/fingerprint identity). */
  readonly id: string
  /** Fully expanded text; rich placeholders are represented by `pastes`/`mentions`. */
  readonly text: string
  readonly attachments: readonly DraftAttachmentSnapshot[]
  readonly mentions: readonly DraftMentionSnapshot[]
  readonly pastes: readonly DraftPasteSnapshot[]
  readonly createdAt?: number
}

export interface DraftAttachmentSnapshot {
  readonly kind: 'image'
  readonly attachment: DurableImageRef
}

/**
 * A non-paste reference occurrence in expanded-text coordinates.
 *
 * `source` is the input-trigger routing key when captured from a live composer.
 * Durable transcript fallback extraction only knows the trigger glyph (`/` or
 * `@`), so those inferred rows remain display/search metadata and are not
 * blindly reinserted as chips.
 */
export interface DraftMentionSnapshot {
  readonly source: string
  readonly trigger?: '/' | '@'
  readonly ref: string
  readonly label: string
  readonly offset: number
  readonly clipboardText: string
}

export interface DraftPasteSnapshot {
  readonly id: string
  /** Range in the fully expanded text. */
  readonly start: number
  readonly end: number
  readonly payload: string
}

export interface DraftHistorySource extends ConversationHistorySource {
  readonly sessionId?: string
}

/** Minimal live occurrence currency needed to capture a rich composer draft. */
export interface DraftOccurrenceSource {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly clipboardText: string
  readonly offset: number
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function imageRefOf(value: unknown): DurableImageRef | null {
  if (!isRecord(value) || !isRecord(value.attachment)) return null
  const attachment = value.attachment
  if (
    typeof attachment.attachmentId !== 'string'
    || typeof attachment.mediaType !== 'string'
    || !finiteNonNegative(attachment.bytes)
    || !finiteNonNegative(attachment.width)
    || !finiteNonNegative(attachment.height)
  ) return null
  return {
    attachmentId: attachment.attachmentId,
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
    width: attachment.width,
    height: attachment.height,
    ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
  }
}

function contentOf(value: unknown): readonly unknown[] | null {
  return isRecord(value) && Array.isArray(value.content) ? value.content : null
}

function textAndImages(content: readonly unknown[]): {
  text: string
  attachments: DraftAttachmentSnapshot[]
  pasteRanges: Array<{ start: number; end: number; payload: string }>
} | null {
  let text = ''
  const attachments: DraftAttachmentSnapshot[] = []
  const pasteRanges: Array<{ start: number; end: number; payload: string }> = []

  for (const block of content) {
    if (!isRecord(block)) return null
    if (block.type === 'text' && typeof block.text === 'string') {
      const start = text.length
      text += block.text
      if (block.text.length >= LARGE_PASTE_THRESHOLD) {
        pasteRanges.push({ start, end: text.length, payload: block.text })
      }
      continue
    }
    if (block.type === 'image') {
      const attachment = imageRefOf(block)
      if (attachment === null) return null
      attachments.push({ kind: 'image', attachment })
      continue
    }
    // An unknown block can carry semantics the composer cannot reconstruct.
    // Skip the whole history row rather than silently flattening it.
    return null
  }

  return { text, attachments, pasteRanges }
}

const MENTION_PATTERN = /(^|\s)([/@][\w-]+)(?=\s|$)/g

function mentionsOf(text: string): DraftMentionSnapshot[] {
  const mentions: DraftMentionSnapshot[] = []
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const token = match[2]
    if (token === undefined || match.index === undefined) continue
    const offset = match.index + (match[1]?.length ?? 0)
    const trigger = token.startsWith('@') ? '@' : '/'
    mentions.push({
      source: trigger,
      trigger,
      ref: token.slice(1),
      label: token,
      offset,
      clipboardText: token,
    })
  }
  return mentions
}

function idForNode(node: UnknownRecord, index: number): string {
  if (typeof node.seq === 'number' && Number.isFinite(node.seq)) return `node:${node.seq}`
  if (node.kind === 'command' && typeof node.name === 'string') return `command:${index}:${node.name}`
  return `node:${index}`
}

function snapshotForContent(
  id: string,
  content: readonly unknown[],
  createdAt?: number,
): DraftSnapshot | null {
  const projected = textAndImages(content)
  if (projected === null || projected.text.length === 0) return null
  return {
    version: 1,
    id,
    text: projected.text,
    attachments: projected.attachments,
    mentions: mentionsOf(projected.text),
    pastes: projected.pasteRanges.map((range, index) => ({
      id: `${id}:paste:${index}`,
      ...range,
    })),
    ...(createdAt === undefined ? {} : { createdAt }),
  }
}

function commandSnapshot(node: UnknownRecord, index: number): DraftSnapshot | null {
  if (typeof node.name !== 'string' || node.name.length === 0) return null
  const text = `/${node.name}${typeof node.args === 'string' ? node.args : ''}`
  return {
    version: 1,
    id: idForNode(node, index),
    text,
    attachments: [],
    mentions: [],
    pastes: [],
    ...(typeof node.time === 'number' ? { createdAt: node.time } : {}),
  }
}

/** Project one durable user/steering/command node to a restorable snapshot. */
export function draftSnapshotForNode(raw: unknown, fallbackIndex = 0): DraftSnapshot | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string') return null
  if (raw.kind === 'user' || raw.kind === 'steering') {
    const content = contentOf(raw)
    if (content === null) return null
    return snapshotForContent(
      idForNode(raw, fallbackIndex),
      content,
      typeof raw.time === 'number' ? raw.time : undefined,
    )
  }
  if (raw.kind === 'command') return commandSnapshot(raw, fallbackIndex)
  return null
}

/** Extract rich user/steering history without silently flattening unknown blocks. */
export function extractDraftSnapshots(source: DraftHistorySource): DraftSnapshot[] {
  const snapshots: DraftSnapshot[] = []
  source.nodes.forEach((raw, index) => {
    const snapshot = draftSnapshotForNode(raw, index)
    if (snapshot !== null) snapshots.push(snapshot)
  })

  for (const [index, raw] of (source.queue ?? []).entries()) {
    if (!isRecord(raw)) continue
    const content = contentOf(raw)
    if (content !== null) {
      const snapshot = snapshotForContent(`queue:${index}`, content)
      if (snapshot !== null) snapshots.push(snapshot)
      continue
    }
    if (typeof raw.text === 'string' && raw.text.length > 0) {
      snapshots.push({
        version: 1,
        id: `queue:${index}`,
        text: raw.text,
        attachments: [],
        mentions: mentionsOf(raw.text),
        pastes: raw.text.length >= LARGE_PASTE_THRESHOLD ? [{
          id: `queue:${index}:paste:0`,
          start: 0,
          end: raw.text.length,
          payload: raw.text,
        }] : [],
      })
    }
  }

  return normalizeDraftSnapshots(snapshots)
}

/**
 * Capture a live input-machine draft by replacing U+FFFC placeholders with
 * their clipboard projections. Paste payloads and real source routing keys are
 * retained so history/search cancel and post-send persistence can rebuild the
 * original chips rather than returning a visually similar plain string.
 */
export function draftSnapshotFromComposer(
  id: string,
  draft: string,
  occurrences: readonly DraftOccurrenceSource[],
  pastePayloadOf: (id: string) => string | undefined,
  createdAt?: number,
): DraftSnapshot {
  let text = ''
  let cursor = 0
  const mentions: DraftMentionSnapshot[] = []
  const pastes: DraftPasteSnapshot[] = []

  for (const occurrence of [...occurrences].sort((a, b) => a.offset - b.offset)) {
    if (occurrence.offset < cursor || occurrence.offset >= draft.length) continue
    text += draft.slice(cursor, occurrence.offset)
    const offset = text.length
    const pastePayload = occurrence.source === 'dsh-air-paste'
      ? pastePayloadOf(occurrence.ref)
      : undefined
    if (pastePayload !== undefined) {
      text += pastePayload
      pastes.push({
        id: occurrence.ref,
        start: offset,
        end: text.length,
        payload: pastePayload,
      })
    } else {
      const clipboardText = occurrence.clipboardText || occurrence.label || occurrence.ref
      text += clipboardText
      const trigger = clipboardText.startsWith('@')
        ? '@'
        : clipboardText.startsWith('/') ? '/' : undefined
      mentions.push({
        source: occurrence.source,
        ...(trigger === undefined ? {} : { trigger }),
        ref: occurrence.ref,
        label: occurrence.label,
        offset,
        clipboardText,
      })
    }
    cursor = occurrence.offset + 1
  }
  text += draft.slice(cursor)

  return {
    version: 1,
    id,
    text,
    attachments: [],
    mentions,
    pastes,
    ...(createdAt === undefined ? {} : { createdAt }),
  }
}

export function snapshotFingerprint(snapshot: Pick<DraftSnapshot, 'text' | 'attachments'>): string {
  const images = snapshot.attachments.map(({ attachment }) => attachment.attachmentId).join(',')
  return `${snapshot.text}\u0000${images}`
}

export function normalizeDraftSnapshots(entries: Iterable<DraftSnapshot>): DraftSnapshot[] {
  const normalized: DraftSnapshot[] = []
  for (const entry of entries) {
    if (!isDraftSnapshot(entry) || entry.text.length === 0) continue
    const previous = normalized.at(-1)
    if (previous !== undefined && snapshotFingerprint(previous) === snapshotFingerprint(entry)) {
      // A queue row can briefly coexist with the durable node it became. Keep
      // the durable identity/attachment descriptors regardless of projection
      // order; otherwise prefer the later occurrence.
      if (!previous.id.startsWith('queue:') && entry.id.startsWith('queue:')) continue
      normalized[normalized.length - 1] = entry
      continue
    }
    normalized.push(entry)
  }
  return normalized
}

function isDurableImageRef(value: unknown): value is DurableImageRef {
  return isRecord(value)
    && typeof value.attachmentId === 'string'
    && typeof value.mediaType === 'string'
    && finiteNonNegative(value.bytes)
    && finiteNonNegative(value.width)
    && finiteNonNegative(value.height)
    && (value.name === undefined || typeof value.name === 'string')
}

function isAttachmentSnapshot(value: unknown): value is DraftAttachmentSnapshot {
  return isRecord(value) && value.kind === 'image' && isDurableImageRef(value.attachment)
}

function isMentionSnapshot(value: unknown): value is DraftMentionSnapshot {
  return isRecord(value)
    && typeof value.source === 'string'
    && (value.trigger === undefined || value.trigger === '/' || value.trigger === '@')
    && typeof value.ref === 'string'
    && typeof value.label === 'string'
    && finiteNonNegative(value.offset)
    && typeof value.clipboardText === 'string'
}

function isPasteSnapshot(value: unknown): value is DraftPasteSnapshot {
  return isRecord(value)
    && typeof value.id === 'string'
    && finiteNonNegative(value.start)
    && finiteNonNegative(value.end)
    && value.end >= value.start
    && typeof value.payload === 'string'
}

export function isDraftSnapshot(value: unknown): value is DraftSnapshot {
  if (
    !isRecord(value)
    || value.version !== 1
    || typeof value.id !== 'string'
    || typeof value.text !== 'string'
    || (value.createdAt !== undefined && !finiteNonNegative(value.createdAt))
    || !Array.isArray(value.attachments)
    || !Array.isArray(value.mentions)
    || !Array.isArray(value.pastes)
  ) return false
  return value.attachments.every(isAttachmentSnapshot)
    && value.mentions.every(isMentionSnapshot)
    && value.pastes.every(isPasteSnapshot)
}

/**
 * Convert the rich snapshot to the searchable string used by HistoryNavigator.
 *
 * `occurrence` disambiguates identical text sent more than once (codex keeps
 * each append as its own offset). Search still keys on the text prefix before
 * the first NUL via {@link historyKeyText} / `searchableEntryText`.
 */
export function historyKey(snapshot: DraftSnapshot, occurrence = 0): string {
  return `${snapshot.text}\u0000dsh-air-snapshot:${snapshot.id}\u0000${occurrence}`
}

export function historyKeyText(key: string): string {
  const separator = key.indexOf('\u0000dsh-air-snapshot:')
  return separator < 0 ? key : key.slice(0, separator)
}

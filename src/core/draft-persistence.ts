import {
  isDraftSnapshot,
  normalizeDraftSnapshots,
  snapshotFingerprint,
  type DraftSnapshot,
} from './draft-snapshot.ts'

export const DRAFT_HISTORY_STORAGE_PREFIX = 'dsh-air:drafts:'
export const DRAFT_HISTORY_STORAGE_LIMIT = 500

/** Minimal Storage surface for draft helpers (injectable in tests). */
export interface DraftStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length: number
  key(index: number): string | null
}

export function draftHistoryStorageKey(sessionId: string): string {
  return `${DRAFT_HISTORY_STORAGE_PREFIX}${sessionId}`
}

/**
 * Delete every per-session rich draft sidecar (`dsh-air:drafts:*`).
 *
 * Used together with {@link clearGlobalHistory} so ↑ cannot rehydrate wiped
 * order from leftover snapshots.
 */
export function clearAllDraftHistories(storage: DraftStorageLike): void {
  try {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key !== null && key.startsWith(DRAFT_HISTORY_STORAGE_PREFIX)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    // Ignore blocked storage.
  }
}

export function parseDraftHistory(raw: string | null): DraftSnapshot[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return normalizeDraftSnapshots(parsed.filter(isDraftSnapshot))
  } catch {
    return []
  }
}

export function serializeDraftHistory(entries: readonly DraftSnapshot[]): string {
  return JSON.stringify(capDraftHistory(entries))
}

function mergeSameIdentity(persisted: DraftSnapshot, current: DraftSnapshot): DraftSnapshot {
  const persistedCarriesLiveReferences = persisted.pastes.length > 0
    || persisted.mentions.some((mention) => mention.source !== '/' && mention.source !== '@')
  return {
    ...current,
    // Live composer capture preserves the user-facing clipboard projection for
    // references; the durable row remains authoritative for image descriptors.
    text: persistedCarriesLiveReferences ? persisted.text : current.text,
    attachments: current.attachments.length > 0 ? current.attachments : persisted.attachments,
    mentions: persisted.mentions.length > 0 ? persisted.mentions : current.mentions,
    pastes: persisted.pastes.length > 0 ? persisted.pastes : current.pastes,
  }
}


function queueMatchesDurable(queue: DraftSnapshot, durable: DraftSnapshot): boolean {
  if (!queue.id.startsWith('queue:')) return false
  if (snapshotFingerprint(queue) === snapshotFingerprint(durable)) return true
  // Queue projections may expose image content without durable attachment ids.
  // Text equality is the best seam identity in that one asymmetric case.
  return queue.text === durable.text && queue.attachments.length === 0
}

/** Merge by stable event identity; queue-to-durable handoff is folded at the seam. */
export function mergeDraftHistory(
  persisted: readonly DraftSnapshot[],
  current: readonly DraftSnapshot[],
): DraftSnapshot[] {
  const persistedById = new Map(persisted.map((entry) => [entry.id, entry]))
  const currentIds = new Set(current.map((entry) => entry.id))
  const currentFingerprints = new Set(current.map(snapshotFingerprint))
  const olderOnly = persisted.filter((entry) => {
    if (currentIds.has(entry.id)) return false
    // Queue occurrence ids are browser-window identities. Once the durable
    // row with the same content arrives, retain the durable row instead.
    if (entry.id.startsWith('queue:') && (
      currentFingerprints.has(snapshotFingerprint(entry))
      || current.some((candidate) => queueMatchesDurable(entry, candidate))
    )) return false
    return true
  })
  const mergedCurrent = current.map((entry) => {
    const existing = persistedById.get(entry.id)
    if (existing !== undefined) return mergeSameIdentity(existing, entry)
    // Queue ids are browser-window identities. When the matching durable node
    // arrives under a new id, carry the live-captured chips across the seam.
    const queuePredecessor = [...persisted].reverse().find((candidate) =>
      queueMatchesDurable(candidate, entry),
    )
    return queuePredecessor === undefined ? entry : mergeSameIdentity(queuePredecessor, entry)
  })
  return normalizeDraftSnapshots([...olderOnly, ...mergedCurrent])
}

export function capDraftHistory(
  entries: readonly DraftSnapshot[],
  limit = DRAFT_HISTORY_STORAGE_LIMIT,
): DraftSnapshot[] {
  if (entries.length <= limit) return [...entries]
  return entries.slice(entries.length - limit)
}

/** Match a node after a reload when the host's window no longer carries our local id. */
export function findRichSnapshot(
  entries: readonly DraftSnapshot[],
  candidate: Pick<DraftSnapshot, 'text' | 'attachments'>,
): DraftSnapshot | undefined {
  const fingerprint = snapshotFingerprint(candidate)
  return [...entries].reverse().find((entry) => snapshotFingerprint(entry) === fingerprint)
}

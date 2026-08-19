import { normalizeHistoryEntries } from './history-navigation.ts'

/**
 * Cross-session recall history, modeled after codex's global append-only
 * message history file (`~/.codex/history.jsonl`).
 *
 * codex stores every sent message in one shared file with
 * `{session_id, ts, text}` records and does **not** collapse identical text
 * that reappears later. Local composer history only skips an entry when it is
 * identical to the immediate previous submission. This module is the web
 * equivalent: one localStorage key holding every session's sent text in send
 * order, with consecutive-duplicate collapse only.
 */

/** Single key for the whole cross-session history (codex's shared history file). */
export const GLOBAL_HISTORY_STORAGE_KEY = 'dsh-air:history:global'

/**
 * Prefix of the legacy per-session storage keys (`dsh-air:history:<sessionId>`)
 * from before cross-session history existed. Kept only to migrate that data
 * once into the global store.
 */
export const HISTORY_STORAGE_PREFIX = 'dsh-air:history:'

/**
 * Optional localStorage override for the entry cap (Codex `History.max_bytes`
 * adapted to a Web entry count). Invalid or missing values fall back to
 * {@link HISTORY_STORAGE_LIMIT}.
 */
export const HISTORY_LIMIT_STORAGE_KEY = 'dsh-air:history:limit'

/** Default upper bound on persisted global entries. */
export const HISTORY_STORAGE_LIMIT = 500

/** Inclusive clamp for {@link resolveHistoryLimit}. */
export const HISTORY_STORAGE_LIMIT_MIN = 10
export const HISTORY_STORAGE_LIMIT_MAX = 5_000

/** Minimal Storage surface used by pure helpers (injectable in tests). */
export interface HistoryStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length: number
  key(index: number): string | null
}

/** One recalled send, mirroring codex's `{session_id, ts, text}` record. */
export interface GlobalHistoryEntry {
  readonly sessionId: string
  /** Unix seconds when the message was sent (0 for migrated legacy entries). */
  readonly ts: number
  readonly text: string
}

/** Guard for records parsed back from storage. */
export function isGlobalHistoryEntry(value: unknown): value is GlobalHistoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.sessionId === 'string' &&
    typeof entry.ts === 'number' &&
    typeof entry.text === 'string'
  )
}

/**
 * Resolve the effective entry cap from storage.
 *
 * Missing, non-integer, non-positive, or out-of-range values return the default
 * 500. Values are clamped into {@link HISTORY_STORAGE_LIMIT_MIN}…
 * {@link HISTORY_STORAGE_LIMIT_MAX}.
 */
export function resolveHistoryLimit(storage?: HistoryStorageLike | null): number {
  if (storage == null) return HISTORY_STORAGE_LIMIT
  let raw: string | null
  try {
    raw = storage.getItem(HISTORY_LIMIT_STORAGE_KEY)
  } catch {
    return HISTORY_STORAGE_LIMIT
  }
  if (raw === null || raw.trim() === '') return HISTORY_STORAGE_LIMIT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return HISTORY_STORAGE_LIMIT
  }
  return Math.min(HISTORY_STORAGE_LIMIT_MAX, Math.max(HISTORY_STORAGE_LIMIT_MIN, parsed))
}

/** Parse a global history JSON blob; invalid input yields `[]`. */
export function parseGlobalHistory(raw: string | null): GlobalHistoryEntry[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isGlobalHistoryEntry)
  } catch {
    return []
  }
}

/**
 * Read and cap global history so a lowered limit takes effect without a new send.
 */
export function readGlobalHistory(storage: HistoryStorageLike): GlobalHistoryEntry[] {
  try {
    const entries = parseGlobalHistory(storage.getItem(GLOBAL_HISTORY_STORAGE_KEY))
    return capHistoryEntries(entries, resolveHistoryLimit(storage))
  } catch {
    return []
  }
}

/** Persist global history, applying the resolved entry cap. */
export function writeGlobalHistory(
  storage: HistoryStorageLike,
  entries: readonly GlobalHistoryEntry[],
): void {
  try {
    const capped = capHistoryEntries(entries, resolveHistoryLimit(storage))
    storage.setItem(GLOBAL_HISTORY_STORAGE_KEY, JSON.stringify(capped))
  } catch {
    // Storage full or blocked; callers still keep an in-memory copy.
  }
}

/**
 * Remove the global history blob. Leaves {@link HISTORY_LIMIT_STORAGE_KEY} intact
 * so the user's capacity preference survives a clear.
 */
export function clearGlobalHistory(storage: HistoryStorageLike): void {
  try {
    storage.removeItem(GLOBAL_HISTORY_STORAGE_KEY)
  } catch {
    // Ignore blocked storage.
  }
}

/**
 * True when `windowTexts` is a prefix of the current global suffix (after
 * empty rows are dropped). Used so a stable ConversationSnapshot projection
 * does not re-append the same sends on every render.
 */
export function isWindowPrefixOfGlobalSuffix(
  existing: readonly GlobalHistoryEntry[],
  windowTexts: readonly string[],
): boolean {
  const window = windowTexts.filter((text) => text.length > 0)
  if (window.length === 0) return true
  if (window.length > existing.length) return false
  const suffix = existing.slice(existing.length - window.length)
  return suffix.every((entry, index) => entry.text === window[index])
}

/**
 * Append window texts that are not already the trailing suffix of the global
 * history.
 *
 * Unlike an earlier draft of this module, identical text is allowed to appear
 * more than once when it is not consecutive — matching codex's append-only
 * `history.jsonl`. Only an empty row, or a row equal to the previous entry, is
 * skipped (codex `record_local_submission` adjacent-duplicate rule).
 *
 * When the full window already matches the global suffix (typical steady-state
 * after the previous append), nothing is written. When the window is a longer
 * extension of that suffix, only the unseen tail is appended.
 */
export function appendNewGlobalEntries(
  existing: readonly GlobalHistoryEntry[],
  sessionId: string,
  windowTexts: readonly string[],
  ts: number,
  limit = HISTORY_STORAGE_LIMIT,
): GlobalHistoryEntry[] {
  const window = windowTexts.filter((text) => text.length > 0)
  if (window.length === 0) return capHistoryEntries(existing, limit)

  // Longest prefix of `window` that is already the suffix of `existing`.
  let matched = 0
  const maxMatch = Math.min(window.length, existing.length)
  for (let size = maxMatch; size >= 0; size -= 1) {
    const suffix = existing.slice(existing.length - size)
    if (suffix.every((entry, index) => entry.text === window[index])) {
      matched = size
      break
    }
  }

  if (matched === window.length) return capHistoryEntries(existing, limit)

  const merged = existing.slice()
  for (let index = matched; index < window.length; index += 1) {
    const text = window[index]
    if (text === undefined || text.length === 0) continue
    if (merged.at(-1)?.text === text) continue
    merged.push({ sessionId, ts, text })
  }
  return capHistoryEntries(merged, limit)
}

/**
 * Project the recallable texts for one session: global history first, then any
 * current-window texts not already covered as the global suffix (so a just-sent
 * message is recallable even before the persistence effect runs).
 */
export function mergeGlobalWithWindow(
  global: readonly GlobalHistoryEntry[],
  windowTexts: readonly string[],
): string[] {
  const merged = appendNewGlobalEntries(global, '', windowTexts, 0, Number.MAX_SAFE_INTEGER)
  return normalizeHistoryEntries(merged.map((entry) => entry.text))
}

/**
 * Fold one or more legacy per-session string lists into global entries.
 *
 * Legacy keys already applied consecutive-duplicate collapse per session. The
 * migration preserves that per-list order and only collapses a boundary when
 * two adjacent lists end/start with the same text. Used by the one-time
 * migration; identical non-adjacent texts across sessions are kept so the
 * resulting store matches append-only semantics as closely as possible.
 */
export function assembleGlobalFromLegacy(
  lists: Iterable<readonly string[]>,
  sessionIdOf?: (listIndex: number) => string,
  limit = HISTORY_STORAGE_LIMIT,
): GlobalHistoryEntry[] {
  const entries: GlobalHistoryEntry[] = []
  let index = 0
  for (const list of lists) {
    const sessionId = sessionIdOf?.(index) ?? ''
    for (const text of list) {
      if (text.length === 0) continue
      if (entries.at(-1)?.text === text) continue
      entries.push({ sessionId, ts: 0, text })
    }
    index += 1
  }
  return capHistoryEntries(entries, limit)
}

/**
 * Cap a persisted list to the newest `limit` entries.
 *
 * Keeps storage bounded while preserving the most recently sent messages,
 * which are the ones recall navigates to first.
 */
export function capHistoryEntries<T>(entries: readonly T[], limit = HISTORY_STORAGE_LIMIT): T[] {
  if (entries.length <= limit) return [...entries]
  return entries.slice(entries.length - limit)
}

/** Compare two global histories by text sequence (order-sensitive). */
export function equalGlobalEntries(
  left: readonly GlobalHistoryEntry[],
  right: readonly GlobalHistoryEntry[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((entry, index) => entry.text === right[index]?.text)
}

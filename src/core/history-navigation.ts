/** Direction in which the user is traversing sent-message history. */
export type HistoryDirection = 'up' | 'down'

/** Current input state relevant to history-key arbitration. */
export interface HistoryNavigationRequest {
  readonly draft: string
  readonly selectionStart: number
  readonly selectionEnd: number
}

/** Result of one ArrowUp/ArrowDown attempt. */
export type HistoryNavigationResult =
  | { readonly handled: false }
  | { readonly handled: true, readonly text: string }

const NOT_HANDLED: HistoryNavigationResult = { handled: false }

/**
 * Remove unusable rows and collapse consecutive exact duplicates.
 *
 * Whitespace is intentionally preserved: history recall must restore exactly
 * what DSH recorded rather than normalizing a user's message.
 */
export function normalizeHistoryEntries(entries: Iterable<string>): string[] {
  const normalized: string[] = []
  for (const entry of entries) {
    if (entry.length === 0) continue
    if (normalized.at(-1) === entry) continue
    normalized.push(entry)
  }
  return normalized
}

function equalEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

/**
 * History state machine kept independent from its integration layer so its
 * boundary behavior can be tested directly.
 */
export class HistoryNavigator {
  private entries: string[]
  private cursor: number | null = null
  private lastHistoryText: string | null = null

  constructor(entries: Iterable<string> = []) {
    this.entries = normalizeHistoryEntries(entries)
  }

  /** Replace the projected history. A real change exits active traversal. */
  replaceHistory(entries: Iterable<string>): void {
    const next = normalizeHistoryEntries(entries)
    if (equalEntries(this.entries, next)) return
    this.entries = next
    this.resetNavigation()
  }

  /** Snapshot exposed for diagnostics and unit tests. */
  get history(): readonly string[] {
    return this.entries
  }

  /** Exit traversal without changing the history rows. */
  resetNavigation(): void {
    this.cursor = null
    this.lastHistoryText = null
  }

  /**
   * Attempt one history movement.
   *
   * Empty input can start traversal. Non-empty input is only intercepted when
   * it still exactly matches the last recalled row and the selection is a
   * collapsed caret at the start or end. This leaves ordinary multiline arrow
   * movement and edited drafts untouched.
   */
  navigate(direction: HistoryDirection, request: HistoryNavigationRequest): HistoryNavigationResult {
    if (!this.shouldHandle(request)) return NOT_HANDLED
    return direction === 'up' ? this.navigateUp() : this.navigateDown()
  }

  private shouldHandle(request: HistoryNavigationRequest): boolean {
    if (this.entries.length === 0) return false
    if (request.selectionStart !== request.selectionEnd) return false
    if (request.draft.length === 0) return true

    const atBoundary = request.selectionStart === 0 || request.selectionStart === request.draft.length
    return atBoundary && this.lastHistoryText === request.draft
  }

  private navigateUp(): HistoryNavigationResult {
    const next = this.cursor === null ? this.entries.length - 1 : this.cursor - 1
    if (next < 0) return NOT_HANDLED
    return this.recall(next)
  }

  private navigateDown(): HistoryNavigationResult {
    if (this.cursor === null) return NOT_HANDLED
    if (this.cursor + 1 < this.entries.length) return this.recall(this.cursor + 1)

    this.resetNavigation()
    return { handled: true, text: '' }
  }

  private recall(index: number): HistoryNavigationResult {
    const text = this.entries[index]
    if (text === undefined) return NOT_HANDLED
    this.cursor = index
    this.lastHistoryText = text
    return { handled: true, text }
  }
}

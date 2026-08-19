/** Direction in which the user is traversing sent-message history. */
export type HistoryDirection = 'up' | 'down'

/** Direction in which an active reverse-history search is traversing matches. */
export type HistorySearchDirection = 'older' | 'newer'

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

/** Result of one reverse-history search step or query update. */
export type HistorySearchResult =
  | { readonly type: 'found', readonly text: string }
  | { readonly type: 'boundary' }
  | { readonly type: 'notFound' }

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

/** Rich-history integrations may append an identity after a NUL separator. */
function searchableEntryText(entry: string): string {
  const separator = entry.indexOf('\u0000')
  return separator < 0 ? entry : entry.slice(0, separator)
}

/**
 * History state machine kept independent from its integration layer so its
 * boundary behavior can be tested directly.
 */
export class HistoryNavigator {
  private entries: string[]
  private cursor: number | null = null
  private lastHistoryText: string | null = null
  private searchActiveFlag = false
  private searchQueryText = ''
  private searchQueryLower = ''
  private searchMatches: number[] = []
  private searchSelected: number | null = null

  constructor(entries: Iterable<string> = []) {
    this.entries = normalizeHistoryEntries(entries)
  }

  /** Replace the projected history. A real change exits active traversal. */
  replaceHistory(entries: Iterable<string>): void {
    const next = normalizeHistoryEntries(entries)
    if (equalEntries(this.entries, next)) return
    this.entries = next
    this.resetNavigation()
    this.finishSearch()
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

  // ---- reverse history search -------------------------------------------

  /** True while a Ctrl+R reverse-history search session is open. */
  isSearching(): boolean {
    return this.searchActiveFlag
  }

  /** Open a reverse-history search without previewing any entry yet. */
  beginSearch(): void {
    this.searchActiveFlag = true
    this.searchQueryText = ''
    this.searchQueryLower = ''
    this.resetSearchCaches()
  }

  /** Close the active reverse-history search. */
  finishSearch(): void {
    this.searchActiveFlag = false
    this.resetSearchCaches()
  }

  /** Query currently being searched, when a search session is open. */
  searchQueryTextOf(): string {
    return this.searchQueryText
  }

  /**
   * 1-based position of the currently previewed unique match, or `null` when no
   * search is open or the query has produced no printable result yet.
   *
   * Positions count from the newest match (the first one a fresh search lands
   * on), so a brand-new query reports `1`; stepping Older reports increasing
   * values up to {@link searchMatchCount}. Combined they power the reverse-search
   * status footer ("match 1/5") while browsing an incremental search.
   */
  searchMatchPosition(): number | null {
    if (!this.searchActiveFlag || this.searchSelected === null) return null
    return this.searchMatches.length - this.searchSelected
  }

  /**
   * Number of unique matches for the active query, or `null` when no search is
   * open or matches have not been (re)built yet.
   */
  searchMatchCount(): number | null {
    if (!this.searchActiveFlag) return null
    return this.searchMatches.length
  }

  /**
   * Update the search query and preview the newest unique match.
   *
   * An empty query leaves the composer untouched and reports `notFound` so the
   * caller restores the idle draft. Matching is case-insensitive; duplicates of
   * an exact recalled text are folded so Older/Newer move between distinct
   * messages without mutating the stored history.
   */
  updateSearchQuery(query: string): HistorySearchResult {
    this.searchQueryText = query
    this.searchQueryLower = query.toLowerCase()
    this.resetSearchCaches()
    if (query.length === 0) return { type: 'notFound' }

    this.rebuildSearchMatches()
    if (this.searchMatches.length === 0) return { type: 'notFound' }
    return this.recallSearchMatch(this.searchMatches.length - 1)
  }

  /**
   * Move to the next unique match toward older or newer entries.
   *
   * At either boundary the current match is preserved (`boundary`) instead of
   * being reported as a miss, so repeated Older/Newer presses never flicker the
   * preview or corrupt the caret state.
   */
  stepSearch(direction: HistorySearchDirection): HistorySearchResult {
    if (!this.searchActiveFlag) return { type: 'notFound' }

    const selected = this.searchSelected
    if (selected === null) {
      if (this.searchMatches.length === 0) return { type: 'notFound' }
      return this.recallSearchMatch(this.searchMatches.length - 1)
    }

    const next = direction === 'older' ? selected - 1 : selected + 1
    if (next < 0 || next >= this.searchMatches.length) return { type: 'boundary' }
    return this.recallSearchMatch(next)
  }

  private resetSearchCaches(): void {
    this.searchMatches = []
    this.searchSelected = null
  }

  private rebuildSearchMatches(): void {
    this.searchMatches = []
    const seen = new Set<string>()
    this.entries.forEach((entry, index) => {
      const searchable = searchableEntryText(entry)
      if (!searchable.toLowerCase().includes(this.searchQueryLower)) return
      if (seen.has(searchable)) return
      seen.add(searchable)
      this.searchMatches.push(index)
    })
  }

  private recallSearchMatch(index: number): HistorySearchResult {
    if (index < 0 || index >= this.searchMatches.length) return { type: 'boundary' }
    const entryIndex = this.searchMatches[index]
    const text = this.entries[entryIndex]
    this.searchSelected = index
    // Point the normal navigation cursor at the recalled entry so accepting the
    // match lets a following ArrowUp keep walking from here.
    this.cursor = entryIndex
    this.lastHistoryText = text
    return { type: 'found', text }
  }
}

import type { CSSProperties } from 'react'

/**
 * Visible phase of an active Ctrl+R reverse-history search session.
 *
 * Three phases let the footer tell `idle` (search just opened, no query yet)
 * apart from `noMatch` (query typed but nothing matched — the draft is
 * restored while the search stays open) and `match` (an entry is previewed in
 * the composer).
 */
export type HistorySearchStatus = 'idle' | 'match' | 'noMatch'

/** Footer state derived from the navigator after each search keystroke. */
export interface HistorySearchFooterData {
  readonly status: HistorySearchStatus
  readonly query: string
  /** Currently previewed match position (1-based) or null for statuses without a match. */
  readonly matchPosition: number | null
  /** Number of unique matches for the active query or null when unbuilt. */
  readonly matchCount: number | null
  /** The text currently previewed in the composer, for match highlighting. */
  readonly previewText: string
}

/** Segment of {@link HistorySearchFooterData.previewText} that matches the query. */
interface HighlightedSegment {
  readonly text: string
  readonly matched: boolean
}

/**
 * Split `text` into matched/unmatched segments for one query.
 *
 * Case-insensitive substring matching (JavaScript `toLowerCase` follows full
 * Unicode lowercasing, so it folds accented and multi-char case). The footer
 * renders the matched span prominently — the closest a textarea preview can
 * get to in-preview reversed+bold highlighting, since a real textarea cannot
 * style substrings.
 */
function highlightSegments(text: string, query: string): HighlightedSegment[] {
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  if (lowerQuery.length === 0 || lowerText.length === 0) return [{ text, matched: false }]

  const segments: HighlightedSegment[] = []
  let cursor = 0
  while (cursor < text.length) {
    const foundAt = lowerText.indexOf(lowerQuery, cursor)
    if (foundAt === -1) {
      segments.push({ text: text.slice(cursor), matched: false })
      break
    }
    if (foundAt > cursor) segments.push({ text: text.slice(cursor, foundAt), matched: false })
    segments.push({ text: text.slice(foundAt, foundAt + query.length), matched: true })
    cursor = foundAt + query.length
  }
  return segments
}

/** Compact a long preview to a window around the first match, elided on both sides. */
function elidePreview(text: string, query: string, max = 60): string {
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const index = needle.length === 0 ? -1 : lower.indexOf(needle)
  if (text.length <= max || index === -1) return text

  const start = Math.max(0, index - Math.floor(max / 3))
  const end = Math.min(text.length, start + max)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return prefix + text.slice(start, end) + suffix
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    justifyContent: 'center',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '12px',
    lineHeight: '26px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    fontVariantNumeric: 'tabular-nums',
  },
  prompt: {
    color: 'var(--dsw-alias-label-secondary)',
  },
  query: {
    color: 'var(--dsw-alias-label-primary)',
    maxWidth: '30ch',
    textOverflow: 'ellipsis',
    overflow: 'hidden',
  },
  preview: {
    display: 'inline-flex',
    gap: '0',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: 'var(--dsw-alias-label-secondary)',
  },
  match: {
    color: 'var(--dsw-alias-label-primary)',
    fontWeight: 600,
  },
  count: {
    color: 'var(--dsw-alias-label-primary)',
  },
  noMatch: {
    color: 'var(--dsw-alias-state-error-primary)',
  },
  hints: {
    display: 'inline-flex',
    gap: '4px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  hintKey: {
    color: 'var(--dsw-alias-label-secondary)',
    fontWeight: 600,
  },
}

/** Key-caption pair used by the footer hint row. */
type KeyHint = readonly [key: string, label: string]

/** Key hints shown for a live search. */
const KEY_HINTS: readonly KeyHint[] = [
  ['↑', 'older'],
  ['↓', 'newer'],
  ['⏎', 'accept'],
  ['esc', 'cancel'],
] as const

/**
 * Reverse-history search footer rendered above the composer while a Ctrl+R
 * search session is open.
 *
 * Only mounted while {@link HistorySearchFooterData} is non-null, so the seat
 * is invisible during ordinary editing. It displays the editable query, the
 * highlighted match preview, match progress, and the accept/cancel key hints.
 */
export function HistorySearchFooter({ data, }: { data: HistorySearchFooterData }): JSX.Element {
  const { status, query, matchPosition, matchCount, previewText } = data
  const preview = status === 'match' ? elidePreview(previewText, query) : ''

  const segments = status === 'match' ? highlightSegments(preview, query) : []

  return (
    <div style={styles.root} role="status" aria-live="polite">
      <span style={styles.prompt}>reverse-i-search:</span>
      <span style={styles.query}>{query}</span>

      {status === 'match' && (
        <span>
          <span aria-hidden="true" style={styles.preview}>
            {segments.map((segment, index) =>
              segment.matched ? (
                <span key={index} style={styles.match}>
                  {segment.text}
                </span>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
          </span>
        </span>
      )}
      <span>
        {status === 'idle' && <span>…</span>}
        {status === 'noMatch' && <span style={styles.noMatch}>no match</span>}
        {status === 'match' && matchCount !== null && (
          <span>
            (<span style={styles.count}>{matchPosition}</span>
            <span>/</span>
            <span>{matchCount}</span>)
          </span>
        )}
      </span>

      <span style={styles.hints} aria-hidden="true">
        {KEY_HINTS.map(([key, label]) => (
          <span key={key}>
            <span style={styles.hintKey}>{key}</span> {label}
            {key !== 'esc' ? ' · ' : ''}
          </span>
        ))}
      </span>
    </div>
  )
}

export { elidePreview }
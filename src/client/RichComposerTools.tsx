import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { PASTE_REFERENCE_SOURCE, pasteLabel } from '../core/paste-chip.ts'
import { LargePasteController } from './LargePasteController.ts'

interface OccurrenceLike {
  readonly occurrenceId: number
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly clipboardText: string
  readonly offset: number
  readonly invalid?: boolean
}

interface ComposerProps {
  readonly sessionId: SessionId
  readonly input: {
    readonly draft: string
    readonly imageIds: readonly unknown[]
    readonly occurrences: readonly OccurrenceLike[]
  }
  readonly paste: LargePasteController
}

const styles = {
  chipRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '6px',
    alignItems: 'center',
    padding: '5px 0 2px',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    maxWidth: '100%',
    border: '1px solid rgba(97, 135, 216, .45)',
    borderRadius: '7px',
    padding: '3px 5px 3px 8px',
    color: 'var(--dsw-alias-label-primary, inherit)',
    background: 'rgba(97, 135, 216, .12)',
    fontSize: '12px',
  } as const,
  chipButton: {
    border: 0,
    borderRadius: '4px',
    padding: '1px 4px',
    cursor: 'pointer',
    color: 'inherit',
    background: 'rgba(127, 127, 127, .12)',
    fontSize: '11px',
  } as const,
}

/** Display already-folded paste chips below the composer. */
export function LargePasteDock({ sessionId, input, paste }: Pick<ComposerProps, 'sessionId' | 'input' | 'paste'>): JSX.Element | null {
  const occurrences = input.occurrences as readonly OccurrenceLike[]
  const chips = occurrences.filter((occurrence) => occurrence.source === PASTE_REFERENCE_SOURCE)
  if (chips.length === 0) return null
  return (
    <div style={styles.chipRow} aria-label="已折叠的粘贴内容">
      {chips.map((occurrence) => {
        const payload = paste.payloadOf(occurrence.ref)
        return (
          <span key={occurrence.occurrenceId} style={{ ...styles.chip, opacity: payload === undefined ? .6 : 1 }}>
            <strong>{payload === undefined ? '粘贴内容已失效' : pasteLabel(payload)}</strong>
            <button type="button" style={styles.chipButton} onClick={() => { paste.expand(sessionId, occurrence.occurrenceId) }}>展开</button>
            <button type="button" style={styles.chipButton} onClick={() => { paste.remove(sessionId, occurrence.occurrenceId) }} aria-label="删除粘贴内容">×</button>
          </span>
        )
      })}
    </div>
  )
}

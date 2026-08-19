import { describe, expect, it } from 'vitest'
import {
  markerForPaste,
  parsePasteMarker,
  pasteLabel,
} from '../src/core/paste-chip.ts'
import { LARGE_PASTE_THRESHOLD } from '../src/core/draft-snapshot.ts'

describe('large paste helpers', () => {
  it('uses the shared large-paste threshold for snapshot folding', () => {
    expect(LARGE_PASTE_THRESHOLD).toBe(2_000)
  })

  it('formats byte-aware labels', () => {
    expect(pasteLabel('abc')).toBe('已粘贴 3 B')
    expect(pasteLabel('你'.repeat(400))).toBe('已粘贴 1.2 KB')
  })

  it('round-trips a persisted marker id containing colons', () => {
    const marker = markerForPaste('session:paste:1')
    expect(parsePasteMarker(marker)).toBe('session:paste:1')
    expect(parsePasteMarker('plain')).toBeUndefined()
  })
})

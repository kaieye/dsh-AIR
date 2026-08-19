import { describe, expect, it } from 'vitest'
import { elidePreview } from '../src/client/HistorySearchFooter.tsx'

describe('elidePreview', () => {
  it('returns short text unchanged', () => {
    expect(elidePreview('git status', 'git')).toBe('git status')
  })

  it('elides around the first match with ellipses on both sides', () => {
    const long = `prefix ${'x'.repeat(40)} needle ${'y'.repeat(60)} suffix`
    const result = elidePreview(long, 'needle', 60)
    expect(result.startsWith('…')).toBe(true)
    expect(result.endsWith('…')).toBe(true)
    expect(result).toContain('needle')
    expect(result.length).toBeLessThanOrEqual(60 + 2)
  })

  it('does not elide when there is no match', () => {
    const long = `prefix ${'x'.repeat(80)} suffix`
    expect(elidePreview(long, 'needle', 60)).toBe(long)
  })

  it('elide windows from the start when the match is early', () => {
    const long = `needle ${'y'.repeat(80)}`
    const result = elidePreview(long, 'needle', 60)
    expect(result.startsWith('needle')).toBe(true)
    expect(result.endsWith('…')).toBe(true)
  })
})
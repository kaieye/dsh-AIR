import { describe, expect, it } from 'vitest'
import {
  GLOBAL_HISTORY_STORAGE_KEY,
  HISTORY_LIMIT_STORAGE_KEY,
  HISTORY_STORAGE_LIMIT,
  HISTORY_STORAGE_LIMIT_MAX,
  HISTORY_STORAGE_LIMIT_MIN,
  HISTORY_STORAGE_PREFIX,
  appendNewGlobalEntries,
  assembleGlobalFromLegacy,
  capHistoryEntries,
  clearGlobalHistory,
  equalGlobalEntries,
  isGlobalHistoryEntry,
  isWindowPrefixOfGlobalSuffix,
  mergeGlobalWithWindow,
  parseGlobalHistory,
  readGlobalHistory,
  resolveHistoryLimit,
  writeGlobalHistory,
  type GlobalHistoryEntry,
  type HistoryStorageLike,
} from '../src/core/history-persistence.ts'

function memoryStorage(seed: Record<string, string> = {}): HistoryStorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem(key) { return data.has(key) ? data.get(key)! : null },
    setItem(key, value) { data.set(key, value) },
    removeItem(key) { data.delete(key) },
    get length() { return data.size },
    key(index) { return [...data.keys()][index] ?? null },
  }
}

const entry = (text: string, sessionId = 's', ts = 0): GlobalHistoryEntry => ({ sessionId, ts, text })

describe('appendNewGlobalEntries', () => {
  it('appends new window texts with the current session and timestamp', () => {
    const result = appendNewGlobalEntries(
      [entry('old-1'), entry('old-2')],
      'session-b',
      ['w1', 'w2'],
      1700000000,
    )
    expect(result).toEqual([
      { sessionId: 's', ts: 0, text: 'old-1' },
      { sessionId: 's', ts: 0, text: 'old-2' },
      { sessionId: 'session-b', ts: 1700000000, text: 'w1' },
      { sessionId: 'session-b', ts: 1700000000, text: 'w2' },
    ])
  })

  it('re-appends identical text when it is not the consecutive previous entry', () => {
    // codex history.jsonl is append-only; the same prompt may appear many times.
    const result = appendNewGlobalEntries(
      [entry('a'), entry('b')],
      'session-c',
      ['a', 'b', 'a'],
      0,
    )
    expect(result.map((e) => e.text)).toEqual(['a', 'b', 'a'])
  })

  it('skips only empty rows and consecutive duplicates while extending the window', () => {
    const result = appendNewGlobalEntries(
      [entry('x'), entry('y')],
      's',
      ['x', 'y', '', 'y', 'z'],
      0,
    )
    // 'y' after matched suffix is consecutive with existing tail and skipped; 'z' appends.
    expect(result.map((e) => e.text)).toEqual(['x', 'y', 'z'])
  })

  it('is a no-op when the window is already the global suffix', () => {
    const existing = [entry('a'), entry('b'), entry('c')]
    const result = appendNewGlobalEntries(existing, 's', ['a', 'b', 'c'], 0)
    expect(result).toEqual(existing)
  })

  it('caps the merged store to the newest limit', () => {
    const existing = [entry('old')]
    const result = appendNewGlobalEntries(existing, 's', ['a', 'b', 'c', 'd'], 0, 3)
    expect(result.map((e) => e.text)).toEqual(['b', 'c', 'd'])
  })
})

describe('isWindowPrefixOfGlobalSuffix', () => {
  it('accepts an empty window and an exact trailing suffix', () => {
    expect(isWindowPrefixOfGlobalSuffix([entry('a'), entry('b')], [])).toBe(true)
    expect(isWindowPrefixOfGlobalSuffix([entry('a'), entry('b')], ['b'])).toBe(true)
    expect(isWindowPrefixOfGlobalSuffix([entry('a'), entry('b')], ['a', 'b'])).toBe(true)
  })

  it('rejects a window that is not the trailing suffix', () => {
    expect(isWindowPrefixOfGlobalSuffix([entry('a'), entry('b')], ['a'])).toBe(false)
    expect(isWindowPrefixOfGlobalSuffix([entry('a')], ['a', 'b'])).toBe(false)
  })
})

describe('mergeGlobalWithWindow', () => {
  it('projects global texts and appends unrecorded window texts', () => {
    expect(mergeGlobalWithWindow([entry('old-1'), entry('old-2')], ['w1', 'w2'])).toEqual([
      'old-1',
      'old-2',
      'w1',
      'w2',
    ])
  })

  it('keeps non-consecutive repeats from the window extension', () => {
    expect(mergeGlobalWithWindow([entry('a'), entry('b')], ['a', 'b', 'a'])).toEqual([
      'a',
      'b',
      'a',
    ])
  })

  it('collapses consecutive duplicates and drops empty rows', () => {
    expect(mergeGlobalWithWindow([entry('x')], ['x', '', 'x', 'z'])).toEqual(['x', 'z'])
  })

  it('returns an empty list when both stores are empty', () => {
    expect(mergeGlobalWithWindow([], [])).toEqual([])
  })
})

describe('assembleGlobalFromLegacy', () => {
  it('folds per-session string lists into global entries with session ids', () => {
    const result = assembleGlobalFromLegacy(
      [['a', 'b'], ['c']],
      (index) => (index === 0 ? 'session-a' : 'session-b'),
    )
    expect(result).toEqual([
      { sessionId: 'session-a', ts: 0, text: 'a' },
      { sessionId: 'session-a', ts: 0, text: 'b' },
      { sessionId: 'session-b', ts: 0, text: 'c' },
    ])
  })

  it('keeps non-adjacent identical texts and only collapses consecutive seams', () => {
    const result = assembleGlobalFromLegacy([['', 'same', 'other'], ['same', 'third']])
    expect(result.map((e) => e.text)).toEqual(['same', 'other', 'same', 'third'])
  })

  it('collapses a boundary when two adjacent lists end and start with the same text', () => {
    const result = assembleGlobalFromLegacy([['a', 'b'], ['b', 'c']])
    expect(result.map((e) => e.text)).toEqual(['a', 'b', 'c'])
  })

  it('caps the assembled store', () => {
    const result = assembleGlobalFromLegacy([['a', 'b', 'c', 'd']], undefined, 3)
    expect(result.map((e) => e.text)).toEqual(['b', 'c', 'd'])
  })
})

describe('equalGlobalEntries', () => {
  it('compares by text sequence, ignoring session and timestamp differences', () => {
    expect(equalGlobalEntries([entry('a', 's1', 1)], [entry('a', 's2', 2)])).toBe(true)
    expect(equalGlobalEntries([entry('a'), entry('a')], [entry('a')])).toBe(false)
    expect(equalGlobalEntries([entry('a')], [entry('b')])).toBe(false)
    expect(equalGlobalEntries([entry('a')], [entry('a'), entry('b')])).toBe(false)
  })
})

describe('isGlobalHistoryEntry', () => {
  it('accepts well-formed records and rejects everything else', () => {
    expect(isGlobalHistoryEntry({ sessionId: 's', ts: 1, text: 't' })).toBe(true)
    expect(isGlobalHistoryEntry({ sessionId: 's', text: 't' })).toBe(false)
    expect(isGlobalHistoryEntry({ sessionId: 's', ts: 1 })).toBe(false)
    expect(isGlobalHistoryEntry('t')).toBe(false)
    expect(isGlobalHistoryEntry(null)).toBe(false)
  })
})

describe('storage keys', () => {
  it('uses a single global key distinct from the legacy per-session prefix', () => {
    expect(GLOBAL_HISTORY_STORAGE_KEY.startsWith(HISTORY_STORAGE_PREFIX)).toBe(true)
    expect(GLOBAL_HISTORY_STORAGE_KEY).toBe('dsh-air:history:global')
    // Legacy per-session keys live under the same prefix but not the global key.
    expect(`${HISTORY_STORAGE_PREFIX}abc-123`).toBe('dsh-air:history:abc-123')
    expect(`${HISTORY_STORAGE_PREFIX}abc-123`).not.toBe(GLOBAL_HISTORY_STORAGE_KEY)
  })
})

describe('capHistoryEntries', () => {
  it('leaves a list within the limit untouched', () => {
    expect(capHistoryEntries(['a', 'b', 'c'], 5)).toEqual(['a', 'b', 'c'])
  })

  it('keeps the newest entries when over the limit', () => {
    expect(capHistoryEntries(['old', 'mid', 'new'], 2)).toEqual(['mid', 'new'])
  })
})

describe('resolveHistoryLimit', () => {
  it('defaults when storage is missing or the key is empty', () => {
    expect(resolveHistoryLimit()).toBe(HISTORY_STORAGE_LIMIT)
    expect(resolveHistoryLimit(memoryStorage())).toBe(HISTORY_STORAGE_LIMIT)
    expect(resolveHistoryLimit(memoryStorage({ [HISTORY_LIMIT_STORAGE_KEY]: '  ' }))).toBe(HISTORY_STORAGE_LIMIT)
  })

  it('accepts a positive integer and clamps to the documented range', () => {
    expect(resolveHistoryLimit(memoryStorage({ [HISTORY_LIMIT_STORAGE_KEY]: '42' }))).toBe(42)
    expect(resolveHistoryLimit(memoryStorage({ [HISTORY_LIMIT_STORAGE_KEY]: String(HISTORY_STORAGE_LIMIT_MIN - 1) }))).toBe(HISTORY_STORAGE_LIMIT_MIN)
    expect(resolveHistoryLimit(memoryStorage({ [HISTORY_LIMIT_STORAGE_KEY]: String(HISTORY_STORAGE_LIMIT_MAX + 1) }))).toBe(HISTORY_STORAGE_LIMIT_MAX)
  })

  it('rejects non-integers and non-positive values', () => {
    expect(resolveHistoryLimit(memoryStorage({ [HISTORY_LIMIT_STORAGE_KEY]: '3.5' }))).toBe(HISTORY_STORAGE_LIMIT)
    expect(resolveHistoryLimit(memoryStorage({ [HISTORY_LIMIT_STORAGE_KEY]: '0' }))).toBe(HISTORY_STORAGE_LIMIT)
    expect(resolveHistoryLimit(memoryStorage({ [HISTORY_LIMIT_STORAGE_KEY]: '-2' }))).toBe(HISTORY_STORAGE_LIMIT)
    expect(resolveHistoryLimit(memoryStorage({ [HISTORY_LIMIT_STORAGE_KEY]: 'nope' }))).toBe(HISTORY_STORAGE_LIMIT)
  })
})

describe('read/write/clear global history', () => {
  it('caps on read when the stored list exceeds the resolved limit', () => {
    const storage = memoryStorage({
      [HISTORY_LIMIT_STORAGE_KEY]: '10',
      [GLOBAL_HISTORY_STORAGE_KEY]: JSON.stringify(
        Array.from({ length: 12 }, (_, index) => entry(`t${index}`)),
      ),
    })
    expect(readGlobalHistory(storage).map((e) => e.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => `t${index + 2}`),
    )
  })

  it('writes a capped list and leaves the limit key alone when clearing', () => {
    const storage = memoryStorage({ [HISTORY_LIMIT_STORAGE_KEY]: '10' })
    const many = Array.from({ length: 12 }, (_, index) => entry(`t${index}`))
    writeGlobalHistory(storage, many)
    expect(parseGlobalHistory(storage.getItem(GLOBAL_HISTORY_STORAGE_KEY)).map((e) => e.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => `t${index + 2}`),
    )
    clearGlobalHistory(storage)
    expect(storage.getItem(GLOBAL_HISTORY_STORAGE_KEY)).toBeNull()
    expect(storage.getItem(HISTORY_LIMIT_STORAGE_KEY)).toBe('10')
    expect(readGlobalHistory(storage)).toEqual([])
  })

  it('parseGlobalHistory tolerates corrupt JSON', () => {
    expect(parseGlobalHistory('{broken')).toEqual([])
    expect(parseGlobalHistory(JSON.stringify([{ text: 'x' }]))).toEqual([])
  })
})

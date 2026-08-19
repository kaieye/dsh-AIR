import { describe, expect, it } from 'vitest'
import {
  DRAFT_HISTORY_STORAGE_PREFIX,
  capDraftHistory,
  clearAllDraftHistories,
  draftHistoryStorageKey,
  findRichSnapshot,
  mergeDraftHistory,
  parseDraftHistory,
  serializeDraftHistory,
} from '../src/core/draft-persistence.ts'
import type { DraftSnapshot } from '../src/core/draft-snapshot.ts'

function snapshot(id: string, text: string, extra: Partial<DraftSnapshot> = {}): DraftSnapshot {
  return { version: 1, id, text, attachments: [], mentions: [], pastes: [], ...extra }
}

const attachment = {
  kind: 'image' as const,
  attachment: { attachmentId: 'image-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
}

const richMention = {
  source: 'files',
  trigger: '@' as const,
  ref: 'README.md',
  label: '@README.md',
  offset: 0,
  clipboardText: '@README.md',
}

describe('draft persistence', () => {
  it('uses a session-specific key and tolerates invalid JSON', () => {
    expect(draftHistoryStorageKey('s1')).toBe('dsh-air:drafts:s1')
    expect(parseDraftHistory('{broken')).toEqual([])
    expect(parseDraftHistory(JSON.stringify([{ nope: true }]))).toEqual([])
  })

  it('serializes only the newest capped entries', () => {
    const entries = [snapshot('1', 'a'), snapshot('2', 'b'), snapshot('3', 'c')]
    expect(capDraftHistory(entries, 2).map((entry) => entry.id)).toEqual(['2', '3'])
    expect(parseDraftHistory(serializeDraftHistory(entries))).toEqual(entries)
  })

  it('keeps persisted live references while durable attachments win', () => {
    const persisted = snapshot('node:1', '@README.md', { mentions: [richMention] })
    const current = snapshot('node:1', '@README.md', { attachments: [attachment] })
    expect(mergeDraftHistory([persisted], [current])).toEqual([{
      ...current,
      mentions: [richMention],
    }])
  })

  it('carries rich queue metadata onto the matching durable node', () => {
    const queue = snapshot('queue:0', 'payload', {
      pastes: [{ id: 'paste-1', start: 0, end: 7, payload: 'payload' }],
    })
    const durable = snapshot('node:9', 'payload', { attachments: [attachment] })
    expect(mergeDraftHistory([queue], [durable])).toEqual([{
      ...durable,
      pastes: queue.pastes,
    }])
  })

  it('finds the newest rich equivalent by text and attachment identity', () => {
    const old = snapshot('old', 'same', { attachments: [attachment] })
    const latest = snapshot('latest', 'same', { attachments: [attachment], mentions: [richMention] })
    expect(findRichSnapshot([old, latest], latest)?.id).toBe('latest')
  })

  it('clears every dsh-air:drafts:* sidecar and leaves unrelated keys', () => {
    const data = new Map<string, string>([
      [`${DRAFT_HISTORY_STORAGE_PREFIX}s1`, '[]'],
      [`${DRAFT_HISTORY_STORAGE_PREFIX}s2`, '[]'],
      ['other', '1'],
    ])
    const storage = {
      getItem(key: string) { return data.has(key) ? data.get(key)! : null },
      setItem(key: string, value: string) { data.set(key, value) },
      removeItem(key: string) { data.delete(key) },
      get length() { return data.size },
      key(index: number) { return [...data.keys()][index] ?? null },
    }
    clearAllDraftHistories(storage)
    expect(data.has(`${DRAFT_HISTORY_STORAGE_PREFIX}s1`)).toBe(false)
    expect(data.has(`${DRAFT_HISTORY_STORAGE_PREFIX}s2`)).toBe(false)
    expect(data.get('other')).toBe('1')
  })
})

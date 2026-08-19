import { describe, expect, it } from 'vitest'
import {
  draftSnapshotForNode,
  draftSnapshotFromComposer,
  extractDraftSnapshots,
  historyKey,
  historyKeyText,
  isDraftSnapshot,
  LARGE_PASTE_THRESHOLD,
  normalizeDraftSnapshots,
} from '../src/core/draft-snapshot.ts'

const image = {
  attachmentId: 'attachment-1',
  mediaType: 'image/png',
  bytes: 123,
  width: 20,
  height: 10,
  name: 'shot.png',
}

describe('draftSnapshotForNode', () => {
  it('projects text and durable images without dropping either', () => {
    expect(draftSnapshotForNode({
      kind: 'user',
      seq: 7,
      time: 1234,
      content: [
        { type: 'text', text: 'inspect this' },
        { type: 'image', attachment: image },
      ],
    })).toEqual({
      version: 1,
      id: 'node:7',
      text: 'inspect this',
      attachments: [{ kind: 'image', attachment: image }],
      mentions: [],
      pastes: [],
      createdAt: 1234,
    })
  })

  it('skips an entire row containing an unknown semantic block', () => {
    expect(draftSnapshotForNode({
      kind: 'user',
      seq: 8,
      content: [{ type: 'text', text: 'prefix' }, { type: 'audio', id: 'a' }],
    })).toBeNull()
  })

  it('projects slash commands', () => {
    expect(draftSnapshotForNode({ kind: 'command', seq: 9, name: 'review', args: ' --staged' }))
      .toMatchObject({ id: 'node:9', text: '/review --staged' })
  })

  it('records large text blocks as paste ranges', () => {
    const payload = 'x'.repeat(LARGE_PASTE_THRESHOLD)
    const result = draftSnapshotForNode({ kind: 'user', seq: 10, content: [{ type: 'text', text: payload }] })
    expect(result?.pastes).toEqual([{ id: 'node:10:paste:0', start: 0, end: payload.length, payload }])
  })
})

describe('extractDraftSnapshots', () => {
  it('includes transient queue rows and keeps a coexisting durable identity', () => {
    const source = {
      nodes: [{ kind: 'user', seq: 2, content: [{ type: 'text', text: 'same' }] }],
      queue: [{ text: 'same' }],
    }
    expect(extractDraftSnapshots(source).map((entry) => entry.id)).toEqual(['node:2'])
  })
})

describe('draftSnapshotFromComposer', () => {
  it('expands paste placeholders and preserves live reference routing', () => {
    const result = draftSnapshotFromComposer(
      'live:1',
      `a\uFFFCb\uFFFCc`,
      [
        { source: 'dsh-air-paste', ref: 'paste-1', label: 'paste', clipboardText: 'ignored', offset: 1 },
        { source: 'files', ref: 'src/index.ts', label: '@src/index.ts', clipboardText: '@src/index.ts', offset: 3 },
      ],
      (id) => id === 'paste-1' ? 'LONG' : undefined,
    )
    expect(result.text).toBe('aLONGb@src/index.tsc')
    expect(result.pastes).toEqual([{ id: 'paste-1', start: 1, end: 5, payload: 'LONG' }])
    expect(result.mentions).toEqual([{
      source: 'files',
      trigger: '@',
      ref: 'src/index.ts',
      label: '@src/index.ts',
      offset: 6,
      clipboardText: '@src/index.ts',
    }])
  })
})

describe('snapshot validation and history identity', () => {
  const valid = {
    version: 1 as const,
    id: 'node:1',
    text: 'hello',
    attachments: [],
    mentions: [],
    pastes: [],
  }

  it('round-trips visible text through an identity-bearing history key', () => {
    expect(historyKeyText(historyKey(valid))).toBe('hello')
    expect(historyKey(valid)).not.toBe('hello')
  })

  it('rejects malformed nested persisted data', () => {
    expect(isDraftSnapshot(valid)).toBe(true)
    expect(isDraftSnapshot({ ...valid, pastes: [{ id: 'p', start: 3, end: 2, payload: 'x' }] })).toBe(false)
    expect(isDraftSnapshot({ ...valid, attachments: [{ kind: 'image', attachment: { ...image, bytes: -1 } }] })).toBe(false)
    expect(isDraftSnapshot({ ...valid, mentions: [{ source: 'x', ref: 'r', label: 'l', offset: -1, clipboardText: 'l' }] })).toBe(false)
  })

  it('prefers a durable duplicate over a queue projection', () => {
    expect(normalizeDraftSnapshots([
      { ...valid, id: 'node:1' },
      { ...valid, id: 'queue:0' },
    ]).map((entry) => entry.id)).toEqual(['node:1'])
  })
})

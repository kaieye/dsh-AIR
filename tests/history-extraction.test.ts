import { describe, expect, it } from 'vitest'
import { extractHistoryEntries } from '../src/core/history-extraction.ts'

describe('extractHistoryEntries', () => {
  it('projects user, steering, slash-command, and queued text in send order', () => {
    expect(extractHistoryEntries({
      nodes: [
        { kind: 'user', content: [{ type: 'text', text: 'first' }] },
        { kind: 'assistant', blocks: [{ kind: 'text', text: 'reply' }] },
        { kind: 'steering', content: [{ type: 'text', text: 'second' }] },
        { kind: 'command', name: 'model', args: ' deepseek-chat' },
      ],
      queue: [
        { text: 'queued one', content: [] },
        { content: [{ type: 'text', text: 'queued ' }, { type: 'text', text: 'two' }] },
      ],
    })).toEqual([
      'first',
      'second',
      '/model deepseek-chat',
      'queued one',
      'queued two',
    ])
  })

  it('skips rich messages that cannot be faithfully restored as a draft', () => {
    expect(extractHistoryEntries({
      nodes: [
        { kind: 'user', content: [{ type: 'text', text: 'caption' }, { type: 'image' }] },
        { kind: 'steering', content: [{ type: 'image' }] },
      ],
      queue: [
        { text: null, content: [{ type: 'text', text: 'caption' }, { type: 'image' }] },
      ],
    })).toEqual([])
  })

  it('folds queue-to-durable handoff duplicates', () => {
    expect(extractHistoryEntries({
      nodes: [
        { kind: 'user', content: [{ type: 'text', text: 'same' }] },
        { kind: 'steering', content: [{ type: 'text', text: 'same' }] },
      ],
      queue: [{ text: 'same' }],
    })).toEqual(['same'])
  })

  it('ignores malformed and history-ineligible rows defensively', () => {
    expect(extractHistoryEntries({
      nodes: [
        null,
        { kind: 'command', name: null, args: null },
        { kind: 'context', content: [{ type: 'text', text: 'system context' }] },
        { kind: 'user', content: [{ type: 'text', text: 42 }] },
      ],
      queue: [null, { text: null }, { content: 'not-blocks' }],
    })).toEqual([])
  })
})

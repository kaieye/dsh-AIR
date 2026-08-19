import type {
  ConversationNode,
  PartialAssistant,
  RunningToolCall,
} from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'
import {
  projectBtwTranscript,
  type BtwTurnRecord,
} from '../src/core/btw-transcript.ts'

const asNode = (node: object): ConversationNode => node as ConversationNode

function userNode(seq: number, text: string): ConversationNode {
  return asNode({
    kind: 'user',
    seq,
    time: 0,
    content: [{ type: 'text', text }],
    source: null,
  })
}

function assistantNode(seq: number, blocks: object[], interrupted = false): ConversationNode {
  return asNode({
    kind: 'assistant',
    seq,
    time: 0,
    turn: 1,
    step: 1,
    blocks,
    ...(interrupted ? { interrupted: true } : {}),
    source: null,
  })
}

function turn(id: number, question: string, afterSeq: number, status: BtwTurnRecord['status'] = 'sent'): BtwTurnRecord {
  return { id, question, afterSeq, status }
}

const emptyPartial = null
const emptyRunningCalls: readonly RunningToolCall[] = []

describe('projectBtwTranscript', () => {
  it('hides inherited and boundary user nodes while preserving the local turn', () => {
    const entries = projectBtwTranscript({
      baselineSeq: 2,
      nodes: [
        userNode(1, 'inherited question'),
        assistantNode(2, [{ kind: 'text', text: 'inherited answer' }]),
        userNode(3, 'hidden boundary envelope'),
        assistantNode(4, [{ kind: 'text', text: 'side answer' }]),
      ],
      partial: emptyPartial,
      runningCalls: emptyRunningCalls,
      turns: [turn(1, 'Explain this', 2)],
    })

    expect(entries).toEqual([
      { kind: 'user', id: 1, text: 'Explain this', status: 'sent' },
      { kind: 'assistant', id: 'node:4:text', text: 'side answer' },
    ])
    expect(entries.some((entry) => 'text' in entry && typeof entry.text === 'string' && entry.text.includes('inherited'))).toBe(false)
    expect(entries.some((entry) => 'text' in entry && typeof entry.text === 'string' && entry.text.includes('boundary'))).toBe(false)
  })

  it('renders reasoning, assistant text, tool results, running tools, and errors', () => {
    const entries = projectBtwTranscript({
      baselineSeq: 10,
      nodes: [
        userNode(11, 'boundary'),
        assistantNode(12, [
          { kind: 'reasoning', text: 'checking the evidence' },
          { kind: 'text', text: 'Here is the answer.' },
        ]),
        asNode({
          kind: 'tool-result',
          seq: 13,
          time: 0,
          callId: 'call-1',
          call: { name: 'read', argsRaw: '{"path":"README.md"}' },
          callTime: 0,
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
          callView: null,
          resultView: null,
          subCalls: [],
        }),
        asNode({ kind: 'turn-error', seq: 14, time: 0, turn: 1, step: 1, message: 'network failed' }),
      ],
      partial: {
        turn: 1,
        step: 2,
        blocks: [{ kind: 'text', text: 'still writing' }],
      } as PartialAssistant,
      runningCalls: [{
        callId: 'call-2',
        name: 'search',
        argsRaw: '{"query":"BTW"}',
        turn: 1,
        step: 2,
        time: 0,
        callView: null,
        subCalls: [],
      }],
      turns: [turn(1, 'Inspect this', 10)],
    })

    expect(entries).toEqual(expect.arrayContaining([
      { kind: 'user', id: 1, text: 'Inspect this', status: 'sent' },
      { kind: 'reasoning', id: 'node:12:reasoning', text: 'checking the evidence' },
      { kind: 'assistant', id: 'node:12:text', text: 'Here is the answer.' },
      { kind: 'tool', id: 'node:13:tool:call-1', name: 'read', text: 'file contents', error: false },
      { kind: 'notice', id: 'node:14:error', text: 'network failed', tone: 'error' },
      { kind: 'assistant', id: 'partial:1:2:text', text: 'still writing' },
      { kind: 'tool', id: 'running:call-2', name: 'search', text: '{"query":"BTW"}', error: false, running: true },
    ]))
  })

  it('uses each turn afterSeq as a boundary for multi-turn projection', () => {
    const entries = projectBtwTranscript({
      baselineSeq: 0,
      nodes: [
        userNode(1, 'first boundary'),
        assistantNode(2, [{ kind: 'text', text: 'first answer' }]),
        userNode(3, 'second boundary'),
        assistantNode(4, [{ kind: 'text', text: 'second answer' }]),
      ],
      partial: null,
      runningCalls: [],
      turns: [
        turn(1, 'first question', 0),
        turn(2, 'second question', 2),
      ],
    })

    expect(entries).toEqual([
      { kind: 'user', id: 1, text: 'first question', status: 'sent' },
      { kind: 'assistant', id: 'node:2:text', text: 'first answer' },
      { kind: 'user', id: 2, text: 'second question', status: 'sent' },
      { kind: 'assistant', id: 'node:4:text', text: 'second answer' },
    ])
  })

  it('can show child output even before a local turn record exists', () => {
    const entries = projectBtwTranscript({
      baselineSeq: 4,
      nodes: [assistantNode(6, [{ kind: 'text', text: 'early output' }])],
      partial: null,
      runningCalls: [],
      turns: [],
    })

    expect(entries).toEqual([
      { kind: 'assistant', id: 'node:6:text', text: 'early output' },
    ])
  })

  it('marks interruption-frozen assistant output, including an empty partial', () => {
    const entries = projectBtwTranscript({
      baselineSeq: 4,
      nodes: [
        assistantNode(6, [{ kind: 'text', text: 'partial answer' }], true),
        assistantNode(7, [], true),
      ],
      partial: null,
      runningCalls: [],
      turns: [],
    })

    expect(entries).toEqual([
      { kind: 'assistant', id: 'node:6:text', text: 'partial answer', interrupted: true },
      { kind: 'assistant', id: 'node:7:text', text: '', interrupted: true },
    ])
  })
})

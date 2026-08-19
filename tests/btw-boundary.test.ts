import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'
import {
  BTW_BOUNDARY_PROMPT,
  btwInitialPrompt,
  btwInterruptedContext,
} from '../src/core/btw-boundary.ts'

describe('BTW boundary prompt', () => {
  it('keeps the side-conversation safety boundary in the first prompt', () => {
    const prompt = btwInitialPrompt('Explain this error')

    expect(prompt).toContain(BTW_BOUNDARY_PROMPT)
    expect(prompt).toContain('User question after the boundary:')
    expect(prompt).toMatch(/User question after the boundary:\nExplain this error$/)
    expect(prompt).toContain('Sub-agents are off-limits')
    expect(prompt).toContain('Do not modify files')
  })

  it('trims the visible question without dropping the boundary for blank input', () => {
    expect(btwInitialPrompt('  what happened?  ')).toMatch(/boundary:\nwhat happened\?$/)
    expect(btwInitialPrompt('   ')).toMatch(/User question after the boundary:\n$/)
  })

  it('places only the visible open-turn snapshot before the boundary', () => {
    const context = btwInterruptedContext({
      nodes: [
        {
          kind: 'user',
          seq: 2,
          time: 0,
          content: [{ type: 'text', text: 'completed parent request' }],
          source: null,
        } as never,
        {
          kind: 'user',
          seq: 12,
          time: 0,
          content: [{ type: 'text', text: 'open parent request' }],
          source: null,
        } as never,
        {
          kind: 'assistant',
          seq: 13,
          time: 0,
          turn: 2,
          step: 1,
          blocks: [
            { kind: 'reasoning', text: 'hidden chain of thought' },
            { kind: 'text', text: 'visible parent answer' },
          ],
        } as never,
        {
          kind: 'tool-result',
          seq: 14,
          time: 0,
          callId: 'read-1',
          call: { name: 'read', argsRaw: '{"path":"README.md"}' },
          content: [{ type: 'text', text: 'tool output' }],
          isError: false,
        } as never,
      ],
      partial: {
        turn: 2,
        step: 2,
        blocks: [
          { kind: 'reasoning', text: 'hidden partial reasoning' },
          { kind: 'text', text: 'partial visible answer' },
        ],
      } as ConversationSnapshot['partial'],
      runningCalls: [{
        callId: 'grep-1',
        name: 'grep',
        argsRaw: '{"query":"BTW"}',
      } as never],
    }, 10)
    const prompt = btwInitialPrompt('side question', context)

    expect(prompt.indexOf('open parent request')).toBeLessThan(prompt.indexOf(BTW_BOUNDARY_PROMPT))
    expect(prompt).toContain('visible parent answer')
    expect(prompt).toContain('tool output')
    expect(prompt).toContain('partial visible answer')
    expect(prompt).toContain('grep')
    expect(prompt).not.toContain('completed parent request')
    expect(prompt).not.toContain('hidden chain of thought')
    expect(prompt).not.toContain('hidden partial reasoning')
  })
})

import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'
import {
  deriveBtwParentStatus,
  deriveBtwSessionStatus,
  formatBtwChildStatus,
  formatBtwParentStatus,
  summarizeBtwPending,
} from '../src/core/btw-status.ts'

function snapshot(options: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: 'session' as SessionId,
    views: {} as ConversationSnapshot['views'],
    chat: {} as ConversationSnapshot['chat'],
    nodes: [],
    turnTimings: new Map(),
    turnEnds: new Map(),
    partial: null,
    runningCalls: [],
    pending: [],
    queue: [],
    running: false,
    subagent: null,
    composerPhase: 'active',
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    ...options,
  }
}

describe('BTW parent status', () => {
  it('prioritizes input over approval and both interactions over running', () => {
    expect(deriveBtwParentStatus(snapshot({ running: true, pending: [{ kind: 'approval' } as never] }))).toBe('needs-approval')
    expect(deriveBtwParentStatus(snapshot({ running: true, pending: [{ kind: 'question' } as never] }))).toBe('needs-input')
    expect(deriveBtwParentStatus(snapshot({
      running: true,
      pending: [{ kind: 'approval' } as never, { kind: 'question' } as never],
    }))).toBe('needs-input')
  })

  it('derives running, failed, interrupted, closed, finished, and idle states', () => {
    expect(deriveBtwParentStatus(snapshot({ running: true }))).toBe('running')
    expect(deriveBtwSessionStatus(snapshot({ running: true, lastAgentError: 'stale error' }))).toBe('failed')
    expect(deriveBtwParentStatus(snapshot({ lastAgentError: 'failed' }))).toBe('failed')
    expect(deriveBtwParentStatus(snapshot({ openState: 'error' }))).toBe('failed')
    expect(deriveBtwParentStatus(snapshot({
      nodes: [
        { kind: 'assistant', seq: 1, interrupted: false } as never,
        { kind: 'assistant', seq: 2, interrupted: true } as never,
      ],
    }))).toBe('interrupted')
    expect(deriveBtwParentStatus(snapshot({
      nodes: [
        { kind: 'assistant', seq: 1, interrupted: true } as never,
        { kind: 'assistant', seq: 2 } as never,
      ],
    }))).toBe('finished')
    expect(deriveBtwParentStatus(snapshot({ removed: true }))).toBe('closed')
    expect(deriveBtwParentStatus(snapshot({ nodes: [{ kind: 'assistant', seq: 1 } as never] }))).toBe('finished')
    expect(deriveBtwParentStatus(snapshot({ blank: true, composerPhase: 'blank' }))).toBe('idle')
    expect(deriveBtwParentStatus(null)).toBe('closed')
  })

  it('formats statuses for the drawer', () => {
    expect(formatBtwParentStatus('needs-approval')).toBe('主会话等待审批')
    expect(formatBtwParentStatus('interrupted')).toBe('主会话已中断')
    expect(formatBtwParentStatus('finished')).toBe('主会话已完成')
    expect(formatBtwChildStatus('needs-input')).toBe('BTW 等待输入')
  })

  it('summarizes actionable parent interactions for the header', () => {
    expect(summarizeBtwPending(snapshot({
      pending: [{ kind: 'question' } as never, { kind: 'approval' } as never, { kind: 'approval' } as never],
    }))).toEqual({ total: 3, questions: 1, approvals: 2 })
    expect(summarizeBtwPending(null)).toEqual({ total: 0, questions: 0, approvals: 0 })
  })
})

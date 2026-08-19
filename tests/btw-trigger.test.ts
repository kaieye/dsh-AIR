import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { BtwController } from '../src/client/BtwController.ts'
import { describe, expect, it, vi } from 'vitest'
import { BTW_IN_SIDE_UNAVAILABLE, createBtwTrigger } from '../src/client/BtwTrigger.ts'

const session = { sessionId: 'session-1' as SessionId }
const signal = new AbortController().signal

function claimFrom(outcome: Awaited<ReturnType<NonNullable<ReturnType<typeof createBtwTrigger>['matchEnter']>>>): { submit(args: string, actx: ClientContext): Promise<{ kind: 'success' | 'error'; text?: string }> } {
  if (outcome === undefined || typeof outcome === 'string' || !('claim' in outcome)) throw new Error('expected a command claim')
  return outcome.claim
}

describe('/btw and /side input triggers', () => {
  it('offers prefix-matching candidates for both aliases', async () => {
    const manager = { invoke: vi.fn(), isChildSession: vi.fn(() => false) } as unknown as BtwController
    const source = createBtwTrigger(manager)

    expect(await source.candidates(session, { query: 'bt', position: 'leading', signal })).toEqual([
      { name: 'btw', description: expect.any(String), hint: 'Ask a BTW question' },
    ])
    expect(await source.candidates(session, { query: 'si', position: 'leading', signal })).toEqual([
      { name: 'side', description: expect.any(String), hint: 'Ask a side question' },
    ])
    expect(await source.candidates(session, { query: 'tw', position: 'leading', signal })).toEqual([])
    expect(await source.candidates(session, { query: '', position: 'leading', signal })).toHaveLength(2)
  })

  it('hides both aliases from the active child menu while retaining exact dispatch', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('already open'))
    const manager = { invoke, isChildSession: vi.fn(() => true) } as unknown as BtwController
    const source = createBtwTrigger(manager)

    expect(await source.candidates(session, { query: '', position: 'leading', signal })).toEqual([])
    const exact = await source.matchEnter?.(session, '/side', signal)
    const picked = source.matchSpace?.(session, '/btw')
    expect(exact).toBeDefined()
    expect(picked).toBeDefined()
    if (exact === undefined || typeof exact === 'string') throw new Error('expected a claim')
    if (picked === undefined || typeof picked === 'string' || !('claim' in picked)) throw new Error('expected a claim')

    // Reference-aligned guard: the child itself is a side conversation, so both
    // aliases reject without ever invoking the controller.
    await expect(claimFrom(exact).submit('', {} as ClientContext)).resolves.toEqual({
      kind: 'error',
      text: BTW_IN_SIDE_UNAVAILABLE,
    })
    await expect(picked.claim.submit('question', {} as ClientContext)).resolves.toEqual({
      kind: 'error',
      text: BTW_IN_SIDE_UNAVAILABLE,
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('claims bare and inline questions for both aliases, but not longer tokens', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const manager = { invoke, isChildSession: vi.fn(() => false) } as unknown as BtwController
    const source = createBtwTrigger(manager)

    const bare = await source.matchEnter?.(session, '/btw', signal)
    const withQuestion = await source.matchEnter?.(session, '/side explain this', signal)
    const longer = await source.matchEnter?.(session, '/btwfoo', signal)

    expect(bare).toBeDefined()
    expect(withQuestion).toBeDefined()
    expect(longer).toBeUndefined()

    await claimFrom(bare).submit('', {} as ClientContext)
    await claimFrom(withQuestion).submit('explain this', {} as ClientContext)
    expect(invoke).toHaveBeenNthCalledWith(1, 'session-1', '')
    expect(invoke).toHaveBeenNthCalledWith(2, 'session-1', 'explain this')
  })

  it('claims after a space and reports controller failures as command errors', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('not available'))
    const manager = { invoke, isChildSession: vi.fn(() => false) } as unknown as BtwController
    const source = createBtwTrigger(manager)

    const outcome = source.matchSpace?.(session, '/side')
    expect(outcome).toBeDefined()
    if (outcome === undefined || typeof outcome === 'string' || !('claim' in outcome)) throw new Error('expected a claim')

    await expect(outcome.claim.submit('question', {} as ClientContext)).resolves.toEqual({
      kind: 'error',
      text: 'not available',
    })
    expect(source.matchSpace?.(session, '/btwfoo')).toBeUndefined()
  })
})

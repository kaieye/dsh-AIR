import { describe, expect, it } from 'vitest'
import { previousTurnBoundary, turnContaining, planFork } from '../src/core/fork-boundary.ts'

describe('previousTurnBoundary', () => {
  it('returns the nearest completed turn strictly before the selected prompt', () => {
    expect(previousTurnBoundary(new Map([[1, 5], [2, 12], [3, 20]]), 18)).toBe(12)
  })

  it('returns undefined for the first prompt', () => {
    expect(previousTurnBoundary(new Map([[1, 5]]), 5)).toBeUndefined()
  })

  it('ignores boundaries at/after the prompt and non-finite values', () => {
    expect(previousTurnBoundary(new Map([[1, Number.NaN], [2, 9], [3, 11], [4, Number.POSITIVE_INFINITY]]), 10)).toBe(9)
  })
})

describe('turnContaining', () => {
  it('finds the completed turn whose end covers the seq', () => {
    expect(turnContaining(new Map([[1, 5], [2, 12], [3, 20]]), 8)).toEqual({ turn: 2, turnEnd: 12 })
  })

  it('treats a seq exactly at a turn end as inside that turn', () => {
    expect(turnContaining(new Map([[1, 5], [2, 12]]), 12)).toEqual({ turn: 2, turnEnd: 12 })
  })

  it('returns undefined for a message in a turn that has not ended', () => {
    expect(turnContaining(new Map([[1, 5], [2, 12]]), 15)).toBeUndefined()
  })

  it('ignores non-finite turn ends', () => {
    expect(turnContaining(new Map([[1, Number.NaN], [2, 12]]), 4)).toEqual({ turn: 2, turnEnd: 12 })
  })
})

describe('planFork', () => {
  const user = (seq: number) => ({ kind: 'user', seq })
  const steering = (seq: number) => ({ kind: 'steering', seq })
  const assistant = (seq: number) => ({ kind: 'assistant', seq })

  it('resolves the boundary to the previous turn end for a later prompt', () => {
    const nodes = [assistant(5), user(10), assistant(12), user(18), assistant(20)]
    expect(planFork(new Map([[1, 5], [2, 12], [3, 20]]), nodes, 18))
      .toEqual({ ok: true, plan: { turn: 3, boundary: 12 } })
  })

  it('maps the first prompt to a new-session plan with no boundary', () => {
    expect(planFork(new Map([[1, 5]]), [user(1), assistant(5)], 1))
      .toEqual({ ok: true, plan: { turn: 1 } })
  })

  it('rejects a prompt in a turn that is still in progress', () => {
    expect(planFork(new Map([[1, 5]]), [user(1), assistant(5), user(8)], 8))
      .toEqual({ ok: false, reason: 'in-progress' })
  })

  it('rejects a steer that is not the first user message of its turn', () => {
    const nodes = [user(1), assistant(5), user(8), steering(9), assistant(12)]
    expect(planFork(new Map([[1, 5], [2, 12]]), nodes, 9))
      .toEqual({ ok: false, reason: 'steer' })
  })

  it('allows the initial prompt of a turn that later received a steer', () => {
    const nodes = [user(1), assistant(5), user(8), steering(9), assistant(12)]
    expect(planFork(new Map([[1, 5], [2, 12]]), nodes, 8))
      .toEqual({ ok: true, plan: { turn: 2, boundary: 5 } })
  })
})

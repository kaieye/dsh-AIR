/** The last completed turn before a selected user message, or undefined for the first turn. */
export function previousTurnBoundary(
  turnEnds: ReadonlyMap<number, number>,
  selectedSeq: number,
): number | undefined {
  let boundary: number | undefined
  for (const seq of turnEnds.values()) {
    if (!Number.isFinite(seq) || seq >= selectedSeq) continue
    if (boundary === undefined || seq > boundary) boundary = seq
  }
  return boundary
}

/** A completed turn and the seq of its turn/end event. */
export interface TurnMembership {
  readonly turn: number
  readonly turnEnd: number
}

/**
 * The completed turn containing `seq` — the turn whose end is the smallest
 * completed end at or after `seq`. Returns undefined when the message belongs
 * to a turn that has not ended (still running, or its end is outside the
 * loaded window); such a prompt cannot be branched because the fork cannot cut
 * cleanly inside an open turn.
 */
export function turnContaining(
  turnEnds: ReadonlyMap<number, number>,
  seq: number,
): TurnMembership | undefined {
  let best: TurnMembership | undefined
  for (const [turn, end] of turnEnds) {
    if (!Number.isFinite(end) || end < seq) continue
    if (best === undefined || end < best.turnEnd) best = { turn, turnEnd: end }
  }
  return best
}

/** Why a fork-before-prompt plan was rejected. */
export type ForkRejectionReason = 'in-progress' | 'steer'

/**
 * A resolved source-preserving branch target for one selected prompt.
 *
 * Mirrors codex `backtrack_fork_before_turn_id`:
 * - a prompt inside a turn that has not ended is rejected (`in-progress`);
 * - a prompt that is not the first user-kind message of its turn is a steer
 *   and is rejected (`steer`) — DSH cannot fork in the middle of a turn, so
 *   only the initial prompt of a turn can be reopened independently;
 * - otherwise the fork boundary is the previous turn's end; the first turn has
 *   no earlier boundary and maps to creating a brand-new session instead.
 */
export interface ForkPlan {
  /** The turn that contains the selected prompt. */
  readonly turn: number
  /**
   * Completed end seq of the turn before the selected prompt. Absent for the
   * first turn, meaning a new session must be created instead of forking.
   */
  readonly boundary?: number
}

export type ForkPlanResult =
  | { readonly ok: true; readonly plan: ForkPlan }
  | { readonly ok: false; readonly reason: ForkRejectionReason }

export function planFork(
  turnEnds: ReadonlyMap<number, number>,
  nodes: readonly { readonly kind: string; readonly seq: number }[],
  selectedSeq: number,
): ForkPlanResult {
  const membership = turnContaining(turnEnds, selectedSeq)
  if (membership === undefined) return { ok: false, reason: 'in-progress' }

  // A turn spans (previous turn end, this turn end]. A steer is any user-kind
  // message that is not the first one of its turn.
  const previousEnd = previousTurnBoundary(turnEnds, membership.turnEnd) ?? 0
  const isSteer = nodes.some(
    (node) =>
      (node.kind === 'user' || node.kind === 'steering')
      && node.seq > previousEnd
      && node.seq < selectedSeq,
  )
  if (isSteer) return { ok: false, reason: 'steer' }

  const boundary = previousTurnBoundary(turnEnds, selectedSeq)
  return { ok: true, plan: { turn: membership.turn, ...(boundary === undefined ? {} : { boundary }) } }
}

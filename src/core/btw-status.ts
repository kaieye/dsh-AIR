import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

/** The strongest session state the public DSH snapshot can expose. */
export type BtwSessionStatus =
  | 'needs-input'
  | 'needs-approval'
  | 'running'
  | 'failed'
  | 'interrupted'
  | 'closed'
  | 'finished'
  | 'idle'

/** Kept as a semantic alias for the parent-side status shown by the drawer. */
export type BtwParentStatus = BtwSessionStatus

export interface BtwPendingSummary {
  readonly total: number
  readonly questions: number
  readonly approvals: number
}

function latestAssistantWasInterrupted(snapshot: ConversationSnapshot): boolean {
  let latestSeq = Number.NEGATIVE_INFINITY
  let interrupted = false
  for (const node of snapshot.nodes) {
    if (node.kind !== 'assistant' || node.seq < latestSeq) continue
    latestSeq = node.seq
    interrupted = node.interrupted === true
  }
  return interrupted
}

/** Count actionable interactions without depending on private server events. */
export function summarizeBtwPending(snapshot: ConversationSnapshot | null): BtwPendingSummary {
  if (snapshot === null) return { total: 0, questions: 0, approvals: 0 }
  let questions = 0
  let approvals = 0
  for (const item of snapshot.pending) {
    if (item.kind === 'question') questions += 1
    else if (item.kind === 'approval') approvals += 1
  }
  return { total: snapshot.pending.length, questions, approvals }
}

/**
 * Derive a side-panel status without depending on the host's private TUI state.
 * Pending interactions are checked before `running`, because they are the
 * actionable state the user must resolve first. Errors are checked before the
 * transient running bit so a stale frame cannot hide a terminal failure.
 */
export function deriveBtwSessionStatus(snapshot: ConversationSnapshot | null): BtwSessionStatus {
  if (snapshot === null) return 'closed'
  if (snapshot.removed) return 'closed'

  if (snapshot.pending.some((item) => item.kind === 'question')) return 'needs-input'
  if (snapshot.pending.some((item) => item.kind === 'approval')) return 'needs-approval'
  if (snapshot.lastAgentError !== null || snapshot.promptError !== null || snapshot.openState === 'error') return 'failed'
  if (snapshot.running || snapshot.composerPhase === 'engaging') return 'running'
  if (latestAssistantWasInterrupted(snapshot)) return 'interrupted'

  const hasConversation = snapshot.nodes.length > 0 || snapshot.turnEnds.size > 0 || !snapshot.blank
  return hasConversation ? 'finished' : 'idle'
}

/** Parent-facing name retained for callers that want the explicit semantic API. */
export function deriveBtwParentStatus(snapshot: ConversationSnapshot | null): BtwParentStatus {
  return deriveBtwSessionStatus(snapshot)
}

export function formatBtwParentStatus(status: BtwParentStatus): string {
  switch (status) {
    case 'needs-input': return '主会话等待输入'
    case 'needs-approval': return '主会话等待审批'
    case 'running': return '主会话运行中'
    case 'failed': return '主会话失败'
    case 'interrupted': return '主会话已中断'
    case 'closed': return '主会话已关闭'
    case 'finished': return '主会话已完成'
    case 'idle': return '主会话空闲'
  }
}

export function formatBtwChildStatus(status: BtwSessionStatus): string {
  switch (status) {
    case 'needs-input': return 'BTW 等待输入'
    case 'needs-approval': return 'BTW 等待审批'
    case 'running': return 'BTW 运行中'
    case 'failed': return 'BTW 失败'
    case 'interrupted': return 'BTW 已中断'
    case 'closed': return 'BTW 已关闭'
    case 'finished': return 'BTW 已完成'
    case 'idle': return 'BTW 空闲'
  }
}

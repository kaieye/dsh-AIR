import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { DraftSnapshot } from '../core/draft-snapshot.ts'
import { planFork, type ForkRejectionReason } from '../core/fork-boundary.ts'
import { LargePasteController } from './LargePasteController.ts'

interface CreateCapableSessions {
  create?(opts?: { readonly cwd?: string }): Promise<SessionId>
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return '未知错误'
}

/** User-facing copy for a rejected fork plan (codex-aligned guardrails). */
function rejectionMessage(reason: ForkRejectionReason): string {
  switch (reason) {
    case 'steer':
      return '选中的问题是同一回合中的插入指令（steer），无法独立创建分支。'
    case 'in-progress':
      return '选中的问题所在回合仍在进行中，请等待该回合结束后再分支。'
  }
}

/** Coordinates the transactional “fork before this prompt, then restore it” flow. */
export class ForkEditController {
  private inFlight = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly paste: LargePasteController,
  ) {}

  /** The workspace the source session is accounted under, when one exists. */
  private sourceWorkspaceId(sessionId: SessionId): WorkspaceId | undefined {
    try {
      const state = this.ctx.workspaces.list.getSnapshot()
      return state.items.find((workspace) => workspace.sessionIds.includes(sessionId))?.workspaceId
    } catch {
      return undefined
    }
  }

  async forkAndEdit(
    sourceSessionId: SessionId,
    selectedSeq: number,
    snapshot: DraftSnapshot,
  ): Promise<boolean> {
    const operationKey = `${sourceSessionId}:${selectedSeq}`
    if (this.inFlight.has(operationKey)) return false
    this.inFlight.add(operationKey)

    let childId: SessionId | null = null
    try {
      const binding = this.ctx.sessions.binding(sourceSessionId)
      if (binding === undefined) throw new Error('来源会话当前不可用。')
      const source = binding.session.getSnapshot()
      const planned = planFork(source.turnEnds, source.nodes, selectedSeq)
      if (!planned.ok) {
        this.paste.notify(sourceSessionId, 'error', rejectionMessage(planned.reason))
        return false
      }
      const { plan } = planned

      if (plan.boundary === undefined) {
        const create = (this.ctx.sessions as unknown as CreateCapableSessions).create
        // Attach the new blank session to the source's workspace so it opens as
        // an editable hero instead of the inert workspace picker. A bare
        // `create({ cwd })` yields a blank session that is not yet accounted
        // under any workspace in the client view, so DSH renders it as the
        // workspace-selection state and picking one jumps to a different
        // session.
        const workspaceId = this.sourceWorkspaceId(sourceSessionId)
        if (workspaceId !== undefined) {
          childId = await this.ctx.workspaces.connectWorkspace(workspaceId)
        } else if (typeof create === 'function') {
          const cwd = this.ctx.sessions.list.getSnapshot().byId[sourceSessionId]?.cwd
          childId = await create.call(this.ctx.sessions, cwd === undefined ? {} : { cwd })
        } else {
          throw new Error('当前 DSH 版本无法在第一轮之前创建可编辑分支。')
        }
      } else {
        childId = await this.ctx.sessions.fork({
          sessionId: sourceSessionId,
          atSeq: plan.boundary,
          increaseTitle: true,
        })
      }

      const restored = await this.paste.restoreSnapshot(childId, snapshot, sourceSessionId)
      if (!restored) throw new Error('新分支的输入框尚未就绪。')

      this.ctx.sessions.open(childId)
      return true
    } catch (error) {
      if (childId !== null) {
        try { await this.ctx.workspaces.archiveSession(childId) } catch { /* best-effort rollback */ }
      }
      // Codex restores the prompt into the source composer when branching
      // fails, so the edit intent is not lost. Only do this when the composer
      // is empty to avoid clobbering an in-progress draft.
      try {
        if (this.paste.composerEmpty(sourceSessionId)) {
          await this.paste.restoreSnapshot(sourceSessionId, snapshot)
        }
      } catch { /* the error notice below is authoritative */ }
      this.paste.notify(sourceSessionId, 'error', `分支并编辑失败：${errorMessage(error)}`)
      return false
    } finally {
      this.inFlight.delete(operationKey)
    }
  }
}

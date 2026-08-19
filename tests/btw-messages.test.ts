import { describe, expect, it } from 'vitest'
import {
  BTW_ALREADY_OPEN,
  BTW_BUSY,
  BTW_CLOSE_FAILED,
  BTW_CLOSE_UNQUIESCENT,
  BTW_CLOSING,
  BTW_DISPOSED,
  BTW_FORK_UNREACHABLE,
  BTW_IN_SIDE_UNAVAILABLE,
  BTW_LIVE_FORK_UNAVAILABLE,
  BTW_MAIN_THREAD_UNAVAILABLE,
  BTW_NOT_READY,
  BTW_NO_STARTED_CONVERSATION,
  BTW_OPERATION_FAILED,
  BTW_SESSIONS_UNAVAILABLE,
  BTW_WORKSPACES_UNAVAILABLE,
} from '../src/core/btw-messages.ts'

/**
 * Reference constants these web messages mirror (from codex-rs/tui):
 * - SIDE_MAIN_THREAD_UNAVAILABLE_MESSAGE
 * - SIDE_NO_STARTED_CONVERSATION_MESSAGE
 * - SIDE_ALREADY_OPEN_MESSAGE
 */
describe('BTW message constants', () => {
  it('keeps reference-aligned start/block copy stable', () => {
    expect(BTW_MAIN_THREAD_UNAVAILABLE).toContain('当前主会话不可用')
    expect(BTW_NO_STARTED_CONVERSATION).toContain('还没有消息')
    expect(BTW_ALREADY_OPEN).toContain('已有一个 BTW 会话')
    expect(BTW_IN_SIDE_UNAVAILABLE).toContain('不能再次创建 BTW')
    expect(BTW_CLOSING).toContain('正在关闭')
    expect(BTW_CLOSE_FAILED).toContain('无法安全关闭')
  })

  it('keeps lifecycle/error copy non-empty and stable', () => {
    expect(BTW_FORK_UNREACHABLE).toContain('无法连接到它')
    expect(BTW_LIVE_FORK_UNAVAILABLE).toContain('无法为进行中的主回复创建 BTW 快照')
    expect(BTW_CLOSE_UNQUIESCENT).toContain('无法确认')
    expect(BTW_NOT_READY).toContain('尚未准备好')
    expect(BTW_BUSY).toContain('正在准备上一条请求')
    expect(BTW_OPERATION_FAILED).toContain('操作失败')
    expect(BTW_DISPOSED).toContain('disposed')
    expect(BTW_SESSIONS_UNAVAILABLE).toContain('sessions service unavailable')
    expect(BTW_WORKSPACES_UNAVAILABLE).toContain('workspaces service unavailable')
  })

  it('exports exactly the shared set used by trigger and controller', () => {
    const values = [
      BTW_ALREADY_OPEN, BTW_BUSY, BTW_CLOSE_FAILED, BTW_CLOSE_UNQUIESCENT,
      BTW_CLOSING, BTW_DISPOSED, BTW_FORK_UNREACHABLE, BTW_IN_SIDE_UNAVAILABLE,
      BTW_LIVE_FORK_UNAVAILABLE, BTW_MAIN_THREAD_UNAVAILABLE, BTW_NOT_READY, BTW_NO_STARTED_CONVERSATION,
      BTW_OPERATION_FAILED, BTW_SESSIONS_UNAVAILABLE, BTW_WORKSPACES_UNAVAILABLE,
    ]
    expect(values.every((value) => typeof value === 'string' && value.length > 0)).toBe(true)
    expect(new Set(values).size).toBe(values.length)
  })
})

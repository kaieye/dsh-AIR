/**
 * BTW / side-conversation user-facing messages.
 *
 * Each entry carries the corresponding Codex TUI constant from
 * `codex-rs/tui/src/app/side.rs` and `chatwidget/slash_dispatch.rs` in a
 * comment so the alignment stays auditable. The UI copy is Chinese, but the
 * semantics (blocked conditions, hints) mirror the reference.
 */

/** codex: SIDE_MAIN_THREAD_UNAVAILABLE_MESSAGE — "'/side' is unavailable until the main thread is ready." */
export const BTW_MAIN_THREAD_UNAVAILABLE = '当前主会话不可用，暂时无法创建 BTW。'

/** codex: SIDE_NO_STARTED_CONVERSATION_MESSAGE — "'/side' is unavailable until the current conversation has started. Send a message first, then try /side again." */
export const BTW_NO_STARTED_CONVERSATION = '当前主会话还没有消息；请先发送一条消息，再使用 BTW。'

/** Web-only: an older/nonstandard runtime lacks the concrete session create capability. */
export const BTW_LIVE_FORK_UNAVAILABLE = '当前 DSH 运行时无法为进行中的主回复创建 BTW 快照。'

/** codex: SIDE_ALREADY_OPEN_MESSAGE — "A side conversation is already open. Press ctrl + c to return before starting another." */
export const BTW_ALREADY_OPEN = '已有一个 BTW 会话，请先关闭它，再从当前主会话创建新的 BTW。'

/** Web-only: the drawer is mid-close, so a new start must wait. */
export const BTW_CLOSING = 'BTW 正在关闭，请稍候。'

/** Web adaptation: a BTW child cannot recursively create another side conversation. */
export const BTW_IN_SIDE_UNAVAILABLE = 'BTW 旁路会话中不能再次创建 BTW；请直接继续提问，或先关闭当前 BTW。'

/** Web-only: replacement close failed, so the retained drawer stays actionable. */
export const BTW_CLOSE_FAILED = '现有 BTW 会话无法安全关闭，请处理后重试。'

/** Web-only: fork resolved but the browser cannot reach the child binding. */
export const BTW_FORK_UNREACHABLE = 'BTW fork 已创建，但浏览器无法连接到它。'

/** codex: close failure — "Failed to close side conversation {id}; it is still open: {err}" */
export const BTW_CLOSE_UNQUIESCENT = '无法确认 BTW 子会话已停止；请稍后重试。'

/** Web-only: send raced the fork/admission phase. */
export const BTW_NOT_READY = 'BTW 面板尚未准备好。'

/** Web-only: the previous prompt is still being admitted. */
export const BTW_BUSY = 'BTW 正在准备上一条请求，请稍候。'

/** Fallback for an unknown operation error. */
export const BTW_OPERATION_FAILED = 'BTW 会话操作失败。'

/** Web-only: controller already disposed. */
export const BTW_DISPOSED = 'BTW controller is disposed'

/** Web-only: sessions service not bound. */
export const BTW_SESSIONS_UNAVAILABLE = 'DSH sessions service unavailable'

/** Web-only: workspaces service not bound. */
export const BTW_WORKSPACES_UNAVAILABLE = 'DSH workspaces service unavailable'

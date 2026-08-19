# 历史 ↑/↓ 与 Ctrl+R：与 Codex TUI 的对齐清单

> 对照源码：
> - Codex：`codex-rs/tui/src/bottom_pane/chat_composer_history.rs`、`chat_composer.rs`
> - dsh-air：`src/core/history-navigation.ts`、`src/client/HistoryKeyHandler.tsx`、`src/core/history-persistence.ts`

## 已对齐

| 行为 | Codex | dsh-air |
|---|---|---|
| 空输入 `↑` 召回最新一条 | `should_handle_navigation("") == true`，`navigate_up` 从末尾开始 | `HistoryNavigator.navigate('up')` 同等语义 |
| 继续 `↑` 向更旧走 | `history_cursor` 递减 | `cursor` 递减 |
| 最旧边界再 `↑` | 不再替换文本（交给 textarea） | `handled: false` |
| `↓` 向更新走，越过最新清空 | `navigate_down` 返回 empty entry 并退出 browsing | `text: ''` + `resetNavigation()` |
| 非空草稿默认不劫持 | 仅当 `text == last_history_text` | 同等；未召回的编辑草稿不接管 |
| 光标边界门闩 | cursor 在 text 起点或终点 | `selectionStart` 在 0 或 `draft.length`，且 collapsed |
| 有选区不劫持 | textarea selection | `selectionStart !== selectionEnd` → 不处理 |
| 召回后光标落在末尾 | `move_cursor_to_history_entry_end` | `restoreCaretAtEnd` |
| 相邻重复提交折叠 | `record_local_submission` 跳过与上一条相同 | `normalizeHistoryEntries` / append 时跳过 consecutive |
| 跨会话全局历史 | `~/.codex/history.jsonl` append-only | `dsh-air:history:global` append-only（非相邻同文可重复） |
| 本地会话富草稿 | local `HistoryEntry` 含 paste/image/mention | `DraftSnapshot` + per-session `dsh-air:drafts:*` |
| 全局持久层多为 text | persistent lookup text-only | global 存 text；rich 侧车按 session 再 hydrate |
| Ctrl+R 反向搜索 | 独立 search session | `beginSearch` / `updateSearchQuery` / `stepSearch` |
| 搜索唯一匹配折叠 | `seen_texts` 按 exact text | search 内 `Set` 折叠 searchable text |
| 搜索边界 | `AtBoundary` 保留当前匹配 | `type: 'boundary'` |
| 搜索取消恢复草稿 | 恢复 search 前内容 | 恢复 `originalSnapshot` + 选区 + 图片 |
| 搜索接受后可接 `↑` | search 命中会 set `history_cursor` | `recallSearchMatch` 写 `cursor` / `lastHistoryText` |
| 斜杠/建议优先 | popup 激活时 history 路径让位 | bubble 阶段监听，让 DSH 菜单先 `preventDefault` |
| 历史变化重置 browsing | 新 submission 清 cursor | `replaceHistory` 在 entries 变化时 reset |

## 有意差异 / 平台近似

| 点 | 说明 |
|---|---|
| 光标「行边界」 | Codex 注释写 line boundary，实现是 **整段 text 的 start/end**（非「当前视觉行」首尾）。dsh-air 与实现对齐。浏览器 textarea 多行时，中间行行首/行尾不会被当成 history 门闩——与 Codex 一致，也避免劫持多行编辑。 |
| 异步 persistent fetch | Codex 对跨会话条目按需 `LookupMessageHistoryEntry` / batch；Web 侧全局列表已在 localStorage 同步加载，无 Pending 状态。 |
| 全局容量 | Codex `max_bytes`；dsh-air 默认 500 条，可用 `dsh-air:history:limit` 配置，并提供 UI 清空。 |
| 写入驱动 | Codex 在 submit 时 append；dsh-air 用 ConversationSnapshot 窗口差分 append（后缀匹配防重复写），以适配公开 client 无 submit hook 的约束。 |
| Vim / keymap 重绑定 | Codex 支持 editor/vim keymap；Web 固定 `ArrowUp`/`ArrowDown` 与 `Ctrl+R`/`Ctrl+S`。 |
| Bash `!` 模式 | Codex 专有；dsh-air 无。 |
| Ctrl+C 清空并记入 local history | Codex `clear_for_ctrl_c`；Web 不拦截浏览器/宿主 Ctrl+C。 |
| 搜索 footer | 两者都有 reverse-i-search 状态；布局与快捷键文案按 Web 适配。 |
| 清空历史 | Codex 侧多为配置/文件操作；dsh-air 通过 localStorage / `clearGlobalHistory` + `clearAllDraftHistories` 清理（无输入区按钮）。 |

## 状态机对照（↑/↓）

```
idle (cursor=null)
  ↑ + empty draft          → recall newest, cursor=n-1
  ↑ + non-empty (no match) → not handled (native caret)
  ↓                        → not handled

browsing (cursor=k, lastText=entries[k])
  ↑ + draft==lastText + caret at 0|len → recall k-1 (or not handled at 0)
  ↓ + draft==lastText + caret at 0|len → recall k+1, or clear+idle past newest
  any edit / mid-caret / selection     → not handled; next empty ↑ restarts from newest
                                         after replaceHistory / reset
```

## 验证

- 单元：`tests/history-navigation.test.ts`、`tests/history-persistence.test.ts`
- 集成入口：`HistoryKeyHandler`（document bubble `keydown`）
- `pnpm test`

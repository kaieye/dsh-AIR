# 跨会话历史召回：与 codex 对齐的设计要点

> 目标：在 dsh-air 中复刻 codex 的「全局历史」行为——**新建任意会话后，按 `↑` 都能不断调出之前所有会话发送过的记录**。

## 1. codex 参考模型（已验证源码）

`codex-rs/message-history/src/lib.rs` 顶部明确：

> **global, append-only *message history* file** — stored at `~/.codex/history.jsonl`
> 每条记录：`{"session_id":"<uuid>","ts":<unix_seconds>,"text":"<message>"}`

要点：

| codex 概念 | 说明 |
|---|---|
| 全局历史文件 | 所有会话共享 `~/.codex/history.jsonl`，新会话不新建文件 |
| 记录 schema | `{session_id, ts, text}`，每次发送 append 一行 |
| 写入时机 | 提交消息时 `AppendMessageHistoryEntry` → `append_entry()` |
| 去重 | **append-only，不按全文全局去重**；local composer 仅折叠「与上一条完全相同」的相邻提交（`record_local_submission`） |
| 导航 offset | 整个文件的 offset（不是 per-thread），`persistent_entry_count` = 会话启动时文件里已有条目数 |
| 容量控制 | 超过 `max_bytes` 时裁掉最旧的记录，保留最新 |

因此 codex 的 `↑` 历史**天然跨会话**：新会话启动时 `persistent_entry_count` 已包含旧会话写入的条目。同一段文案在不同时间点发送会作为多条 offset 出现。

## 2. dsh-air 映射（Web / localStorage）

| codex | dsh-air 映射 |
|---|---|
| `~/.codex/history.jsonl` | 单个 localStorage key：`dsh-air:history:global` |
| `{session_id, ts, text}` 记录 | `GlobalHistoryEntry { sessionId, ts, text }`（JSON 数组） |
| 发送时 append | 由会话窗口快照驱动：每个会话的 handler 把「相对全局后缀尚未记录的窗口尾部」append 进全局存储 |
| 全文件 offset 导航 | `↑`/`↓` 导航整个全局数组（最新在末尾，从末尾往前翻）；重复文本保留为独立 offset |
| 相邻重复折叠 | 仅跳过 empty 与「与上一条 text 完全相同」的相邻行（对齐 local `record_local_submission`） |
| 容量控制 | 默认 500 条；可用 localStorage `dsh-air:history:limit`（10–5000）覆盖；读取与写入均 cap |
| — | 旧版 per-session key（`dsh-air:history:<sessionId>`）首次加载时一次性迁移合并（迁移时同样只折叠相邻重复） |

## 3. 行为规格

- 任意会话中，输入框为空按 `↑` → 召回**全局**最近一条可恢复草稿（含富草稿侧车数据时一并还原）。
- 继续按 `↑` → 向更早的全局记录移动（可跨会话）；`↓` 向更新移动，越过最新一条后清空并退出。
- 记录按「全局数组顺序 = 发送顺序」（最新在末尾），会话间天然混排。
- **非相邻重复文本会保留多条 offset**（对齐 codex append-only）。仅 empty 与相邻完全相同的条目会被折叠。
- 窗口快照若已是全局后缀，则不重复写入（避免每个 render 再 append 一遍）。
- 非空草稿仅在「光标在边界 且 内容 == 上次召回文本」时才接管上下键；其余交给 DSH 原生处理。
- 无法安全还原的未知内容块仍整条跳过，避免伪装成完整草稿。
- 容量：默认全局上限 500 条，超出裁最旧（保留最新）。可通过 localStorage 键 `dsh-air:history:limit` 覆盖（整数，钳制到 10–5000）。
- 清理：无输入区按钮。可通过控制台删除 `dsh-air:history:global` 与 `dsh-air:drafts:*`，或调用 `clearGlobalHistory` / `clearAllDraftHistories` 后刷新页面（不改会话 transcript）。
- 迁移：检测到全局 key 不存在但存在旧 per-session key 时，将所有旧会话条目按列表顺序合并（仅折叠相邻重复）后写入全局（旧数据无 ts，跨会话顺序为尽力而为）。

## 4. 改动文件

- `src/core/history-persistence.ts`：全局存储 API（`appendNewGlobalEntries`、`assembleGlobalFromLegacy`、`mergeGlobalWithWindow`、`GlobalHistoryEntry`），append-only + 相邻去重。
- `src/client/HistoryKeyHandler.tsx`：读取/写入全局历史；导航 entries = 全局记录 + 当前窗口新增后缀；`historyKey(..., occurrence)` 区分同文案多 offset。
- `src/core/draft-snapshot.ts`：`historyKey` 支持 occurrence 消歧。
- `tests/history-persistence.test.ts`：覆盖全局记录/迁移/裁剪与重复文本语义。
- `README.md` / `README.en.md`：中英文项目说明。
- `docs/history-global.md`：本文档。
- `docs/history-navigation-alignment.md`：↑/↓ 与 Ctrl+R 的行为对齐清单。

## 5. 验证

- `pnpm test`（vitest 全绿）
- `pnpm run typecheck`
- `pnpm run build`

## 6. 容量与清理

| 项 | 说明 |
|---|---|
| 默认上限 | `HISTORY_STORAGE_LIMIT = 500` |
| 覆盖键 | `dsh-air:history:limit`（正整数，钳制 10–5000） |
| 生效时机 | 读取全局历史与每次 append/write 时 |
| 清理 API | `clearGlobalHistory` + `clearAllDraftHistories` |
| 事件 | `dsh-air:history-changed` — `HistoryKeyHandler` 重载内存中的全局/侧车列表 |

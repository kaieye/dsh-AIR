# BTW 旁路会话：与 Codex TUI 的功能对齐清单

本文档记录 `dsh-air` 的 BTW（`/btw`、`/side`）与参考实现
`ref_project/codex/codex-rs/tui` 的对应关系。重点是把 Codex side conversation
中高价值的生命周期、安全边界和状态反馈迁移到 Web，同时明确哪些行为受公开
DSH client API 或 Web 交互模型限制，不能假装完全一致。

## 已对齐或已做 Web 适配

| Codex 行为 | dsh-air 实现 | Web 适配说明 |
| --- | --- | --- |
| boundary 隐藏，继承历史只作参考 | `src/core/btw-boundary.ts`、`btw-native-snapshot.ts` | 公开 API 没有独立 hidden item 注入能力，因此 boundary 与首条问题一起发送，并从原生 session/input projection 中隐藏 |
| side developer instructions：不继续旧任务、默认非侵入探索、禁 sub-agent、未经明确要求不改工作区 | `BTW_BOUNDARY_PROMPT` | 合并进首条 boundary prompt；只有用户在 BTW 中明确提出修改要求时才允许改变 |
| ephemeral side fork | `BtwController` 的安全关闭流程 | 公开 API 只能创建普通 child；关闭时先清理队列和运行 turn，再 `workspaces.archiveSession()` |
| parent status 上下文标签 | `src/core/btw-status.ts`、`BtwController.parentStatus`、`BtwPanel` header | 显示主会话等待输入/审批、运行中、失败、中断、完成等状态；pending 数量也会显示 |
| side child 独立 interrupt | `BtwController.cancel()`、原生 child conversation | 只调用 child 的 cancel，不影响主会话 |
| parent 再次执行 `/side` 替换已有 side | `BtwController.invoke()` | 先安全关闭旧 child；归档失败时保留原侧栏和错误，禁止悄悄创建第二个 child |
| child 内再次执行 `/side` 被拒绝 | `BtwTrigger.ts` | 通过明确错误文案阻止递归 BTW |
| 离开 parent 时清理 side | `BtwController.onSelectionChanged()` | Web 仍保留当前导航目标；清理失败时自动回到 parent，让错误侧栏可见 |
| inherited turns 不重复展示 | `btw-transcript.ts`、`btw-native-snapshot.ts` | completed prefix 由 `baselineSeq` 截断；首条 boundary 和 inherited queue 在原生投影中隐藏 |
| 原生消息、工具、审批、队列、附件、composer | `BtwNativeConversation.tsx` | 复用 Host 的 `conversation` slot tree，只固定 child session，不另写 transcript/composer |
| side 是临时且不应影响主会话选择 | `BtwPanel.tsx` | 采用右侧 dock：主会话保持全局 selected，child 原生 UI 嵌在 dock 中 |
| 关闭前 drain queue → cancel → quiescence → cleanup | `BtwController.quiesceChild()` | queue row 被抢先 claim 时按竞态处理；在超时或 RPC 失败时保留可操作的错误侧栏 |

## 当前 Web 交互语义

- BTW 面板是右侧 dock，不是全局 session tab，也不会替换 selected session。
- 面板 header 显示 `BTW`、 “继承内容仅作参考”、父会话状态、child 生命周期状态和父会话待处理交互数量。
- 面板没有 `Ctrl+/` / `Ctrl+7` session switch、**打开分支**或**返回主会话**按钮。这样避免在 Web 中同时驱动 Host 的全局会话选择和嵌入式 child conversation。
- `Esc`、`Ctrl+C` 等快捷键交给 Host 原生 composer；插件只提供右上角显式关闭按钮。关闭按钮进入 `closing` 后会禁用，直到 child 已静止并完成归档。
- 桌面端可拖动左边缘调整宽度并持久化；窄屏切换为全宽 dock。
- parent 中再次执行 `/btw` 或 `/side` 会替换既有 BTW；后续问题直接使用右侧原生输入区。

## 公开 API 约束下无法完全对齐

| 参考行为 | 无法对齐原因 | 当前近似 |
| --- | --- | --- |
| ephemeral fork 且不会留下普通 thread | `sessions.fork()` 没有 `ephemeral`，也没有公开 child delete/unsubscribe | 安全关闭后 archive；Host session log 仍可能存在 |
| 独立隐藏 boundary/developer item | 没有 `thread_inject_items` 或等价公开 API | 首条 prompt envelope + native snapshot projection |
| 由服务端事件驱动的精确 `SideParentStatus` 生命周期 | Web 公开 snapshot 没有 Codex 的完整 notification 状态流 | 根据 pending、running、error、interrupted node 和是否有历史推导最强公开状态 |
| side thread 禁止重命名 | 插件无法统一拦截 Host 的重命名入口 | 未伪造禁用能力；Web 中 child 不提供插件自有 rename UI |
| side 模式禁用所有其他 slash command | 插件只能注册自己的 input trigger | `/btw`、`/side` 可拦截；其他命令仍由 Host 处理 |
| side 专属 interrupted notice 抑制 | 没有公开 notice 层控制 API | header 显示中断状态；原生 Host notice 保持 Host 行为 |

## 关闭安全性

关闭是一个可观察的生命周期，而不是直接从 React 树移除：

1. 将 phase 切换为 `closing`，阻止新的 BTW prompt admission。
2. 等待已经进入 Host 的 fork/prompt RPC，避免 late resolution 复活 UI。
3. 删除 child 的 queued inbox rows；如果 row 在竞态中已被 claim，则继续 cancel。
4. cancel 运行中的 child，并在有限时间内等待 `running=false` 且 queue 收敛。
5. 将当前选中的 child 暂时切回 parent，再 archive child。
6. 任一步骤失败时保留 child、parent 和错误文本，导航到 parent 以便用户重试；不会静默丢弃 side 状态。

## 验证

```bash
pnpm typecheck
pnpm test
```

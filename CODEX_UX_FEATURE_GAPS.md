# Codex → DeepSeek Harness：小而美 UX 功能差异清单

> 目标：从本地 Codex 源码中筛出实现面较小、用户感知明显，并且在所检查的 DeepSeek Harness 提交中**未发现对应闭环**的功能，供 `dsh-air` 后续选型。

## 1. 比较基线

| 项目 | 基线 |
|---|---|
| Codex 本地源码 | `/Users/chos1nz/Documents/project/StudiumX-project/ref_project/codex` |
| Codex 提交 | `18f50c9e628af083a52d9240de09fc2db24d79ce`，2026-07-26 |
| DeepSeek Harness 官方仓库镜像 | `/tmp/deepseek-harness-92566` |
| Harness 提交 | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`，2026-08-17，`dsh-0.1.0-rc.7` 合并提交 |
| 调研日期 | 2026-08-18 |

本文以固定提交的一手源码为准。“Harness 没有”均表示：**在上述提交和本次检查范围内未发现对应实现**，不代表后续提交、其他分支或私有版本一定没有。

### 筛选原则

1. 明显减少输入、等待、找回或确认成本；
2. 能独立交付，不要求复制 Codex 的整套 TUI 架构；
3. 优先前端插件或单一 Host/RPC 能力即可完成的功能；
4. Harness 已有相近基础能力时，只列真正缺少的“最后一公里”，不重复包装已有功能。

## 2. 已确认存在的能力：排除误报

以下功能在 Harness 中已经存在，因此**不列为缺失项**：

- **逐条消息复制**：`packages/client/ui-conversation/src/client/chat/MessageIconActions.tsx`。
- **从消息位置创建普通分支**：`MessageIconActions.tsx` 与 `packages/client/ui-conversation/src/client/apply.ts:417-423`。
- **队列查看、编辑、删除、立即发送**：`packages/client/ui-conversation/src/client/queue/QueueDock.tsx`。
- **附件、拖放与图片预览**：`packages/client/ui-attachment`、`InputBar.tsx`。
- **主题、模型选择、权限预设、Plan、Jobs、反馈、Reasoning 折叠**：对应 `packages/client/ui-*` 包。
- **聊天滚动跟随与历史锚点恢复**：`ChatView.tsx`、`apps/web/tests/chat-scroll-contract.e2e.ts`。
- **浏览器页签标题**：`packages/client/web/src/DocumentTitle.tsx` 已把当前会话标题投影到 `document.title`。
- **会话搜索**：`packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx:832-867, 983-1015` 已有搜索 UI、异步查询、取消与错误状态。

因此，不应再把“消息复制”“普通会话分支”“浏览器标题”“会话搜索”等写成 Codex 独有功能。

## 3. `dsh-air` 当前已落地

当前工作区已经实现以下能力，不作为新候选重复推荐：

- **`ArrowUp` / `ArrowDown` 历史召回**：`src/client/HistoryKeyHandler.tsx`、`src/core/history-navigation.ts`。
- **`Ctrl+R` 逆向历史搜索**：`HistoryKeyHandler.tsx`、`HistorySearchFooter.tsx`。
- **`/btw` / `/side` 旁路会话**：`BtwController.ts`、`BtwPanel.tsx`、`btw-boundary.ts`。

其中，当前历史召回仍明确跳过图片或其他不能完整还原为文本草稿的消息，见 `README.zh.md:47`。这为下文“富草稿历史恢复”留下了清晰的第二阶段空间。

## 4. 候选总览

| # | 候选功能 | 核心收益 | 复杂度 | 优先级 | 置信度 |
|---|---|---|---|---|---|
| 1 | 大段粘贴折叠为内容 Chip | 输入框不再被日志/代码淹没 | M | P0 | 高 |
| 2 | 分支后自动恢复旧 Prompt 供编辑 | 把“分支”和“改写上一问”连成一步 | M | P0 | 高 |
| 3 | 长 Prompt 全屏编辑器 | 长任务说明更容易审阅和组织 | S–M | P1 | 高 |
| 4 | 上下文相关快捷键帮助浮层 | 提高现有键盘能力的可发现性 | S | P1 | 高 |
| 5 | 富草稿历史恢复 | 历史召回不再丢附件、Mention、粘贴块 | M | P1 | 高 |
| 6 | 页面失焦时的系统通知 | 长任务结束或待审批时无需反复切回 | S–M | P1 | 高 |
| 7 | 一键查看完整工作区 Git diff | 不占模型轮次即可确认真实改动 | M | P1 | 中高 |
| 8 | 少量高价值动作的可配置快捷键 | 避免快捷键冲突，适应个人习惯 | M | P2 | 高 |
| 9 | 一键复制最新 Agent 回复 | 无需滚动寻找复制按钮 | S | P2 | 高 |

复杂度说明：`S` 为单一前端面或轻量状态逻辑；`M` 为需要增加草稿数据结构、持久化或只读 Host/RPC 能力。

---

## 5. 功能详情

### 5.1 大段粘贴折叠为可展开内容 Chip

**Codex 源码证据**

- `codex-rs/tui/src/bottom_pane/chat_composer.rs:1077-1113`：大段文本粘贴后，用 placeholder 替代正文，并把完整 payload 放入 `pending_pastes`。
- `chat_composer.rs:1820-1841`：生成 `[Pasted Content N chars]` 占位文本，并处理多段相同长度粘贴的唯一编号。
- `chat_composer.rs:2425-2469`：提交前按元素范围恢复真实内容。
- `codex-rs/tui/src/bottom_pane/chat_composer_history.rs:38-53`：历史项也保存 `pending_pastes`，保证召回后仍能还原。
- 快照 `codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__chat_composer__tests__large.snap` 显示实际占位效果。

**Harness 缺失检查**

Harness 已有成熟的粘贴事务和引用识别：`packages/client/ui-conversation/src/client/input/contract.ts:180-190, 262-267` 定义了 `paste-begin`、`paste-upgrade`。但在 `ui-conversation`、`ui-attachment` 和 Web 测试中，未发现按文本大小折叠、独立保存大文本 payload、提交时展开的内容块实现。

**UX 价值**

粘贴日志、堆栈、配置或代码时，textarea 不会瞬间变成数千行；用户可以继续在内容块前后补充要求，也更不容易误删粘贴正文。

**Web / DSH 适配**

- 超过 2,000–4,000 字符时显示 `已粘贴 8.4 KB` Chip；
- 提供“预览/编辑”“展开为正文”“删除”；
- payload 存入 composer 状态，不放 DOM 私有字段；
- 提交、草稿持久化、会话切换和历史召回都必须能恢复 payload；
- 浏览器已有原生 paste event，不照搬 Codex 的终端 paste-burst 时间启发式。

**建议**：`M / P0`。

---

### 5.2 “分支并编辑旧 Prompt”的一键闭环

**Codex 源码证据**

- `codex-rs/tui/src/app_backtrack.rs:6-15` 明确描述：选择旧用户消息后，在该轮之前创建分支，并把旧 Prompt 恢复到新 composer。
- `app_backtrack.rs:163-180` 发送 `ForkSessionForPromptEdit`，携带选中消息序号与完整 prompt。
- `app_backtrack.rs:183-190` 在分支失败时恢复原 prompt，避免用户输入丢失。

**Harness 已有与缺口**

Harness 并不缺普通分支：`packages/client/ui-conversation/src/client/apply.ts:417-423` 调用 `sessions.fork(...)`，成功后打开 child session。缺口是：该流程只“创建并打开分支”，未发现把被选中的用户消息自动恢复到新输入框、保留附件/引用并进入可编辑状态的闭环。

因此准确的候选不是“增加会话分支”，而是：**在现有分支按钮旁增加“分支并编辑此问题”**。

**UX 价值**

用户经常只想改上一问中的一个条件。现在需要分支、切换、找到原文、复制、粘贴、修改；闭环后只需一次操作，而且保留原会话作为对照。

**Web / DSH 适配**

- 用户消息操作区增加“分支并编辑”；
- fork 成功后，通过 input machine 的正式事件写入 child draft，而不是直接改 textarea；
- 恢复文本、附件、Mention、粘贴块和光标位置；
- fork 失败则停留原会话，并保留/恢复待编辑内容；
- 可在新分支顶部显示来源提示，避免用户误以为修改了原会话。

**建议**：`M / P0`。

---

### 5.3 长 Prompt 全屏编辑器

**Codex 源码证据**

- `codex-rs/tui/src/external_editor.rs:31-90`：从 `$VISUAL` / `$EDITOR` 解析命令，把当前草稿写入临时 Markdown 文件，编辑完成后读回。
- `codex-rs/tui/src/keymap.rs:61-62, 934`：把“编辑当前草稿”作为正式动作，默认 `Ctrl+G`。
- `codex-rs/tui/src/app/input.rs:189-199`：在 Agent 仍运行时也可提前编辑下一条消息。

**Harness 缺失检查**

检查 `InputBar.tsx`、`ui-conversation/src/client/input/*`、`ui-commands`、settings 与 Host 侧后，未发现针对当前聊天草稿的外部编辑器桥接，也未发现全屏/扩展型 Prompt 编辑面。设置页中的配置文件编辑器不属于聊天草稿编辑。

**UX 价值**

复杂任务说明通常包含背景、约束、清单和验收标准。全屏编辑比在窄 composer 中滚动更容易发现遗漏，也适合在当前任务运行时准备下一轮。

**Web / DSH 适配**

- 第一阶段做 Web 原生全屏 Markdown 编辑器，而不是直接执行任意本地编辑器；
- 进入和退出时保留草稿、附件、Mention、粘贴块、光标与撤销栈；
- `Esc` 取消，`Cmd/Ctrl+Enter` 确认；
- 只有在 Host 将来提供固定协议、显式授权后，再考虑安全的系统编辑器桥接。

**建议**：`S–M / P1`。

---

### 5.4 上下文相关的快捷键帮助浮层

**Codex 源码证据**

- `codex-rs/tui/src/keymap.rs:102-111, 954-960`：快捷键帮助是 composer 正式动作，默认 `?`。
- `codex-rs/tui/src/bottom_pane/chat_composer.rs:3623-3649`：只在适合的 composer 状态下打开，避免正常输入 `?` 被劫持。
- `codex-rs/tui/src/bottom_pane/footer.rs:1108-1266`：根据任务是否运行、当前模式和可用能力动态展示不同快捷键说明。

**Harness 缺失检查**

Harness 有按钮 tooltip 和各组件自己的键盘事件，但检索 `keyboard shortcuts`、`shortcut overlay`、`keymap`、`keybindings`、`aria-keyshortcuts` 后，未发现一个集中且随当前状态变化的快捷键速查层。

**UX 价值**

快捷键只有被发现才有价值。`dsh-air` 已经加入历史召回、逆向搜索和 BTW；如果没有统一入口，很多用户不会知道这些能力存在。

**Web / DSH 适配**

- `?` 或 `Cmd/Ctrl+/` 打开；
- 按“输入”“发送/排队”“运行中”“会话”“BTW”分组；
- 只显示当前状态真正可用的动作；
- 自动适配 macOS 的 `Cmd` 与 Windows/Linux 的 `Ctrl`；
- 第一版只读即可，不需要先实现完整 keymap 配置系统。

**建议**：`S / P1`。

---

### 5.5 富草稿历史恢复

**Codex 源码证据**

`codex-rs/tui/src/bottom_pane/chat_composer_history.rs:38-53` 的 `HistoryEntry` 不只保存字符串，还保存：

- `text_elements`；
- 本地图片路径；
- 远程图片 URL；
- Mention 绑定；
- 大段粘贴 placeholder 与 payload。

文件顶部 `1-17` 行还说明了跨会话历史、普通 Up/Down 召回和 `Ctrl+R` 唯一匹配搜索的边界。

**Harness / dsh-air 缺口**

固定 Harness 提交中未发现 composer 发送历史召回。`dsh-air` 已补上纯文本历史，但 `README.zh.md:47` 明确说明图片或其他非文本内容无法完整恢复，因此会被跳过。

**UX 价值**

历史召回不应只找回“看起来一样的文本”，还应恢复这条草稿真正引用的图片、文件、Mention 和大粘贴内容，否则用户可能在不知情时发送一个语义不完整的 Prompt。

**Web / DSH 适配**

- 把历史项从 `string` 升级为版本化 `DraftSnapshot`；
- 保存文本、attachment id/可重解析描述、reference occurrence、Mention 和 paste payload；
- 资源已经失效时，不静默丢弃，显示“1 个附件需要重新选择”；
- 先支持同一浏览器、同一会话内恢复，再决定是否跨会话或跨设备同步；
- 与“大段粘贴 Chip”共用同一草稿序列化格式，避免两套恢复逻辑。

**建议**：`M / P1`，作为现有历史功能的第二阶段。

---

### 5.6 页面失焦时的系统通知

**Codex 源码证据**

- `codex-rs/tui/src/notifications/mod.rs:13-50`：抽象桌面通知后端。
- `codex-rs/tui/src/tui.rs:85-89, 720-744`：支持“仅失焦时通知”，并在通知失败后停止持续报错。
- `codex-rs/tui/src/chatwidget/notifications.rs:26-33`：覆盖任务完成、命令审批、编辑审批、MCP 交互和 Plan 提问等事件。
- `codex-rs/tui/src/chatwidget/turn_runtime.rs:210-217`：只有 Agent 真正等待用户时才通知，避免队列继续运行时产生假完成提醒。

**Harness 缺失检查**

Harness 有页面内 toast/notice 与 session notifier，但在客户端和 Web 应用中未发现 `Notification.requestPermission`、`new Notification(...)`、`document.hidden` 或 `visibilitychange` 驱动的浏览器外系统提醒。

**UX 价值**

代码 Agent 的等待时间很长。只在页面隐藏时通知任务完成、执行失败或等待审批，可以让用户放心切到 IDE 或其他会话。

**Web / DSH 适配**

- 默认关闭，用户主动开启或首次需要时温和请求权限；
- 当前页可见时只使用现有 toast；
- 第一版覆盖“任务完成、等待审批/回答、失败”；
- 点击通知聚焦并导航到对应 session；
- 同一 session 连续事件去重，避免通知轰炸；
- 通知正文避免包含敏感 Prompt 或代码内容。

**建议**：`S–M / P1`。这是可以与主路线并行交付的 quick win。

---

### 5.7 一键查看当前工作区完整 Git diff

**Codex 源码证据**

- `codex-rs/tui/src/get_git_diff.rs:1-6, 49-120`：同时收集 tracked diff 和 untracked 文件，并为未跟踪文件生成 no-index diff。
- `get_git_diff.rs:62-84, 102-115`：禁用 external diff/textconv 等可能执行外部程序的 Git 配置。
- `codex-rs/tui/src/chatwidget/slash_dispatch.rs:396-420`：通过 `/diff` 暴露给用户。

**Harness 已有与缺口**

Harness 已有 `packages/client/ui-primitives/src/DiffBlock.tsx`，能展示工具产生的文件 diff；但在 `ui-commands`、`workspace`、`shell`、`ui-conversation` 中未发现用户主动触发、汇总当前工作区全部 tracked + untracked 改动的 `/diff` 或等价只读入口。

**UX 价值**

Agent 修改完成后，用户最常见的确认动作就是查看真实工作区变化。专用入口不需要再发一轮 Prompt，也不依赖模型是否正确执行命令。

**Web / DSH 适配**

- command menu 增加 `/diff`，或在会话顶部增加“工作区改动”；
- Host 提供只读 `workspace.gitDiff` RPC；
- 明确禁用 hooks、external diff、textconv，并设置超时和输出上限；
- 前端复用现有 `DiffBlock`，按文件折叠并显示 `N files · +A −D`；
- 大型二进制和超大 untracked 文件只显示元信息。

**建议**：`M / P1`。

---

### 5.8 少量高价值动作的可配置快捷键

**Codex 源码证据**

- `codex-rs/config/src/tui_keymap.rs`：按 `global`、`chat`、`composer`、`editor`、`approval` 等上下文持久化 keymap。
- `codex-rs/tui/src/keymap.rs:44-118`：运行时按作用域拆分动作。
- `keymap.rs:925-960`：内置默认绑定。
- `codex-rs/tui/src/keymap_setup/*`：提供交互式配置、动作说明和冲突检查。

**Harness 缺失检查**

检查 Web settings、composer、commands 和客户端公共包后，未发现用户级快捷键配置页、动作到按键的持久化映射或统一冲突检测。

**UX 价值**

Web 应用容易和浏览器、输入法、操作系统快捷键冲突；少量可配置入口能让高频用户保留肌肉记忆，也能处理企业环境中的保留键位。

**Web / DSH 适配**

不要第一版复制 Codex 的完整 keymap 系统。只开放 5–8 个高价值动作，例如：

- 打开快捷键帮助；
- 逆向历史搜索；
- 打开全屏 Prompt 编辑器；
- 打开 BTW；
- 复制最新回复；
- 停止当前任务。

设置时实时检测浏览器保留键、应用内冲突，并提供“一键恢复默认”。

**建议**：`M / P2`。

---

### 5.9 一键复制最新 Agent 回复

**Codex 源码证据**

- `codex-rs/tui/src/keymap.rs:63-64, 935`：把“复制最后一条 Agent 回复”定义为全局动作，默认 `Ctrl+O`。
- `codex-rs/tui/src/chatwidget/interaction.rs:41-46, 257-265`：命中快捷键后直接复制最后一条 Agent 原始 Markdown。
- `codex-rs/tui/src/chatwidget/slash_dispatch.rs:390`：同时提供 slash command 路径。

**Harness 已有与缺口**

Harness 已有逐条消息复制按钮，见 `MessageIconActions.tsx:63-77`。本候选不重复“复制消息”，只补充一个未发现的全局动作：**无需找到消息或移动鼠标，直接复制当前会话最新一条 Agent 回复**。

**UX 价值**

用户经常在回复结束后立刻把结果粘到 IDE、Issue 或文档中。会话很长或页面停在其他位置时，一个快捷键能省去滚动和精确点击。

**Web / DSH 适配**

- 默认不使用浏览器常见保留键；可通过快捷键帮助层暴露；
- 复制原始 Markdown，而不是视觉渲染后的纯文本；
- 成功后显示短暂 toast；没有 Agent 回复时不清空剪贴板，并给出轻提示；
- 与 5.8 的有限可配置快捷键共用动作注册表。

**建议**：`S / P2`。

## 6. 推荐 Top 5 路线图

### 第一阶段：先做输入体验的两个高价值闭环

1. **大段粘贴折叠 Chip**
2. **分支并编辑旧 Prompt**

这两项都直接改善高频输入，而且边界清晰。建议先定义统一的 `DraftSnapshot`，让文本、引用、附件与 paste payload 使用同一序列化模型。

### 第二阶段：让长输入和已有快捷键更好用

3. **长 Prompt 全屏编辑器**
4. **上下文快捷键帮助浮层**

帮助浮层可以先独立上线；全屏编辑器应复用正常 composer 的 input machine，不维护第二套草稿真相源。

### 第三阶段：补齐 `dsh-air` 历史能力

5. **富草稿历史恢复**

它应建立在统一 `DraftSnapshot` 上，同时复用大粘贴 Chip 的 payload 持久化，不建议先做一次性的附件历史补丁。

### 可并行 quick wins

- **页面失焦系统通知**：不依赖上述草稿模型，可独立推进。
- **一键复制最新回复**：实现面最小，可与快捷键帮助层一起交付。
- **工作区 `/diff`**：需要 Host/RPC 安全边界，适合单独立项。

## 7. 不建议直接照搬

1. **终端 paste-burst 启发式**：浏览器已有明确 paste event，只借鉴内容折叠与 payload 恢复。
2. **OSC 9 / BEL 通知后端**：Web 应使用 Notifications API、Page Visibility 和页面内 toast。
3. **浏览器任意执行 `$VISUAL` / `$EDITOR`**：命令注入和平台兼容面过大；优先全屏 Web 编辑器。
4. **Codex 完整可编程 keymap**：第一阶段过重，应先开放少量高价值动作。
5. **终端 raw scrollback、alternate screen、终端颜色探测和 terminal title 拼装器**：属于 TUI 特性；Harness 已有 Web 原生滚动、复制和会话标题能力。
6. **把普通分支重新实现一遍**：Harness 已有 `sessions.fork()`；只需增加“fork 后恢复 Prompt”的编排层。
7. **把会话搜索重新实现一遍**：Harness 已有真实搜索 UI 与异步查询，不应误列为功能空白。

## 8. 结论

最值得借鉴的不是 Codex 的终端外观，而是几个围绕草稿状态设计的精细闭环：

- 大内容进入 composer 后可折叠、可恢复；
- 旧问题可在保留原会话的前提下一键改写；
- 长 Prompt 有独立编辑空间；
- 历史召回恢复的是完整草稿，而不只是字符串；
- 快捷键会在正确的上下文中被用户发现。

若只选一个技术基础优先建设，建议先定义统一、可版本化的 **`DraftSnapshot`**。它能同时支撑大粘贴 Chip、分支后恢复 Prompt、全屏编辑器和富草稿历史，避免四个功能各自保存一套不兼容的草稿状态。

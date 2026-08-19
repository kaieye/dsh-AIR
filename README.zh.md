# dsh-air

`dsh-air` 是一个轻量的 DSH 网页插件，补齐历史召回、富草稿编辑、分支改写和 BTW 旁路会话等高频输入体验。

## 行为

- 输入框为空时按 `↑`，召回最近一条已发送消息的完整可恢复草稿。
- 继续按 `↑`，向更早的消息移动。
- 按 `↓`，向更新的消息移动。
- 越过最新一条消息后继续按 `↓`，清空输入框并退出历史切换。
- 编辑普通非空草稿时，不接管上下键。
- 召回的消息只有在内容未被修改、没有选区，并且光标位于开头或结尾时才能继续切换。
- 斜杠命令或引用建议正在处理上下键时，以 DSH 的处理结果为准。
- 按 `Ctrl+R` 打开反向历史搜索：输入查询词后立即预览最近一条匹配的消息。
  - `Ctrl+R` 或 `↑` 移动到下一条更早的唯一匹配；`Ctrl+S` 或 `↓` 移动到下一条更新的唯一匹配。
  - `Enter` 接受当前预览的匹配作为可编辑草稿；`Esc`（或 `Ctrl+C`）恢复搜索前你原有的草稿*和光标位置*。
  - 搜索期间，作曲区上方会显示 `reverse-i-search:` 状态栏：展示查询词、高亮的匹配预览、`1/N` 匹配计数，以及 `↑ 更早 · ↓ 更新 · ⏎ 接受 · esc 取消` 按键提示。查询无匹配时显示 `no match` 并保持搜索开启。
  - 匹配不区分大小写，单次搜索内完全相同的消息会被折叠。
- 支持用户消息、steering 消息、斜杠命令和队列消息；可恢复的图片、引用与大段粘贴会随历史一起还原。
- 仅自动折叠相邻且完全相同的记录（其余为 append-only，对齐 codex `history.jsonl`；同一文案稍后再次发送会作为独立召回步）。
- 已发送的历史会全局持久化到浏览器 localStorage（单一共享存储，类似 codex 的 `history.jsonl`），因此**即使是新建的会话**，刷新后仍可用 `↑` 召回之前发送过的记录（默认上限 500 条；可用 localStorage 键 `dsh-air:history:limit`（10–5000）覆盖。清除召回存储可在控制台删除 `dsh-air:history:global` 与 `dsh-air:drafts:*`，或调用导出的 clear 辅助函数）。
- 对齐说明见 [`docs/history-global.md`](docs/history-global.md) 与 [`docs/history-navigation-alignment.md`](docs/history-navigation-alignment.md)。

## Composer UX Top 5

### 1. 大段粘贴 Chip

- 大段粘贴的自动折叠捕获已移除；仅当“分支并编辑”或历史召回恢复出已折叠的粘贴引用时，输入框下方会显示对应 Chip。
- Chip 提供**展开、删除**；真正发送前仍由 DSH 的引用 codec 展开为完整原文。
- 粘贴 payload 保存在内存与浏览器 localStorage 中，历史召回可以继续还原。

### 2. 分支并编辑旧 Prompt

- 每条已发送的用户消息旁会出现“分支并编辑此问题”动作。
- 插件在该 Prompt 之前最近的已完成 turn 处创建分支，然后把原 Prompt（含可恢复的图片、引用和粘贴块）放回新分支输入框，**不会自动发送**。
- 对第一条 Prompt，由于不存在更早的 turn 边界，插件会把新会话**挂到来源会话所属的同一工作区**（无工作区时退回到相同 cwd 创建），再恢复草稿，保证新输入框可直接编辑，而不是跳回首页的工作区选择。
- 与 DSH 自带的“在新对话中分支”不同：该按钮只开新会话（输入框留空），本功能会把选中的旧 Prompt 完整搬进新输入框供改写，二者互补不重复。
- 分支目标按 codex `app_backtrack` 的语义校验：
  - 选中的问题若属于**仍在进行中**的回合，会拒绝分支并提示等待回合结束；
  - 选中的问题若是同一回合内的**插入指令（steer）**，会拒绝分支（DSH 无法在回合中间切分），仅回合的首条问题可独立改写；
  - 分支失败时保留原会话选中状态并显示错误通知，同时**把原 Prompt 恢复到原会话输入框**（仅当输入框为空，避免覆盖进行中的草稿），供就地改写；已创建但未恢复成功的 child 会尽力归档。

### 3. 富草稿历史恢复

- `↑` / `↓` 与 `Ctrl+R` 现在恢复版本化 `DraftSnapshot`，而不只是字符串。
- Snapshot 包含展开文本、持久化图片描述、真实输入引用的 source/ref、粘贴 payload 与稳定消息身份。
- 取消反向搜索会恢复搜索前的完整本地草稿、引用、粘贴块、图片 ID 和选区。
- 历史图片会通过 DSH 图片服务重新获取并加入草稿；若个别资源已不可用，会保留其余内容并显示提示。

## BTW 旁路会话

BTW 是临时旁路会话在网页端的实现。`/btw` 与 `/side` 是等价别名：

- 输入 `/btw` 或 `/side` 后按 `Enter`，打开一个空的 BTW 右侧栏。
- 也可以在命令后直接附带问题，例如 `/side 解释一下这个实现`，创建后立即提问。
- 主会话只要已经有消息，就可以创建 BTW。若主回复仍在生成，插件会优先 fork 最新的已完成前缀，并把尚未完成的尾部放入 BTW 首条 prompt 作为参考；如果还没有任何已完成回合，则在同一 workspace 创建 child，并把当前快照作为参考上下文。这个过程不会停止主回复。
- 在 parent 中再次执行 `/btw` 或 `/side`，会先安全关闭并替换已有 BTW child。后续问题直接在右侧原生输入区发送；BTW child 内不能递归创建另一个 BTW。

在网页中，BTW 使用右侧停靠式侧边栏展示，不会替换全局选中的 DSH 主会话：

- 主会话始终保持选中，即使 BTW 正在运行，主会话也可以继续工作。
- 右侧栏不再包含顶部 Tab 栏；插件只在右上角提供一个关闭按钮，用于安全结束 child 并收起侧边栏。
- 侧边栏会占用布局空间而不是覆盖主会话。桌面端可拖动左边缘调整宽度并持久化；窄屏会切换为全宽抽屉。
- Host 与主会话相同的原生 `conversation` slot tree 会直接铺满右侧栏。消息、reasoning、工具调用、审批、状态区、队列操作、附件和输入区在左右两边都使用同一套组件与行为。
- 顶部轻量状态栏会标识 BTW 是“继承内容仅作参考”的旁路会话，并显示主会话状态（包括待处理问题/审批数量）和 child 生命周期状态。
- 不再提供 `Ctrl+/` / `Ctrl+7` 会话切换，也没有 **打开分支** / **返回主会话** 路径。BTW 内部操作固定留在右侧，不会改变全局 selected session。
- `Esc`、`Ctrl+C` 等输入快捷键完全交给 Host 原生 composer 处理；BTW 只通过右上角的显式关闭按钮（或生命周期清理）结束。
- BTW 分支会继承主会话作为参考上下文，但只有 BTW boundary 之后提交的问题才是有效指令。
- BTW 默认用于回答问题和轻量、非修改性的探索。boundary 会禁止 sub-agent，并要求它不要修改文件、git 状态、权限、配置或工作区；只有你在 BTW 中明确要求修改时才例外。

### 当前网页端限制

DSH 公开 client API 会把 BTW 创建为普通、持久化的 child session：存在已完成前缀时使用 `sessions.fork()`；首回合仍在进行时，则通过 runtime 的 session-create 能力在同一 workspace 创建 child。公开 API 不支持 ephemeral fork，也不能删除或 unsubscribe child。因此插件会在 child 首次成功接收 prompt 时注入 boundary，并在 Host 原生 session/input 快照投影中隐藏这层 envelope；安全清理后再通过 `workspaces.archiveSession()` 归档 child。Host 持有的 session log 仍然存在。

## 范围

历史顺序仍使用所有会话共享的全局 localStorage（默认上限 500 条，可用 `dsh-air:history:limit` 覆盖），每个来源会话另存版本化富草稿快照。当前窗口、持久化快照和队列到 durable node 的交接会按稳定身份合并。图片仅保存 Host 提供的 durable 描述，召回时重新解析；浏览器或 Host 无法再提供资源时会提示重新选择。无法安全理解的未知内容块仍会整条跳过，避免伪装成完整草稿。大段粘贴 payload 也位于 localStorage；清理站点数据会使对应 Chip 无法恢复。

## 安装

从 npm 安装已发布的插件包：

```bash
dsh plugin --profile web add dsh-air
```

安装后重新启动 DSH。卸载命令：

```bash
dsh plugin --profile web remove dsh-air
```

## 更新

使用以下命令更新到 npm 上的最新版本：

```bash
dsh plugin --profile web update dsh-air --latest
```

更新后重新启动 DSH。

## 开发与验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

历史状态机与全局顺序位于 `src/core/history-navigation.ts`、`src/core/history-persistence.ts`；富草稿模型和持久化位于 `src/core/draft-snapshot.ts`、`src/core/draft-persistence.ts`，集成入口是 `src/client/HistoryKeyHandler.tsx`。粘贴引用与 Chip 位于 `src/core/paste-chip.ts`、`src/client/LargePasteController.ts`、`src/client/RichComposerTools.tsx`。分支编辑位于 `src/core/fork-boundary.ts`、`src/client/ForkEditController.ts`、`src/client/ForkEditEnhancer.tsx`。BTW boundary、原生快照投影及 UI 位于对应的 `btw-*` 核心文件与 `BtwController.ts`、`BtwNativeConversation.tsx`、`BtwPanel.tsx`。

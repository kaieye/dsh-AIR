# dsh-air

`dsh-air` 是一个轻量的 DSH 插件，通过键盘召回当前会话中已经发送的消息。**AIR 只是用来表达插件轻量、小巧，不是功能名称的缩写。**

插件只做一件事：使用 `↑` 和 `↓` 切换当前会话的发送历史。

## 行为

- 输入框为空时按 `↑`，召回最近一条已发送的纯文本消息。
- 继续按 `↑`，向更早的消息移动。
- 按 `↓`，向更新的消息移动。
- 越过最新一条消息后继续按 `↓`，清空输入框并退出历史切换。
- 编辑普通非空草稿时，不接管上下键。
- 召回的消息只有在内容未被修改、没有选区，并且光标位于开头或结尾时才能继续切换。
- 斜杠命令或引用建议正在处理上下键时，以 DSH 的处理结果为准。
- 支持用户消息、steering 消息、斜杠命令和队列中的纯文本消息。
- 自动折叠相邻且完全相同的记录。

## 范围

插件只能读取当前会话已经加载的历史。包含图片或其他非文本内容的消息无法完整恢复为文本草稿，因此不会进入可切换历史。

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

历史状态机位于 `src/core/history-navigation.ts`，历史提取逻辑位于 `src/core/history-extraction.ts`，键盘事件处理位于 `src/client/HistoryKeyHandler.ts`。

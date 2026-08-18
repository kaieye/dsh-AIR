# dsh-air

`dsh-air` is a lightweight DSH plugin for recalling sent messages with the keyboard.

The plugin does one thing: use `ArrowUp` and `ArrowDown` to navigate the current conversation's sent-message history.

## Behavior

- Press `ArrowUp` on an empty composer to recall the newest sent plain-text message.
- Keep pressing `ArrowUp` to move toward older messages.
- Press `ArrowDown` to move toward newer messages.
- Press `ArrowDown` past the newest message to clear the composer and stop navigating history.
- Do not intercept arrow keys while editing an ordinary non-empty draft.
- Continue navigating a recalled message only while its text is unchanged, the selection is collapsed, and the caret is at the beginning or end.
- Let DSH consume arrow keys first when slash-command or reference suggestions are active.
- Include user messages, steering messages, slash commands, and queued plain-text messages.
- Fold consecutive exact duplicates.

## Scope

Only history already loaded for the current conversation is available. Messages containing images or other non-text content are skipped because they cannot be restored as an intact text draft.

## Install

```bash
pnpm install
pnpm build
dsh plugin --profile web add link:/absolute/path/to/dsh-AIR
```

Restart DSH after installation. To remove the plugin:

```bash
dsh plugin --profile web remove air
```

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

The history state machine is in `src/core/history-navigation.ts`, history extraction is in `src/core/history-extraction.ts`, and keyboard event handling is in `src/client/HistoryKeyHandler.ts`.

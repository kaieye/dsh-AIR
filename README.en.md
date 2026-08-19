# dsh-air

[中文](README.md) | English

`dsh-air` lets you browse previously sent prompts with `ArrowUp` / `ArrowDown` and open a docked side conversation with `/btw`.

## Install

```bash
dsh plugin --profile web add dsh-air
```

Restart DSH after installation.

## Uninstall

```bash
dsh plugin --profile web remove dsh-air
```

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `ArrowUp` | Recall the previous sent prompt from an empty composer. |
| `ArrowDown` | Move to a newer history entry. |
| `Ctrl+R` | Search sent prompt history. |
| `Enter` | Accept the current history search result. |
| `Esc` | Cancel history search and restore the original draft. |
| `/btw [question]` | Open a side conversation; `/side` is an alias. |

## Settings and local data

The **AIR 插件** section in DSH settings shows the saved history count, lets you change the history cap, and can clear dsh-air's stored history, rich drafts, and large-paste payloads. The cap defaults to 500 entries and accepts 10–5,000; clearing data keeps the cap setting.

History, drafts, and paste references are stored in the current browser's `localStorage`. Clearing the site's browser data removes these records as well.

Drag the left edge of the BTW panel to resize it. When the resize handle is focused, `←` / `→` change the width by 24 pixels, `Shift` plus an arrow changes it by 80 pixels, and `Home` / `End` jump to the minimum / maximum width. The chosen width is persisted locally.

## License

[MIT](LICENSE)

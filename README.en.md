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

## License

[MIT](LICENSE)

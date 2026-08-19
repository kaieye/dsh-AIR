# dsh-air

中文 | [English](README.en.md)

`dsh-air` 支持使用 `↑` / `↓` 切换历史发送记录，并通过 `/btw` 打开停靠式侧边对话。

## 安装

```bash
dsh plugin --profile web add dsh-air
```

安装后重新启动 DSH。

## 卸载

```bash
dsh plugin --profile web remove dsh-air
```

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `↑` | 输入框为空时召回上一条发送记录。 |
| `↓` | 切换到更新的历史记录。 |
| `Ctrl+R` | 搜索历史发送记录。 |
| `Enter` | 接受当前历史搜索结果。 |
| `Esc` | 取消历史搜索并恢复原草稿。 |
| `/btw [问题]` | 打开侧边对话；`/side` 是等价别名。 |

## License

[MIT](LICENSE)

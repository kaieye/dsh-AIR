import { useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import {
  HISTORY_LIMIT_STORAGE_KEY,
  HISTORY_STORAGE_LIMIT,
  HISTORY_STORAGE_LIMIT_MAX,
  HISTORY_STORAGE_LIMIT_MIN,
  clearGlobalHistory,
  readGlobalHistory,
} from '../core/history-persistence.ts'
import { clearAllDraftHistories } from '../core/draft-persistence.ts'
import { PASTE_STORAGE_PREFIX } from '../core/paste-chip.ts'

/**
 * Settings page contributed by dsh-air into the `settings.section` slot,
 * registered under the nav label "AIR 插件".
 *
 * The page is intentionally self-contained: it renders plugin overview copy
 * and owns the few preferences dsh-air stores directly in localStorage
 * (history entry cap and the stored recall data). Nothing here depends on a
 * settings namespace, so the section works even in deployments where the
 * plugin never registers host-side settings.
 */

/** Feature rows shown in the overview block. */
const FEATURES: ReadonlyArray<readonly [name: string, detail: string]> = [
  ['历史召回', '输入框为空时用 ↑ / ↓ 切换历史消息，Ctrl+R 反向搜索。'],
  ['分支改写', '旧 Prompt 一键“分支并编辑”，图片、引用与大段粘贴一起还原。'],
  ['BTW 旁路会话', '/btw 或 /side 打开右侧旁路会话，直接使用与主会话一致的原生 UI。'],
] as const

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
    padding: '20px 4px 4px',
    color: 'var(--dsw-alias-label-primary)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  },
  title: {
    margin: 0,
    fontSize: '18px',
    fontWeight: 600,
    lineHeight: 1.4,
  },
  close: {
    font: 'inherit',
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    padding: '4px 10px',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  closeHover: {
    color: 'var(--dsw-alias-label-primary)',
  },
  description: {
    margin: 0,
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '13px',
    lineHeight: 1.6,
  },
  block: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  blockTitle: {
    margin: 0,
    fontSize: '13px',
    fontWeight: 600,
    lineHeight: 1.5,
  },
  featureRow: {
    display: 'flex',
    gap: '10px',
    alignItems: 'baseline',
    fontSize: '13px',
    lineHeight: 1.6,
  },
  featureName: {
    flex: '0 0 96px',
    color: 'var(--dsw-alias-label-primary)',
    fontWeight: 500,
  },
  featureDetail: {
    color: 'var(--dsw-alias-label-secondary)',
  },
  field: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  fieldLabel: {
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '13px',
    lineHeight: 1.5,
    whiteSpace: 'nowrap',
  },
  input: {
    width: '96px',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-3)',
    height: '32px',
    font: 'inherit',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: '8px',
    padding: '0 10px',
    fontSize: '13px',
    lineHeight: 1.5,
    fontVariantNumeric: 'tabular-nums',
  },
  hint: {
    margin: 0,
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  count: {
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '13px',
    lineHeight: 1.5,
    fontVariantNumeric: 'tabular-nums',
  },
  clearButton: {
    font: 'inherit',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid var(--dsw-alias-state-error-primary)',
    borderRadius: '8px',
    padding: '6px 12px',
    fontSize: '13px',
    lineHeight: 1.5,
  },
  clearDone: {
    color: 'var(--dsw-alias-state-success-primary)',
    fontSize: '12px',
    lineHeight: 1.5,
  },
}

/** Props accepted by the AIR settings page (the shell supplies `close`). */
export interface AirSettingsSectionProps {
  /** Close the settings panel (shell affordance). */
  readonly close?: () => void
}

/** Resolve the current persisted history cap, or null when on the default. */
function readHistoryLimit(): number | null {
  try {
    const raw = window.localStorage.getItem(HISTORY_LIMIT_STORAGE_KEY)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isInteger(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Count persisted recall entries across the global history store. */
function readHistoryCount(): number {
  try {
    return readGlobalHistory(window.localStorage).length
  } catch {
    return 0
  }
}

/** Remove every `dsh-air:paste:*` payload key from storage. */
function clearPastePayloads(): void {
  try {
    const storage = window.localStorage
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key !== null && key.startsWith(PASTE_STORAGE_PREFIX)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    // Ignore blocked storage.
  }
}

/**
 * AIR plugin settings page. Renders plugin overview copy plus the two
 * preferences dsh-air keeps in localStorage: the history recall cap and the
 * stored recall data (history, rich drafts, and paste payloads).
 */
export function AirSettingsSection({ close }: AirSettingsSectionProps): JSX.Element {
  const [historyCount, setHistoryCount] = useState<number>(readHistoryCount)
  const [limitText, setLimitText] = useState<string>(() => String(readHistoryLimit() ?? HISTORY_STORAGE_LIMIT))
  const [cleared, setCleared] = useState<boolean>(false)

  function applyLimit(): void {
    const parsed = Number(limitText)
    if (!Number.isInteger(parsed)) {
      // Invalid input: fall back to the default value shown in the field.
      setLimitText(String(HISTORY_STORAGE_LIMIT))
      return
    }
    const clamped = Math.min(HISTORY_STORAGE_LIMIT_MAX, Math.max(HISTORY_STORAGE_LIMIT_MIN, parsed))
    setLimitText(String(clamped))
    try {
      window.localStorage.setItem(HISTORY_LIMIT_STORAGE_KEY, String(clamped))
    } catch {
      // Ignore blocked storage.
    }
  }

  function clearData(): void {
    clearGlobalHistory(window.localStorage)
    clearAllDraftHistories(window.localStorage)
    clearPastePayloads()
    setHistoryCount(0)
    setCleared(true)
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <h2 style={styles.title}>AIR 插件</h2>
        {close !== undefined && (
          <button type="button" style={styles.close} onClick={close}>
            完成
          </button>
        )}
      </div>

      <p style={styles.description}>
        轻量的 DSH 网页插件，补齐历史召回、富草稿编辑、分支改写和 BTW 旁路会话等高频输入体验。
      </p>

      <div style={styles.block}>
        <h3 style={styles.blockTitle}>功能</h3>
        {FEATURES.map(([name, detail]) => (
          <div key={name} style={styles.featureRow}>
            <span style={styles.featureName}>{name}</span>
            <span style={styles.featureDetail}>{detail}</span>
          </div>
        ))}
      </div>

      <div style={styles.block}>
        <h3 style={styles.blockTitle}>历史召回上限</h3>
        <div style={styles.field}>
          <label style={styles.fieldLabel} htmlFor="dsh-air-history-limit">
            保留条数
          </label>
          <input
            id="dsh-air-history-limit"
            style={styles.input}
            type="number"
            inputMode="numeric"
            min={HISTORY_STORAGE_LIMIT_MIN}
            max={HISTORY_STORAGE_LIMIT_MAX}
            value={limitText}
            onChange={(event) => {
              setLimitText(event.target.value)
              setCleared(false)
            }}
            onBlur={applyLimit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyLimit()
            }}
          />
        </div>
        <p style={styles.hint}>
          默认 {HISTORY_STORAGE_LIMIT} 条，范围 {HISTORY_STORAGE_LIMIT_MIN}–{HISTORY_STORAGE_LIMIT_MAX}，失焦或按回车保存。
        </p>
      </div>

      <div style={styles.block}>
        <h3 style={styles.blockTitle}>数据管理</h3>
        <div style={styles.row}>
          <span style={styles.count}>已保存 {historyCount} 条历史消息</span>
          <button type="button" style={styles.clearButton} onClick={clearData}>
            清除历史与草稿
          </button>
        </div>
        {cleared && (
          <p style={styles.clearDone} role="status">
            已清除全局历史、草稿与粘贴数据；历史召回上限设置不受影响。
          </p>
        )}
        <p style={styles.hint}>清除后 ↑ / Ctrl+R 无法再召回旧消息，仅保留已发送窗口内的内容。</p>
      </div>
    </div>
  )
}

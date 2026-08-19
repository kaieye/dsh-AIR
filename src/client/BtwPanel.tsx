import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type {
  ConversationSnapshot,
  SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import {
  deriveBtwSessionStatus,
  formatBtwChildStatus,
  formatBtwParentStatus,
  summarizeBtwPending,
  type BtwParentStatus,
} from '../core/btw-status.ts'
import { BtwController, type BtwSnapshot } from './BtwController.ts'
import type { BtwConversationSurface } from './BtwNativeConversation.tsx'

interface BtwPanelProps {
  readonly sessionId: SessionId
  readonly useSession: SnapshotSelectorHook<ConversationSnapshot>
  readonly btw: BtwController
  readonly nativeConversation: BtwConversationSurface
}

const BTW_PANEL_WIDTH_KEY = 'dsh-air:btw-panel-width'
const BTW_PANEL_DEFAULT_WIDTH = 440
const BTW_PANEL_MIN_WIDTH = 320
const BTW_PANEL_MAX_WIDTH = 720
const BTW_PANEL_STYLE_ID = 'dsh-air-btw-panel-layout'
let panelLayoutUsers = 0
let panelLayoutPreviouslyOpen = false
let panelLayoutPreviousWidth = ''

const BTW_PANEL_LAYOUT_CSS = `
body[data-dsh-air-btw-open] #root {
  margin-right: calc(var(--dsh-sidebar-width, 0px) + var(--dsh-air-btw-width, ${BTW_PANEL_DEFAULT_WIDTH}px));
  transition: margin-right var(--ds-transition-duration-slow, 180ms) var(--ds-ease-in-out, ease);
}

body[data-dsh-air-btw-resizing] #root,
body[data-dsh-air-btw-resizing] [data-dsh-air-btw-panel] {
  transition: none !important;
  user-select: none;
}

[data-dsh-air-btw-close]:not(:disabled):hover {
  background: var(--dsw-alias-interactive-bg-hover) !important;
  color: var(--dsw-alias-label-primary) !important;
}

[data-dsh-air-btw-resize]:hover,
body[data-dsh-air-btw-resizing] [data-dsh-air-btw-resize] {
  background: var(--dsw-alias-interactive-bg-hover-accent);
}

@media (max-width: 760px) {
  body[data-dsh-air-btw-open] #root {
    margin-right: var(--dsh-sidebar-width, 0px);
  }

  [data-dsh-air-btw-panel] {
    right: 0 !important;
    width: 100vw !important;
  }

  [data-dsh-air-btw-resize] {
    display: none !important;
  }
}

@media (prefers-reduced-motion: reduce) {
  body[data-dsh-air-btw-open] #root,
  [data-dsh-air-btw-panel] {
    transition: none !important;
  }
}
`

function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return BTW_PANEL_DEFAULT_WIDTH
  const viewportMaximum = typeof window === 'undefined'
    ? BTW_PANEL_MAX_WIDTH
    : Math.max(BTW_PANEL_MIN_WIDTH, window.innerWidth - 280)
  return Math.round(Math.min(BTW_PANEL_MAX_WIDTH, viewportMaximum, Math.max(BTW_PANEL_MIN_WIDTH, width)))
}

function readPanelWidth(): number {
  if (typeof window === 'undefined') return BTW_PANEL_DEFAULT_WIDTH
  try {
    const value = Number.parseInt(window.localStorage.getItem(BTW_PANEL_WIDTH_KEY) ?? '', 10)
    return clampPanelWidth(value)
  } catch {
    return BTW_PANEL_DEFAULT_WIDTH
  }
}

function persistPanelWidth(width: number): void {
  try {
    window.localStorage.setItem(BTW_PANEL_WIDTH_KEY, String(clampPanelWidth(width)))
  } catch {
    // A blocked storage implementation should not make the BTW panel unusable.
  }
}

function installPanelLayoutStyles(): () => void {
  const existing = document.getElementById(BTW_PANEL_STYLE_ID) as HTMLStyleElement | null
  const style = existing ?? document.createElement('style')
  if (existing === null) {
    style.id = BTW_PANEL_STYLE_ID
    style.textContent = BTW_PANEL_LAYOUT_CSS
    document.head.appendChild(style)
  }
  const references = Number.parseInt(style.dataset.references ?? '0', 10) + 1
  style.dataset.references = String(references)
  return () => {
    const remaining = Math.max(0, Number.parseInt(style.dataset.references ?? '1', 10) - 1)
    if (remaining === 0) style.remove()
    else style.dataset.references = String(remaining)
  }
}

function acquirePanelLayout(width: number): () => void {
  const uninstallStyles = installPanelLayoutStyles()
  const body = document.body
  if (panelLayoutUsers === 0) {
    panelLayoutPreviouslyOpen = body.hasAttribute('data-dsh-air-btw-open')
    panelLayoutPreviousWidth = body.style.getPropertyValue('--dsh-air-btw-width')
  }
  panelLayoutUsers += 1
  body.setAttribute('data-dsh-air-btw-open', '')
  body.style.setProperty('--dsh-air-btw-width', `${width}px`)

  let released = false
  return () => {
    if (released) return
    released = true
    uninstallStyles()
    panelLayoutUsers = Math.max(0, panelLayoutUsers - 1)
    if (panelLayoutUsers > 0) return
    body.removeAttribute('data-dsh-air-btw-resizing')
    if (!panelLayoutPreviouslyOpen) body.removeAttribute('data-dsh-air-btw-open')
    if (panelLayoutPreviousWidth === '') body.style.removeProperty('--dsh-air-btw-width')
    else body.style.setProperty('--dsh-air-btw-width', panelLayoutPreviousWidth)
    panelLayoutPreviouslyOpen = false
    panelLayoutPreviousWidth = ''
  }
}

const styles = {
  shell: {
    position: 'fixed' as const,
    zIndex: 40,
    top: 0,
    right: 'var(--dsh-sidebar-width, 0px)',
    bottom: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    boxSizing: 'border-box' as const,
    paddingTop: 'var(--dsh-title-bar-strip, 0px)',
    overflow: 'hidden',
    borderLeft: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    transition: 'width var(--ds-transition-duration-slow, 180ms) var(--ds-ease-in-out, ease), right var(--ds-transition-duration-slow, 180ms) var(--ds-ease-in-out, ease)',
  },
  resize: {
    position: 'absolute' as const,
    zIndex: 20,
    top: 0,
    bottom: 0,
    left: '-4px',
    width: '8px',
    cursor: 'col-resize',
    touchAction: 'none',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    minHeight: '58px',
    boxSizing: 'border-box' as const,
    padding: '10px 52px 9px 16px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-base)',
  },
  headerTitle: {
    display: 'flex',
    flexDirection: 'column' as const,
    minWidth: 0,
    gap: '2px',
  },
  title: {
    fontSize: '14px',
    fontWeight: 650,
    lineHeight: 1.3,
    color: 'var(--dsw-alias-label-primary)',
  },
  subtitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '11px',
    lineHeight: 1.3,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  headerMeta: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '4px',
    maxWidth: '66%',
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    maxWidth: '100%',
    padding: '3px 6px',
    borderRadius: '5px',
    fontSize: '10px',
    lineHeight: 1.25,
    whiteSpace: 'nowrap' as const,
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-module-platform)',
  },
  pendingBadge: {
    color: 'var(--dsw-alias-state-warning-primary)',
    background: 'var(--dsw-alias-state-warning-secondary)',
  },
  close: {
    position: 'absolute' as const,
    zIndex: 30,
    top: 'calc(var(--dsh-title-bar-strip, 0px) + 8px)',
    right: '8px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    padding: 0,
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-base)',
    boxShadow: 'var(--ds-shadow-1, 0 1px 3px rgb(0 0 0 / 12%))',
    cursor: 'pointer',
    fontSize: '20px',
    lineHeight: 1,
  },
  surface: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    background: 'var(--dsw-alias-bg-base)',
  },
  notice: {
    margin: '16px',
    padding: '10px 12px',
    borderRadius: '8px',
    fontSize: '12px',
    lineHeight: 1.45,
    background: 'var(--dsw-alias-bg-module-platform)',
  },
  error: { color: 'var(--dsw-alias-state-error-primary)' },
}

interface ParentIndicator {
  readonly status: BtwParentStatus
  readonly pending: ReturnType<typeof summarizeBtwPending>
}

function sameParentIndicator(a: ParentIndicator, b: ParentIndicator): boolean {
  return a.status === b.status
    && a.pending.total === b.pending.total
    && a.pending.questions === b.pending.questions
    && a.pending.approvals === b.pending.approvals
}

function childStatusLabel(
  phase: BtwSnapshot['phase'],
  child: ConversationSnapshot | null,
): string {
  if (phase === 'forking') return 'BTW 正在准备'
  if (phase === 'sending') return 'BTW 正在发送'
  if (phase === 'closing') return 'BTW 正在关闭'
  if (child === null) return 'BTW 尚未就绪'
  return formatBtwChildStatus(deriveBtwSessionStatus(child))
}

/** Docked shell whose body is the Host's native conversation UI for the BTW child. */
export function BtwPanel({ sessionId, useSession, btw, nativeConversation }: BtwPanelProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(btw.subscribe, btw.getSnapshot, btw.getSnapshot)
  const [panelWidth, setPanelWidth] = useState(readPanelWidth)
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const panelWidthRef = useRef(panelWidth)
  const active = btw.isVisibleFor(sessionId)
  const parentIndicator = useSession((state) => ({
    status: deriveBtwSessionStatus(state),
    pending: summarizeBtwPending(state),
  }), sameParentIndicator)

  useEffect(() => {
    panelWidthRef.current = panelWidth
  }, [panelWidth])

  useEffect(() => {
    if (!active) return
    return acquirePanelLayout(panelWidthRef.current)
  }, [active])

  useEffect(() => {
    if (!active) return
    document.body.style.setProperty('--dsh-air-btw-width', `${panelWidth}px`)
  }, [active, panelWidth])

  if (!active) return null
  const closing = snapshot.phase === 'closing'
  const parentStatus = snapshot.parentStatus === 'closed' ? parentIndicator.status : snapshot.parentStatus
  const childLabel = childStatusLabel(snapshot.phase, snapshot.child)
  const childStatus = snapshot.child === null ? snapshot.phase : deriveBtwSessionStatus(snapshot.child)
  const pendingLabel = parentIndicator.pending.total === 0
    ? null
    : `主会话待处理 ${parentIndicator.pending.total} 项`

  return (
    <aside
      data-dsh-air-btw-panel=""
      style={{ ...styles.shell, width: `${panelWidth}px` }}
      aria-label="BTW side conversation"
    >
      <header data-dsh-air-btw-header="" style={styles.header}>
        <div style={styles.headerTitle}>
          <strong data-dsh-air-btw-title="" style={styles.title}>BTW</strong>
          <span data-dsh-air-btw-context="" style={styles.subtitle}>旁路会话 · 继承内容仅作参考</span>
        </div>
        <div data-dsh-air-btw-statuses="" style={styles.headerMeta} aria-live="polite">
          <span
            data-dsh-air-btw-parent-status=""
            data-status={parentStatus}
            style={styles.badge}
          >{formatBtwParentStatus(parentStatus)}</span>
          <span
            data-dsh-air-btw-child-status=""
            data-status={childStatus}
            style={styles.badge}
          >{childLabel}</span>
          {pendingLabel === null ? null : (
            <span data-dsh-air-btw-pending="" style={{ ...styles.badge, ...styles.pendingBadge }}>
              {pendingLabel}
            </span>
          )}
        </div>
      </header>
      <div
        data-dsh-air-btw-resize=""
        style={styles.resize}
        aria-hidden="true"
        onPointerDown={(event) => {
          event.preventDefault()
          resizeRef.current = { startX: event.clientX, startWidth: panelWidthRef.current }
          document.body.setAttribute('data-dsh-air-btw-resizing', '')
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const drag = resizeRef.current
          if (drag === null || !event.currentTarget.hasPointerCapture(event.pointerId)) return
          const nextWidth = clampPanelWidth(drag.startWidth + drag.startX - event.clientX)
          panelWidthRef.current = nextWidth
          setPanelWidth(nextWidth)
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          resizeRef.current = null
          document.body.removeAttribute('data-dsh-air-btw-resizing')
          persistPanelWidth(panelWidthRef.current)
        }}
        onPointerCancel={() => {
          resizeRef.current = null
          document.body.removeAttribute('data-dsh-air-btw-resizing')
          persistPanelWidth(panelWidthRef.current)
        }}
        onLostPointerCapture={() => {
          if (resizeRef.current === null) return
          resizeRef.current = null
          document.body.removeAttribute('data-dsh-air-btw-resizing')
          persistPanelWidth(panelWidthRef.current)
        }}
      />

      <button
        type="button"
        data-dsh-air-btw-close=""
        style={{ ...styles.close, opacity: closing ? .45 : 1 }}
        onClick={() => void btw.close()}
        disabled={closing}
        title="关闭 BTW"
        aria-label="关闭 BTW"
      >×</button>

      <div data-dsh-air-btw-surface="" style={styles.surface}>
        {snapshot.childSessionId !== null
          ? nativeConversation.render(snapshot.childSessionId)
          : <div style={{ ...styles.notice, ...(snapshot.error === null ? {} : styles.error) }}>
              {snapshot.error ?? '正在从主会话创建 BTW 分支…'}
            </div>}
      </div>
    </aside>
  )
}

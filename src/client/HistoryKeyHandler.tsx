import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  draftSnapshotFromComposer,
  extractDraftSnapshots,
  historyKey,
  historyKeyText,
  type DraftHistorySource,
  type DraftOccurrenceSource,
  type DraftSnapshot,
} from '../core/draft-snapshot.ts'
import {
  DRAFT_HISTORY_STORAGE_PREFIX,
  capDraftHistory,
  draftHistoryStorageKey,
  mergeDraftHistory,
  parseDraftHistory,
  serializeDraftHistory,
} from '../core/draft-persistence.ts'
import {
  GLOBAL_HISTORY_STORAGE_KEY,
  HISTORY_STORAGE_PREFIX,
  appendNewGlobalEntries,
  assembleGlobalFromLegacy,
  equalGlobalEntries,
  parseGlobalHistory,
  resolveHistoryLimit,
  writeGlobalHistory,
  type GlobalHistoryEntry,
} from '../core/history-persistence.ts'
import {
  HistoryNavigator,
  type HistorySearchResult,
} from '../core/history-navigation.ts'
import { LargePasteController } from './LargePasteController.ts'
import {
  HistorySearchFooter,
  type HistorySearchFooterData,
} from './HistorySearchFooter.tsx'

interface HistoryInputState {
  readonly draft: string
  readonly draftRev: number
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
  readonly imageIds: readonly unknown[]
  readonly occurrences: readonly (DraftOccurrenceSource & { readonly occurrenceId: number })[]
}

interface HistoryKeyHandlerProps {
  readonly session: DraftHistorySource & { readonly sessionId: SessionId }
  readonly input: HistoryInputState
  readonly inputActions: {
    setDraft(text: string): void
  }
  readonly paste: LargePasteController
}

interface RecallEntry {
  readonly snapshot: DraftSnapshot
  readonly sourceSessionId: SessionId
}

/** One live Ctrl+R reverse-history search session (rich draft + caret restored on cancel). */
interface HistorySearchSession {
  readonly originalSnapshot: DraftSnapshot
  readonly originalImageIds: readonly unknown[]
  readonly originalSelectionStart: number
  readonly originalSelectionEnd: number
}

function legacySnapshot(id: string, text: string, createdAt?: number): DraftSnapshot {
  return {
    version: 1,
    id,
    text,
    attachments: [],
    mentions: [],
    pastes: [],
    ...(createdAt === undefined ? {} : { createdAt }),
  }
}

/**
 * Load the cross-session global recall order. On first load, legacy per-session
 * string lists are migrated exactly as before so this upgrade never loses an
 * existing ArrowUp/Ctrl+R history. The effective entry cap comes from
 * {@link resolveHistoryLimit} so a lowered `dsh-air:history:limit` applies on read.
 */
function loadGlobalHistory(): GlobalHistoryEntry[] {
  const limit = resolveHistoryLimit(window.localStorage)
  try {
    const raw = window.localStorage.getItem(GLOBAL_HISTORY_STORAGE_KEY)
    if (raw !== null) return parseGlobalHistory(raw).slice(-limit)
  } catch {
    return []
  }

  try {
    const lists: string[][] = []
    const sessionIds: string[] = []
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (key === null || key === GLOBAL_HISTORY_STORAGE_KEY || !key.startsWith(HISTORY_STORAGE_PREFIX)) continue
      const raw = window.localStorage.getItem(key)
      if (raw === null) continue
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { continue }
      if (!Array.isArray(parsed)) continue
      lists.push(parsed.filter((entry): entry is string => typeof entry === 'string'))
      sessionIds.push(key.slice(HISTORY_STORAGE_PREFIX.length))
    }
    const migrated = assembleGlobalFromLegacy(lists, (index) => sessionIds[index] ?? '', limit)
    if (migrated.length > 0) writeGlobalHistory(window.localStorage, migrated)
    return migrated
  } catch {
    return []
  }
}

function saveGlobalHistory(entries: readonly GlobalHistoryEntry[]): void {
  writeGlobalHistory(window.localStorage, entries)
}

function legacyDraftsForSession(sessionId: string): DraftSnapshot[] {
  try {
    const raw = window.localStorage.getItem(`${HISTORY_STORAGE_PREFIX}${sessionId}`)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .map((text, index) => legacySnapshot(`legacy:${sessionId}:${index}`, text))
  } catch {
    return []
  }
}

function loadDraftsForSession(sessionId: string): DraftSnapshot[] {
  const rich = parseDraftHistory(window.localStorage.getItem(draftHistoryStorageKey(sessionId)))
  const limit = resolveHistoryLimit(window.localStorage)
  const entries = rich.length > 0 ? rich : legacyDraftsForSession(sessionId)
  return capDraftHistory(entries, limit)
}

function loadAllDraftHistories(): Map<string, DraftSnapshot[]> {
  const result = new Map<string, DraftSnapshot[]>()
  const limit = resolveHistoryLimit(window.localStorage)
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)
      if (key === null || !key.startsWith(DRAFT_HISTORY_STORAGE_PREFIX)) continue
      const sessionId = key.slice(DRAFT_HISTORY_STORAGE_PREFIX.length)
      result.set(sessionId, capDraftHistory(parseDraftHistory(window.localStorage.getItem(key)), limit))
    }
  } catch {
    // localStorage may be blocked; the current transcript still works.
  }
  return result
}

function saveDraftHistory(sessionId: string, entries: readonly DraftSnapshot[]): void {
  try {
    const limit = resolveHistoryLimit(window.localStorage)
    window.localStorage.setItem(
      draftHistoryStorageKey(sessionId),
      JSON.stringify(capDraftHistory(entries, limit)),
    )
  } catch {
    // Storage is an enhancement only; in-window rich recall remains available.
  }
}

function isDshComposerTextarea(target: EventTarget | null): target is HTMLTextAreaElement {
  if (!(target instanceof HTMLTextAreaElement)) return false
  if (!target.matches('textarea[data-phase]')) return false
  if (target.closest('[data-composer-seat]') === null) return false
  return target.parentElement?.querySelector('[data-input-mirror]') !== null
}

function restoreCaretAtEnd(textarea: HTMLTextAreaElement, text: string): void {
  requestAnimationFrame(() => {
    if (!textarea.isConnected) return
    try {
      textarea.setSelectionRange(text.length, text.length)
      textarea.scrollTop = textarea.scrollHeight
    } catch (error) {
      console.error('[dsh-air] failed to restore composer caret', error)
    }
  })
}

function restoreSelection(textarea: HTMLTextAreaElement, start: number, end: number): void {
  requestAnimationFrame(() => {
    if (!textarea.isConnected) return
    try { textarea.setSelectionRange(start, end) } catch (error) {
      console.error('[dsh-air] failed to restore composer selection', error)
    }
  })
}

/** Plain Ctrl+R/Ctrl+S (Cmd/Alt excluded, so browser refresh/save stay untouched). */
function isReverseSearchPrevious(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'r' || event.key === 'R')
}

function isReverseSearchNext(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 's' || event.key === 'S')
}

function syncSearchFooter(
  navigator: HistoryNavigator,
  previewText: string,
  setFooter: (data: HistorySearchFooterData | null) => void,
): void {
  if (!navigator.isSearching()) {
    setFooter(null)
    return
  }
  const query = navigator.searchQueryTextOf()
  const position = navigator.searchMatchPosition()
  const count = navigator.searchMatchCount()
  if (query.length === 0) {
    setFooter({ status: 'idle', query: '', matchPosition: null, matchCount: null, previewText: '' })
  } else if (position === null) {
    setFooter({ status: 'noMatch', query, matchPosition: null, matchCount: count, previewText: '' })
  } else {
    setFooter({ status: 'match', query, matchPosition: position, matchCount: count, previewText })
  }
}

function enrichLatestMatchingSnapshot(
  snapshots: readonly DraftSnapshot[],
  pending: DraftSnapshot | null,
): { readonly snapshots: DraftSnapshot[]; readonly durableMatch: boolean } {
  if (pending === null) return { snapshots: [...snapshots], durableMatch: false }
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const candidate = snapshots[index]
    if (candidate === undefined || candidate.text !== pending.text) continue
    const enriched: DraftSnapshot = {
      ...candidate,
      text: pending.text,
      mentions: pending.mentions,
      pastes: pending.pastes,
    }
    const next = snapshots.slice()
    next[index] = enriched
    return { snapshots: next, durableMatch: !candidate.id.startsWith('queue:') }
  }
  return { snapshots: [...snapshots], durableMatch: false }
}

/**
 * Build the Up/Down recall list in codex-like append order.
 *
 * Global entries are one slot each (identical text may appear more than once).
 * Rich snapshots are consumed newest-first per session so repeated sends of the
 * same text still rehydrate the matching local draft when available. Window-only
 * texts that are not yet the global suffix are appended so a just-sent message
 * is recallable before the persistence effect runs.
 */
function assembleRecallEntries(
  global: readonly GlobalHistoryEntry[],
  richBySession: ReadonlyMap<string, readonly DraftSnapshot[]>,
  currentSessionId: SessionId,
  current: readonly DraftSnapshot[],
): RecallEntry[] {
  const recalled: RecallEntry[] = []
  const remainingBySession = new Map<string, DraftSnapshot[]>()

  const takeSnapshot = (sourceId: string, text: string, fallbackId: string, createdAt?: number): DraftSnapshot => {
    let remaining = remainingBySession.get(sourceId)
    if (remaining === undefined) {
      const candidates = sourceId === currentSessionId ? current : richBySession.get(sourceId) ?? []
      remaining = candidates.slice()
      remainingBySession.set(sourceId, remaining)
    }
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index]
      if (candidate === undefined || candidate.text !== text) continue
      remaining.splice(index, 1)
      return candidate
    }
    return legacySnapshot(fallbackId, text, createdAt)
  }

  global.forEach((entry, index) => {
    if (entry.text.length === 0) return
    if (recalled.at(-1)?.snapshot.text === entry.text) return
    const sourceId = (entry.sessionId || currentSessionId) as SessionId
    const snapshot = takeSnapshot(
      sourceId,
      entry.text,
      `global:${entry.sessionId}:${entry.ts}:${index}`,
      entry.ts > 0 ? entry.ts : undefined,
    )
    recalled.push({ snapshot, sourceSessionId: sourceId })
  })

  // Extend with any current-window rows not already covered as the global suffix.
  let matched = 0
  const maxMatch = Math.min(current.length, recalled.length)
  for (let size = maxMatch; size >= 0; size -= 1) {
    const suffix = recalled.slice(recalled.length - size)
    if (suffix.every((entry, index) => entry.snapshot.text === current[index]?.text)) {
      matched = size
      break
    }
  }
  for (let index = matched; index < current.length; index += 1) {
    const snapshot = current[index]
    if (snapshot === undefined || snapshot.text.length === 0) continue
    if (recalled.at(-1)?.snapshot.text === snapshot.text) continue
    recalled.push({ snapshot, sourceSessionId: currentSessionId })
  }
  return recalled
}

/** Handle sent-message history keys for one conversation session. */
export function HistoryKeyHandler({ session, input, inputActions, paste }: HistoryKeyHandlerProps): JSX.Element | null {
  const sessionId = session.sessionId
  const navigatorRef = useRef<HistoryNavigator | null>(null)
  const searchRef = useRef<HistorySearchSession | null>(null)
  const recalledKeyRef = useRef<string | null>(null)
  const pendingSentRef = useRef<DraftSnapshot | null>(null)
  const lastLiveRef = useRef<DraftSnapshot | null>(null)
  const previousPhaseRef = useRef(input.phase)
  const globalRef = useRef<GlobalHistoryEntry[] | null>(null)
  const richBySessionRef = useRef<Map<string, DraftSnapshot[]> | null>(null)
  const [footer, setFooter] = useState<HistorySearchFooterData | null>(null)

  if (globalRef.current === null) globalRef.current = loadGlobalHistory()
  if (richBySessionRef.current === null) richBySessionRef.current = loadAllDraftHistories()
  if (!richBySessionRef.current.has(sessionId)) {
    richBySessionRef.current.set(sessionId, loadDraftsForSession(sessionId))
  }

  // Keep the latest pre-submit input-machine state. The submitting render can
  // already have an empty textarea, so capture before the phase transition.
  if (input.phase === 'plain' && (input.draft.length > 0 || input.occurrences.length > 0)) {
    lastLiveRef.current = draftSnapshotFromComposer(
      `local:${sessionId}:${input.draftRev}`,
      input.draft,
      input.occurrences,
      (id) => paste.payloadOf(id),
    )
  }
  if (previousPhaseRef.current === 'plain' && input.phase !== 'plain' && lastLiveRef.current !== null) {
    pendingSentRef.current = {
      ...lastLiveRef.current,
      id: `pending:${sessionId}:${Date.now()}`,
      createdAt: Math.floor(Date.now() / 1000),
    }
  }
  if (previousPhaseRef.current !== 'plain' && input.phase === 'plain' && input.draft.length > 0) {
    // Failed/aborted submits restore the draft; do not attach that capture to a
    // later unrelated durable row.
    pendingSentRef.current = null
  }
  previousPhaseRef.current = input.phase

  const windowSnapshots = useMemo(() => extractDraftSnapshots(session), [session])
  const enrichedWindow = enrichLatestMatchingSnapshot(windowSnapshots, pendingSentRef.current)
  const persistedForSession = richBySessionRef.current.get(sessionId) ?? []
  const currentSnapshots = mergeDraftHistory(persistedForSession, enrichedWindow.snapshots)
  const recallEntries = assembleRecallEntries(globalRef.current, richBySessionRef.current, sessionId, currentSnapshots)
  // occurrence keeps identical text as distinct navigation offsets (codex append-only).
  const keys = recallEntries.map((entry, index) => historyKey(entry.snapshot, index))
  const byKey = new Map(keys.map((key, index) => [key, recallEntries[index]] as const))

  if (navigatorRef.current === null) navigatorRef.current = new HistoryNavigator(keys)
  else navigatorRef.current.replaceHistory(keys)
  if (searchRef.current !== null && !navigatorRef.current.isSearching()) searchRef.current = null

  useEffect(() => {
    const previous = richBySessionRef.current?.get(sessionId) ?? []
    if (serializeDraftHistory(previous) === serializeDraftHistory(currentSnapshots)) return
    richBySessionRef.current?.set(sessionId, currentSnapshots)
    saveDraftHistory(sessionId, currentSnapshots)
    if (enrichedWindow.durableMatch) pendingSentRef.current = null
  }, [currentSnapshots, enrichedWindow.durableMatch, sessionId])

  useEffect(() => {
    const persisted = globalRef.current
    if (persisted === null) return
    const limit = resolveHistoryLimit(window.localStorage)
    const merged = appendNewGlobalEntries(
      persisted,
      sessionId,
      windowSnapshots.map((entry) => entry.text),
      Math.floor(Date.now() / 1000),
      limit,
    )
    if (equalGlobalEntries(persisted, merged)) return
    globalRef.current = merged
    saveGlobalHistory(merged)
  }, [sessionId, windowSnapshots])

  useEffect(() => {
    const navigator = navigatorRef.current
    if (navigator === null) return

    const restoreEntry = (key: string, textarea: HTMLTextAreaElement): boolean => {
      const entry = byKey.get(key)
      if (entry === undefined) return false
      recalledKeyRef.current = key
      void paste.restoreSnapshot(sessionId, entry.snapshot, entry.sourceSessionId)
      restoreCaretAtEnd(textarea, entry.snapshot.text)
      return true
    }

    const restoreOriginal = (search: HistorySearchSession, textarea: HTMLTextAreaElement): void => {
      recalledKeyRef.current = null
      void paste.restoreLocalSnapshot(sessionId, search.originalSnapshot, search.originalImageIds)
      restoreSelection(textarea, search.originalSelectionStart, search.originalSelectionEnd)
    }

    const onSearchKey = (event: KeyboardEvent, textarea: HTMLTextAreaElement): void => {
      const search = searchRef.current
      if (search === null) return
      const hasModifier = event.ctrlKey || event.metaKey || event.altKey
      const strictCtrl = event.ctrlKey && !event.metaKey && !event.altKey
      const applyResult = (result: HistorySearchResult): void => {
        if (result.type === 'found') {
          restoreEntry(result.text, textarea)
          syncSearchFooter(navigator, historyKeyText(result.text), setFooter)
        } else {
          syncSearchFooter(navigator, textarea.value, setFooter)
        }
      }
      const updateQuery = (query: string): void => {
        const result = navigator.updateSearchQuery(query)
        if (result.type === 'found') {
          restoreEntry(result.text, textarea)
          syncSearchFooter(navigator, historyKeyText(result.text), setFooter)
        } else {
          restoreOriginal(search, textarea)
          syncSearchFooter(navigator, search.originalSnapshot.text, setFooter)
        }
      }

      if (event.key === 'Escape' || strictCtrl && (event.key === 'c' || event.key === 'C')) {
        event.preventDefault()
        navigator.finishSearch()
        navigator.resetNavigation()
        searchRef.current = null
        setFooter(null)
        restoreOriginal(search, textarea)
        return
      }
      if (event.key === 'Enter' && !hasModifier) {
        event.preventDefault()
        if (navigator.searchMatchPosition() === null) return
        navigator.finishSearch()
        searchRef.current = null
        setFooter(null)
        restoreCaretAtEnd(textarea, textarea.value)
        return
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (!hasModifier && !event.shiftKey) {
          event.preventDefault()
          applyResult(navigator.stepSearch(event.key === 'ArrowDown' ? 'newer' : 'older'))
        }
        return
      }
      if (isReverseSearchPrevious(event) || isReverseSearchNext(event)) {
        event.preventDefault()
        applyResult(navigator.stepSearch(isReverseSearchNext(event) ? 'newer' : 'older'))
        return
      }
      if (!hasModifier && event.key === 'Backspace') {
        event.preventDefault()
        updateQuery(navigator.searchQueryTextOf().slice(0, -1))
        return
      }
      if (strictCtrl && (event.key === 'h' || event.key === 'H')) {
        event.preventDefault()
        updateQuery(navigator.searchQueryTextOf().slice(0, -1))
        return
      }
      if (strictCtrl && (event.key === 'u' || event.key === 'U')) {
        event.preventDefault()
        updateQuery('')
        return
      }
      if (!hasModifier && event.key.length === 1) {
        event.preventDefault()
        updateQuery(navigator.searchQueryTextOf() + event.key)
        return
      }
      if (!hasModifier) event.preventDefault()
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      if (!isDshComposerTextarea(event.target)) return
      const textarea = event.target
      if (textarea.disabled || textarea.readOnly) return

      if (navigator.isSearching()) {
        onSearchKey(event, textarea)
        return
      }

      if (isReverseSearchPrevious(event)) {
        event.preventDefault()
        searchRef.current = {
          originalSnapshot: draftSnapshotFromComposer(
            `search:${sessionId}:${Date.now()}`,
            textarea.value,
            input.occurrences,
            (id) => paste.payloadOf(id),
          ),
          originalImageIds: [...input.imageIds],
          originalSelectionStart: textarea.selectionStart ?? textarea.value.length,
          originalSelectionEnd: textarea.selectionEnd ?? textarea.value.length,
        }
        recalledKeyRef.current = null
        navigator.beginSearch()
        setFooter({ status: 'idle', query: '', matchPosition: null, matchCount: null, previewText: '' })
        return
      }

      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return

      const recalledKey = recalledKeyRef.current
      const expandedLiveDraft = input.occurrences.length === 0
        ? textarea.value
        : draftSnapshotFromComposer(
          `navigation:${sessionId}:${input.draftRev}`,
          textarea.value,
          input.occurrences,
          (id) => paste.payloadOf(id),
        ).text
      const stillRecalled = recalledKey !== null && historyKeyText(recalledKey) === expandedLiveDraft
      if (!stillRecalled) recalledKeyRef.current = null
      const navigatorDraft = stillRecalled ? recalledKey : textarea.value
      const visibleStart = textarea.selectionStart ?? textarea.value.length
      const visibleEnd = textarea.selectionEnd ?? textarea.value.length
      const atVisibleEnd = visibleStart === textarea.value.length && visibleEnd === textarea.value.length
      const result = navigator.navigate(event.key === 'ArrowUp' ? 'up' : 'down', {
        draft: navigatorDraft,
        selectionStart: stillRecalled && atVisibleEnd ? navigatorDraft.length : visibleStart,
        selectionEnd: stillRecalled && atVisibleEnd ? navigatorDraft.length : visibleEnd,
      })
      if (!result.handled) return

      event.preventDefault()
      if (result.text === '') {
        recalledKeyRef.current = null
        inputActions.setDraft('')
        restoreCaretAtEnd(textarea, '')
      } else {
        restoreEntry(result.text, textarea)
      }
    }

    // Bubble phase lets DSH's slash/reference menus consume the key first.
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [byKey, input, inputActions, paste, sessionId])

  if (footer === null) return null
  return <HistorySearchFooter data={footer} />
}

import { describe, expect, it } from 'vitest'
import { HistoryNavigator, normalizeHistoryEntries } from '../src/core/history-navigation.ts'

const caret = (draft: string, position = draft.length) => ({
  draft,
  selectionStart: position,
  selectionEnd: position,
})

describe('HistoryNavigator', () => {
  it('does not consume arrows when history is empty', () => {
    const history = new HistoryNavigator()
    expect(history.navigate('up', caret(''))).toEqual({ handled: false })
    expect(history.navigate('down', caret(''))).toEqual({ handled: false })
  })

  it('recalls newest first and then walks toward older entries', () => {
    const history = new HistoryNavigator(['first', 'second', 'third'])
    expect(history.navigate('up', caret(''))).toEqual({ handled: true, text: 'third' })
    expect(history.navigate('up', caret('third'))).toEqual({ handled: true, text: 'second' })
    expect(history.navigate('up', caret('second', 0))).toEqual({ handled: true, text: 'first' })
  })

  it('leaves ArrowUp to the textarea at the oldest boundary', () => {
    const history = new HistoryNavigator(['first'])
    expect(history.navigate('up', caret(''))).toEqual({ handled: true, text: 'first' })
    expect(history.navigate('up', caret('first'))).toEqual({ handled: false })
  })

  it('walks down toward newer entries and clears past the newest', () => {
    const history = new HistoryNavigator(['first', 'second'])
    expect(history.navigate('up', caret(''))).toEqual({ handled: true, text: 'second' })
    expect(history.navigate('up', caret('second'))).toEqual({ handled: true, text: 'first' })
    expect(history.navigate('down', caret('first'))).toEqual({ handled: true, text: 'second' })
    expect(history.navigate('down', caret('second'))).toEqual({ handled: true, text: '' })
    expect(history.navigate('down', caret(''))).toEqual({ handled: false })
  })

  it('does not hijack an ordinary non-empty draft', () => {
    const history = new HistoryNavigator(['sent'])
    expect(history.navigate('up', caret('work in progress'))).toEqual({ handled: false })
  })

  it('continues only for an unchanged recalled draft at a text boundary', () => {
    const history = new HistoryNavigator(['older', 'newer'])
    expect(history.navigate('up', caret(''))).toEqual({ handled: true, text: 'newer' })
    expect(history.navigate('up', caret('newer', 2))).toEqual({ handled: false })
    expect(history.navigate('up', caret('edited'))).toEqual({ handled: false })
    expect(history.navigate('up', caret('newer', 0))).toEqual({ handled: true, text: 'older' })
  })

  it('does not hijack a non-collapsed selection', () => {
    const history = new HistoryNavigator(['sent'])
    expect(history.navigate('up', {
      draft: '',
      selectionStart: 0,
      selectionEnd: 1,
    })).toEqual({ handled: false })
  })

  it('keeps traversal state when the projected history is unchanged', () => {
    const history = new HistoryNavigator(['older', 'newer'])
    expect(history.navigate('up', caret(''))).toEqual({ handled: true, text: 'newer' })
    history.replaceHistory(['older', 'newer'])
    expect(history.navigate('up', caret('newer'))).toEqual({ handled: true, text: 'older' })
  })

  it('resets traversal when a new submission changes projected history', () => {
    const history = new HistoryNavigator(['older', 'newer'])
    expect(history.navigate('up', caret(''))).toEqual({ handled: true, text: 'newer' })
    history.replaceHistory(['older', 'newer', 'latest'])
    expect(history.navigate('down', caret('newer'))).toEqual({ handled: false })
    expect(history.navigate('up', caret(''))).toEqual({ handled: true, text: 'latest' })
  })
})

describe('normalizeHistoryEntries', () => {
  it('drops empty rows and folds consecutive exact duplicates', () => {
    expect(normalizeHistoryEntries(['', 'same', 'same', 'other', 'same'])).toEqual([
      'same',
      'other',
      'same',
    ])
  })
})

describe('reverse history search', () => {
  it('opening a search never previews an entry until a query is typed', () => {
    const history = new HistoryNavigator(['remembered', 'other'])
    history.beginSearch()
    expect(history.isSearching()).toBe(true)
    expect(history.searchQueryTextOf()).toBe('')
    expect(history.updateSearchQuery('')).toEqual({ type: 'notFound' })
  })

  it('matches case-insensitively and previews the newest match first', () => {
    const history = new HistoryNavigator(['Build Rel', 'other', 'build rel'])
    history.beginSearch()
    expect(history.updateSearchQuery('rel')).toEqual({ type: 'found', text: 'build rel' })
  })

  it('steps older to older unique matches and stops at the boundary', () => {
    const history = new HistoryNavigator([
      'git status',
      'cargo test -p dsh-air',
      'git diff',
    ])
    history.beginSearch()
    expect(history.updateSearchQuery('git')).toEqual({ type: 'found', text: 'git diff' })
    expect(history.stepSearch('older')).toEqual({ type: 'found', text: 'git status' })
    expect(history.stepSearch('older')).toEqual({ type: 'boundary' })
    expect(history.stepSearch('older')).toEqual({ type: 'boundary' })
  })

  it('steps newer back to the newest match and stays there at the boundary', () => {
    const history = new HistoryNavigator(['git status', 'git diff'])
    history.beginSearch()
    expect(history.updateSearchQuery('git')).toEqual({ type: 'found', text: 'git diff' })
    history.stepSearch('older')
    expect(history.stepSearch('newer')).toEqual({ type: 'found', text: 'git diff' })
    expect(history.stepSearch('newer')).toEqual({ type: 'boundary' })
  })

  it('deduplicates matching entries within a search without mutating history', () => {
    const history = new HistoryNavigator(['git status', 'cargo test', 'git status', 'git diff'])
    history.beginSearch()
    expect(history.updateSearchQuery('git')).toEqual({ type: 'found', text: 'git diff' })
    expect(history.stepSearch('older')).toEqual({ type: 'found', text: 'git status' })
    expect(history.stepSearch('older')).toEqual({ type: 'boundary' })
    expect(history.stepSearch('newer')).toEqual({ type: 'found', text: 'git diff' })
    expect(history.history).toEqual(['git status', 'cargo test', 'git status', 'git diff'])
  })

  it('returns notFound when no entry matches, and recovers on a broadened query', () => {
    const history = new HistoryNavigator(['git status'])
    history.beginSearch()
    expect(history.updateSearchQuery('zzz')).toEqual({ type: 'notFound' })
    expect(history.updateSearchQuery('git')).toEqual({ type: 'found', text: 'git status' })
  })

  it('repointing at a match lets a later Up keep walking from it', () => {
    const history = new HistoryNavigator(['oldest', 'middle', 'newest'])
    history.beginSearch()
    expect(history.updateSearchQuery('newest')).toEqual({ type: 'found', text: 'newest' })
    expect(history.navigate('up', { draft: 'newest', selectionStart: 6, selectionEnd: 6 })).toEqual({
      handled: true,
      text: 'middle',
    })
  })

  it('finishing a search leaves the navigator ready for fresh search', () => {
    const history = new HistoryNavigator(['git status'])
    history.beginSearch()
    history.updateSearchQuery('git')
    history.finishSearch()
    expect(history.isSearching()).toBe(false)
    history.beginSearch()
    expect(history.updateSearchQuery('git')).toEqual({ type: 'found', text: 'git status' })
  })

  it('reports match position and count for the footer status bar', () => {
    const history = new HistoryNavigator([
      'git status',
      'cargo test -p dsh-air',
      'git diff',
    ])
    expect(history.searchMatchPosition()).toBeNull()
    expect(history.searchMatchCount()).toBeNull()

    history.beginSearch()
    // Idle: no query has been rebuilt yet.
    expect(history.searchMatchPosition()).toBeNull()
    expect(history.searchMatchCount()).toBe(0)

    expect(history.updateSearchQuery('git')).toEqual({ type: 'found', text: 'git diff' })
    expect(history.searchMatchCount()).toBe(2)
    expect(history.searchMatchPosition()).toBe(1)

    history.stepSearch('older')
    expect(history.searchMatchPosition()).toBe(2)

    history.stepSearch('older')
    // At the boundary the current match (position 2) is preserved.
    expect(history.searchMatchPosition()).toBe(2)
    expect(history.searchMatchCount()).toBe(2)

    history.stepSearch('newer')
    expect(history.searchMatchPosition()).toBe(1)
  })

  it('a query with no matches yields no position but still counts zero', () => {
    const history = new HistoryNavigator(['git status'])
    history.beginSearch()
    expect(history.updateSearchQuery('zzz')).toEqual({ type: 'notFound' })
    expect(history.searchMatchPosition()).toBeNull()
    expect(history.searchMatchCount()).toBe(0)
  })
})

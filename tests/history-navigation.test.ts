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

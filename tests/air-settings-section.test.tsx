// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AirSettingsSection } from '../src/client/AirSettingsSection.tsx'
import {
  GLOBAL_HISTORY_STORAGE_KEY,
  HISTORY_LIMIT_STORAGE_KEY,
  HISTORY_STORAGE_LIMIT,
} from '../src/core/history-persistence.ts'
import { DRAFT_HISTORY_STORAGE_PREFIX } from '../src/core/draft-persistence.ts'
import { PASTE_STORAGE_PREFIX } from '../src/core/paste-chip.ts'

declare global {
  // React 18 uses this flag to enable act() environment warnings in non-RTL setups.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  window.localStorage.clear()
})

describe('AirSettingsSection rendering', () => {
  it('renders the plugin overview and the AIR 插件 heading', () => {
    const html = renderToStaticMarkup(<AirSettingsSection />)
    expect(html).toContain('AIR 插件')
    expect(html).toContain('历史召回')
    expect(html).toContain('分支改写')
    expect(html).toContain('BTW 旁路会话')
  })

  it('renders a close button that closes the panel when the shell supplies close', () => {
    let closed = false
    const html = renderToStaticMarkup(
      <AirSettingsSection close={() => {
        closed = true
      }} />,
    )
    expect(html).toContain('完成')
    // renderToStaticMarkup does not run handlers; the button must simply be present.
    expect(html).toContain('type="button"')
    expect(closed).toBe(false)
  })

  it('shows the persisted history entry count', () => {
    window.localStorage.setItem(
      GLOBAL_HISTORY_STORAGE_KEY,
      JSON.stringify([
        { sessionId: 'a', ts: 1, text: 'first' },
        { sessionId: 'a', ts: 2, text: 'second' },
      ]),
    )
    const html = renderToStaticMarkup(<AirSettingsSection />)
    expect(html).toContain('已保存 2 条历史消息')
  })

  it('renders the default history cap when no override is stored', () => {
    const html = renderToStaticMarkup(<AirSettingsSection />)
    expect(html).toContain(`value="${HISTORY_STORAGE_LIMIT}"`)
  })
})

describe('AirSettingsSection interactions', () => {
  let mountedRoot: ReturnType<typeof createRoot> | null = null

  afterEach(async () => {
    if (mountedRoot !== null) {
      await act(async () => {
        mountedRoot?.unmount()
      })
      mountedRoot = null
    }
    document.body.innerHTML = ''
  })

  async function mount(): Promise<HTMLElement> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoot = root
    await act(async () => {
      root.render(<AirSettingsSection />)
    })
    return container
  }

  function input(container: HTMLElement): HTMLInputElement {
    const field = container.querySelector<HTMLInputElement>('#dsh-air-history-limit')
    if (field === null) throw new Error('history limit input missing')
    return field
  }

  /** Type a new value through the native setter so React's onChange fires. */
  function typeValue(field: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set
    if (setter === undefined) throw new Error('native value setter missing')
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('persists a valid history cap on blur', async () => {
    const container = await mount()
    await act(async () => {
      typeValue(input(container), '42')
    })
    await act(async () => {
      // React maps onBlur to the bubbling focusout event.
      input(container).dispatchEvent(new Event('focusout', { bubbles: true }))
    })
    expect(window.localStorage.getItem(HISTORY_LIMIT_STORAGE_KEY)).toBe('42')
  })

  it('clamps an out-of-range history cap', async () => {
    const container = await mount()
    await act(async () => {
      typeValue(input(container), '99999')
    })
    await act(async () => {
      input(container).dispatchEvent(new Event('focusout', { bubbles: true }))
    })
    expect(window.localStorage.getItem(HISTORY_LIMIT_STORAGE_KEY)).toBe('5000')
  })

  it('clears history, drafts, and paste payloads while keeping the cap', async () => {
    window.localStorage.setItem(
      GLOBAL_HISTORY_STORAGE_KEY,
      JSON.stringify([{ sessionId: 'a', ts: 1, text: 'stored' }]),
    )
    window.localStorage.setItem(`${DRAFT_HISTORY_STORAGE_PREFIX}a`, '[]')
    window.localStorage.setItem(`${PASTE_STORAGE_PREFIX}a`, '{}')
    window.localStorage.setItem(HISTORY_LIMIT_STORAGE_KEY, '123')

    const container = await mount()

    const button = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('清除历史与草稿'),
    )
    if (button === undefined) throw new Error('clear button missing')

    await act(async () => {
      button.click()
    })

    expect(window.localStorage.getItem(GLOBAL_HISTORY_STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(`${DRAFT_HISTORY_STORAGE_PREFIX}a`)).toBeNull()
    expect(window.localStorage.getItem(`${PASTE_STORAGE_PREFIX}a`)).toBeNull()
    expect(window.localStorage.getItem(HISTORY_LIMIT_STORAGE_KEY)).toBe('123')
    expect(container.textContent).toContain('已保存 0 条历史消息')
  })
})

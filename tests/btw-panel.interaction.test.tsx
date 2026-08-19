// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BtwPanel } from '../src/client/BtwPanel.tsx'
import type { BtwConversationSurface } from '../src/client/BtwNativeConversation.tsx'
import { fakeUseSession, harness } from './helpers/btw-harness.ts'

declare global {
  // React 18 uses this flag to enable act() environment warnings in non-RTL setups.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

function dispatchKey(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

const nativeConversation: BtwConversationSurface = {
  render: (sessionId) => (
    <div data-native-conversation={sessionId}>
      <textarea aria-label="native child composer" />
      <button type="button">native action</button>
    </div>
  ),
}

describe('BtwPanel interactions', () => {
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

  async function mount(
    sessionId: SessionId,
    host: ConversationSnapshot,
    controller: ReturnType<typeof harness>['controller'],
  ) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoot = root
    await act(async () => {
      root.render(
        <BtwPanel
          sessionId={sessionId}
          useSession={fakeUseSession(host)}
          btw={controller}
          nativeConversation={nativeConversation}
        />,
      )
    })
    return { container, root }
  }

  it('does not switch the selected session for Ctrl+/ or its keyboard-layout fallback', async () => {
    const { controller, sessions, parent, getCurrent } = harness()
    await controller.start('parent' as SessionId)
    await mount('parent' as SessionId, parent.getSnapshot(), controller)
    vi.mocked(sessions.open).mockClear()

    await act(async () => {
      dispatchKey(document, { key: '/', ctrlKey: true })
      dispatchKey(document, { key: '7', ctrlKey: true })
    })

    expect(sessions.open).not.toHaveBeenCalled()
    expect(getCurrent()).toBe('parent')
  })

  it('docks the web layout while open and restores it after unmount', async () => {
    const { controller, parent } = harness()
    await controller.start('parent' as SessionId)
    await mount('parent' as SessionId, parent.getSnapshot(), controller)

    expect(document.body.hasAttribute('data-dsh-air-btw-open')).toBe(true)
    expect(document.body.style.getPropertyValue('--dsh-air-btw-width')).toBe('440px')
    expect(document.getElementById('dsh-air-btw-panel-layout')).not.toBeNull()

    await act(async () => {
      mountedRoot?.unmount()
    })
    mountedRoot = null

    expect(document.body.hasAttribute('data-dsh-air-btw-open')).toBe(false)
    expect(document.body.style.getPropertyValue('--dsh-air-btw-width')).toBe('')
    expect(document.getElementById('dsh-air-btw-panel-layout')).toBeNull()
  })

  it('closes BTW only from the explicit top-right close button', async () => {
    const { controller, workspaces, parent } = harness()
    await controller.start('parent' as SessionId)
    const { container } = await mount('parent' as SessionId, parent.getSnapshot(), controller)
    const close = container.querySelector<HTMLButtonElement>('[aria-label="关闭 BTW"]')
    expect(close).not.toBeNull()
    expect(close?.style.position).toBe('absolute')
    expect(close?.style.top).toBe('calc(var(--dsh-title-bar-strip, 0px) + 8px)')
    expect(close?.style.right).toBe('8px')

    await act(async () => {
      close?.click()
    })

    await vi.waitFor(() => {
      expect(workspaces.archiveSession).toHaveBeenCalledWith('child')
    })
    expect(controller.getSnapshot().phase).toBe('closed')
  })

  it('leaves native composer keyboard events to the embedded host UI', async () => {
    const { controller, workspaces, parent } = harness()
    await controller.start('parent' as SessionId)
    const { container } = await mount('parent' as SessionId, parent.getSnapshot(), controller)
    const textarea = container.querySelector<HTMLTextAreaElement>('[aria-label="native child composer"]')
    expect(textarea).not.toBeNull()

    await act(async () => {
      if (textarea === null) return
      textarea.focus()
      dispatchKey(textarea, { key: 'Escape' })
      dispatchKey(textarea, { key: 'c', ctrlKey: true })
    })

    expect(workspaces.archiveSession).not.toHaveBeenCalled()
    expect(controller.getSnapshot().phase).not.toBe('closed')
  })

  it('does not mount another drawer inside the child session surface', async () => {
    const { controller, child } = harness()
    await controller.start('parent' as SessionId)
    const { container } = await mount('child' as SessionId, child.getSnapshot(), controller)

    expect(container.querySelector('[data-dsh-air-btw-panel]')).toBeNull()
  })
})

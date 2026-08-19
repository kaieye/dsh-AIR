import { renderToStaticMarkup } from 'react-dom/server'
import type { ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { BtwPanel } from '../src/client/BtwPanel.tsx'
import type { BtwConversationSurface } from '../src/client/BtwNativeConversation.tsx'
import { fakeUseSession, harness, snapshot } from './helpers/btw-harness.ts'

function nativeSurface(label = 'native child UI'): BtwConversationSurface {
  return {
    render: vi.fn((sessionId: SessionId) => (
      <div data-native-conversation={sessionId}>{label}</div>
    )),
  }
}

function renderPanel(
  sessionId: SessionId,
  host: ConversationSnapshot,
  controller: ReturnType<typeof harness>['controller'],
  nativeConversation = nativeSurface(),
): string {
  return renderToStaticMarkup(
    <BtwPanel
      sessionId={sessionId}
      useSession={fakeUseSession(host)}
      btw={controller}
      nativeConversation={nativeConversation}
    />,
  )
}

describe('BtwPanel rendering', () => {
  it('embeds the host-native conversation surface instead of the custom BTW transcript and composer', async () => {
    const { controller } = harness()
    await controller.start('parent' as SessionId)

    const html = renderPanel('parent' as SessionId, snapshot('parent'), controller)

    expect(html).toContain('data-native-conversation="child"')
    expect(html).toContain('native child UI')
    expect(html).not.toContain('aria-label="BTW question"')
    expect(html).not.toContain('打开分支')
    expect(html).not.toContain('返回主会话')
    expect(html).not.toContain('Ctrl+/')
  })

  it('renders nothing while BTW is closed', () => {
    const { controller } = harness()

    expect(renderPanel('parent' as SessionId, snapshot('parent'), controller)).toBe('')
  })

  it('keeps the shell on the parent with no tab chrome and only a top-right close button', async () => {
    const { controller } = harness()
    await controller.start('parent' as SessionId)

    const parentHtml = renderPanel('parent' as SessionId, snapshot('parent'), controller)
    const childHtml = renderPanel('child' as SessionId, snapshot('child'), controller)

    expect(parentHtml).toContain('aria-label="BTW side conversation"')
    expect(parentHtml).not.toContain('role="tablist"')
    expect(parentHtml).not.toContain('role="tab"')
    expect(parentHtml).not.toContain('role="tabpanel"')
    expect(parentHtml).not.toContain('data-dsh-air-btw-tab')
    expect(parentHtml).toContain('data-dsh-air-btw-close=""')
    expect(parentHtml).toContain('aria-label="关闭 BTW"')
    expect(parentHtml).toContain('position:absolute')
    expect(childHtml).toBe('')
  })

  it('shows a minimal provisioning notice until the native child is available', async () => {
    const { controller, sessions } = harness()
    let resolveFork!: (id: SessionId) => void
    vi.mocked(sessions.fork).mockImplementationOnce(() => new Promise((resolve) => {
      resolveFork = resolve
    }))

    const starting = controller.start('parent' as SessionId)
    const html = renderPanel('parent' as SessionId, snapshot('parent'), controller)

    expect(html).toContain('正在从主会话创建 BTW 分支')
    expect(html).not.toContain('data-native-conversation')

    resolveFork('child' as SessionId)
    await starting
  })

  it('uses host design tokens instead of invented dark fallbacks', async () => {
    const { controller } = harness()
    await controller.start('parent' as SessionId)

    const html = renderPanel('parent' as SessionId, snapshot('parent'), controller)

    expect(html).toContain('var(--dsw-alias-bg-base')
    expect(html).toContain('var(--dsw-alias-border-l2)')
    expect(html).not.toContain('dsw-alias-background')
    expect(html).not.toContain('dsw-alias-border-secondary')
    expect(html).not.toContain('#1f2025')
  })

  it('surfaces the parent condition and child lifecycle without replacing native conversation UI', async () => {
    const parent = snapshot('parent', {
      nodes: [{ kind: 'assistant', seq: 1 } as never],
      turnEnds: new Map([[1, 1]]),
      pending: [{ kind: 'approval' } as never],
    })
    const { controller } = harness({ parent, child: snapshot('child', { blank: true, composerPhase: 'blank' }) })
    await controller.start('parent' as SessionId)

    const html = renderPanel('parent' as SessionId, parent, controller)

    expect(html).toContain('data-dsh-air-btw-header=""')
    expect(html).toContain('data-dsh-air-btw-context=""')
    expect(html).toContain('主会话等待审批')
    expect(html).toContain('主会话待处理 1 项')
    expect(html).toContain('data-dsh-air-btw-child-status=""')
    expect(html).toContain('BTW 空闲')
  })
})

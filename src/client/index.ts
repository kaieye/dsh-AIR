import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { AirSettingsSection } from './AirSettingsSection.tsx'
import { BtwController } from './BtwController.ts'
import { createBtwConversationSurface } from './BtwNativeConversation.tsx'
import { BtwPanel } from './BtwPanel.tsx'
import { createBtwTrigger } from './BtwTrigger.ts'
import { HistoryKeyHandler } from './HistoryKeyHandler.tsx'
import { ForkEditController } from './ForkEditController.ts'
import { ForkEditEnhancer } from './ForkEditEnhancer.tsx'
import { LargePasteDock } from './RichComposerTools.tsx'
import { LargePasteController } from './LargePasteController.ts'

/** Wait until the services used by the history and BTW contributions are available. */
export const inject = ['slots', 'sessions', 'workspaces', 'inputTriggers', 'conversation']

/**
 * Attach history navigation and the web BTW side conversation to each DSH
 * session. BTW is intentionally one controller per plugin instance so only one
 * side conversation can be active at a time; this also prevents multiple
 * drawers from competing for the same composer.
 */
export function apply(ctx: Context): void {
  const btw = new BtwController()
  const nativeConversation = createBtwConversationSurface(ctx)
  const paste = new LargePasteController(ctx)
  const forkEdit = new ForkEditController(ctx, paste)
  btw.bind(ctx)
  ctx.effect(() => () => btw.dispose(), 'dsh-air: btw controller')

  try {
    const disposePasteSource = ctx.inputTriggers.registerSource(paste.registerSource())
    ctx.effect(() => disposePasteSource, 'dsh-air: large paste source')
  } catch (error) {
    console.error('[dsh-air] large paste source registration failed', error)
  }

  try {
    const disposeTrigger = ctx.inputTriggers.registerSource(createBtwTrigger(btw))
    ctx.effect(() => disposeTrigger, 'dsh-air: btw slash source')
  } catch (error) {
    console.error('[dsh-air] BTW trigger registration failed', error)
  }

  try {
    ctx.slots.inject('conversation.input.dock', () => {
      try {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-air-btw-panel',
          order: -10_000,
          inject: () => ({ btw, nativeConversation }),
        }, BtwPanel)
      } catch (error) {
        console.error('[dsh-air] BTW panel registration failed', error)
        return () => {}
      }
    })

    ctx.slots.inject('conversation.input.dock', () => {
      try {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-air-large-paste-dock',
          order: 9_900,
          inject: () => ({ paste }),
        }, LargePasteDock)
      } catch (error) {
        console.error('[dsh-air] large paste dock registration failed', error)
        return () => {}
      }
    })

    ctx.slots.inject('conversation.input.dock', () => {
      try {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-air-fork-edit-enhancer',
          order: 9_950,
          inject: () => ({ forkEdit }),
        }, ForkEditEnhancer)
      } catch (error) {
        console.error('[dsh-air] fork edit enhancer registration failed', error)
        return () => {}
      }
    })

    ctx.slots.inject('conversation.input.dock', () => {
      try {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-air-history-navigation',
          order: 10_000,
          inject: () => ({ paste }),
        }, HistoryKeyHandler)
      } catch (error) {
        console.error('[dsh-air] history slot registration failed', error)
        return () => {}
      }
    })

    // Settings page entry: registered into the settings shell's section list
    // under the nav label "AIR 插件". The slot is declared at runtime by the
    // settings surface; slots.inject waits for that declaration.
    ctx.slots.inject('settings.section', () => {
      try {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-air',
          order: 100,
          label: 'AIR 插件',
        }, AirSettingsSection)
      } catch (error) {
        console.error('[dsh-air] settings section registration failed', error)
        return () => {}
      }
    })
  } catch (error) {
    // Failure in this optional plugin must not prevent DSH from starting.
    console.error('[dsh-air] initialization failed', error)
  }
}

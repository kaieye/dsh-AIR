import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { HistoryKeyHandler } from './HistoryKeyHandler.ts'

/** Wait until the required DSH service is available. */
export const inject = ['slots']

/** Attach history-key handling to each conversation session. */
export function apply(ctx: Context): void {
  try {
    ctx.slots.inject('conversation.input.dock', () => {
      try {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-air-history-navigation',
          order: 10_000,
        }, HistoryKeyHandler)
      } catch (error) {
        console.error('[dsh-air] slot registration failed', error)
        return () => {}
      }
    })
  } catch (error) {
    // Failure in this optional plugin must not prevent DSH from starting.
    console.error('[dsh-air] initialization failed', error)
  }
}

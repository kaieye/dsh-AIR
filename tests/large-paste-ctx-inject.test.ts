// @vitest-environment node
// Regression: ArrowUp/ArrowDown history recall failed in the real DSH app
// because LargePasteController accesses `ctx.conversation` as a property, and
// the plugin's `inject` list did not declare `conversation`. Cordis only
// resolves `ctx.<service>` for services the plugin's own fiber injected; a
// sibling plugin fiber (ui-conversation) providing `conversation` is NOT
// visible to a plain property read — it throws "cannot get property
// 'conversation' without inject". Unit tests mocked `ctx.conversation`
// directly, so they never reproduced the real resolution path.
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { inject as dshAirInject } from '../src/client/index.ts'
import { LargePasteController } from '../src/client/LargePasteController.ts'
import type { DraftSnapshot } from '../src/core/draft-snapshot.ts'

const kScope = Symbol('dsh.client.scope')

function scopedContext(app: Context): Context {
  const scoped = app.extend()
  ;(scoped as unknown as Record<symbol, unknown>)[kScope] = 's1'
  return scoped
}

const draft: string[] = []

function makeInputShell() {
  return {
    state: {
      getSnapshot: () => ({ draft: draft[0] ?? '', draftRev: 0, occurrences: [], imageIds: [] }),
      subscribe: () => () => {},
    },
    setDraft: (text: string) => { draft[0] = text },
    addImages: () => true,
    removeImage: () => {},
    notify: () => {},
  }
}

/**
 * Rebuild the real DSH arrangement: the core services are provided by sibling
 * plugin fibers (runtime/ui-conversation), exactly like the live app. In
 * particular `conversation` lives in ANOTHER fiber, so it resolves from the
 * dsh-air plugin fiber ONLY when dsh-air declares it in `inject`.
 */
async function makeApp(): Promise<Context> {
  const app = new Context()
  app.reflect.provide('slots', {})
  app.reflect.provide('sessions', {
    scope: (id: string) => (id === 's1' ? scopedContext(app) : undefined),
  })
  app.reflect.provide('workspaces', {})
  app.reflect.provide('inputTriggers', {})
  // ui-conversation provides `conversation` from its own fiber, NOT the root.
  const conversationFiber = app.registry.plugin({
    inject: ['slots'],
    apply(ctx: Context) {
      ctx.reflect.provide('conversation', {
        input: {
          for: (actx: unknown) =>
            (actx as Record<symbol, unknown>)[kScope] === 's1' ? makeInputShell() : undefined,
        },
      })
    },
  })
  await conversationFiber.await()
  return app
}

function snapshot(text: string): DraftSnapshot {
  return { version: 1, id: 'node:1', text, attachments: [], mentions: [], pastes: [] }
}

describe('dsh-air conversation service injection', () => {
  it('declares `conversation` in the client inject list', () => {
    expect(dshAirInject).toContain('conversation')
  })

  it('resolves `ctx.conversation` from the plugin fiber with the real inject list', async () => {
    const app = await makeApp()

    let outcome = ''
    const fiber = app.registry.plugin({
      inject: dshAirInject,
      apply(ctx: Context) {
        try {
          // Property access — this is what threw before the fix.
          const conversation = ctx.conversation as { input: { for(c: unknown): unknown } }
          const shell = conversation.input.for(scopedContext(ctx))
          outcome = shell === undefined ? 'missing' : 'ok'
        } catch (error) {
          outcome = `threw: ${(error as Error).message}`
        }
      },
    })
    await fiber.await()

    expect(outcome).toBe('ok')
  })

  it('restoreSnapshot writes the recalled draft through a real cordis ctx', async () => {
    const app = await makeApp()
    draft.length = 0

    let ok: boolean | undefined
    const fiber = app.registry.plugin({
      inject: dshAirInject,
      apply(ctx: Context) {
        const paste = new LargePasteController(ctx)
        ok = undefined
        void paste.restoreSnapshot('s1' as SessionId, snapshot('third'), 's1' as SessionId)
          .then((result) => { ok = result })
          .catch(() => { ok = false })
      },
    })
    await fiber.await()
    // The restore is async; let the microtask land.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ok).toBe(true)
    expect(draft[0]).toBe('third')
  })
})

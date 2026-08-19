import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationSnapshot,
  ISessions,
  SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  HostObservable,
  SessionMaybeProvideInfo,
  SessionProvideInfo,
  SlotRendererHost,
  StoredEntry,
} from '@deepseek-ai/dsh-client-ui-slots'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import type { ReactNode } from 'react'
import { projectBtwNativeSnapshot, projectBtwQueue } from '../core/btw-native-snapshot.ts'

const PANEL_ENTRY_ID = 'dsh-air-btw-panel'
const ROOT_REGISTRANT = 'dsh-air:btw-native-conversation'
const ROOT_SPEC = { kind: 'single', scope: 'root' } as const

interface RuntimeSlotRegistry {
  hostFace(): SlotRendererHost
}

interface RuntimeSessions extends ISessions {
  provideInfo(id: SessionId): SessionProvideInfo | undefined
}

interface SyntheticRootProps {
  readonly renderSlot: (key: 'conversation', owner: object) => ReactNode
}

function SyntheticConversationRoot({ renderSlot }: SyntheticRootProps): ReactNode {
  return renderSlot('conversation', {})
}

class ProjectedObservable<T> implements HostObservable<T> {
  private sourceSnapshot: unknown
  private projectedSnapshot: T | undefined

  constructor(
    private readonly source: HostObservable<unknown>,
    private readonly project: (snapshot: unknown) => T,
  ) {}

  getSnapshot = (): T => {
    const snapshot = this.source.getSnapshot()
    if (snapshot !== this.sourceSnapshot || this.projectedSnapshot === undefined) {
      this.sourceSnapshot = snapshot
      this.projectedSnapshot = this.project(snapshot)
    }
    return this.projectedSnapshot
  }

  subscribe = (listener: () => void): (() => void) => this.source.subscribe(listener)
}

function projectConversationSnapshot(snapshot: unknown): ConversationSnapshot {
  return projectBtwNativeSnapshot(snapshot as ConversationSnapshot)
}

function projectInputSnapshot(snapshot: unknown): unknown {
  if (typeof snapshot !== 'object' || snapshot === null || !Array.isArray((snapshot as { queue?: unknown }).queue)) {
    return snapshot
  }
  const input = snapshot as { queue: ConversationSnapshot['queue'] }
  const queue = projectBtwQueue(input.queue)
  return queue === input.queue ? snapshot : { ...input, queue }
}

function forcedProvideInfo(
  sessions: RuntimeSessions,
  base: SlotRendererHost['sessions']['provideInfo'],
  childId: SessionId,
): HostObservable<SessionMaybeProvideInfo> {
  let sourceInfo: SessionProvideInfo | undefined
  let projectedInfo: SessionProvideInfo | undefined

  return {
    getSnapshot(): SessionProvideInfo {
      const info = sessions.provideInfo(childId)
      if (info === undefined) {
        throw new Error(`BTW child session "${childId}" has no native conversation provide bundle`)
      }
      if (info === sourceInfo && projectedInfo !== undefined) return projectedInfo

      sourceInfo = info
      const hooks = { ...info.hooks }
      const session = hooks.session
      if (session !== undefined) {
        hooks.session = new ProjectedObservable(session, projectConversationSnapshot)
      }
      const input = hooks.input
      if (input !== undefined) {
        hooks.input = new ProjectedObservable(input, projectInputSnapshot)
      }
      projectedInfo = { ...info, hooks }
      return projectedInfo
    },
    subscribe(listener): () => void {
      return base.subscribe(listener)
    },
  }
}

function withoutNestedPanel(key: string, entries: readonly StoredEntry[]): readonly StoredEntry[] {
  if (key !== 'conversation.input.dock') return entries
  return entries.filter((entry) => entry.options.id !== PANEL_ENTRY_ID)
}

function nativeHostFor(
  base: SlotRendererHost,
  sessions: RuntimeSessions,
  childId: SessionId,
): SlotRendererHost {
  const conversationSpec = base.specOf('conversation')
  if (conversationSpec === undefined) {
    throw new Error("BTW native conversation cannot render before the Host declares the 'conversation' slot")
  }

  const rootEntry: StoredEntry = {
    component: SyntheticConversationRoot,
    options: {},
    children: { conversation: conversationSpec },
    registrant: ROOT_REGISTRANT,
  }

  return {
    subscribe(key, listener): () => void {
      return key === 'root' ? () => {} : base.subscribe(key, listener)
    },
    getVersion(key): number {
      return key === 'root' ? 0 : base.getVersion(key)
    },
    entriesOf(key): readonly StoredEntry[] {
      return key === 'root' ? [rootEntry] : withoutNestedPanel(key, base.entriesOf(key))
    },
    entriesOfSlot(key): readonly StoredEntry[] {
      return key === 'root' ? [rootEntry] : withoutNestedPanel(key, base.entriesOfSlot(key))
    },
    reportEntryError(key, entry, error, info): void {
      if (entry === rootEntry) {
        console.error('[dsh-air] BTW native conversation root crashed', error)
        return
      }
      base.reportEntryError(key, entry, error, info)
    },
    specOf(key) {
      return key === 'root' ? ROOT_SPEC : base.specOf(key)
    },
    isLive(entry): boolean {
      return entry === rootEntry || base.isLive(entry)
    },
    storeOf(entry, scopeKey) {
      return entry === rootEntry ? undefined : base.storeOf(entry, scopeKey)
    },
    sessions: {
      list: base.sessions.list,
      provideInfo: forcedProvideInfo(sessions, base.sessions.provideInfo, childId),
    },
    workspaces: base.workspaces,
    get locale() {
      return base.locale
    },
  }
}

export interface BtwConversationSurface {
  /** Render the Host's real conversation slot tree bound to the BTW child. */
  render(sessionId: SessionId): ReactNode
}

/**
 * Build an embedded native conversation renderer. The delegated host keeps
 * the global selected session untouched while its SessionProvider is pinned
 * to the supplied BTW child.
 */
export function createBtwConversationSurface(ctx: Context): BtwConversationSurface {
  const base = (ctx.slots as unknown as RuntimeSlotRegistry).hostFace()
  const sessions = ctx.sessions as unknown as RuntimeSessions
  const renderer = createSlotRenderer()
  let cachedId: SessionId | null = null
  let cachedHost: SlotRendererHost | null = null

  return {
    render(sessionId): ReactNode {
      if (cachedHost === null || cachedId !== sessionId) {
        cachedId = sessionId
        cachedHost = nativeHostFor(base, sessions, sessionId)
      }
      return renderer.renderRoot(cachedHost, {})
    },
  }
}

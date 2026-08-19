import type {
  ClientSessionContext,
  InputTriggerCandidate,
  InputTriggerPick,
  InputTriggerSource,
  PickOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { BTW_IN_SIDE_UNAVAILABLE } from '../core/btw-messages.ts'
import { BtwController } from './BtwController.ts'

export { BTW_IN_SIDE_UNAVAILABLE }

const COMMANDS = ['/btw', '/side'] as const
const CANDIDATES: readonly InputTriggerCandidate[] = [
  {
    name: 'btw',
    description: 'Open a temporary side conversation without leaving the main thread.',
    hint: 'Ask a BTW question',
  },
  {
    name: 'side',
    description: 'Open a temporary side conversation without leaving the main thread.',
    hint: 'Ask a side question',
  },
]

function commandFor(line: string): string | undefined {
  return COMMANDS.find((command) => line === command || line.startsWith(`${command} `))
}

function claimFor(manager: BtwController, session: ClientSessionContext, command: string) {
  return {
    token: command,
    hint: command === '/side' ? 'Ask a side question' : 'Ask a BTW question',
    submit: async (args: string): Promise<{ kind: 'success' | 'error'; text?: string }> => {
      if (manager.isChildSession(session.sessionId)) {
        // Mirrors codex's unavailable-in-side-conversation guard: the child is
        // itself a side conversation, so starting another one is rejected with
        // a hint to return to the main thread first.
        return { kind: 'error', text: BTW_IN_SIDE_UNAVAILABLE }
      }
      try {
        await manager.invoke(session.sessionId, args.trim())
        return { kind: 'success' }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/** Register the browser's `/btw` and `/side` slash aliases. */
export function createBtwTrigger(manager: BtwController): InputTriggerSource {
  return {
    trigger: '/',
    name: 'btw',
    order: -100,
    async candidates(session, req): Promise<readonly InputTriggerCandidate[]> {
      if (req.signal.aborted) return []
      // Side/Btw are hidden from the child menu, while exact submission still
      // resolves below and produces the explicit "already open" error.
      if (manager.isChildSession(session.sessionId)) return []
      const query = req.query.toLowerCase()
      return CANDIDATES.filter((candidate) => candidate.name.startsWith(query))
    },
    onPick(pick: InputTriggerPick): PickOutcome {
      const candidate = CANDIDATES.find((item) => item.name === pick.candidate.name)
      if (candidate === undefined) return undefined
      return { claim: claimFor(manager, pick.session, `/${candidate.name}`) }
    },
    matchSpace(session, token): PickOutcome {
      const command = COMMANDS.find((item) => token === item)
      return command === undefined ? undefined : { claim: claimFor(manager, session, command) }
    },
    async matchEnter(session, line, signal): Promise<PickOutcome> {
      if (signal.aborted) return undefined
      const command = commandFor(line)
      if (command === undefined) return undefined
      return { claim: claimFor(manager, session, command) }
    },
  }
}

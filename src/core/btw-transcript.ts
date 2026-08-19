import type {
  AssistantBlock,
  ConversationNode,
  ConversationSnapshot,
  PartialAssistant,
  RunningToolCall,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'

/** A locally recorded question; inherited user nodes are intentionally absent. */
export interface BtwTurnRecord {
  readonly id: number
  readonly question: string
  /** Highest child seq observed immediately before this question was sent. */
  readonly afterSeq: number
  readonly status: 'sending' | 'sent' | 'error'
  readonly error?: string
}

export type BtwTranscriptEntry =
  | { readonly kind: 'user'; readonly id: number; readonly text: string; readonly status: BtwTurnRecord['status']; readonly error?: string }
  | { readonly kind: 'assistant'; readonly id: string; readonly text: string; readonly interrupted?: true }
  | { readonly kind: 'reasoning'; readonly id: string; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string; readonly text?: string; readonly error: boolean; readonly running?: boolean }
  | { readonly kind: 'notice'; readonly id: string; readonly text: string; readonly tone: 'error' | 'muted' }

export interface BtwTranscriptInput {
  readonly baselineSeq: number
  readonly nodes: readonly ConversationNode[]
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
  readonly turns: readonly BtwTurnRecord[]
}

/** Extract plain text from DSH content blocks without leaking non-text objects into the UI. */
function textOfBlocks(blocks: readonly unknown[]): string {
  return blocks
    .flatMap((block) => {
      if (typeof block !== 'object' || block === null) return []
      const text = (block as { type?: unknown; text?: unknown }).text
      return typeof text === 'string' ? [text] : []
    })
    .join('')
}

function maxSeq(nodes: readonly ConversationNode[], fallback: number): number {
  let max = fallback
  for (const node of nodes) {
    if (Number.isFinite(node.seq)) max = Math.max(max, node.seq)
  }
  return max
}

function assistantEntries(blocks: readonly AssistantBlock[], idPrefix: string, interrupted = false): BtwTranscriptEntry[] {
  const entries: BtwTranscriptEntry[] = []
  let text = ''
  let reasoning = ''
  for (const block of blocks) {
    if (block.kind === 'text') text += block.text
    else if (block.kind === 'reasoning') reasoning += block.text
    else if (block.kind === 'tool-call') {
      entries.push({ kind: 'tool', id: `${idPrefix}:call:${block.callId}`, name: block.name, text: block.argsRaw, error: false, running: true })
    }
  }
  if (reasoning.trim() !== '') entries.push({ kind: 'reasoning', id: `${idPrefix}:reasoning`, text: reasoning })
  if (text.trim() !== '' || interrupted) {
    entries.push({
      kind: 'assistant',
      id: `${idPrefix}:text`,
      text,
      ...(interrupted ? { interrupted: true } : {}),
    })
  }
  return entries
}

function toolEntry(node: ToolResultNode): BtwTranscriptEntry {
  const name = node.call?.name ?? node.callId
  const text = textOfBlocks(node.content)
  return {
    kind: 'tool',
    id: `node:${String(node.seq)}:tool:${node.callId}`,
    name,
    ...(text === '' ? {} : { text }),
    error: node.isError,
  }
}

function nodeEntries(node: ConversationNode): BtwTranscriptEntry[] {
  switch (node.kind) {
    case 'assistant':
      return assistantEntries(node.blocks, `node:${String(node.seq)}`, node.interrupted === true)
    case 'tool-result':
      return [toolEntry(node)]
    case 'turn-error':
      return [{ kind: 'notice', id: `node:${String(node.seq)}:error`, text: node.message, tone: 'error' }]
    case 'turn-max-tokens':
      return [{ kind: 'notice', id: `node:${String(node.seq)}:max-tokens`, text: 'The side response reached the output limit.', tone: 'muted' }]
    case 'unknown':
      return [{ kind: 'notice', id: `node:${String(node.seq)}:unknown`, text: `Unsupported event: ${node.type}`, tone: 'muted' }]
    default:
      // User/context/command/compaction nodes are hidden or are internal
      // implementation details in a BTW drawer. The local turn records are the
      // only user messages shown, which also hides the boundary envelope.
      return []
  }
}

/**
 * Project a fork snapshot into the compact transcript used by the web panel.
 * Inherited history is cut at `baselineSeq`; the boundary prompt is hidden by
 * never rendering child user/context nodes.
 */
export function projectBtwTranscript(input: BtwTranscriptInput): readonly BtwTranscriptEntry[] {
  const nodes = input.nodes
    .filter((node) => node.seq > input.baselineSeq)
    .slice()
    .sort((a, b) => a.seq - b.seq)
  const endSeq = maxSeq(input.nodes, input.baselineSeq)
  const entries: BtwTranscriptEntry[] = []

  for (let index = 0; index < input.turns.length; index += 1) {
    const turn = input.turns[index]
    entries.push({ kind: 'user', id: turn.id, text: turn.question, status: turn.status, ...(turn.error === undefined ? {} : { error: turn.error }) })
    const nextBoundary = input.turns[index + 1]?.afterSeq ?? endSeq
    for (const node of nodes) {
      if (node.seq <= turn.afterSeq || node.seq > nextBoundary) continue
      entries.push(...nodeEntries(node))
    }
  }

  // A child can publish assistant output before the corresponding user event
  // arrives in the mirror. Keep any such nodes visible instead of waiting for
  // durable user-event ordering.
  if (input.turns.length === 0) {
    for (const node of nodes) entries.push(...nodeEntries(node))
  }

  if (input.partial !== null) {
    entries.push(...assistantEntries(input.partial.blocks, `partial:${input.partial.turn}:${input.partial.step}`))
  }
  for (const call of input.runningCalls) {
    const alreadyShown = entries.some((entry) => entry.kind === 'tool' && entry.id.includes(call.callId))
    if (!alreadyShown) entries.push({ kind: 'tool', id: `running:${call.callId}`, name: call.name, text: call.argsRaw, error: false, running: true })
  }
  return entries
}

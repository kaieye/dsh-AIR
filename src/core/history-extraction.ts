import { normalizeHistoryEntries } from './history-navigation.ts'

/** Minimal structural contract needed from a DSH ConversationSnapshot. */
export interface ConversationHistorySource {
  readonly nodes: readonly unknown[]
  readonly queue?: readonly unknown[]
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

/**
 * Restore text only when every block is textual.
 *
 * DSH's public input action can restore a draft string, but cannot recreate
 * historical image attachments or other rich blocks. Skipping mixed content
 * avoids presenting a lossy history entry as if it were complete.
 */
function plainTextContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  let text = ''
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return null
    text += block.text
  }
  return text
}

function nodeText(node: unknown): string | null {
  if (!isRecord(node) || typeof node.kind !== 'string') return null

  if (node.kind === 'user' || node.kind === 'steering') {
    return plainTextContent(node.content)
  }

  if (node.kind === 'command' && typeof node.name === 'string' && node.name.length > 0) {
    return `/${node.name}${typeof node.args === 'string' ? node.args : ''}`
  }

  return null
}

function queuedText(row: unknown): string | null {
  if (!isRecord(row)) return null
  if (typeof row.text === 'string') return row.text
  // In DSH, an explicit null means the queued message contains non-text blocks.
  if (row.text === null) return null
  return plainTextContent(row.content)
}

/**
 * Project recallable user submissions in send order.
 *
 * Durable user/steering nodes and slash commands come first; transient queue
 * rows are appended in their authoritative FIFO order. Consecutive duplicates
 * are folded so a queue-to-durable handoff does not create a double entry.
 */
export function extractHistoryEntries(source: ConversationHistorySource): string[] {
  const entries: string[] = []

  for (const node of source.nodes) {
    const text = nodeText(node)
    if (text !== null) entries.push(text)
  }

  for (const row of source.queue ?? []) {
    const text = queuedText(row)
    if (text !== null) entries.push(text)
  }

  return normalizeHistoryEntries(entries)
}

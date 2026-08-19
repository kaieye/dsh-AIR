import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { BTW_BOUNDARY_PROMPT } from './btw-boundary.ts'

const QUESTION_MARKER = '\n\nUser question after the boundary:\n'

/** Return the user-visible question from a first BTW prompt envelope. */
export function visibleBtwQuestion(text: string): string | null {
  const boundaryAt = text.indexOf(BTW_BOUNDARY_PROMPT)
  if (boundaryAt < 0) return null
  const questionAt = boundaryAt + BTW_BOUNDARY_PROMPT.length
  if (!text.startsWith(QUESTION_MARKER, questionAt)) return null
  return text.slice(questionAt + QUESTION_MARKER.length).trim()
}

function projectContent<T>(content: readonly T[]): readonly T[] {
  let changed = false
  const projected: T[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      projected.push(block)
      continue
    }
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') {
      projected.push(block)
      continue
    }
    const question = visibleBtwQuestion(candidate.text)
    if (question === null) {
      projected.push(block)
      continue
    }
    changed = true
    if (question !== '') projected.push({ ...block, text: question } as T)
  }
  return changed ? projected : content
}

type QueueLike = ConversationSnapshot['queue'][number]

/** Hide the model-only first-turn envelope from native queue presentation. */
export function projectBtwQueue<T extends QueueLike>(queue: readonly T[]): readonly T[] {
  let changed = false
  const projected = queue.map((item) => {
    const content = projectContent(item.content)
    const visibleText = item.text === null ? null : visibleBtwQuestion(item.text)
    const visiblePreview = visibleBtwQuestion(item.preview)
    if (content === item.content && visibleText === null && visiblePreview === null) return item
    changed = true
    const text = visibleText ?? item.text
    return {
      ...item,
      content,
      text,
      preview: visiblePreview ?? (visibleText === null ? item.preview : visibleText),
    }
  })
  return changed ? projected : queue
}

/**
 * Project the BTW child through the Host's native conversation tree while
 * keeping the model-only boundary envelope out of user-visible messages.
 */
export function projectBtwNativeSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  let nodesChanged = false
  const nodes = snapshot.nodes.map((node) => {
    if (node.kind !== 'user' && node.kind !== 'steering') return node
    const content = projectContent(node.content)
    if (content === node.content) return node
    nodesChanged = true
    return { ...node, content }
  })
  const queue = projectBtwQueue(snapshot.queue)
  if (!nodesChanged && queue === snapshot.queue) return snapshot
  return {
    ...snapshot,
    nodes: nodes as ConversationSnapshot['nodes'],
    queue,
  }
}

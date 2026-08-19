import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it } from 'vitest'
import { btwInitialPrompt } from '../src/core/btw-boundary.ts'
import {
  projectBtwNativeSnapshot,
  projectBtwQueue,
  visibleBtwQuestion,
} from '../src/core/btw-native-snapshot.ts'
import { snapshot } from './helpers/btw-harness.ts'

describe('BTW native conversation projection', () => {
  it('extracts only the user-visible question from a boundary envelope with inherited context', () => {
    const envelope = btwInitialPrompt('  explain the failure  ', 'Parent reference context')

    expect(visibleBtwQuestion(envelope)).toBe('explain the failure')
    expect(visibleBtwQuestion('ordinary prompt')).toBeNull()
  })

  it('hides the boundary in native user and steering nodes while preserving other content', () => {
    const userEnvelope = btwInitialPrompt('native question', 'Parent reference context')
    const steerEnvelope = btwInitialPrompt('steer question')
    const image = { type: 'image', mediaType: 'image/png', attachmentId: 'image-1' }
    const source = snapshot('child', {
      nodes: [
        { kind: 'user', seq: 1, content: [image, { type: 'text', text: userEnvelope }] } as never,
        { kind: 'assistant', seq: 2, blocks: [{ kind: 'text', text: 'answer' }] } as never,
        { kind: 'steering', seq: 3, content: [{ type: 'text', text: steerEnvelope }] } as never,
      ],
    })

    const projected = projectBtwNativeSnapshot(source)
    const user = projected.nodes[0] as unknown as { content: readonly unknown[] }
    const steering = projected.nodes[2] as unknown as { content: readonly { text: string }[] }

    expect(user.content).toEqual([image, { type: 'text', text: 'native question' }])
    expect(projected.nodes[1]).toBe(source.nodes[1])
    expect(steering.content).toEqual([{ type: 'text', text: 'steer question' }])
    expect(JSON.stringify(projected.nodes)).not.toContain('Side conversation boundary')
  })

  it('projects queued text, preview, and content through the same visible question', () => {
    const envelope = btwInitialPrompt('queued question', 'Parent reference context')
    const queue = [{
      id: 'queue-1',
      messageId: 'message-1',
      placement: 'queued',
      content: [{ type: 'text', text: envelope }],
      preview: envelope,
      text: envelope,
    }] as unknown as ConversationSnapshot['queue']

    const projected = projectBtwQueue(queue)

    expect(projected).toEqual([{
      ...queue[0],
      content: [{ type: 'text', text: 'queued question' }],
      preview: 'queued question',
      text: 'queued question',
    }])
    expect(projected).not.toBe(queue)
  })

  it('removes an image-only prompt boundary text block from the native transcript', () => {
    const image = { type: 'image', mediaType: 'image/png', attachmentId: 'image-1' }
    const source = snapshot('child', {
      nodes: [{
        kind: 'user',
        seq: 1,
        content: [image, { type: 'text', text: btwInitialPrompt('') }],
      } as never],
    })

    const projected = projectBtwNativeSnapshot(source)
    const user = projected.nodes[0] as unknown as { content: readonly unknown[] }

    expect(user.content).toEqual([image])
  })

  it('preserves snapshot identity when there is no BTW envelope to hide', () => {
    const source = snapshot('child', {
      nodes: [{ kind: 'user', seq: 1, content: [{ type: 'text', text: 'ordinary prompt' }] } as never],
    })

    expect(projectBtwNativeSnapshot(source)).toBe(source)
  })
})

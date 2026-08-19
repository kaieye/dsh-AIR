export const PASTE_REFERENCE_SOURCE = 'dsh-air-paste'
export const PASTE_STORAGE_PREFIX = 'dsh-air:paste:'

export interface PastePayload {
  readonly id: string
  readonly text: string
  readonly createdAt: number
}

export function pasteStorageKey(id: string): string {
  return `${PASTE_STORAGE_PREFIX}${id}`
}

export function pasteLabel(text: string): string {
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes < 1024) return `已粘贴 ${bytes} B`
  return `已粘贴 ${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KB`
}

export function readPastePayload(id: string): string | undefined {
  try {
    const raw = window.localStorage.getItem(pasteStorageKey(id))
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && 'text' in parsed && typeof parsed.text === 'string') return parsed.text
  } catch {
    // A blocked storage does not make the live paste unusable.
  }
  return undefined
}

export function writePastePayload(payload: PastePayload): void {
  try {
    window.localStorage.setItem(pasteStorageKey(payload.id), JSON.stringify(payload))
  } catch {
    // The in-memory registry remains authoritative for the current page.
  }
}

export function markerForPaste(id: string): string {
  return `⟦dsh-air-paste:${id}⟧`
}

export function parsePasteMarker(value: string): string | undefined {
  const match = /^⟦dsh-air-paste:([^⟧]+)⟧$/.exec(value)
  return match?.[1]
}

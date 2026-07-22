import { createMemoryStore, type MemoryStore } from './config-store'
import type { MemoryEntry } from '@shared/types'

// Module-level lazy singleton, mirroring skills/index.ts and roles/index.ts.
// The Electron app's userDataDir is constant for the process lifetime, so the
// first call wins.
let instance: MemoryStore | null = null

export function getMemoryStore(userDataDir: string): MemoryStore {
  if (!instance) {
    instance = createMemoryStore(userDataDir)
  }
  return instance
}

// Format a workspace's memory entries into a section appended to the system
// prompt. Returns '' when there is nothing to remember, so the caller can
// skip the append entirely.
export function formatMemoryForPrompt(entries: MemoryEntry[]): string {
  if (entries.length === 0) return ''
  const lines = entries.map(e => `- ${e.content}`)
  return [
    'Long-term memory for this workspace (pre-loaded; do not re-save anything already listed here):',
    ...lines
  ].join('\n')
}

export type { MemoryStore }
export { MAX_MEMORY_ENTRIES } from './config-store'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryEntry } from '@shared/types'

// Per-workspace cap. When exceeded the oldest entries are dropped so the
// pre-loaded memory section stays bounded (it is injected into the system
// prompt every run and counts against the token budget in runAgent).
export const MAX_MEMORY_ENTRIES = 50

interface MemoryFile {
  [workspace: string]: MemoryEntry[]
}

export interface MemoryStore {
  list(workspace: string): Promise<MemoryEntry[]>
  add(workspace: string, content: string): Promise<MemoryEntry>
  remove(workspace: string, id: string): Promise<{ ok: boolean }>
}

function isEntry(v: unknown): v is MemoryEntry {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as MemoryEntry).id === 'string' &&
    typeof (v as MemoryEntry).content === 'string' &&
    typeof (v as MemoryEntry).createdAt === 'number'
  )
}

export function createMemoryStore(userDataDir: string): MemoryStore {
  const filePath = join(userDataDir, 'memory.json')

  async function readAll(): Promise<MemoryFile> {
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw) as MemoryFile
      if (!parsed || typeof parsed !== 'object') return {}
      const clean: MemoryFile = {}
      for (const [ws, entries] of Object.entries(parsed)) {
        if (Array.isArray(entries)) {
          clean[ws] = entries.filter(isEntry)
        }
      }
      return clean
    } catch {
      return {}
    }
  }

  async function writeAll(data: MemoryFile): Promise<void> {
    await mkdir(userDataDir, { recursive: true })
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
  }

  return {
    async list(workspace): Promise<MemoryEntry[]> {
      const all = await readAll()
      return (all[workspace] ?? []).slice().sort((a, b) => a.createdAt - b.createdAt)
    },

    async add(workspace, content): Promise<MemoryEntry> {
      const all = await readAll()
      const entries = all[workspace] ?? []
      const entry: MemoryEntry = {
        id: crypto.randomUUID(),
        content,
        createdAt: Date.now()
      }
      const next = [...entries, entry]
      // Drop oldest entries beyond the cap (entries are in insertion order =
      // ascending createdAt, so shift from the front).
      while (next.length > MAX_MEMORY_ENTRIES) {
        next.shift()
      }
      all[workspace] = next
      await writeAll(all)
      return entry
    },

    async remove(workspace, id): Promise<{ ok: boolean }> {
      const all = await readAll()
      const entries = all[workspace] ?? []
      const filtered = entries.filter(e => e.id !== id)
      if (filtered.length === entries.length) return { ok: false }
      all[workspace] = filtered
      await writeAll(all)
      return { ok: true }
    }
  }
}
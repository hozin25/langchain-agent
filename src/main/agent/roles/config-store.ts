import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentRole } from '@shared/types'
import { DEFAULT_ROLES, DEFAULT_ROLE_IDS } from './defaults'

interface RoleConfigFile {
  overrides: AgentRole[]
}

export interface RoleConfigStore {
  list(): Promise<AgentRole[]>
  add(config: Omit<AgentRole, 'id' | 'builtin'>): Promise<AgentRole>
  update(config: AgentRole): Promise<AgentRole>
  remove(id: string): Promise<{ ok: boolean }>
  resetBuiltin(): Promise<{ ok: boolean }>
}

// Merge default roles with persisted overrides. A built-in id always keeps
// builtin=true (so remove() can reject it) even if an override tried to clear
// it; custom ids are always builtin=false.
function mergeRoles(overrides: AgentRole[]): AgentRole[] {
  const map = new Map<string, AgentRole>()
  for (const role of DEFAULT_ROLES) map.set(role.id, { ...role })
  for (const o of overrides) {
    const isBuiltin = DEFAULT_ROLE_IDS.has(o.id)
    map.set(o.id, { ...o, id: o.id, builtin: isBuiltin })
  }
  return Array.from(map.values())
}

export function createRoleConfigStore(userDataDir: string): RoleConfigStore {
  const configPath = join(userDataDir, 'roles-config.json')

  async function readOverrides(): Promise<AgentRole[]> {
    try {
      const raw = await readFile(configPath, 'utf8')
      const parsed = JSON.parse(raw) as RoleConfigFile
      if (!parsed || !Array.isArray(parsed.overrides)) return []
      return parsed.overrides.filter(
        o => o && typeof o.id === 'string' && typeof o.systemPrompt === 'string'
      )
    } catch {
      return []
    }
  }

  async function writeOverrides(overrides: AgentRole[]): Promise<void> {
    await mkdir(userDataDir, { recursive: true })
    const data: RoleConfigFile = { overrides }
    await writeFile(configPath, JSON.stringify(data, null, 2), 'utf8')
  }

  return {
    async list() {
      return mergeRoles(await readOverrides())
    },

    async add(config) {
      const overrides = await readOverrides()
      const entry: AgentRole = {
        ...config,
        id: crypto.randomUUID(),
        builtin: false
      }
      overrides.push(entry)
      await writeOverrides(overrides)
      return entry
    },

    async update(config) {
      const isBuiltin = DEFAULT_ROLE_IDS.has(config.id)
      const overrides = await readOverrides()
      const normalized: AgentRole = { ...config, builtin: isBuiltin }
      const idx = overrides.findIndex(o => o.id === config.id)
      if (idx >= 0) {
        overrides[idx] = normalized
      } else if (isBuiltin) {
        // first override of a built-in role
        overrides.push(normalized)
      } else {
        throw new Error(`Role not found: ${config.id}`)
      }
      await writeOverrides(overrides)
      return normalized
    },

    async remove(id) {
      // built-in ids can never be deleted (only reset to default)
      if (DEFAULT_ROLE_IDS.has(id)) return { ok: false }
      const overrides = await readOverrides()
      const len = overrides.length
      const filtered = overrides.filter(o => o.id !== id)
      if (filtered.length !== len) {
        await writeOverrides(filtered)
      }
      return { ok: filtered.length !== len }
    },

    async resetBuiltin() {
      const overrides = await readOverrides()
      const filtered = overrides.filter(o => !DEFAULT_ROLE_IDS.has(o.id))
      await writeOverrides(filtered)
      return { ok: true }
    }
  }
}

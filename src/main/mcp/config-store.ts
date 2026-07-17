import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpServerConfig } from './types'

interface McpConfigFile {
  servers: McpServerConfig[]
}

export interface McpConfigStore {
  list(): Promise<McpServerConfig[]>
  add(config: Omit<McpServerConfig, 'id'>): Promise<McpServerConfig>
  update(config: McpServerConfig): Promise<McpServerConfig>
  delete(id: string): Promise<{ ok: boolean }>
}

export function createMcpConfigStore(userDataDir: string): McpConfigStore {
  const configPath = join(userDataDir, 'mcp-config.json')

  async function readConfig(): Promise<McpServerConfig[]> {
    try {
      const raw = await readFile(configPath, 'utf8')
      const parsed = JSON.parse(raw) as McpConfigFile
      if (!parsed || !Array.isArray(parsed.servers)) return []
      return parsed.servers
    } catch {
      return []
    }
  }

  async function writeConfig(servers: McpServerConfig[]): Promise<void> {
    await mkdir(userDataDir, { recursive: true })
    const data: McpConfigFile = { servers }
    await writeFile(configPath, JSON.stringify(data, null, 2), 'utf8')
  }

  return {
    async list() {
      return readConfig()
    },

    async add(config) {
      const servers = await readConfig()
      const entry: McpServerConfig = {
        ...config,
        id: crypto.randomUUID()
      }
      servers.push(entry)
      await writeConfig(servers)
      return entry
    },

    async update(config) {
      const servers = await readConfig()
      const idx = servers.findIndex(s => s.id === config.id)
      if (idx < 0) throw new Error(`Server not found: ${config.id}`)
      servers[idx] = config
      await writeConfig(servers)
      return config
    },

    async delete(id) {
      const servers = await readConfig()
      const len = servers.length
      const filtered = servers.filter(s => s.id !== id)
      if (filtered.length !== len) {
        await writeConfig(filtered)
      }
      return { ok: filtered.length !== len }
    }
  }
}

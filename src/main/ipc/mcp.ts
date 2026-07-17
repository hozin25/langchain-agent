import { ipcMain, app } from 'electron'
import { createMcpConfigStore } from '../mcp/config-store'
import { getMcpManager } from '../mcp/manager'
import type { McpServerConfig, McpServerStateEntry } from '@shared/types'

export function registerMcpIpc(): void {
  const store = createMcpConfigStore(app.getPath('userData'))

  ipcMain.handle('mcp:listServers', async (): Promise<McpServerConfig[]> => {
    return store.list()
  })

  ipcMain.handle(
    'mcp:addServer',
    async (_e, config: Omit<McpServerConfig, 'id'>): Promise<McpServerConfig> => {
      const entry = await store.add(config)
      const configs = await store.list()
      await getMcpManager().reconnect(configs)
      return entry
    }
  )

  ipcMain.handle(
    'mcp:updateServer',
    async (_e, config: McpServerConfig): Promise<McpServerConfig> => {
      const updated = await store.update(config)
      const configs = await store.list()
      await getMcpManager().reconnect(configs)
      return updated
    }
  )

  ipcMain.handle('mcp:deleteServer', async (_e, id: string): Promise<{ ok: boolean }> => {
    const result = await store.delete(id)
    const configs = await store.list()
    await getMcpManager().reconnect(configs)
    return result
  })

  ipcMain.handle('mcp:getServerStatus', async (): Promise<McpServerStateEntry[]> => {
    return getMcpManager().getStatus()
  })
}

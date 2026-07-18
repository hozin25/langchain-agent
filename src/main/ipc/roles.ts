import { ipcMain, app } from 'electron'
import { getRoleStore } from '../agent/roles'
import type { AgentRole } from '@shared/types'

// Roles are plain config (no live connection to manage), so unlike mcp.ts there
// is no reconnect step — handlers just read/write the store.
export function registerRolesIpc(): void {
  const store = getRoleStore(app.getPath('userData'))

  ipcMain.handle('roles:list', async (): Promise<AgentRole[]> => {
    return store.list()
  })

  ipcMain.handle(
    'roles:add',
    async (_e, config: Omit<AgentRole, 'id' | 'builtin'>): Promise<AgentRole> => {
      return store.add(config)
    }
  )

  ipcMain.handle('roles:update', async (_e, config: AgentRole): Promise<AgentRole> => {
    return store.update(config)
  })

  ipcMain.handle('roles:remove', async (_e, id: string): Promise<{ ok: boolean }> => {
    return store.remove(id)
  })

  ipcMain.handle('roles:resetBuiltin', async (): Promise<{ ok: boolean }> => {
    return store.resetBuiltin()
  })
}

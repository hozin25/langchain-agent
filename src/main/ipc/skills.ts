import { ipcMain, app } from 'electron'
import { getSkillStore } from '../agent/skills'
import type { SkillConfig } from '@shared/types'

// Skills are plain config, so handlers just read/write the store.
export function registerSkillsIpc(): void {
  const store = getSkillStore(app.getPath('userData'))

  ipcMain.handle('skills:list', async (): Promise<SkillConfig[]> => {
    return store.list()
  })

  ipcMain.handle(
    'skills:add',
    async (_e, config: Omit<SkillConfig, 'id'>): Promise<SkillConfig> => {
      return store.add(config)
    }
  )

  ipcMain.handle('skills:update', async (_e, config: SkillConfig): Promise<SkillConfig> => {
    return store.update(config)
  })

  ipcMain.handle('skills:remove', async (_e, id: string): Promise<{ ok: boolean }> => {
    return store.remove(id)
  })
}
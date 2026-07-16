import { ipcMain, app } from 'electron'
import { createConversationStore } from '../conversations/store'
import type { Conversation } from '@shared/types'

export function registerConversationIpc(): void {
  const store = createConversationStore(app.getPath('userData'))

  ipcMain.handle('conversations:list', (_e, workspace: string) => store.listMetas(workspace))
  ipcMain.handle('conversations:load', (_e, id: string) => store.loadConversation(id))
  ipcMain.handle('conversations:save', (_e, conv: Conversation) => store.saveConversation(conv))
  ipcMain.handle('conversations:delete', (_e, id: string) => store.deleteConversation(id))
  ipcMain.handle('app:lastWorkspace', () => store.getLastWorkspace())
  ipcMain.handle('app:setWorkspace', (_e, path: string) => store.setLastWorkspace(path))
}

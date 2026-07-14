import { ipcMain, BrowserWindow, dialog, app } from 'electron'
import { runAgent } from '../agent'
import type { AgentEvent } from '@shared/types'

interface RunPayload {
  message: string
  workspace: string
}

export function registerIpc(): void {
  ipcMain.handle('agent:run', async (event, payload: RunPayload) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const onEvent = (evt: AgentEvent): void => {
      win?.webContents.send('agent:event', evt)
    }
    await runAgent({
      message: payload.message,
      workspace: payload.workspace,
      onEvent
    })
    return { ok: true }
  })

  ipcMain.handle('agent:cancel', () => {
    // Cancellation hook — wire an AbortController through runAgent when needed.
    return { ok: true }
  })

  ipcMain.handle('workspace:select', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null }
    }
    return { canceled: false, path: result.filePaths[0] }
  })

  ipcMain.handle('app:version', () => app.getVersion())
}

import { ipcMain, BrowserWindow, dialog, app } from 'electron'
import { basename } from 'node:path'
import { runAgent } from '../agent'
import { DEFAULT_MODEL_ID, listModels } from '../agent/llm'
import type { AgentEvent, FileAttachment } from '@shared/types'

// Active run per window, keyed by webContents id, so agent:cancel targets the
// correct run without the renderer needing to pass a run id.
const controllers = new Map<number, AbortController>()

interface RunPayload {
  message: string
  workspace: string
  modelId?: string
  attachments?: FileAttachment[]
}

const TEXT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'log',
  'json',
  'json5',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'cc',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'xml',
  'svg',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'csv',
  'tsv',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'sql',
  'env',
  'gitignore',
  'dockerfile',
  'vue',
  'svelte'
]

export function registerIpc(): void {
  ipcMain.handle('agent:run', async (event, payload: RunPayload) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const onEvent = (evt: AgentEvent): void => {
      win?.webContents.send('agent:event', evt)
    }
    const controller = new AbortController()
    controllers.set(event.sender.id, controller)
    try {
      await runAgent({
        message: payload.message,
        workspace: payload.workspace,
        modelId: payload.modelId,
        attachments: payload.attachments,
        signal: controller.signal,
        onEvent
      })
    } finally {
      controllers.delete(event.sender.id)
    }
    return { ok: true }
  })

  ipcMain.handle('agent:cancel', event => {
    controllers.get(event.sender.id)?.abort('user')
    return { ok: true }
  })

  ipcMain.handle('agent:listModels', () => ({
    models: listModels(),
    defaultId: DEFAULT_MODEL_ID
  }))

  ipcMain.handle('workspace:select', async event => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, path: null }
    }
    return { canceled: false, path: result.filePaths[0] }
  })

  ipcMain.handle('file:select', async event => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: 'Select files to attach',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Text & code', extensions: TEXT_EXTENSIONS }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, files: [] }
    }
    const files: FileAttachment[] = result.filePaths.map(path => ({
      name: basename(path),
      path
    }))
    return { canceled: false, files }
  })

  ipcMain.handle('app:version', () => app.getVersion())
}

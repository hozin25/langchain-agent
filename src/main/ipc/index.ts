import { ipcMain, BrowserWindow, dialog, app } from 'electron'
import { basename } from 'node:path'
import { runAgent } from '../agent'
import { compactHistory } from '../agent/compact'
import { DEFAULT_MODEL_ID, listModels } from '../agent/llm'
import { registerConversationIpc } from './conversations'
import { registerMcpIpc } from './mcp'
import { registerRolesIpc } from './roles'
import { registerSkillsIpc } from './skills'
import { registerSettingsIpc } from '../settings'
import { getMcpManager } from '../mcp/manager'
import { getRoleStore } from '../agent/roles'
import { getSkillStore } from '../agent/skills'
import { getMemoryStore } from '../agent/memory'
import { createMcpConfigStore } from '../mcp/config-store'
import { ConfirmManager } from '../agent/confirm'
import type { AgentEvent, AgentMode, ChatMessage, FileAttachment } from '@shared/types'

// Active run per window, keyed by webContents id, so agent:cancel targets the
// correct run without the renderer needing to pass a run id.
const controllers = new Map<number, AbortController>()
const managers = new Map<number, ConfirmManager>()

interface RunPayload {
  message: string
  workspace: string
  modelId?: string
  attachments?: FileAttachment[]
  history?: ChatMessage[]
  mode?: AgentMode
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
  const mcpConfigStore = createMcpConfigStore(app.getPath('userData'))
  void mcpConfigStore.list().then(configs => getMcpManager().initialize(configs))

  registerMcpIpc()
  registerRolesIpc()
  registerSkillsIpc()
  registerSettingsIpc(app.getPath('userData'))
  ipcMain.handle('agent:run', async (event, payload: RunPayload) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const onEvent = (evt: AgentEvent): void => {
      // webContents.send 在窗口销毁/重载时会抛错;吞掉避免污染 run 的 promise
      // 链导致 IPC "reply was never sent"。事件丢失不影响主流程(下一轮会重发)。
      try {
        win?.webContents.send('agent:event', evt)
      } catch {
        /* window may be gone — ignore */
      }
    }
    const controller = new AbortController()
    const manager = new ConfirmManager(
      controller.signal,
      onEvent,
      payload.mode === 'bypass'
    )
    controllers.set(event.sender.id, controller)
    managers.set(event.sender.id, manager)
    try {
      // Snapshot roles once per run (small local JSON) so a sub-agent can't see
      // mid-run edits if the user changes a role while a run is in flight.
      const roles = await getRoleStore(app.getPath('userData')).list()
      const skills = await getSkillStore(app.getPath('userData')).list()
      const memoryStore = getMemoryStore(app.getPath('userData'))
      await runAgent({
        message: payload.message,
        workspace: payload.workspace,
        modelId: payload.modelId,
        attachments: payload.attachments,
        history: payload.history,
        mode: payload.mode,
        signal: controller.signal,
        confirm: manager.request.bind(manager),
        onEvent,
        mcpTools: getMcpManager().getTools(),
        roles,
        skills,
        memoryStore
      })
    } catch (err) {
      // runAgent 内部本应自己 emit error 并 return,但防御性兜底:任何逃逸的
      // 异常都转成 error 事件推给前端,并保证 handler 一定 resolve(否则渲染
      // 进程会卡在 "reply was never sent")。
      console.error('[ipc] agent:run failed:', err)
      try {
        onEvent({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          kind: 'unknown',
          retryable: false
        })
      } catch {
        /* ignore */
      }
    } finally {
      controllers.delete(event.sender.id)
      managers.delete(event.sender.id)
    }
    return { ok: true }
  })

  ipcMain.handle('agent:cancel', event => {
    controllers.get(event.sender.id)?.abort('user')
    return { ok: true }
  })

  // 手动 /compact:把当前历史发到主进程压缩。事件(compact-start/progress/
  // end/error)经 agent:event 推送,与 run 共用同一事件流。返回压缩后的历史
  // (失败为 null,前端已通过 compact-error 提示,无需再靠返回值判断)。
  ipcMain.handle(
    'agent:compact',
    async (
      event,
      payload: { workspace: string; modelId?: string; history: ChatMessage[] }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const onEvent = (evt: AgentEvent): void => {
        try {
          win?.webContents.send('agent:event', evt)
        } catch {
          /* ignore */
        }
      }
      try {
        const result = await compactHistory(payload.history, {
          workspace: payload.workspace,
          modelId: payload.modelId,
          onEvent
        })
        return { history: result.history }
      } catch (err) {
        // compactHistory 内部已处理 LLM 失败(emit compact-error + 返回 null),
        // 这里只兜底同步异常(如 createLlm 抛错),保证 handler 一定 resolve。
        console.error('[ipc] agent:compact failed:', err)
        onEvent({
          type: 'compact-error',
          message: err instanceof Error ? err.message : String(err)
        })
        return { history: null }
      }
    }
  )

  ipcMain.handle(
    'agent:respondConfirmation',
    (event, payload: { id: string; approved: boolean; remember?: boolean }) => {
      managers
        .get(event.sender.id)
        ?.respond(payload.id, payload.approved, payload.remember ?? false)
      return { ok: true }
    }
  )

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

  registerConversationIpc()
}

import { contextBridge, ipcRenderer } from 'electron'
import type { AgentApi, AgentEvent } from '../shared/types'

const api: AgentApi = {
  agent: {
    run: (message, workspace, modelId) =>
      ipcRenderer.invoke('agent:run', { message, workspace, modelId }),
    cancel: () => ipcRenderer.invoke('agent:cancel'),
    onEvent: cb => {
      const handler = (_e: unknown, event: AgentEvent): void => cb(event)
      ipcRenderer.on('agent:event', handler)
      return () => {
        ipcRenderer.off('agent:event', handler)
      }
    },
    listModels: () => ipcRenderer.invoke('agent:listModels')
  },
  workspace: {
    select: () => ipcRenderer.invoke('workspace:select')
  },
  app: {
    version: () => ipcRenderer.invoke('app:version')
  }
}

contextBridge.exposeInMainWorld('api', api)

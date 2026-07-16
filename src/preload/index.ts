import { contextBridge, ipcRenderer } from 'electron'
import type { AgentApi, AgentEvent, Conversation } from '../shared/types'

const api: AgentApi = {
  agent: {
    run: (message, workspace, modelId, attachments) =>
      ipcRenderer.invoke('agent:run', { message, workspace, modelId, attachments }),
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
  file: {
    select: () => ipcRenderer.invoke('file:select')
  },
  conversations: {
    list: (workspace: string) => ipcRenderer.invoke('conversations:list', workspace),
    load: (id: string) => ipcRenderer.invoke('conversations:load', id),
    save: (conv: Conversation) => ipcRenderer.invoke('conversations:save', conv),
    delete: (id: string) => ipcRenderer.invoke('conversations:delete', id)
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    getLastWorkspace: () => ipcRenderer.invoke('app:lastWorkspace'),
    setLastWorkspace: (path: string) => ipcRenderer.invoke('app:setWorkspace', path)
  }
}

contextBridge.exposeInMainWorld('api', api)

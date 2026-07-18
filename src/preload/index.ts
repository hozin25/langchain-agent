import { contextBridge, ipcRenderer } from 'electron'
import type { AgentApi, AgentEvent, Conversation } from '../shared/types'

const api: AgentApi = {
  agent: {
    run: (message, workspace, modelId, attachments, history) =>
      ipcRenderer.invoke('agent:run', { message, workspace, modelId, attachments, history }),
    cancel: () => ipcRenderer.invoke('agent:cancel'),
    onEvent: cb => {
      const handler = (_e: unknown, event: AgentEvent): void => cb(event)
      ipcRenderer.on('agent:event', handler)
      return () => {
        ipcRenderer.off('agent:event', handler)
      }
    },
    listModels: () => ipcRenderer.invoke('agent:listModels'),
    respondConfirmation: (id, approved, remember) =>
      ipcRenderer.invoke('agent:respondConfirmation', { id, approved, remember })
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
  },
  mcp: {
    listServers: () => ipcRenderer.invoke('mcp:listServers'),
    addServer: config => ipcRenderer.invoke('mcp:addServer', config),
    updateServer: config => ipcRenderer.invoke('mcp:updateServer', config),
    deleteServer: id => ipcRenderer.invoke('mcp:deleteServer', id),
    getServerStatus: () => ipcRenderer.invoke('mcp:getServerStatus')
  }
}

contextBridge.exposeInMainWorld('api', api)

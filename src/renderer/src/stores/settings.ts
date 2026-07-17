import { create } from 'zustand'
import type { McpServerConfig, McpServerStateEntry } from '@shared/types'

interface SettingsState {
  isOpen: boolean
  servers: McpServerConfig[]
  serverStatuses: McpServerStateEntry[]
  editingServer: McpServerConfig | null

  open: () => void
  close: () => void
  loadServers: () => Promise<void>
  loadStatus: () => Promise<void>
  addServer: (config: Omit<McpServerConfig, 'id'>) => Promise<void>
  updateServer: (config: McpServerConfig) => Promise<void>
  deleteServer: (id: string) => Promise<void>
  startEditing: (server: McpServerConfig | null) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  isOpen: false,
  servers: [],
  serverStatuses: [],
  editingServer: null,

  open: () => {
    set({ isOpen: true })
    void get().loadServers()
    void get().loadStatus()
  },

  close: () => set({ isOpen: false, editingServer: null }),

  loadServers: async () => {
    const servers = await window.api.mcp.listServers()
    set({ servers })
  },

  loadStatus: async () => {
    const serverStatuses = await window.api.mcp.getServerStatus()
    set({ serverStatuses })
  },

  addServer: async config => {
    await window.api.mcp.addServer(config)
    await get().loadServers()
    await get().loadStatus()
  },

  updateServer: async config => {
    await window.api.mcp.updateServer(config)
    await get().loadServers()
    await get().loadStatus()
    set({ editingServer: null })
  },

  deleteServer: async id => {
    await window.api.mcp.deleteServer(id)
    await get().loadServers()
    await get().loadStatus()
  },

  startEditing: server => set({ editingServer: server })
}))

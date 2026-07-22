import { create } from 'zustand'
import type { AgentRole, McpServerConfig, McpServerStateEntry, SkillConfig } from '@shared/types'

interface SettingsState {
  isOpen: boolean
  servers: McpServerConfig[]
  serverStatuses: McpServerStateEntry[]
  editingServer: McpServerConfig | null
  roles: AgentRole[]
  editingRole: AgentRole | null
  // MCP tool names currently available (mcp__server__tool), for the role editor's
  // allowedTools checkboxes. Built-in tool names are a frontend constant.
  toolNames: string[]
  skills: SkillConfig[]
  editingSkill: SkillConfig | null

  open: () => void
  close: () => void
  loadServers: () => Promise<void>
  loadStatus: () => Promise<void>
  addServer: (config: Omit<McpServerConfig, 'id'>) => Promise<void>
  updateServer: (config: McpServerConfig) => Promise<void>
  deleteServer: (id: string) => Promise<void>
  startEditing: (server: McpServerConfig | null) => void

  loadRoles: () => Promise<void>
  loadToolNames: () => Promise<void>
  addRole: (config: Omit<AgentRole, 'id' | 'builtin'>) => Promise<void>
  updateRole: (config: AgentRole) => Promise<void>
  removeRole: (id: string) => Promise<void>
  resetBuiltinRoles: () => Promise<void>
  startEditingRole: (role: AgentRole | null) => void

  loadSkills: () => Promise<void>
  addSkill: (config: Omit<SkillConfig, 'id'>) => Promise<void>
  updateSkill: (config: SkillConfig) => Promise<void>
  removeSkill: (id: string) => Promise<void>
  startEditingSkill: (skill: SkillConfig | null) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  isOpen: false,
  servers: [],
  serverStatuses: [],
  editingServer: null,
  roles: [],
  editingRole: null,
  toolNames: [],
  skills: [],
  editingSkill: null,

  open: () => {
    set({ isOpen: true })
    void get().loadServers()
    void get().loadStatus()
    void get().loadRoles()
    void get().loadToolNames()
    void get().loadSkills()
  },

  close: () => set({ isOpen: false, editingServer: null, editingRole: null, editingSkill: null }),

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
    await get().loadToolNames()
  },

  updateServer: async config => {
    await window.api.mcp.updateServer(config)
    await get().loadServers()
    await get().loadStatus()
    await get().loadToolNames()
    set({ editingServer: null })
  },

  deleteServer: async id => {
    await window.api.mcp.deleteServer(id)
    await get().loadServers()
    await get().loadStatus()
    await get().loadToolNames()
  },

  startEditing: server => set({ editingServer: server }),

  loadRoles: async () => {
    const roles = await window.api.roles.list()
    set({ roles })
  },

  loadToolNames: async () => {
    const toolNames = await window.api.mcp.listToolNames()
    set({ toolNames })
  },

  addRole: async config => {
    await window.api.roles.add(config)
    await get().loadRoles()
    set({ editingRole: null })
  },

  updateRole: async config => {
    await window.api.roles.update(config)
    await get().loadRoles()
    set({ editingRole: null })
  },

  removeRole: async id => {
    await window.api.roles.remove(id)
    await get().loadRoles()
  },

  resetBuiltinRoles: async () => {
    await window.api.roles.resetBuiltin()
    await get().loadRoles()
  },

  startEditingRole: role => set({ editingRole: role }),

  loadSkills: async () => {
    const skills = await window.api.skills.list()
    set({ skills })
  },

  addSkill: async config => {
    await window.api.skills.add(config)
    await get().loadSkills()
    set({ editingSkill: null })
  },

  updateSkill: async config => {
    await window.api.skills.update(config)
    await get().loadSkills()
    set({ editingSkill: null })
  },

  removeSkill: async id => {
    await window.api.skills.remove(id)
    await get().loadSkills()
  },

  startEditingSkill: skill => set({ editingSkill: skill })
}))

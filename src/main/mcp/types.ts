export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}

export type McpServerStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface McpServerStateEntry {
  configId: string
  name: string
  status: McpServerStatus
  toolCount: number
  error?: string
}

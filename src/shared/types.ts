export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type MessageStatus = 'running' | 'done' | 'error'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  toolCallId?: string
  toolInput?: unknown
  status?: MessageStatus
  attachments?: { name: string }[]
  createdAt: number
}

export interface ConversationMeta {
  id: string
  title: string
  workspace: string
  createdAt: number
  updatedAt: number
}

export interface Conversation extends ConversationMeta {
  messages: ChatMessage[]
  todos: TodoItem[]
}

export type AgentEvent =
  | { type: 'message'; content: string }
  | { type: 'message-delta'; delta: string }
  | { type: 'tool-start'; tool: string; toolCallId: string; input: unknown }
  | { type: 'tool-end'; tool: string; output: string }
  | { type: 'confirm-request'; id: string; tool: string; input: unknown }
  | { type: 'todo-update'; todos: TodoItem[] }
  | { type: 'context-usage'; used: number; max: number }
  | { type: 'error'; message: string }
  | { type: 'interrupted' }
  | { type: 'done' }

export interface AgentRunResult {
  ok: boolean
}

export interface ModelOption {
  id: string
  name: string
  provider: string
  maxContextTokens: number
}

export interface ModelListResult {
  models: ModelOption[]
  defaultId: string
}

export interface WorkspaceSelectResult {
  canceled: boolean
  path: string | null
}

export interface FileAttachment {
  name: string
  path: string
}

export interface FileSelectResult {
  canceled: boolean
  files: FileAttachment[]
}

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

export interface AgentApi {
  agent: {
    run: (
      message: string,
      workspace: string,
      modelId?: string,
      attachments?: FileAttachment[],
      history?: ChatMessage[]
    ) => Promise<AgentRunResult>
    cancel: () => Promise<AgentRunResult>
    onEvent: (cb: (event: AgentEvent) => void) => () => void
    listModels: () => Promise<ModelListResult>
    respondConfirmation: (id: string, approved: boolean, remember?: boolean) => Promise<void>
  }
  workspace: {
    select: () => Promise<WorkspaceSelectResult>
  }
  file: {
    select: () => Promise<FileSelectResult>
  }
  conversations: {
    list: (workspace: string) => Promise<ConversationMeta[]>
    load: (id: string) => Promise<Conversation | null>
    save: (conv: Conversation) => Promise<{ id: string }>
    delete: (id: string) => Promise<{ ok: boolean }>
  }
  app: {
    version: () => Promise<string>
    getLastWorkspace: () => Promise<string | null>
    setLastWorkspace: (path: string) => Promise<{ ok: boolean }>
  }
  mcp: {
    listServers: () => Promise<McpServerConfig[]>
    addServer: (config: Omit<McpServerConfig, 'id'>) => Promise<McpServerConfig>
    updateServer: (config: McpServerConfig) => Promise<McpServerConfig>
    deleteServer: (id: string) => Promise<{ ok: boolean }>
    getServerStatus: () => Promise<McpServerStateEntry[]>
  }
}

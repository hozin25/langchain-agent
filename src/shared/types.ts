export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type MessageStatus = 'running' | 'done' | 'error'

// Structured error category used by classifyError (src/main/agent/errors.ts) and
// surfaced to the UI so the error card can show targeted guidance + a retry
// button. Defined here (not in errors.ts) because both the node and web
// tsconfigs include src/shared, making it the single source of truth.
export type ErrorKind =
  | 'aborted'
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'overloaded'
  | 'network'
  | 'context_too_long'
  | 'recursion_limit'
  | 'unknown'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
  toolCallId?: string
  toolInput?: unknown
  status?: MessageStatus
  attachments?: { name: string }[]
  // Present when the message belongs to a delegated sub-agent rather than the
  // root agent. Undefined (or 'main') = root. Flat-list grouping key for the UI.
  agentId?: string
  agentName?: string
  createdAt: number
  // Tool messages: wall-clock duration set on tool-end. Assistant messages: unset.
  durationMs?: number
  // Error card fields — only set on assistant messages finalized via the
  // 'error' event. errorKind drives icon/color; guidance is the actionable hint;
  // retryable gates the manual "retry" button.
  errorKind?: ErrorKind
  guidance?: string
  retryable?: boolean
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

// Process events carry optional `agentId` / `agentName` so the same event shapes
// serve both the root agent and delegated sub-agents. When undefined, the event
// belongs to the root. `done` / `interrupted` are root-only (a sub-agent must
// NEVER emit them — doing so would finalize the whole turn). Sub-agent lifetimes
// are bounded by `subagent-start` / `subagent-end` instead. Both fields are
// optional on every process event so a sub-agent can stamp identity uniformly.
export type AgentEvent =
  | { type: 'message'; content: string; agentId?: string; agentName?: string }
  | { type: 'message-delta'; delta: string; agentId?: string; agentName?: string }
  | {
      type: 'tool-start'
      tool: string
      toolCallId: string
      input: unknown
      agentId?: string
      agentName?: string
    }
  | {
      type: 'tool-end'
      tool: string
      output: string
      durationMs?: number
      agentId?: string
      agentName?: string
    }
  | {
      type: 'confirm-request'
      id: string
      tool: string
      input: unknown
      agentId?: string
      agentName?: string
    }
  | { type: 'todo-update'; todos: TodoItem[]; agentId?: string; agentName?: string }
  | { type: 'context-usage'; used: number; max: number; agentId?: string; agentName?: string }
  | {
      type: 'error'
      message: string
      kind: ErrorKind
      retryable: boolean
      guidance?: string
      agentId?: string
      agentName?: string
    }
  // Root-only: emitted between failed attempts during turn-level backoff retry
  // (src/main/agent/index.ts). Tells the UI the run is pausing before retrying.
  | { type: 'retry'; attempt: number; maxAttempts: number; reason: string; delayMs: number }
  | { type: 'interrupted' }
  | { type: 'done' }
  | { type: 'subagent-start'; agentId: string; roleId: string; roleName: string; task: string }
  | {
      type: 'subagent-end'
      agentId: string
      roleId: string
      roleName: string
      summary: string
      ok: boolean
    }

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

// A delegatable sub-agent role. Built-in roles have stable ids (researcher /
// coder / tester / reviewer) and builtin=true; users can edit them or add
// custom ones. `allowedTools` is a name whitelist over the built-in + MCP tools.
export interface AgentRole {
  id: string
  name: string
  // One-line "what this role is good at" — concatenated into the delegate tool's
  // description so the root agent knows when to pick it.
  description: string
  systemPrompt: string
  allowedTools: string[]
  // Undefined = inherit the root agent's model.
  modelId?: string
  builtin?: boolean
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
    listToolNames: () => Promise<string[]>
  }
  roles: {
    list: () => Promise<AgentRole[]>
    add: (config: Omit<AgentRole, 'id' | 'builtin'>) => Promise<AgentRole>
    update: (config: AgentRole) => Promise<AgentRole>
    remove: (id: string) => Promise<{ ok: boolean }>
    resetBuiltin: () => Promise<{ ok: boolean }>
  }
}

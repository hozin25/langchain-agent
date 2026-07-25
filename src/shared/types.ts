export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type MessageStatus = 'running' | 'done' | 'error'

// Coarse operating mode threaded from the UI down to runAgent. 'plan' restricts
// the agent to read-only tools and a planning prompt; the user must approve a
// plan before any edits happen (approvePlan flips mode back to act/bypass).
// 'bypass' behaves like 'act' (full tool set) but the ConfirmManager is
// constructed with bypass=true, so shell/delete (and delegated sub-agent calls)
// auto-approve without a dialog — the workspace sandbox still applies.
export type AgentMode = 'plan' | 'act' | 'bypass'

// Lifecycle of a plan-mode assistant message. 'pending' shows the approve/revise
// bar; 'approved' shows a badge after the user approved (execution follows);
// 'closed' hides the bar when the user chose to keep refining. Undefined on all
// non-plan (act) messages.
export type PlanState = 'pending' | 'approved' | 'closed'

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
  // Present on plan-mode assistant messages (the agent's proposed plan). Drives
  // the approve/revise bar in the UI. See PlanState.
  plan?: PlanState
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

// A long-term memory entry persisted across conversations, scoped to a single
// workspace. Pre-loaded into the agent's system prompt at the start of every
// run (see src/main/agent/memory), so durable facts (user preferences, project
// conventions) survive session boundaries without being re-stated.
export interface MemoryEntry {
  id: string
  content: string
  createdAt: number
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
  // Compact(对话压缩)生命周期。手动 /compact 与自动(回复中超 80%)共用同一
  // 套事件。start→progress(可多次)→end 成功;或 start→error 失败。skipped
  // 表示历史太短无需压缩(仍发 end)。percent 是阶段式估算,非精确 token 进度。
  | { type: 'compact-start'; beforeTokens: number; afterTokensEstimate: number }
  | { type: 'compact-progress'; stage: 'collecting' | 'summarizing' | 'replacing'; percent: number }
  | {
      type: 'compact-end'
      skipped: boolean
      beforeTokens?: number
      afterTokens?: number
      summary?: string
    }
  | { type: 'compact-error'; message: string }
  // 自动 compact 触发信号:runAgent 在 stream 中检测到 used/max > 80% 时发出。
  // 前端收到后,在当前轮 done 结束后自动触发 compact(不在 stream 中途打断
  // 生成,也避免与正在进行的 LLM 调用并发)。一轮内只发一次。
  | { type: 'compact-needed'; used: number; max: number }
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

// A user-defined skill: a Markdown file the agent can list and read at runtime.
// `name` is the unique key the agent uses to request a skill via read_skill; the
// absolute `filePath` points at the .md body (may live outside the workspace, so
// read_skill bypasses resolveInWorkspace — the path is user-curated config, not
// agent input). `description` is what list_skills returns so the agent can pick.
export interface SkillConfig {
  id: string
  name: string
  description: string
  filePath: string
  enabled: boolean
}

// Persisted user settings (userData/settings.json). `mode` is the operating
// mode restored on startup; `bypassAcknowledged` records that the user has
// already accepted the bypass-mode danger warning once, so we never re-prompt
// on subsequent toggles into bypass (it is sticky — toggling to plan/act does
// not clear it).
export interface AppSettings {
  mode: AgentMode
  bypassAcknowledged: boolean
}

export interface AgentApi {
  agent: {
    run: (
      message: string,
      workspace: string,
      modelId?: string,
      attachments?: FileAttachment[],
      history?: ChatMessage[],
      mode?: AgentMode
    ) => Promise<AgentRunResult>
    cancel: () => Promise<AgentRunResult>
    onEvent: (cb: (event: AgentEvent) => void) => () => void
    listModels: () => Promise<ModelListResult>
    respondConfirmation: (id: string, approved: boolean, remember?: boolean) => Promise<void>
    // 压缩对话历史:把旧消息总结成一条 summary,保留尾部。手动 /compact 与
    // 自动触发共用。返回压缩后的历史(失败时返回 null,前端已通过 compact-error
    // 事件提示)。事件流(compact-start/progress/end/error)经 onEvent 推送。
    compact: (
      workspace: string,
      modelId: string | undefined,
      history: ChatMessage[]
    ) => Promise<{ history: ChatMessage[] | null }>
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
    getSettings: () => Promise<AppSettings | null>
    setSettings: (settings: AppSettings) => Promise<{ ok: boolean }>
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
  skills: {
    list: () => Promise<SkillConfig[]>
    add: (config: Omit<SkillConfig, 'id'>) => Promise<SkillConfig>
    update: (config: SkillConfig) => Promise<SkillConfig>
    remove: (id: string) => Promise<{ ok: boolean }>
  }
}

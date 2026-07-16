export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type AgentEvent =
  | { type: 'message'; content: string }
  | { type: 'message-delta'; delta: string }
  | { type: 'tool-start'; tool: string; input: unknown }
  | { type: 'tool-end'; tool: string; output: string }
  | { type: 'todo-update'; todos: TodoItem[] }
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

export interface AgentApi {
  agent: {
    run: (
      message: string,
      workspace: string,
      modelId?: string,
      attachments?: FileAttachment[]
    ) => Promise<AgentRunResult>
    cancel: () => Promise<AgentRunResult>
    onEvent: (cb: (event: AgentEvent) => void) => () => void
    listModels: () => Promise<ModelListResult>
  }
  workspace: {
    select: () => Promise<WorkspaceSelectResult>
  }
  file: {
    select: () => Promise<FileSelectResult>
  }
  app: {
    version: () => Promise<string>
  }
}

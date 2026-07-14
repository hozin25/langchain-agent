export type AgentEvent =
  | { type: 'message'; content: string }
  | { type: 'tool-start'; tool: string; input: unknown }
  | { type: 'tool-end'; tool: string; output: string }
  | { type: 'error'; message: string }
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

export interface AgentApi {
  agent: {
    run: (message: string, workspace: string, modelId?: string) => Promise<AgentRunResult>
    cancel: () => Promise<AgentRunResult>
    onEvent: (cb: (event: AgentEvent) => void) => () => void
    listModels: () => Promise<ModelListResult>
  }
  workspace: {
    select: () => Promise<WorkspaceSelectResult>
  }
  app: {
    version: () => Promise<string>
  }
}

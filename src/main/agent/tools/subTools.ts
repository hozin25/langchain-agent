import type { StructuredTool } from '@langchain/core/tools'
import {
  makeReadFile,
  makeWriteFile,
  makeEditFile,
  makeListDirectory,
  makeCreateDirectory,
  makeMoveFile,
  makeDeleteFile
} from './fileSystem'
import { makeGlob, makeGrep } from './search'
import { makeWebFetch, makeWebSearch } from './web'
import { makeTodoWrite } from './todo'
import { makeRunShellCommand } from './shell'
import type { ConfirmFn } from '../confirm'
import type { AgentEvent } from '@shared/types'

export interface SubToolContext {
  workspace: string
  emit: (event: AgentEvent) => void
  confirm: ConfirmFn
  mcpTools: StructuredTool[]
  allowedTools: string[]
  // Root depth = 0. A sub-agent (depth > 0) never receives the delegate tool,
  // which physically prevents unbounded recursion.
  depth: number
}

// Tool factories close over different subsets of deps (read_file needs only the
// workspace; delete_file adds confirm; todo_write uses emit). Normalize them to
// one signature so a name -> tool table works uniformly.
type Factory = (ctx: SubToolContext) => StructuredTool

const TOOL_FACTORIES: Record<string, Factory> = {
  read_file: ({ workspace }) => makeReadFile(workspace),
  write_file: ({ workspace }) => makeWriteFile(workspace),
  edit_file: ({ workspace }) => makeEditFile(workspace),
  list_directory: ({ workspace }) => makeListDirectory(workspace),
  create_directory: ({ workspace }) => makeCreateDirectory(workspace),
  move_file: ({ workspace }) => makeMoveFile(workspace),
  delete_file: ({ workspace, confirm }) => makeDeleteFile(workspace, confirm),
  glob: ({ workspace }) => makeGlob(workspace),
  grep: ({ workspace }) => makeGrep(workspace),
  web_fetch: () => makeWebFetch(),
  web_search: () => makeWebSearch(),
  todo_write: ({ emit }) => makeTodoWrite(emit),
  run_shell_command: ({ workspace, confirm }) => makeRunShellCommand(workspace, confirm)
}

// Build a sub-agent's restricted tool set from a name whitelist. MCP tools are
// stateless singletons identified by name (mcp__server__tool); including one by
// name just reuses the shared instance.
export function buildSubTools(ctx: SubToolContext): StructuredTool[] {
  const want = new Set(ctx.allowedTools)
  const tools: StructuredTool[] = []
  for (const [name, factory] of Object.entries(TOOL_FACTORIES)) {
    if (want.has(name)) tools.push(factory(ctx))
  }
  for (const mcp of ctx.mcpTools) {
    if (want.has(mcp.name)) tools.push(mcp)
  }
  return tools
}

// The full set of tool names a role's allowedTools can reference — built-in
// names plus currently-connected MCP tool names. Used by the role editor UI.
export function availableToolNames(mcpTools: StructuredTool[]): string[] {
  return [...Object.keys(TOOL_FACTORIES), ...mcpTools.map(t => t.name)]
}

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

export function getTools(
  workspace: string,
  emit: (event: AgentEvent) => void,
  confirm: ConfirmFn,
  mcpTools: StructuredTool[] = [],
  planMode = false
) {
  // Plan mode: read-only by construction. The LLM physically cannot call any
  // mutating tool (no write/edit/move/delete, no shell) nor delegate (a
  // sub-agent could mutate) nor use MCP tools (their side effects are unknown)
  // nor todo_write. This is the hard guarantee behind plan mode — it does not
  // rely on the model obeying the prompt.
  if (planMode) {
    return [
      makeReadFile(workspace),
      makeListDirectory(workspace),
      makeGlob(workspace),
      makeGrep(workspace),
      makeWebFetch(),
      makeWebSearch()
    ]
  }
  return [
    ...mcpTools,
    makeReadFile(workspace),
    makeWriteFile(workspace),
    makeEditFile(workspace),
    makeListDirectory(workspace),
    makeCreateDirectory(workspace),
    makeMoveFile(workspace),
    makeDeleteFile(workspace, confirm),
    makeGlob(workspace),
    makeGrep(workspace),
    makeWebFetch(),
    makeWebSearch(),
    makeTodoWrite(emit),
    makeRunShellCommand(workspace, confirm)
  ]
}

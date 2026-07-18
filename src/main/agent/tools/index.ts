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
  mcpTools: StructuredTool[] = []
) {
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

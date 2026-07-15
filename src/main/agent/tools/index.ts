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
import type { AgentEvent } from '@shared/types'

export function getTools(workspace: string, emit: (event: AgentEvent) => void) {
  return [
    makeReadFile(workspace),
    makeWriteFile(workspace),
    makeEditFile(workspace),
    makeListDirectory(workspace),
    makeCreateDirectory(workspace),
    makeMoveFile(workspace),
    makeDeleteFile(workspace),
    makeGlob(workspace),
    makeGrep(workspace),
    makeWebFetch(),
    makeWebSearch(),
    makeTodoWrite(emit),
    makeRunShellCommand(workspace)
  ]
}

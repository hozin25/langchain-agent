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
import { makeWebFetch } from './web'
import { makeRunShellCommand } from './shell'

export function getTools(workspace: string) {
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
    makeRunShellCommand(workspace)
  ]
}

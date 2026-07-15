import {
  makeReadFile,
  makeWriteFile,
  makeEditFile,
  makeListDirectory,
  makeCreateDirectory,
  makeMoveFile
} from './fileSystem'
import { makeSearchFiles } from './search'
import { makeRunShellCommand } from './shell'

export function getTools(workspace: string) {
  return [
    makeReadFile(workspace),
    makeWriteFile(workspace),
    makeEditFile(workspace),
    makeListDirectory(workspace),
    makeCreateDirectory(workspace),
    makeMoveFile(workspace),
    makeSearchFiles(workspace),
    makeRunShellCommand(workspace)
  ]
}

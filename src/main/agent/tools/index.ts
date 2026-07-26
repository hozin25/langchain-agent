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
import { makeListSkills, makeReadSkill } from './skills'
import { makeSaveMemory } from './memory'
import { wrapWithSnapshot, WRITE_TOOL_NAMES, type SnapshotFn } from './withSnapshot'
import type { ConfirmFn } from '../confirm'
import type { AgentEvent, SkillConfig } from '@shared/types'
import type { MemoryStore } from '../memory'

export function getTools(
  workspace: string,
  emit: (event: AgentEvent) => void,
  confirm: ConfirmFn,
  mcpTools: StructuredTool[] = [],
  planMode = false,
  skills: SkillConfig[] = [],
  memoryStore?: MemoryStore,
  // Phase 3:when provided, each write tool snapshots the workspace BEFORE it
  // executes. Undefined in plan mode (read-only) and in tests that don't care
  // about rollback.
  snapshot?: SnapshotFn
) {
  // Wrap a built-in tool with a pre-execution snapshot iff it is a write tool
  // and a snapshot fn was supplied. Read tools pass through unchanged.
  const maybeWrap = (t: StructuredTool): StructuredTool =>
    snapshot && WRITE_TOOL_NAMES.has(t.name) ? wrapWithSnapshot(t, snapshot) : t

  const skillTools = [makeListSkills(skills), makeReadSkill(skills)]
  // Plan mode: read-only by construction. The LLM physically cannot call any
  // mutating tool (no write/edit/move/delete, no shell) nor delegate (a
  // sub-agent could mutate) nor use MCP tools (their side effects are unknown)
  // nor todo_write. This is the hard guarantee behind plan mode — it does not
  // rely on the model obeying the prompt. Skills are read-only, so they stay.
  if (planMode) {
    return [
      makeReadFile(workspace),
      makeListDirectory(workspace),
      makeGlob(workspace),
      makeGrep(workspace),
      makeWebFetch(),
      makeWebSearch(),
      ...skillTools
    ]
  }
  return [
    ...mcpTools,
    makeReadFile(workspace),
    maybeWrap(makeWriteFile(workspace)),
    maybeWrap(makeEditFile(workspace)),
    makeListDirectory(workspace),
    maybeWrap(makeCreateDirectory(workspace)),
    maybeWrap(makeMoveFile(workspace)),
    maybeWrap(makeDeleteFile(workspace, confirm)),
    makeGlob(workspace),
    makeGrep(workspace),
    makeWebFetch(),
    makeWebSearch(),
    makeTodoWrite(emit),
    maybeWrap(makeRunShellCommand(workspace, confirm)),
    ...(memoryStore ? [makeSaveMemory(workspace, memoryStore)] : []),
    ...skillTools
  ]
}

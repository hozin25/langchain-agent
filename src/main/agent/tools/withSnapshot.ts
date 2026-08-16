import { DynamicStructuredTool } from '@langchain/core/tools'
import type { StructuredTool } from '@langchain/core/tools'

// Phase 3:tools whose execution mutates the workspace. Each gets a shadow-git
// snapshot taken BEFORE it runs, so the user can roll back to just before any
// write. Read-only tools never snapshot (nothing to undo).
export const WRITE_TOOL_NAMES = new Set<string>([
  'write_file',
  'edit_file',
  'create_directory',
  'move_file',
  'delete_file',
  'run_shell_command'
])

// Best-effort snapshot thunk. Created by runAgent, closes over the shadow repo +
// index store + emit + conversationId. `label` distinguishes 'turn-start' from
// per-tool snapshots; `toolName`/`agentId` populate the timeline entry; `detail`
// carries the operation's target path (timeline 显示「编辑文件 src/app.js」而非
// 仅「编辑文件」)。 Never throws on the tool's critical path — wrapWithSnapshot
// swallows failures so a snapshot glitch can't block the agent's actual work.
export type SnapshotFn = (
  label: string,
  toolName?: string,
  agentId?: string,
  detail?: string
) => Promise<void>

// 从工具 input 提取目标路径:write/edit/delete/create 用 path,move 用 source;
// run_shell_command 等无单一路径的操作返回 undefined。
function inputPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const rec = input as Record<string, unknown>
  for (const key of ['path', 'source']) {
    const v = rec[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

// Wrap a write tool: snapshot, then delegate to the original. Returns a NEW
// DynamicStructuredTool sharing name/description/schema. Best-effort — snapshot
// errors are caught + logged, the tool still runs.
export function wrapWithSnapshot(t: StructuredTool, snapshot: SnapshotFn): StructuredTool {
  return new DynamicStructuredTool({
    name: t.name,
    description: t.description,
    schema: t.schema,
    func: async input => {
      try {
        await snapshot('write', t.name, undefined, inputPath(input))
      } catch (e) {
        console.log(
          `[snapshot] best-effort snapshot failed for ${t.name}: ${
            e instanceof Error ? e.message : String(e)
          }`
        )
      }
      // Delegate to the original tool's invoke with the already-parsed input.
      return (await t.invoke(input as never)) as string
    }
  })
}

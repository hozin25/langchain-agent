import type { SnapshotEntry } from '@shared/types'

const TOOL_LABELS: Record<string, string> = {
  write_file: '写入文件',
  edit_file: '编辑文件',
  create_directory: '创建目录',
  move_file: '移动文件',
  delete_file: '删除文件',
  run_shell_command: 'Shell 命令'
}

// Human label for a snapshot, shown in the restore confirm dialog and the
// timeline. Falls back through tool name (+ target path) → turn label → generic.
export function snapshotLabel(entry: SnapshotEntry): string {
  if (entry.toolName) {
    const base = TOOL_LABELS[entry.toolName] ?? entry.toolName
    return entry.filePath ? `${base} ${entry.filePath}` : base
  }
  if (entry.turnLabel === 'turn-start') return '回合开始'
  if (entry.turnLabel) return entry.turnLabel
  return '快照'
}

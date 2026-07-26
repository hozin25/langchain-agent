import { ipcMain, BrowserWindow, app } from 'electron'
import { createShadowRepo } from '../snapshots/shadowRepo'
import { createSnapshotIndexStore } from '../snapshots/index-store'
import { restoreToSnapshot } from '../snapshots/restore'
import type { AgentEvent, RestoreMode, SnapshotEntry } from '@shared/types'

// Phase 3 snapshot timeline IPC. `list` reads the per-workspace index (optionally
// filtered to one conversation). `restore` is user-initiated rollback: it streams
// restore-start/progress/end/error through the same agent:event channel the run
// uses (so the chat UI picks it up uniformly), then returns the result. Restore
// NEVER runs git checkout in the workspace — file copy only (restore.ts).
export function registerSnapshotIpc(): void {
  const indexStore = createSnapshotIndexStore(app.getPath('userData'))

  ipcMain.handle('snapshots:list', (_e, workspace: string, conversationId?: string) => {
    return indexStore.list(workspace).then((entries: SnapshotEntry[]) =>
      conversationId ? entries.filter(x => x.conversationId === conversationId) : entries
    )
  })

  ipcMain.handle(
    'snapshots:restore',
    async (
      event,
      payload: { workspace: string; sha: string; mode?: RestoreMode }
    ): Promise<{ preRestoreSha?: string; restoredFiles: number; removedFiles: number }> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const onEvent = (evt: AgentEvent): void => {
        try {
          win?.webContents.send('agent:event', evt)
        } catch {
          /* window may be gone — ignore */
        }
      }
      onEvent({ type: 'restore-start' })
      onEvent({ type: 'restore-progress', percent: 10 })
      try {
        const repo = createShadowRepo(app.getPath('userData'), payload.workspace)
        const result = await restoreToSnapshot(
          repo,
          payload.workspace,
          payload.sha,
          payload.mode ?? 'conservative'
        )
        onEvent({ type: 'restore-progress', percent: 100 })
        onEvent({
          type: 'restore-end',
          preRestoreSha: result.preRestoreSha,
          restoredFiles: result.restoredFiles,
          removedFiles: result.removedFiles
        })
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[ipc] snapshots:restore failed:', err)
        onEvent({ type: 'restore-error', message: msg })
        return { restoredFiles: 0, removedFiles: 0 }
      }
    }
  )
}

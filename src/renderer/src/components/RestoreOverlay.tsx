import { useChatStore } from '../stores/chat'

// 「撤销回滚」按钮。props 里拿 sha(而非闭包读 notice.preRestoreSha)是为了让
// TS 正确窄化 string | undefined —— JSX 条件渲染的守卫传不进 onClick 闭包。
function UndoRestoreButton({ sha }: { sha: string }) {
  const dismissNotice = useChatStore(s => s.dismissRestoreNotice)
  const restore = useChatStore(s => s.restore)
  return (
    <button
      type="button"
      className="compact-banner__action"
      onClick={() => {
        dismissNotice()
        void restore(sha, 'conservative', '回滚前状态')
      }}
    >
      撤销回滚
    </button>
  )
}

// Phase 3 restore status UI, three states like CompactBanner:
// - isRestoring: a blocking modal overlay with spinner + staged percent. Restore
//   overwrites workspace files, so we block interaction while in flight.
// - restoreError (after a failed restore): a dismissible banner.
// - restoreNotice (after a successful restore): a dismissible banner with the
//   result + an "undo restore" action (pre-restore sha), so the rollback outcome
//   stays visible instead of the progress bar flashing away.
export function RestoreOverlay() {
  const isRestoring = useChatStore(s => s.isRestoring)
  const progress = useChatStore(s => s.restoreProgress)
  const error = useChatStore(s => s.restoreError)
  const dismiss = useChatStore(s => s.dismissRestoreError)
  const notice = useChatStore(s => s.restoreNotice)
  const dismissNotice = useChatStore(s => s.dismissRestoreNotice)

  if (isRestoring) {
    const pct = Math.min(100, Math.max(0, progress))
    return (
      <div className="restore-overlay" role="status" aria-live="polite">
        <div className="restore-overlay__card">
          <div className="restore-overlay__head">
            <span className="compact-banner__spinner" aria-hidden />
            <span className="restore-overlay__title">正在回滚工作区文件…</span>
          </div>
          <div className="compact-banner__bar" aria-hidden>
            <span className="compact-banner__fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="restore-overlay__pct">{pct}%</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="compact-banner compact-banner--error" role="alert">
        <span className="compact-banner__title">⚠️ 回滚失败：{error}</span>
        <button
          type="button"
          className="compact-banner__close"
          onClick={dismiss}
          aria-label="关闭提示"
        >
          ×
        </button>
      </div>
    )
  }

  if (notice) {
    const undone =
      notice.restoredFiles > 0 ? `恢复 ${notice.restoredFiles} 个文件` : '无文件变动'
    const removed =
      notice.removedFiles > 0 ? `、删除 ${notice.removedFiles} 个文件` : ''
    return (
      <div className="compact-banner compact-banner--success" role="status">
        <span className="compact-banner__title">
          ✓ 已回滚到「{notice.label}」（{undone}
          {removed}）
        </span>
        {notice.preRestoreSha && (
          <UndoRestoreButton sha={notice.preRestoreSha} />
        )}
        <button
          type="button"
          className="compact-banner__close"
          onClick={dismissNotice}
          aria-label="关闭提示"
        >
          ×
        </button>
      </div>
    )
  }

  return null
}

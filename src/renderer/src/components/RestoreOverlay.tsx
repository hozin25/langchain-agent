import { useChatStore } from '../stores/chat'

// Phase 3 restore status UI, two states like CompactBanner:
// - isRestoring: a blocking modal overlay with spinner + staged percent. Restore
//   overwrites workspace files, so we block interaction while in flight.
// - restoreError (after a failed restore): a dismissible banner.
// lastPreRestoreSha is surfaced here as an "undo restore" hint once a restore
// completes — but we don't render a persistent banner on success (the timeline +
// inline buttons already cover re-rollback), so it stays as store state only.
export function RestoreOverlay() {
  const isRestoring = useChatStore(s => s.isRestoring)
  const progress = useChatStore(s => s.restoreProgress)
  const error = useChatStore(s => s.restoreError)
  const dismiss = useChatStore(s => s.dismissRestoreError)

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

  return null
}

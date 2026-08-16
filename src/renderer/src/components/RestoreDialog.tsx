import { useEffect, useState } from 'react'
import type { RestoreMode } from '@shared/types'
import { useChatStore } from '../stores/chat'

const MODE_DESC: Record<RestoreMode, string> = {
  conservative: '仅把快照中的文件还原回去；你在快照之后新建的文件会保留。',
  full: '还原快照中的文件，并删除快照里没有的文件（不含 node_modules、out 等构建产物）。'
}

// Phase 3 restore confirm. Triggered by either the inline「⏪ 回滚到此」button on a
// tool bubble or the sidebar timeline (both call requestRestore → pendingRestore).
// The user picks a mode and confirms; restore() then clears pendingRestore and
// drives the progress overlay via restore-* events. This dialog never touches the
// filesystem itself — it only hands the chosen sha + mode to the store action.
export function RestoreDialog() {
  const pending = useChatStore(s => s.pendingRestore)
  const restore = useChatStore(s => s.restore)
  const cancel = useChatStore(s => s.cancelRestore)
  const [mode, setMode] = useState<RestoreMode>('conservative')

  // Reset to the safe default whenever a new restore target is queued, so a prior
  // 'full' choice doesn't silently carry over to the next rollback.
  useEffect(() => {
    if (pending) setMode('conservative')
  }, [pending])

  if (!pending) return null

  const confirm = (): void => {
    void restore(pending.sha, mode)
  }

  // 遮罩不响应点击:确认与取消都是「弹窗消失」,点遮罩静默取消曾让用户误以为
  // 已确认(真机验证踩坑)。只能通过下方按钮显式选择。危险操作的 ConfirmDialog
  // 保持遮罩取消(取消 = 不执行 = 安全默认,语义直观)。
  return (
    <div className="confirm-overlay">
      <div className="confirm-dialog">
        <div className="confirm-dialog__header">
          <span className="confirm-dialog__icon" aria-hidden>
            ⏪
          </span>
          <h2 className="confirm-dialog__title">回滚工作区文件</h2>
        </div>
        <p className="confirm-dialog__text">
          将把工作区文件还原到快照<strong>「{pending.label}」</strong>。此操作会用快照内容覆盖现有文件，
          不会改动当前对话历史。
        </p>
        <div className="confirm-dialog__fields">
          <label className="restore-mode">
            <input
              type="radio"
              name="restore-mode"
              checked={mode === 'conservative'}
              onChange={() => setMode('conservative')}
            />
            <span className="restore-mode__label">保守还原（默认）</span>
            <span className="restore-mode__desc">{MODE_DESC.conservative}</span>
          </label>
          <label className="restore-mode">
            <input
              type="radio"
              name="restore-mode"
              checked={mode === 'full'}
              onChange={() => setMode('full')}
            />
            <span className="restore-mode__label">完全还原</span>
            <span className="restore-mode__desc">{MODE_DESC.full}</span>
          </label>
        </div>
        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-actions__btn confirm-actions__btn--deny"
            onClick={cancel}
          >
            取消
          </button>
          <button
            type="button"
            className="confirm-actions__btn confirm-actions__btn--allow"
            onClick={confirm}
          >
            确认回滚
          </button>
        </div>
      </div>
    </div>
  )
}

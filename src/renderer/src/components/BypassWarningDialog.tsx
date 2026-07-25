import { useChatStore } from '../stores/chat'

// One-time danger confirmation shown the first time the user toggles into
// bypass mode (and only the first time — bypassAcknowledged is sticky). Reuses
// the ConfirmDialog CSS so no new styles are needed. Clicking the overlay
// cancels (default-safe for a dangerous action).
export function BypassWarningDialog() {
  const open = useChatStore(s => s.pendingBypassWarning)
  const confirmBypass = useChatStore(s => s.confirmBypass)
  const cancelBypass = useChatStore(s => s.cancelBypass)

  if (!open) return null

  return (
    <div className="confirm-overlay" onClick={() => cancelBypass()}>
      <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
        <div className="confirm-dialog__header">
          <span className="confirm-dialog__icon" aria-hidden>
            ⚠
          </span>
          <h2 className="confirm-dialog__title">免确认模式</h2>
        </div>
        <p className="confirm-dialog__text">
          开启后，Agent 在本工作区执行 <strong>Shell 命令</strong>与<strong>删除文件</strong>时将不再弹窗确认，委派的子 Agent 调用也会一并自动放行。
        </p>
        <p className="confirm-dialog__text">
          这意味着它能直接运行 <code>rm -rf</code>、覆盖文件、启动后台进程等操作，无需你逐一批准。请仅在你信任当前 workspace、并接受其后果时开启。
        </p>
        <p className="confirm-dialog__text">
          workspace 沙箱仍然生效：文件路径被限制在工作区内、Shell 仍以工作区为当前目录。
        </p>
        <p className="confirm-dialog__text">
          确认后将记住选择，后续切换到免确认模式不再提示；可随时切回执行模式。
        </p>
        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-actions__btn confirm-actions__btn--deny"
            onClick={() => cancelBypass()}
          >
            取消
          </button>
          <button
            type="button"
            className="confirm-actions__btn confirm-actions__btn--allow"
            onClick={() => void confirmBypass()}
          >
            我已了解，开启
          </button>
        </div>
      </div>
    </div>
  )
}

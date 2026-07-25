import { useChatStore } from '../stores/chat'

const STAGE_LABEL: Record<string, string> = {
  collecting: '收集对话历史',
  summarizing: '调用模型总结',
  replacing: '替换历史'
}

// compact(对话压缩)状态横幅。进行中时显示阶段 + 进度条;失败时显示错误
// 提示 + 关闭按钮。手动 /compact 与自动触发共用同一套状态(compact 字段)。
// 进度是阶段式估算(percent 由后端 compact-progress 事件给出),非精确 token
// 进度——"调用模型总结"阶段没有天然百分比,用一个不确定宽度的呼吸动画兜底。
export function CompactBanner() {
  const compact = useChatStore(s => s.compactState)
  const compactError = useChatStore(s => s.compactError)
  const dismiss = useChatStore(s => s.dismissCompactError)

  if (compact?.active) {
    const percent = compact.percent
    const indeterminate = compact.stage === 'summarizing'
    return (
      <div className="compact-banner compact-banner--active" role="status" aria-live="polite">
        <div className="compact-banner__head">
          <span className="compact-banner__spinner" aria-hidden />
          <span className="compact-banner__title">
            正在压缩对话
            {compact.stage ? ` · ${STAGE_LABEL[compact.stage] ?? compact.stage}` : '…'}
          </span>
        </div>
        <div className="compact-banner__bar" aria-hidden>
          {indeterminate ? (
            <span className="compact-banner__fill compact-banner__fill--indeterminate" />
          ) : (
            <span
              className="compact-banner__fill"
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          )}
        </div>
        {!indeterminate && (
          <span className="compact-banner__pct">{Math.min(100, Math.max(0, percent))}%</span>
        )}
      </div>
    )
  }

  if (compactError) {
    return (
      <div className="compact-banner compact-banner--error" role="alert">
        <span className="compact-banner__title">
          ⚠️ 对话压缩失败：{compactError}
        </span>
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

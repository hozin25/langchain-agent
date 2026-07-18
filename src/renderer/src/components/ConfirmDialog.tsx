import { useState } from 'react'
import { useChatStore } from '../stores/chat'

const TOOL_LABELS: Record<string, string> = {
  delete_file: '删除文件',
  run_shell_command: '运行 Shell 命令'
}

interface Field {
  label: string
  value: string
}

function describeInput(tool: string, input: unknown): Field[] {
  const obj = (input ?? {}) as Record<string, unknown>
  if (tool === 'run_shell_command') {
    const fields: Field[] = [{ label: '命令', value: String(obj['command'] ?? '') }]
    if (obj['background']) fields.push({ label: '后台运行', value: '是' })
    return fields
  }
  if (tool === 'delete_file') {
    return [{ label: '路径', value: String(obj['path'] ?? '') }]
  }
  return Object.entries(obj).map(([k, v]) => ({
    label: k,
    value: typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  }))
}

export function ConfirmDialog() {
  const pending = useChatStore(s => s.pendingConfirm)
  const respond = useChatStore(s => s.respondConfirmation)
  const [remember, setRemember] = useState(false)

  if (!pending) return null

  const label = TOOL_LABELS[pending.tool] ?? pending.tool
  const fields = describeInput(pending.tool, pending.input)
  const decide = (approved: boolean): void => {
    respond(approved, remember)
    setRemember(false)
  }

  return (
    <div className="confirm-overlay" onClick={() => decide(false)}>
      <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
        <div className="confirm-dialog__header">
          <span className="confirm-dialog__icon" aria-hidden>
            ⚠
          </span>
          <h2 className="confirm-dialog__title">{label}</h2>
        </div>
        <p className="confirm-dialog__text">
          {pending.agentName ? `${pending.agentName} 想执行以下操作` : 'Agent 想执行以下操作'}
          ，请确认是否允许。
        </p>
        <div className="confirm-dialog__fields">
          {fields.map(f => (
            <div key={f.label} className="confirm-field">
              <span className="confirm-field__label">{f.label}</span>
              <pre className="confirm-field__value">{f.value}</pre>
            </div>
          ))}
        </div>
        <label className="confirm-dialog__remember">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          下次相同的操作不再提示
        </label>
        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-actions__btn confirm-actions__btn--deny"
            onClick={() => decide(false)}
          >
            拒绝
          </button>
          <button
            type="button"
            className="confirm-actions__btn confirm-actions__btn--allow"
            onClick={() => decide(true)}
          >
            允许
          </button>
        </div>
      </div>
    </div>
  )
}

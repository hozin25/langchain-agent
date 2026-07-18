import { useState, type FormEvent } from 'react'
import { useChatStore } from '../stores/chat'
import type { FileAttachment } from '@shared/types'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function MessageInput({ disabled }: { disabled: boolean }) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const send = useChatStore(s => s.send)
  const isRunning = useChatStore(s => s.isRunning)
  const interrupt = useChatStore(s => s.interrupt)
  const models = useChatStore(s => s.models)
  const modelId = useChatStore(s => s.modelId)
  const setModelId = useChatStore(s => s.setModelId)
  const contextUsed = useChatStore(s => s.contextUsed)
  const contextMax = useChatStore(s => s.contextMax)

  const pickFile = async (): Promise<void> => {
    const res = await window.api.file.select()
    if (!res.canceled && res.files.length > 0) {
      setAttachments(prev => {
        const seen = new Set(prev.map(a => a.path))
        return [...prev, ...res.files.filter(f => !seen.has(f.path))]
      })
    }
  }

  const removeAttachment = (path: string): void => {
    setAttachments(prev => prev.filter(a => a.path !== path))
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    const value = text.trim()
    if (!value || disabled) return
    setText('')
    setAttachments([])
    void send(value, attachments)
  }

  return (
    <form className="input" onSubmit={onSubmit}>
      <div className="input__column">
        <div className="input__toolbar">
          <select
            className="input__model"
            value={modelId}
            onChange={e => setModelId(e.target.value)}
            disabled={models.length === 0}
            aria-label="Select model"
          >
            {models.length === 0 ? (
              <option value="">Loading…</option>
            ) : (
              models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            className="input__attach"
            onClick={() => void pickFile()}
            disabled={disabled}
            aria-label="Attach file"
            title="Attach file"
          >
            +
          </button>
          {contextMax > 0 &&
            (() => {
              const pct = Math.round((contextUsed / contextMax) * 100)
              const danger =
                pct > 80 ? ' input__context--danger' : pct > 60 ? ' input__context--warn' : ''
              return (
                <span
                  className={`input__context${danger}`}
                  title={`上下文用量: ${formatTokens(contextUsed)} / ${formatTokens(contextMax)} (${pct}%)`}
                >
                  <span className="input__context-bar">
                    <span
                      className="input__context-fill"
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </span>
                  <span className="input__context-text">
                    {formatTokens(contextUsed)} / {formatTokens(contextMax)} ({pct}%)
                  </span>
                </span>
              )
            })()}
        </div>
        {attachments.length > 0 && (
          <div className="input__attachments">
            {attachments.map(a => (
              <span key={a.path} className="input__chip">
                <span className="input__chip-name">📄 {a.name}</span>
                <button
                  type="button"
                  className="input__chip-remove"
                  onClick={() => removeAttachment(a.path)}
                  aria-label={`Remove ${a.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="input__row">
          <textarea
            className="input__field"
            placeholder={
              disabled ? 'Select a workspace first…' : 'Describe what you want the agent to do…'
            }
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onSubmit(e)
              }
            }}
            rows={3}
            disabled={disabled}
          />
          {isRunning ? (
            <button
              type="button"
              className="input__send input__send--stop"
              onClick={() => interrupt()}
              aria-label="停止生成"
              title="停止生成"
            >
              ■ 停止
            </button>
          ) : (
            <button className="input__send" type="submit" disabled={disabled || !text.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </form>
  )
}

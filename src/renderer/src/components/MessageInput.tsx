import { useState, type FormEvent } from 'react'
import { useChatStore } from '../stores/chat'

export function MessageInput({ disabled }: { disabled: boolean }) {
  const [text, setText] = useState('')
  const send = useChatStore(s => s.send)
  const models = useChatStore(s => s.models)
  const modelId = useChatStore(s => s.modelId)
  const setModelId = useChatStore(s => s.setModelId)

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    const value = text.trim()
    if (!value || disabled) return
    setText('')
    void send(value)
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
        </div>
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
          <button className="input__send" type="submit" disabled={disabled || !text.trim()}>
            Send
          </button>
        </div>
      </div>
    </form>
  )
}

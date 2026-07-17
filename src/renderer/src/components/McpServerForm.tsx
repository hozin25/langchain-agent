import { useState, useEffect } from 'react'
import type { McpServerConfig } from '@shared/types'

interface McpServerFormProps {
  server: McpServerConfig | null
  onSave: (config: McpServerConfig | Omit<McpServerConfig, 'id'>) => void
  onCancel: () => void
}

export function McpServerForm({ server, onSave, onCancel }: McpServerFormProps) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    if (server) {
      setName(server.name)
      setCommand(server.command)
      setArgsText(server.args.join('\n'))
      setEnvText(
        server.env
          ? Object.entries(server.env)
              .map(([k, v]) => `${k}=${v}`)
              .join('\n')
          : ''
      )
      setEnabled(server.enabled)
    } else {
      setName('')
      setCommand('')
      setArgsText('')
      setEnvText('')
      setEnabled(true)
    }
  }, [server])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const args = argsText
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0)

    const env: Record<string, string> = {}
    for (const line of envText.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 0) continue
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
    }

    const config = server
      ? { id: server.id, name, command, args, env: Object.keys(env).length > 0 ? env : undefined, enabled }
      : { name, command, args, env: Object.keys(env).length > 0 ? env : undefined, enabled }

    onSave(config as McpServerConfig)
  }

  return (
    <form className="settings-form" onSubmit={onSubmit}>
      <label className="settings-form__label">
        Name
        <input
          className="settings-form__input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. filesystem"
          required
        />
      </label>

      <label className="settings-form__label">
        Command
        <input
          className="settings-form__input"
          value={command}
          onChange={e => setCommand(e.target.value)}
          placeholder="e.g. npx"
          required
        />
      </label>

      <label className="settings-form__label">
        Arguments (one per line)
        <textarea
          className="settings-form__textarea"
          value={argsText}
          onChange={e => setArgsText(e.target.value)}
          placeholder={"-y\n@anthropic/mcp-server-filesystem\n/path/to/dir"}
          rows={4}
        />
      </label>

      <label className="settings-form__label">
        Environment variables (KEY=VALUE, one per line)
        <textarea
          className="settings-form__textarea"
          value={envText}
          onChange={e => setEnvText(e.target.value)}
          placeholder="API_KEY=sk-..."
          rows={3}
        />
      </label>

      <label className="settings-form__checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
        />
        Enabled
      </label>

      <div className="settings-form__actions">
        <button type="button" className="settings-form__btn settings-form__btn--cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="settings-form__btn settings-form__btn--save">
          Save
        </button>
      </div>
    </form>
  )
}

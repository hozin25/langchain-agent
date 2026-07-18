import { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settings'
import { useChatStore } from '../stores/chat'
import type { AgentRole } from '@shared/types'

// The full built-in tool whitelist. Must stay in sync with the TOOL_FACTORIES
// keys in src/main/agent/tools/subTools.ts. MCP tool names are dynamic and come
// from the settings store (mcp:listToolNames).
const BUILTIN_TOOLS: { name: string; label: string }[] = [
  { name: 'read_file', label: '读取文件' },
  { name: 'write_file', label: '写入文件' },
  { name: 'edit_file', label: '编辑文件' },
  { name: 'list_directory', label: '列目录' },
  { name: 'create_directory', label: '创建目录' },
  { name: 'move_file', label: '移动文件' },
  { name: 'delete_file', label: '删除文件' },
  { name: 'glob', label: '按名搜索文件' },
  { name: 'grep', label: '按内容搜索' },
  { name: 'web_fetch', label: '抓取网页' },
  { name: 'web_search', label: '网页搜索' },
  { name: 'todo_write', label: '任务清单' },
  { name: 'run_shell_command', label: '执行 Shell' }
]

interface AgentRoleFormProps {
  role: AgentRole | null
  onSave: (config: AgentRole | Omit<AgentRole, 'id' | 'builtin'>) => void
  onCancel: () => void
}

export function AgentRoleForm({ role, onSave, onCancel }: AgentRoleFormProps) {
  const models = useChatStore(s => s.models)
  const mcpToolNames = useSettingsStore(s => s.toolNames)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [allowedTools, setAllowedTools] = useState<string[]>([])
  const [inheritModel, setInheritModel] = useState(true)
  const [modelId, setModelId] = useState('')

  useEffect(() => {
    if (role) {
      setName(role.name)
      setDescription(role.description)
      setSystemPrompt(role.systemPrompt)
      setAllowedTools(role.allowedTools)
      const hasOwnModel = typeof role.modelId === 'string' && role.modelId.length > 0
      setInheritModel(!hasOwnModel)
      setModelId(hasOwnModel ? (role.modelId as string) : '')
    } else {
      setName('')
      setDescription('')
      setSystemPrompt('')
      setAllowedTools([])
      setInheritModel(true)
      setModelId('')
    }
  }, [role])

  const toggleTool = (toolName: string): void => {
    setAllowedTools(prev =>
      prev.includes(toolName) ? prev.filter(t => t !== toolName) : [...prev, toolName]
    )
  }

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    const finalModelId = inheritModel ? undefined : modelId
    const base = {
      name: name.trim(),
      description: description.trim(),
      systemPrompt,
      allowedTools,
      modelId: finalModelId
    }
    if (role) {
      onSave({ ...base, id: role.id, builtin: role.builtin ?? false })
    } else {
      onSave(base)
    }
  }

  return (
    <form className="settings-form" onSubmit={onSubmit}>
      <label className="settings-form__label">
        Name
        <input
          className="settings-form__input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Researcher"
          required
        />
      </label>

      <label className="settings-form__label">
        Description
        <input
          className="settings-form__input"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="One line: what this role is good at (shown to the main agent)"
          required
        />
      </label>

      <label className="settings-form__label">
        Model
        <select
          className="settings-form__input"
          value={inheritModel ? '__inherit__' : modelId}
          onChange={e => {
            const v = e.target.value
            if (v === '__inherit__') {
              setInheritModel(true)
            } else {
              setInheritModel(false)
              setModelId(v)
            }
          }}
        >
          <option value="__inherit__">继承主模型</option>
          {models.map(m => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      <div className="settings-form__label">
        Allowed tools
        <div className="settings-form__tools">
          {BUILTIN_TOOLS.map(t => (
            <label key={t.name} className="settings-form__checkbox">
              <input
                type="checkbox"
                checked={allowedTools.includes(t.name)}
                onChange={() => toggleTool(t.name)}
              />
              <code>{t.name}</code>
              <span className="settings-form__tool-label">{t.label}</span>
            </label>
          ))}
          {mcpToolNames.map(t => (
            <label key={t} className="settings-form__checkbox">
              <input type="checkbox" checked={allowedTools.includes(t)} onChange={() => toggleTool(t)} />
              <code>{t}</code>
            </label>
          ))}
        </div>
      </div>

      <label className="settings-form__label">
        System prompt
        <textarea
          className="settings-form__textarea"
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          placeholder="Instructions that shape this role's behavior…"
          rows={6}
          required
        />
      </label>

      <div className="settings-form__actions">
        <button
          type="button"
          className="settings-form__btn settings-form__btn--cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="submit" className="settings-form__btn settings-form__btn--save">
          Save
        </button>
      </div>
    </form>
  )
}

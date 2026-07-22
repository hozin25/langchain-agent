import { useSettingsStore } from '../stores/settings'
import { McpServerForm } from './McpServerForm'
import { AgentRoleForm } from './AgentRoleForm'
import { SkillForm } from './SkillForm'
import type { AgentRole, McpServerConfig, McpServerStateEntry, SkillConfig } from '@shared/types'

function statusColor(status: McpServerStateEntry['status']): string {
  switch (status) {
    case 'connected':
      return 'var(--success)'
    case 'connecting':
      return 'var(--warning)'
    case 'error':
      return 'var(--danger)'
    default:
      return 'var(--text-muted)'
  }
}

export function SettingsPanel() {
  const isOpen = useSettingsStore(s => s.isOpen)
  const close = useSettingsStore(s => s.close)
  const servers = useSettingsStore(s => s.servers)
  const statuses = useSettingsStore(s => s.serverStatuses)
  const editingServer = useSettingsStore(s => s.editingServer)
  const startEditing = useSettingsStore(s => s.startEditing)
  const deleteServer = useSettingsStore(s => s.deleteServer)
  const addServer = useSettingsStore(s => s.addServer)
  const updateServer = useSettingsStore(s => s.updateServer)

  const roles = useSettingsStore(s => s.roles)
  const editingRole = useSettingsStore(s => s.editingRole)
  const startEditingRole = useSettingsStore(s => s.startEditingRole)
  const addRole = useSettingsStore(s => s.addRole)
  const updateRole = useSettingsStore(s => s.updateRole)
  const removeRole = useSettingsStore(s => s.removeRole)
  const resetBuiltinRoles = useSettingsStore(s => s.resetBuiltinRoles)

  const skills = useSettingsStore(s => s.skills)
  const editingSkill = useSettingsStore(s => s.editingSkill)
  const startEditingSkill = useSettingsStore(s => s.startEditingSkill)
  const addSkill = useSettingsStore(s => s.addSkill)
  const updateSkill = useSettingsStore(s => s.updateSkill)
  const removeSkill = useSettingsStore(s => s.removeSkill)

  if (!isOpen) return null

  const getStatus = (id: string) => statuses.find(s => s.configId === id)

  const onSave = (config: McpServerConfig | Omit<McpServerConfig, 'id'>) => {
    if ('id' in config) {
      void updateServer(config)
    } else {
      void addServer(config)
    }
  }

  const onSaveRole = (config: AgentRole | Omit<AgentRole, 'id' | 'builtin'>) => {
    if ('id' in config) {
      void updateRole(config)
    } else {
      void addRole(config)
    }
  }

  const onSaveSkill = (config: SkillConfig | Omit<SkillConfig, 'id'>) => {
    if ('id' in config) {
      void updateSkill(config)
    } else {
      void addSkill(config)
    }
  }

  const hasBuiltinRole = roles.some(r => r.builtin)

  return (
    <div className="settings-overlay" onClick={close}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2 className="settings-header__title">Settings</h2>
          <button className="settings-header__close" onClick={close} aria-label="Close settings">
            &times;
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-section">
            <h3 className="settings-section__title">MCP Servers</h3>

            {servers.length === 0 && !editingServer ? (
              <div className="settings-empty">
                No MCP servers configured. Add one to extend the agent with external tools.
              </div>
            ) : (
              <div className="settings-list">
                {servers.map(server => {
                  const status = getStatus(server.id)
                  return (
                    <div key={server.id} className="settings-server">
                      <span
                        className="status-dot"
                        style={{ background: statusColor(status?.status ?? 'disconnected') }}
                        title={status?.status ?? 'disconnected'}
                      />
                      <div className="settings-server__info">
                        <span className="settings-server__name">{server.name}</span>
                        <span className="settings-server__meta">
                          {server.enabled ? (status?.toolCount ?? 0) + ' tools' : 'disabled'}
                          {status?.error ? ` — ${status.error}` : ''}
                        </span>
                      </div>
                      <button
                        className="settings-server__btn"
                        title="Edit"
                        onClick={() => startEditing(server)}
                      >
                        Edit
                      </button>
                      <button
                        className="settings-server__btn settings-server__btn--danger"
                        title="Delete"
                        onClick={() => {
                          if (window.confirm(`Delete "${server.name}"?`)) {
                            void deleteServer(server.id)
                          }
                        }}
                      >
                        Del
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {editingServer === null && (
              <button
                className="settings-add-btn"
                onClick={() =>
                  startEditing({ id: '', name: '', command: '', args: [], enabled: true })
                }
              >
                + Add Server
              </button>
            )}

            {editingServer !== null && (
              <McpServerForm
                server={editingServer.id ? editingServer : null}
                onSave={onSave}
                onCancel={() => startEditing(null)}
              />
            )}
          </div>

          <div className="settings-section">
            <h3 className="settings-section__title">Skills</h3>

            {skills.length === 0 && !editingSkill ? (
              <div className="settings-empty">
                No skills configured. Add a skill (name + description + a Markdown file) so the
                agent can discover and load it via list_skills / read_skill.
              </div>
            ) : (
              <div className="settings-list">
                {skills.map(skill => (
                  <div key={skill.id} className="settings-server">
                    <span
                      className="status-dot"
                      style={{ background: skill.enabled ? 'var(--accent)' : 'var(--text-muted)' }}
                      title={skill.enabled ? 'enabled' : 'disabled'}
                    />
                    <div className="settings-server__info">
                      <span className="settings-server__name">
                        {skill.name}
                        {!skill.enabled && <span className="settings-role__badge">disabled</span>}
                      </span>
                      <span className="settings-server__meta">{skill.description}</span>
                    </div>
                    <button
                      className="settings-server__btn"
                      title="Edit"
                      onClick={() => startEditingSkill(skill)}
                    >
                      Edit
                    </button>
                    <button
                      className="settings-server__btn settings-server__btn--danger"
                      title="Delete"
                      onClick={() => {
                        if (window.confirm(`Delete skill "${skill.name}"?`)) {
                          void removeSkill(skill.id)
                        }
                      }}
                    >
                      Del
                    </button>
                  </div>
                ))}
              </div>
            )}

            {editingSkill === null && (
              <button
                className="settings-add-btn"
                onClick={() =>
                  startEditingSkill({ id: '', name: '', description: '', filePath: '', enabled: true })
                }
              >
                + Add Skill
              </button>
            )}

            {editingSkill !== null && (
              <SkillForm
                skill={editingSkill.id ? editingSkill : null}
                onSave={onSaveSkill}
                onCancel={() => startEditingSkill(null)}
              />
            )}
          </div>

          <div className="settings-section">
            <h3 className="settings-section__title">Agents / Roles</h3>

            {roles.length === 0 && !editingRole ? (
              <div className="settings-empty">No roles configured.</div>
            ) : (
              <div className="settings-list">
                {roles.map(role => (
                  <div key={role.id} className="settings-server">
                    <span className="status-dot" style={{ background: 'var(--accent)' }} />
                    <div className="settings-server__info">
                      <span className="settings-server__name">
                        {role.name}
                        {role.builtin && <span className="settings-role__badge">built-in</span>}
                      </span>
                      <span className="settings-server__meta">
                        {role.allowedTools.length} tools · {role.modelId ?? 'inherit model'}
                      </span>
                    </div>
                    <button
                      className="settings-server__btn"
                      title="Edit"
                      onClick={() => startEditingRole(role)}
                    >
                      Edit
                    </button>
                    {!role.builtin && (
                      <button
                        className="settings-server__btn settings-server__btn--danger"
                        title="Delete"
                        onClick={() => {
                          if (window.confirm(`Delete role "${role.name}"?`)) {
                            void removeRole(role.id)
                          }
                        }}
                      >
                        Del
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {editingRole === null && (
              <button
                className="settings-add-btn"
                onClick={() =>
                  startEditingRole({
                    id: '',
                    name: '',
                    description: '',
                    systemPrompt: '',
                    allowedTools: [],
                    builtin: false
                  })
                }
              >
                + Add Role
              </button>
            )}

            {editingRole === null && hasBuiltinRole && (
              <button
                className="settings-link-btn"
                onClick={() => {
                  if (window.confirm('Reset all built-in roles to their defaults?')) {
                    void resetBuiltinRoles()
                  }
                }}
              >
                重置内置角色
              </button>
            )}

            {editingRole !== null && (
              <AgentRoleForm
                role={editingRole.id ? editingRole : null}
                onSave={onSaveRole}
                onCancel={() => startEditingRole(null)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

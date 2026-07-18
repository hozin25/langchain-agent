import { useSettingsStore } from '../stores/settings'
import { McpServerForm } from './McpServerForm'
import type { McpServerConfig, McpServerStateEntry } from '@shared/types'

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

  if (!isOpen) return null

  const getStatus = (id: string) => statuses.find(s => s.configId === id)

  const onSave = (config: McpServerConfig | Omit<McpServerConfig, 'id'>) => {
    if ('id' in config) {
      void updateServer(config)
    } else {
      void addServer(config)
    }
  }

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
        </div>
      </div>
    </div>
  )
}

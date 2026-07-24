import { useEffect, useState } from 'react'
import { useChatStore } from '../stores/chat'
import { useSettingsStore } from '../stores/settings'
import { useThemeStore } from '../stores/theme'
import { formatRelative } from '../utils/time'

export function Sidebar() {
  const workspace = useChatStore(s => s.workspace)
  const setWorkspace = useChatStore(s => s.setWorkspace)
  const conversations = useChatStore(s => s.conversations)
  const currentConversationId = useChatStore(s => s.currentConversationId)
  const isRunning = useChatStore(s => s.isRunning)
  const startNewConversation = useChatStore(s => s.startNewConversation)
  const openConversation = useChatStore(s => s.openConversation)
  const deleteConversation = useChatStore(s => s.deleteConversation)
  const openSettings = useSettingsStore(s => s.open)
  const theme = useThemeStore(s => s.theme)
  const toggleTheme = useThemeStore(s => s.toggle)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.api.app.version().then(setVersion)
  }, [])

  const onSelect = async () => {
    const res = await window.api.workspace.select()
    if (!res.canceled && res.path) await setWorkspace(res.path)
  }

  const onDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (window.confirm('Delete this conversation? This cannot be undone.')) {
      void deleteConversation(id)
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__logo">⬡</span>
        <span className="sidebar__title">Code Agent</span>
      </div>

      <section className="sidebar__section">
        <div className="sidebar__label">Workspace</div>
        <button
          className="sidebar__btn"
          onClick={onSelect}
          title={workspace ?? ''}
          disabled={isRunning}
        >
          {workspace ? workspace : 'Select folder…'}
        </button>
      </section>

      <section className="sidebar__section">
        <button
          className="sidebar__btn sidebar__btn--ghost"
          onClick={startNewConversation}
          disabled={!workspace || isRunning}
        >
          + New conversation
        </button>
      </section>

      <section className="sidebar__section sidebar__history">
        <div className="sidebar__label">History</div>
        <div className="history__list">
          {!workspace ? (
            <div className="history__empty">Select a folder to see its conversations.</div>
          ) : conversations.length === 0 ? (
            <div className="history__empty">No conversations yet.</div>
          ) : (
            conversations.map(c => (
              <button
                key={c.id}
                className={`history__item${c.id === currentConversationId ? ' history__item--active' : ''}`}
                onClick={() => openConversation(c.id)}
                title={new Date(c.updatedAt).toLocaleString()}
                disabled={isRunning}
              >
                <span className="history__title">{c.title}</span>
                <span className="history__time">{formatRelative(c.updatedAt)}</span>
                <span
                  className="history__del"
                  role="button"
                  aria-label="Delete conversation"
                  tabIndex={-1}
                  onClick={e => onDelete(e, c.id)}
                >
                  ×
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <footer className="sidebar__footer">
        <button
          className="sidebar__theme-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? '🌙' : '☀️'}
        </button>
        <button className="sidebar__btn sidebar__btn--ghost" onClick={openSettings}>
          Settings
        </button>
        <span className="sidebar__version">v{version || '0.0.0'}</span>
      </footer>
    </aside>
  )
}

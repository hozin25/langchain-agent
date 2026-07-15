import { useEffect, useState } from 'react'
import { useChatStore } from '../stores/chat'

export function Sidebar() {
  const workspace = useChatStore(s => s.workspace)
  const setWorkspace = useChatStore(s => s.setWorkspace)
  const clear = useChatStore(s => s.clear)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.api.app.version().then(setVersion)
  }, [])

  const onSelect = async () => {
    const res = await window.api.workspace.select()
    if (!res.canceled && res.path) setWorkspace(res.path)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__logo">⬢</span>
        <span className="sidebar__title">Code Agent</span>
      </div>

      <section className="sidebar__section">
        <div className="sidebar__label">Workspace</div>
        <button className="sidebar__btn" onClick={onSelect} title={workspace ?? ''}>
          {workspace ? workspace : 'Select folder…'}
        </button>
      </section>

      <section className="sidebar__section">
        <button className="sidebar__btn sidebar__btn--ghost" onClick={clear}>
          Clear conversation
        </button>
      </section>

      <footer className="sidebar__footer">v{version || '0.0.0'}</footer>
    </aside>
  )
}

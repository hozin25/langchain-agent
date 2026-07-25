import { useState } from 'react'
import type { TodoItem } from '@shared/types'

export function TodoList({ todos }: { todos: TodoItem[] }) {
  const [collapsed, setCollapsed] = useState(false)

  if (todos.length === 0) return null

  const mark = (status: TodoItem['status']): string => {
    if (status === 'completed') return '✓'
    if (status === 'in_progress') return '▶'
    return '○'
  }

  const doneCount = todos.filter(t => t.status === 'completed').length

  return (
    <div className={`todos${collapsed ? ' todos--collapsed' : ''}`} aria-live="polite">
      <button
        type="button"
        className="todos__title"
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
        title={collapsed ? '展开 Tasks' : '收起 Tasks'}
      >
        <span className="todos__title-text">Tasks</span>
        <span className="todos__title-meta">
          {doneCount}/{todos.length}
        </span>
        <span className="todos__toggle">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <ul className="todos__list">
          {todos.map(t => (
            <li key={t.id} className={`todos__item todos__item--${t.status}`}>
              <span className="todos__mark">{mark(t.status)}</span>
              <span className="todos__content">{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

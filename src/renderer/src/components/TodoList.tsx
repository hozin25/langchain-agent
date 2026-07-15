import type { TodoItem } from '@shared/types'

export function TodoList({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null

  const mark = (status: TodoItem['status']): string => {
    if (status === 'completed') return '✓'
    if (status === 'in_progress') return '▶'
    return '○'
  }

  return (
    <div className="todos" aria-live="polite">
      <div className="todos__title">Tasks</div>
      <ul className="todos__list">
        {todos.map(t => (
          <li key={t.id} className={`todos__item todos__item--${t.status}`}>
            <span className="todos__mark">{mark(t.status)}</span>
            <span className="todos__content">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

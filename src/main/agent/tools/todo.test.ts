import { describe, it, expect, vi } from 'vitest'
import type { AgentEvent } from '@shared/types'
import { makeTodoWrite } from './todo'

describe('todo_write', () => {
  it('emits a todo-update event with the provided list', async () => {
    const emitted: AgentEvent[] = []
    const t = makeTodoWrite(e => emitted.push(e))
    const out = await t.invoke({
      todos: [
        { id: '1', content: 'first', status: 'pending' },
        { id: '2', content: 'second', status: 'in_progress' }
      ]
    })
    expect(out).toBe('Updated 2 todos')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      type: 'todo-update',
      todos: [
        { id: '1', content: 'first', status: 'pending' },
        { id: '2', content: 'second', status: 'in_progress' }
      ]
    })
  })

  it('handles an empty list', async () => {
    const emit = vi.fn()
    const t = makeTodoWrite(emit)
    const out = await t.invoke({ todos: [] })
    expect(out).toBe('Updated 0 todos')
    expect(emit).toHaveBeenCalledWith({ type: 'todo-update', todos: [] })
  })

  it('rejects an invalid status', async () => {
    const t = makeTodoWrite(() => {})
    await expect(
      t.invoke({ todos: [{ id: '1', content: 'x', status: 'bogus' as unknown as 'pending' }] })
    ).rejects.toThrow()
  })
})

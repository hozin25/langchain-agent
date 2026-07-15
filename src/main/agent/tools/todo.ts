import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { AgentEvent } from '@shared/types'

export const makeTodoWrite = (emit: (event: AgentEvent) => void) =>
  tool(
    async ({ todos }) => {
      emit({ type: 'todo-update', todos })
      return `Updated ${todos.length} todo${todos.length === 1 ? '' : 's'}`
    },
    {
      name: 'todo_write',
      description:
        'Create or update the task list for the current run. Pass the FULL list each call (it replaces the previous list). Use for multi-step tasks: plan upfront, keep exactly one item in_progress while working on it, mark items completed when done.',
      schema: z.object({
        todos: z
          .array(
            z.object({
              id: z.string(),
              content: z.string(),
              status: z.enum(['pending', 'in_progress', 'completed'])
            })
          )
          .describe('Full task list; replaces the previous list on every call')
      })
    }
  )

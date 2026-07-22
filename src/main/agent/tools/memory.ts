import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { MemoryStore } from '../memory'

// Saves a durable fact scoped to the current workspace so it is pre-loaded into
// the system prompt on future runs. The memory section already in the system
// prompt is listed there — the model must not re-save what is already known.
export const makeSaveMemory = (workspace: string, store: MemoryStore) =>
  tool(
    async ({ content }) => {
      const entry = await store.add(workspace, content)
      return `Saved memory entry (${entry.id}). It will be pre-loaded on future conversations in this workspace.`
    },
    {
      name: 'save_memory',
      description:
        'Save a durable long-term fact about THIS workspace (a user preference, project convention, or long-lived constraint) so it is automatically recalled in future conversations. Keep it concise and general. Do NOT store transient task progress, one-off answers, or conversation-specific details. Anything already shown in the pre-loaded memory section below must NOT be re-saved.',
      schema: z.object({
        content: z
          .string()
          .min(1)
          .describe('A concise durable fact to remember across conversations in this workspace')
      })
    }
  )
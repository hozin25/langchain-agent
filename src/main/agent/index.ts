import { AIMessage, ToolMessage } from '@langchain/core/messages'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { createLlm } from './llm'
import { getTools } from './tools'
import { SYSTEM_PROMPT } from './prompts'
import type { AgentEvent } from '@shared/types'

export interface AgentRunOptions {
  message: string
  workspace: string
  modelId?: string
  onEvent: (event: AgentEvent) => void
}

export async function runAgent({ message, workspace, modelId, onEvent }: AgentRunOptions): Promise<void> {
  try {
    const llm = createLlm(modelId)
    const tools = getTools(workspace)
    const agent = createReactAgent({
      llm,
      tools,
      prompt: SYSTEM_PROMPT
    })

    const stream = await agent.stream(
      { messages: [{ role: 'user', content: message }] },
      { streamMode: 'values' }
    )

    for await (const chunk of stream) {
      const messages = chunk.messages ?? []
      const last = messages[messages.length - 1]
      if (!last) continue

      if (last instanceof AIMessage) {
        if (last.tool_calls && last.tool_calls.length > 0) {
          for (const tc of last.tool_calls) {
            onEvent({ type: 'tool-start', tool: tc.name, input: tc.args })
          }
        }
        if (typeof last.content === 'string' && last.content.length > 0) {
          onEvent({ type: 'message', content: last.content })
        }
      } else if (last instanceof ToolMessage) {
        onEvent({
          type: 'tool-end',
          tool: last.name ?? 'tool',
          output: typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
        })
      }
    }
    onEvent({ type: 'done' })
  } catch (err) {
    onEvent({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

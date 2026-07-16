import {
  AIMessage,
  BaseMessage,
  ToolMessage,
  isAIMessage,
  isToolMessage
} from '@langchain/core/messages'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { readFile } from 'node:fs/promises'
import { createLlm } from './llm'
import { getTools } from './tools'
import { SYSTEM_PROMPT } from './prompts'
import type { AgentEvent, FileAttachment } from '@shared/types'

export interface AgentRunOptions {
  message: string
  workspace: string
  modelId?: string
  attachments?: FileAttachment[]
  onEvent: (event: AgentEvent) => void
}

const MAX_ATTACH_BYTES = 512 * 1024
const RECURSION_LIMIT = 50

type MessageContent = string | Array<Record<string, unknown>>

function extractText(content: MessageContent | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        if ('text' in part && typeof part['text'] === 'string') return part['text']
        if (part['type'] === 'text' && typeof part['content'] === 'string') return part['content']
      }
      return ''
    })
    .join('')
}

async function buildUserMessage(
  message: string,
  attachments: FileAttachment[] | undefined
): Promise<string> {
  if (!attachments || attachments.length === 0) {
    return message
  }

  const parts = [message]
  for (const attachment of attachments) {
    const content = await readFile(attachment.path, 'utf8')
    const trimmed =
      content.length > MAX_ATTACH_BYTES
        ? `${content.slice(0, MAX_ATTACH_BYTES)}\n…[truncated, ${content.length - MAX_ATTACH_BYTES} chars omitted]`
        : content
    parts.push(`\n\n--- file: ${attachment.name} ---\n${trimmed}\n--- end: ${attachment.name} ---`)
  }
  return parts.join('')
}

interface ValuesModeChunk {
  messages?: BaseMessage[]
}

export async function runAgent({
  message,
  workspace,
  modelId,
  attachments,
  onEvent
}: AgentRunOptions): Promise<void> {
  try {
    const llm = createLlm(modelId)
    const tools = getTools(workspace, onEvent)
    const agent = createReactAgent({
      llm,
      tools,
      prompt: SYSTEM_PROMPT
    })

    const userMessage = await buildUserMessage(message, attachments)

    // values mode yields the full message list after each ReAct superstep.
    // We dispatch off the last message: tool calls, tool results, or the final
    // text answer. Token-level streaming is intentionally off (see llm.ts).
    // Array-form streamMode yields [mode, chunk] tuples, so we unpack item[1].
    const stream = await agent.stream(
      { messages: [{ role: 'user', content: userMessage }] },
      { streamMode: ['values'], recursionLimit: RECURSION_LIMIT }
    )

    let step = 0
    for await (const item of stream as AsyncIterable<['values', ValuesModeChunk]>) {
      const messages = item[1].messages ?? []
      const last = messages[messages.length - 1]
      if (!last) continue
      step++
      const lastType = last._getType()
      const calls = 'tool_calls' in last ? (last as AIMessage).tool_calls?.length ?? 0 : 0
      console.log(`[agent] step ${step}: ${last.constructor.name} type=${lastType} calls=${calls}`)

      if (isToolMessage(last)) {
        const toolMsg = last as ToolMessage
        onEvent({
          type: 'tool-end',
          tool: toolMsg.name ?? 'tool',
          output:
            typeof toolMsg.content === 'string'
              ? toolMsg.content
              : JSON.stringify(toolMsg.content)
        })
      } else if (isAIMessage(last)) {
        const aiMsg = last as AIMessage
        if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
          for (const tc of aiMsg.tool_calls) {
            onEvent({ type: 'tool-start', tool: tc.name, input: tc.args })
          }
        } else {
          const text = extractText(aiMsg.content as MessageContent)
          if (text.length > 0) {
            console.log(`[agent] message ${text.length} chars`)
            onEvent({ type: 'message', content: text })
          } else {
            console.log('[agent] WARN: final AI message had no text content')
          }
        }
      } else if (lastType !== 'human') {
        // Defensive: some OpenAI-compatible providers mis-role the final answer
        // as a generic ChatMessage. Extract whatever text it carries so the turn
        // never ends silently with "No response received".
        const text = extractText(last.content as MessageContent)
        if (text.length > 0) {
          console.log(`[agent] message (generic) ${text.length} chars`)
          onEvent({ type: 'message', content: text })
        } else {
          console.log('[agent] WARN: generic message had no text content')
        }
      }
    }
    console.log(`[agent] done (${step} steps)`)
    onEvent({ type: 'done' })
  } catch (err) {
    console.error('[agent] error:', err)
    const isRecursionLimit =
      err instanceof Error &&
      (err as { lc_error_code?: string }).lc_error_code === 'GRAPH_RECURSION_LIMIT'
    const message = isRecursionLimit
      ? `任务步骤过多，超出上限（${RECURSION_LIMIT} 步）已停止。请尝试拆分任务或简化指令后重试。`
      : err instanceof Error
        ? err.message
        : String(err)
    onEvent({ type: 'error', message })
  }
}

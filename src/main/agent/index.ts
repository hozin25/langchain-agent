import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  ToolMessage,
  isAIMessage,
  isToolMessage
} from '@langchain/core/messages'
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

type StreamMode = 'values' | 'messages'
type StreamTuple = [StreamMode, unknown]

interface MessagesModeChunk {
  message?: AIMessageChunk
}

interface ValuesModeChunk {
  messages?: BaseMessage[]
}

type MessageTuple = [BaseMessage, Record<string, unknown>]

export async function runAgent({
  message,
  workspace,
  modelId,
  onEvent
}: AgentRunOptions): Promise<void> {
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
      { streamMode: ['values', 'messages'] }
    )

    let streamedThisStep = false
    let yieldCount = 0

    for await (const item of stream) {
      yieldCount++
      const [mode, chunk] = item as StreamTuple
      console.log(
        `[agent] yield#${yieldCount} mode=${mode}`,
        'chunkKeys=',
        chunk && typeof chunk === 'object' && !Array.isArray(chunk)
          ? Object.keys(chunk).slice(0, 5)
          : `isArray=${Array.isArray(chunk)} len=${Array.isArray(chunk) ? chunk.length : -1}`
      )

      if (mode === 'messages') {
        const tuple = chunk as MessageTuple | MessagesModeChunk
        const msg: BaseMessage | undefined = Array.isArray(tuple)
          ? tuple[0]
          : (tuple as MessagesModeChunk).message
        console.log(
          '[agent] messages branch: isArray=',
          Array.isArray(tuple),
          'msgType=',
          msg ? msg._getType() : 'MISSING',
          'ctor=',
          msg ? msg.constructor.name : 'none'
        )
        if (msg && isAIMessage(msg)) {
          const aiMsg = msg as AIMessage
          const text = typeof aiMsg.content === 'string' ? aiMsg.content : ''
          console.log('[agent] messages ai text.length=', text.length)
          if (text.length > 0) {
            onEvent({ type: 'message-delta', delta: text })
            streamedThisStep = true
          }
        }
        continue
      }

      if (mode === 'values') {
        const messages = (chunk as ValuesModeChunk).messages ?? []
        const last = messages[messages.length - 1]
        console.log(
          '[agent] values branch: msgCount=',
          messages.length,
          'lastType=',
          last ? last._getType() : 'none',
          'ctor=',
          last ? last.constructor.name : 'none',
          'isAI=',
          last ? isAIMessage(last) : false,
          'streamedThisStep=',
          streamedThisStep
        )
        if (last) {
          if (isAIMessage(last)) {
            const aiMsg = last as AIMessage
            console.log(
              '[agent] values ai: tool_calls=',
              aiMsg.tool_calls?.length ?? 0,
              'content.length=',
              typeof aiMsg.content === 'string' ? aiMsg.content.length : 'non-string'
            )
            if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
              for (const tc of aiMsg.tool_calls) {
                onEvent({ type: 'tool-start', tool: tc.name, input: tc.args })
              }
            } else if (
              !streamedThisStep &&
              typeof aiMsg.content === 'string' &&
              aiMsg.content.length > 0
            ) {
              onEvent({ type: 'message', content: aiMsg.content })
            }
          } else if (isToolMessage(last)) {
            const toolMsg = last as ToolMessage
            onEvent({
              type: 'tool-end',
              tool: toolMsg.name ?? 'tool',
              output:
                typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content)
            })
          }
        }
        streamedThisStep = false
      }
    }
    console.log('[agent] stream ended. totalYields=', yieldCount)
    onEvent({ type: 'done' })
  } catch (err) {
    console.error('[agent] runAgent threw:', err)
    onEvent({
      type: 'error',
      message: err instanceof Error ? err.message : String(err)
    })
  }
}

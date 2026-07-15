import {
  AIMessage,
  AIMessageChunk,
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
  attachments,
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

    const userMessage = await buildUserMessage(message, attachments)

    const stream = await agent.stream(
      { messages: [{ role: 'user', content: userMessage }] },
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
          const text = extractText(aiMsg.content as MessageContent)
          console.log(
            '[agent] messages ai text.length=',
            text.length,
            'contentType=',
            typeof aiMsg.content,
            Array.isArray(aiMsg.content) ? `arrLen=${aiMsg.content.length}` : ''
          )
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
            } else if (!streamedThisStep) {
              const text = extractText(aiMsg.content as MessageContent)
              console.log(
                '[agent] values ai fallback: contentType=',
                typeof aiMsg.content,
                Array.isArray(aiMsg.content) ? `arrLen=${aiMsg.content.length}` : '',
                'text.length=',
                text.length
              )
              if (text.length > 0) {
                onEvent({ type: 'message', content: text })
              }
            }
          } else if (isToolMessage(last)) {
            const toolMsg = last as ToolMessage
            onEvent({
              type: 'tool-end',
              tool: toolMsg.name ?? 'tool',
              output:
                typeof toolMsg.content === 'string'
                  ? toolMsg.content
                  : JSON.stringify(toolMsg.content)
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

import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  ToolMessage,
  isAIMessage,
  isToolMessage
} from '@langchain/core/messages'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredTool } from '@langchain/core/tools'
import { readFile } from 'node:fs/promises'
import { createLlm } from './llm'
import { getTools } from './tools'
import { SYSTEM_PROMPT } from './prompts'
import type { ConfirmFn } from './confirm'
import { estimateTokens, MODEL_MAX_CONTEXT, DEFAULT_MAX_CONTEXT } from '@shared/tokens'
import type { AgentEvent, ChatMessage, FileAttachment } from '@shared/types'

export interface AgentRunOptions {
  message: string
  workspace: string
  modelId?: string
  llm?: BaseChatModel
  attachments?: FileAttachment[]
  history?: ChatMessage[]
  signal?: AbortSignal
  onEvent: (event: AgentEvent) => void
  confirm?: ConfirmFn
  mcpTools?: StructuredTool[]
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

function buildHistoryMessages(chatMessages: ChatMessage[]): BaseMessage[] {
  const result: BaseMessage[] = []
  for (const msg of chatMessages) {
    if (msg.role === 'user') {
      result.push(new HumanMessage(msg.content))
    } else if (msg.role === 'assistant') {
      result.push(new AIMessage({ content: msg.content }))
    } else if (msg.role === 'tool') {
      // ReAct tool-use requires AIMessage(tool_calls) + ToolMessage pair
      result.push(
        new AIMessage({
          content: '',
          tool_calls: [
            {
              id: msg.toolCallId ?? '',
              name: msg.toolName ?? 'tool',
              args: (msg.toolInput as Record<string, unknown>) ?? {}
            }
          ]
        })
      )
      result.push(
        new ToolMessage({
          content: msg.content,
          tool_call_id: msg.toolCallId ?? '',
          name: msg.toolName ?? 'tool'
        })
      )
    }
  }
  return result
}

function truncateMessages(messages: BaseMessage[], maxTokens: number): BaseMessage[] {
  let total = countMessagesTokens(messages)
  if (total <= maxTokens) return messages

  // Drop from the oldest messages; keep the most recent user question intact.
  const result = [...messages]
  while (result.length > 0 && total > maxTokens) {
    const first = result[0]
    if (!first) break

    // When removing, handle tool-call pairs together.
    if (first instanceof AIMessage && (first.tool_calls?.length ?? 0) > 0) {
      // Remove AIMessage + following ToolMessage (if any) as a pair
      const removedTokens = countMessagesTokens(result.slice(0, 1))
      total -= removedTokens
      result.shift()
      if (result[0] instanceof ToolMessage) {
        total -= countMessagesTokens(result.slice(0, 1))
        result.shift()
      }
    } else if (first instanceof ToolMessage) {
      // Standalone ToolMessage (shouldn't happen in valid history), remove it
      total -= countMessagesTokens(result.slice(0, 1))
      result.shift()
    } else {
      // HumanMessage or plain AIMessage
      total -= countMessagesTokens(result.slice(0, 1))
      result.shift()
    }
  }

  // Ensure the last message is a HumanMessage (the user's new question).
  // If truncation removed the user message, keep at least one.
  while (result.length > 0 && !(result[result.length - 1] instanceof HumanMessage)) {
    const last = result.pop()
    if (last) total -= countMessagesTokens([last])
  }

  return result
}

interface ValuesModeChunk {
  messages?: BaseMessage[]
}

interface MessagesModeMetadata {
  langgraph_node?: string
}

function countMessagesTokens(messages: BaseMessage[]): number {
  let total = 0
  for (const msg of messages) {
    const role = msg._getType()
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    const calls = 'tool_calls' in msg ? (msg as AIMessage).tool_calls : undefined
    let text = `[${role}] ${content}`
    if (calls && calls.length > 0) {
      text += '\n' + JSON.stringify(calls)
    }
    total += estimateTokens(text)
  }
  return total
}

export async function runAgent({
  message,
  workspace,
  modelId,
  llm: injectedLlm,
  attachments,
  history,
  signal,
  onEvent,
  confirm,
  mcpTools
}: AgentRunOptions): Promise<void> {
  try {
    const llm = injectedLlm ?? createLlm(modelId)
    const tools = getTools(workspace, onEvent, confirm ?? (async () => true), mcpTools ?? [])
    const agent = createReactAgent({
      llm,
      tools,
      prompt: SYSTEM_PROMPT
    })

    const userMessage = await buildUserMessage(message, attachments)

    // Build history from previous conversation turns and apply token budget
    const contextMax = modelId
      ? (MODEL_MAX_CONTEXT[modelId] ?? DEFAULT_MAX_CONTEXT)
      : DEFAULT_MAX_CONTEXT
    const sysTokens = estimateTokens(SYSTEM_PROMPT)
    const newUserTokens = estimateTokens(userMessage)
    const historyBudget = contextMax - sysTokens - newUserTokens

    let historyMessages: BaseMessage[] = []
    if (history && history.length > 0) {
      historyMessages = buildHistoryMessages(history)
      historyMessages = truncateMessages(historyMessages, Math.max(0, historyBudget))
    }

    const allMessages = [...historyMessages, new HumanMessage(userMessage)]

    // Two stream modes feed the UI:
    //  - 'values': full message list after each ReAct superstep. Drives
    //    tool-start / tool-end. The final text answer is emitted here only as a
    //    fallback (when token streaming didn't fire) — see `streamedText`.
    //  - 'messages': token-level AIMessageChunk deltas. GLM-5.x is a reasoning
    //    model, so reasoning lands in `additional_kwargs.reasoning_content` with
    //    an EMPTY `content`; taking `content` alone naturally yields only the
    //    final answer. Tool outputs also surface here as node==='tools' chunks
    //    and must be skipped (tool-end from 'values' already covers them).
    // Array-form streamMode yields [mode, chunk] tuples.
    const stream = await agent.stream(
      { messages: allMessages },
      { streamMode: ['values', 'messages'], recursionLimit: RECURSION_LIMIT, signal }
    )

    const initialTokens = sysTokens + newUserTokens + countMessagesTokens(historyMessages)
    onEvent({ type: 'context-usage', used: initialTokens, max: contextMax })

    let step = 0
    let streamedText = ''
    const streamedMessageIds = new Set<string>()
    for await (const item of stream as AsyncIterable<[string, unknown]>) {
      const [mode, data] = item

      if (mode === 'messages') {
        const [chunk, meta] = data as [BaseMessage, MessagesModeMetadata]
        if (meta?.langgraph_node === 'tools') continue
        const aiChunk = chunk as AIMessageChunk
        if ((aiChunk.tool_call_chunks?.length ?? 0) > 0) continue
        // Non-streaming models (incl. the test fake) yield the whole AIMessage
        // as one chunk; a tool-call step then carries `tool_calls` on the chunk.
        // Skip it so only the final answer streams. Real providers send empty
        // content on tool-call steps anyway.
        if ((aiChunk.tool_calls?.length ?? 0) > 0) continue
        const text = extractText(chunk.content as MessageContent)
        if (text.length > 0) {
          streamedText += text
          streamedMessageIds.add(chunk.id ?? '')
          onEvent({ type: 'message-delta', delta: text })
        }
        continue
      }

      const messages = (data as ValuesModeChunk).messages ?? []
      const last = messages[messages.length - 1]
      if (!last) continue
      step++
      const lastType = last._getType()
      const calls = 'tool_calls' in last ? ((last as AIMessage).tool_calls?.length ?? 0) : 0
      console.log(`[agent] step ${step}: ${last.constructor.name} type=${lastType} calls=${calls}`)

      const used = sysTokens + countMessagesTokens(messages as BaseMessage[])
      onEvent({ type: 'context-usage', used, max: contextMax })

      if (isToolMessage(last)) {
        const toolMsg = last as ToolMessage
        onEvent({
          type: 'tool-end',
          tool: toolMsg.name ?? 'tool',
          output:
            typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content)
        })
      } else if (isAIMessage(last)) {
        const aiMsg = last as AIMessage
        if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
          for (const tc of aiMsg.tool_calls) {
            onEvent({ type: 'tool-start', tool: tc.name, toolCallId: tc.id ?? '', input: tc.args })
          }
        } else if (!streamedMessageIds.has(aiMsg.id ?? '')) {
          // Final answer: emit only if the same message wasn't already streamed
          // token-by-token. The reducer appends, so re-emitting would double text.
          const text = extractText(aiMsg.content as MessageContent)
          if (text.length > 0) {
            console.log(`[agent] message ${text.length} chars (unstreamed fallback)`)
            onEvent({ type: 'message', content: text })
          } else {
            console.log('[agent] WARN: final AI message had no text content')
          }
        }
      } else if (lastType !== 'human' && !streamedMessageIds.has(last.id ?? '')) {
        // Defensive: some OpenAI-compatible providers mis-role the final answer
        // as a generic ChatMessage. Only emit if that message wasn't streamed.
        const text = extractText(last.content as MessageContent)
        if (text.length > 0) {
          console.log(`[agent] message (generic) ${text.length} chars`)
          onEvent({ type: 'message', content: text })
        } else {
          console.log('[agent] WARN: generic message had no text content')
        }
      }
    }
    if (signal?.aborted) {
      console.log('[agent] interrupted')
      onEvent({ type: 'interrupted' })
    } else {
      console.log(`[agent] done (${step} steps, streamed ${streamedText.length} chars)`)
      onEvent({ type: 'done' })
    }
  } catch (err) {
    // LangGraph surfaces an abort as a plain `Error("Abort")` (not an
    // AbortError/DOMException), from either the initial `await agent.stream`
    // or the `for await` iteration. signal.aborted is authoritative.
    const aborted = signal?.aborted || (err instanceof Error && err.message === 'Abort')
    if (aborted) {
      console.log('[agent] interrupted')
      onEvent({ type: 'interrupted' })
      return
    }
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

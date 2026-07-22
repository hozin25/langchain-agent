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
import { createLlm, getApiKeyForModel } from './llm'
import { classifyError, backoffMs, sleep } from './errors'
import { getTools } from './tools'
import { makeDelegate } from './tools/delegate'
import { getSystemPrompt } from './prompts'
import type { ConfirmFn } from './confirm'
import { estimateTokens, MODEL_MAX_CONTEXT, DEFAULT_MAX_CONTEXT } from '@shared/tokens'
import type { AgentEvent, AgentMode, AgentRole, ChatMessage, FileAttachment, SkillConfig } from '@shared/types'

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
  roles?: AgentRole[]
  skills?: SkillConfig[]
  mode?: AgentMode
}

const MAX_ATTACH_BYTES = 512 * 1024
const RECURSION_LIMIT = 50
// Turn-level retries on top of the LLM layer's own AsyncCaller retries. 2 means
// up to 3 total attempts. Only fires when no tool has run yet (toolStarted gate).
const MAX_TURN_RETRIES = 2

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

// GLM-5.x and other reasoning models put the visible answer in
// additional_kwargs.reasoning_content with an EMPTY content. The 'messages'
// mode handler already falls back to it for token streaming; this helper gives
// the 'values' mode final-answer branches the same fallback so an unstreamed
// final message isn't silently dropped.
function messageText(msg: BaseMessage): string {
  let text = extractText(msg.content as MessageContent)
  if (text.length === 0) {
    const rk = (msg as AIMessage).additional_kwargs?.reasoning_content
    if (typeof rk === 'string' && rk.length > 0) text = rk
  }
  return text
}

// When a final message still has no recoverable text, dump its shape so the dev
// log shows where (if anywhere) the answer landed — reasoning_content length,
// other additional_kwargs keys, content form.
function debugMsgShape(msg: BaseMessage): Record<string, unknown> {
  const ak = (msg as AIMessage).additional_kwargs ?? {}
  const rk = ak.reasoning_content
  return {
    type: msg._getType(),
    contentKind: Array.isArray(msg.content) ? 'array' : typeof msg.content,
    contentLen: typeof msg.content === 'string' ? msg.content.length : -1,
    reasoningLen: typeof rk === 'string' ? rk.length : typeof rk,
    akKeys: Object.keys(ak),
    responseMetaKeys: Object.keys(msg.response_metadata ?? {})
  }
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
  mcpTools,
  roles,
  skills,
  mode
}: AgentRunOptions): Promise<void> {
  // Turn-level retry safety gate: flipped true the moment any tool-start is
  // emitted (root OR sub-agent). Once a tool has run we may have real
  // side-effects on disk, so a failed turn is NOT transparently retryable —
  // the user gets a manual retry button instead.
  let toolStarted = false
  // Track whether the current turn produced a content-bearing final message
  // through the values path. GLM often skips the final AIMessage after a tool
  // call, leaving only the 'thinking aloud' text that streamed via messages mode.
  // When this stays false and a delegate ran, we emit its summary as a fallback.
  let hasFinalTextMessage = false
  // Last sub-agent summary seen this turn — used for the fallback above.
  let lastDelegateSummary = ''
  // toolCallId -> emit-tool-start timestamp, consumed at tool-end for durationMs.
  const toolStartTimes = new Map<string, number>()

  // Wrap onEvent to (a) drive the retry safety gate + duration bookkeeping,
  // (b) record delegate summaries, and (c) detect whether a values-path message
  // with content ever landed this turn.
  const emit = (evt: AgentEvent): void => {
    if (evt.type === 'tool-start') {
      toolStarted = true
      toolStartTimes.set(evt.toolCallId, Date.now())
    }
    if (evt.type === 'subagent-end') {
      lastDelegateSummary = evt.summary
    }
    if (evt.type === 'message' && evt.content && evt.content.length > 0) {
      hasFinalTextMessage = true
    }
    onEvent(evt)
  }

  // API key preflight: fail fast with a friendly auth error instead of letting
  // the request leave and come back as a 401. Skipped when an llm is injected
  // (tests/fakes provide their own model).
  if (!injectedLlm && !getApiKeyForModel(modelId)) {
    emit({
      type: 'error',
      message: '未配置 API key',
      kind: 'auth',
      retryable: false,
      guidance:
        'API key 未配置。请检查 .env 里的 GLM_API_KEY / DEEPSEEK_API_KEY，保存后重启应用生效。'
    })
    return
  }

  // Build the input message list ONCE, outside the retry loop. Re-building per
  // attempt would re-truncate history and could diverge; inputs are pure.
  const userMessage = await buildUserMessage(message, attachments)
  const contextMax = modelId
    ? (MODEL_MAX_CONTEXT[modelId] ?? DEFAULT_MAX_CONTEXT)
    : DEFAULT_MAX_CONTEXT
  const systemPrompt = getSystemPrompt(mode)
  const sysTokens = estimateTokens(systemPrompt)
  const newUserTokens = estimateTokens(userMessage)
  const historyBudget = contextMax - sysTokens - newUserTokens

  let historyMessages: BaseMessage[] = []
  if (history && history.length > 0) {
    historyMessages = buildHistoryMessages(history)
    historyMessages = truncateMessages(historyMessages, Math.max(0, historyBudget))
  }
  const allMessages = [...historyMessages, new HumanMessage(userMessage)]
  const initialTokens = sysTokens + newUserTokens + countMessagesTokens(historyMessages)

  // One ReAct run attempt. Throws on failure; the outer loop classifies and
  // decides whether to retry. createReactAgent + stream are rebuilt per attempt
  // (LangGraph state is stream-local, not reused across attempts).
  const executeOnce = async (): Promise<void> => {
    const llm = injectedLlm ?? createLlm(modelId)
    const confirmFn = confirm ?? (async () => true)
    const baseTools = getTools(workspace, onEvent, confirmFn, mcpTools ?? [], mode === 'plan', skills ?? [])
    const tools =
      mode !== 'plan' && roles && roles.length > 0
        ? [
            ...baseTools,
            makeDelegate({
              workspace,
              emit,
              confirm: confirmFn,
              mcpTools: mcpTools ?? [],
              parentModelId: modelId,
              parentSignal: signal,
              depth: 0,
              roles
            })
          ]
        : baseTools
    const agent = createReactAgent({
      llm,
      tools,
      prompt: systemPrompt
    })

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

    emit({ type: 'context-usage', used: initialTokens, max: contextMax })

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
        let text = extractText(chunk.content as MessageContent)
        // GLM-5.x (and other reasoning models) stream reasoning tokens into
        // additional_kwargs.reasoning_content with empty content. Fall back
        // to reasoning_content so token-level streaming still works.
        if (text.length === 0) {
          const rk = aiChunk.additional_kwargs?.reasoning_content
          if (typeof rk === 'string' && rk.length > 0) {
            text = rk
          }
        }
        if (text.length > 0) {
          streamedText += text
          streamedMessageIds.add(chunk.id ?? '')
          emit({ type: 'message-delta', delta: text })
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
      emit({ type: 'context-usage', used, max: contextMax })

      if (isToolMessage(last)) {
        const toolMsg = last as ToolMessage
        const start = toolStartTimes.get(toolMsg.tool_call_id ?? '')
        const durationMs = start !== undefined ? Date.now() - start : undefined
        emit({
          type: 'tool-end',
          tool: toolMsg.name ?? 'tool',
          output:
            typeof toolMsg.content === 'string' ? toolMsg.content : JSON.stringify(toolMsg.content),
          durationMs
        })
      } else if (isAIMessage(last)) {
        const aiMsg = last as AIMessage
        if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
          for (const tc of aiMsg.tool_calls) {
            emit({ type: 'tool-start', tool: tc.name, toolCallId: tc.id ?? '', input: tc.args })
          }
        } else if (!streamedMessageIds.has(aiMsg.id ?? '')) {
          // Final answer: emit only if the same message wasn't already streamed
          // token-by-token. The reducer appends, so re-emitting would double text.
          const text = messageText(aiMsg)
          if (text.length > 0) {
            console.log(`[agent] message ${text.length} chars (unstreamed fallback)`)
            emit({ type: 'message', content: text })
          } else {
            console.log('[agent] WARN: final AI message had no text content', debugMsgShape(aiMsg))
          }
        }
      } else if (lastType !== 'human' && !streamedMessageIds.has(last.id ?? '')) {
        // Defensive: some OpenAI-compatible providers mis-role the final answer
        // as a generic ChatMessage. Only emit if that message wasn't streamed.
        // Same reasoning_content fallback as above — GLM-5.x lands the answer
        // there with empty content.
        const text = messageText(last)
        if (text.length > 0) {
          console.log(`[agent] message (generic) ${text.length} chars`)
          emit({ type: 'message', content: text })
        } else {
          console.log('[agent] WARN: generic message had no text content', debugMsgShape(last))
        }
      }
    }
    if (signal?.aborted) {
      console.log('[agent] interrupted')
      emit({ type: 'interrupted' })
    } else {
      console.log(`[agent] done (${step} steps, streamed ${streamedText.length} chars)`)
      // GLM (and some other OpenAI-compatible providers) habitually omit a final
      // natural-language conclusion after a tool call. If no values-path message
      // was emitted but a delegate ran and returned a summary, emit that summary
      // as a fallback so the user isn't left with an empty turn.
      if (!hasFinalTextMessage && lastDelegateSummary.length > 0) {
        console.log('[agent] fallback: emitting last delegate summary')
        emit({ type: 'message', content: lastDelegateSummary })
      }
      emit({ type: 'done' })
    }
  }

  // Turn-level retry loop. The LLM layer (AsyncCaller, maxRetries=3 in llm.ts)
  // already absorbs most transient failures before we get here; this loop only
  // fires for retryable errors that escaped it AND when no tool has run yet.
  for (let attempt = 0; attempt <= MAX_TURN_RETRIES; attempt++) {
    try {
      await executeOnce()
      return
    } catch (err) {
      const classified = classifyError(err, signal)
      if (classified.kind === 'aborted') {
        console.log('[agent] interrupted')
        emit({ type: 'interrupted' })
        return
      }
      const canRetry = classified.retryable && !toolStarted && attempt < MAX_TURN_RETRIES
      if (!canRetry) {
        console.error('[agent] error:', err)
        emit({
          type: 'error',
          message: classified.message,
          kind: classified.kind,
          retryable: classified.retryable,
          guidance: classified.guidance
        })
        return
      }
      const delayMs = backoffMs(attempt)
      console.log(
        `[agent] retry ${attempt + 1}/${MAX_TURN_RETRIES} after ${delayMs}ms (${classified.kind}): ${classified.message}`
      )
      emit({
        type: 'retry',
        attempt: attempt + 1,
        maxAttempts: MAX_TURN_RETRIES,
        reason: classified.message,
        delayMs
      })
      await sleep(delayMs, signal)
    }
  }
}

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
import { randomUUID } from 'node:crypto'
import { createLlm, getApiKeyForModel } from './llm'
import { classifyError, backoffMs, sleep } from './errors'
import { COMPACT_THRESHOLD, extractTextOrReasoning, chatToBaseMessages } from './compact'
import { getTools } from './tools'
import { makeDelegate } from './tools/delegate'
import type { SnapshotFn } from './tools/withSnapshot'
import { getCheckpointer } from './checkpointer'
import { createShadowRepo } from '../snapshots/shadowRepo'
import { createSnapshotIndexStore } from '../snapshots/index-store'
import { getSystemPrompt } from './prompts'
import { formatMemoryForPrompt, type MemoryStore } from './memory'
import type { ConfirmFn } from './confirm'
import { estimateTokens, countMessagesTokens, MODEL_MAX_CONTEXT, DEFAULT_MAX_CONTEXT } from '@shared/tokens'
import type {
  AgentEvent,
  AgentMode,
  AgentRole,
  ChatMessage,
  FileAttachment,
  SkillConfig,
  SnapshotEntry
} from '@shared/types'

export interface AgentRunOptions {
  // conversationId = LangGraph thread_id。append 契约:checkpointer 有该 thread 的
  // checkpoint 时,首轮只传新 user message(追加);无(首次/compact 删后/进程重启)
  // 时用 history 重建。renderer 仍传完整 history 作降级输入。
  conversationId: string
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
  memoryStore?: MemoryStore
  // Phase 3:when provided (and not plan mode), runAgent creates a shadow-git
  // repo under <userDataDir>/agent-snapshots/ and snapshots the workspace before
  // each write tool + at turn-start. Undefined in tests/plan-mode → no snapshots.
  userDataDir?: string
  // 测试/未来配置用:单段递归上限与最大续跑段数。生产用默认值(RECURSION_LIMIT /
  // MAX_CONTINUATIONS);IPC handler 不传。注入小值可让续跑逻辑快速撞限单测。
  recursionLimit?: number
  maxContinuations?: number
}

const MAX_ATTACH_BYTES = 512 * 1024
const RECURSION_LIMIT = 50
// 撞递归上限后自动续跑的最大段数。每段重置 recursionLimit 计数:5 段 × 50 步
// ≈ 250 步(约 125 次工具调用)。仍不收敛才发 recursion_limit 错误,提示用户拆分。
// 与 compact 互补:compact 解决「token 太多」,续跑解决「单轮 step 太多」。
const MAX_CONTINUATIONS = 5
// Turn-level retries on top of the LLM layer's own AsyncCaller retries. 2 means
// up to 3 total attempts. Only fires when no tool has run yet (toolStarted gate).
const MAX_TURN_RETRIES = 2

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


interface ValuesModeChunk {
  messages?: BaseMessage[]
}

interface MessagesModeMetadata {
  langgraph_node?: string
}

export async function runAgent({
  conversationId,
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
  mode,
  memoryStore,
  userDataDir,
  recursionLimit,
  maxContinuations
}: AgentRunOptions): Promise<void> {
  const effectiveRecursionLimit = recursionLimit ?? RECURSION_LIMIT
  const effectiveMaxContinuations = maxContinuations ?? MAX_CONTINUATIONS
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
  // delegate 执行窗口标志:subagent-start 置位、subagent-end 复位。窗口内
  // root 的 agent 节点阻塞在 tools 节点等工具返回,LLM 不可能产出 chunk——
  // 此窗口内 root tap 收到的任何文本 chunk 都是子 agent 的 LLM chunk 经
  // LangChain callback 继承(AsyncLocalStorage)漏进来的,必须在发射前丢弃,
  // 否则以 root 身份重发 → UI 上 root/sub 双气泡重复。
  let delegating = false
  // toolCallId -> emit-tool-start timestamp, consumed at tool-end for durationMs.
  const toolStartTimes = new Map<string, number>()
  // 跨续跑轮次共享:已发过事件的 message id。续跑首轮的 'values' last 与上一轮
  // 最后一条 id 相同,靠它在处理前 continue 跳过,避免重复 emit tool-start/
  // tool-end/message。同时覆盖 'messages' 模式已流式过的 chunk id,使 unstreamed
  // fallback 判断也正确。
  const emittedMsgIds = new Set<string>()
  // 跨段累加的日志计数(单段 step/streamedText 是局部变量)。
  let cumulativeStep = 0
  let cumulativeStreamedChars = 0

  // Wrap onEvent to (a) drive the retry safety gate + duration bookkeeping,
  // (b) record delegate summaries, and (c) detect whether a values-path message
  // with content ever landed this turn.
  const emit = (evt: AgentEvent): void => {
    if (evt.type === 'tool-start') {
      toolStarted = true
      toolStartTimes.set(evt.toolCallId, Date.now())
    }
    if (evt.type === 'subagent-start') delegating = true
    if (evt.type === 'subagent-end') {
      delegating = false
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
  // Long-term memory for this workspace is pre-loaded into the system prompt so
  // durable facts survive across conversations without the agent having to
  // recall them. The memory section counts against the token budget (via
  // sysTokens), so growth naturally shrinks historyBudget below.
  const baseSystemPrompt = getSystemPrompt(mode)
  let memoryTokens = 0
  let systemPrompt = baseSystemPrompt
  if (memoryStore) {
    const entries = await memoryStore.list(workspace)
    const memSection = formatMemoryForPrompt(entries)
    if (memSection.length > 0) {
      systemPrompt = `${baseSystemPrompt}\n\n${memSection}`
      memoryTokens = estimateTokens(memSection)
    }
  }
  const sysTokens = estimateTokens(baseSystemPrompt) + memoryTokens
  const newUserTokens = estimateTokens(userMessage)

  // 历史不再做自动截断(已移除 truncateMessages)。完整历史直接进入 agent;
  // 上下文超限时由 compact(对话压缩)处理:stream 中检测到 used/max > 80%
  // 会 emit compact-needed,前端在当前轮结束后自动触发 compact。
  let historyMessages: BaseMessage[] = []
  if (history && history.length > 0) {
    historyMessages = chatToBaseMessages(history)
  }
  const initialTokens = sysTokens + newUserTokens + countMessagesTokens(historyMessages)

  // Phase 3 shadow-git snapshots: build the repo + index once per run, define a
  // best-effort takeSnapshot thunk that wraps them. Disabled in plan mode
  // (read-only — nothing to roll back) and when userDataDir is absent (tests).
  // The thunk closes over conversationId + workspace so write tools just call
  // it with their toolName. Failures are swallowed: snapshot is not on the
  // critical path of agent correctness.
  let takeSnapshot: SnapshotFn | undefined
  if (userDataDir && mode !== 'plan') {
    const repo = createShadowRepo(userDataDir, workspace)
    const snapIndex = createSnapshotIndexStore(userDataDir)
    takeSnapshot = async (label, toolName, agentId, detail): Promise<void> => {
      try {
        const sha = await repo.snapshot(label)
        const entry: SnapshotEntry = {
          id: `snap_${randomUUID()}`,
          sha,
          workspace,
          conversationId,
          toolName,
          agentId,
          turnLabel: label,
          filePath: detail,
          createdAt: Date.now()
        }
        await snapIndex.add(entry)
        emit({ type: 'snapshot-taken', entry })
      } catch (e) {
        console.log(
          `[snapshot] ${label} failed: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
  }

  // Agent graph is built ONCE per run, not per attempt/segment. With a
  // checkpointer attached, createReactAgent is stateful: the checkpointer
  // persists the message thread keyed by thread_id (= conversationId) across
  // stream() calls. That is what lets us continue past a recursion limit by
  // re-streaming with messages:[] (append contract — empty input = resume, the
  // checkpointer replays the thread). Per-segment state lives in the
  // checkpointer, not the graph, so one graph serves the whole run.
  const llm = injectedLlm ?? createLlm(modelId)
  const confirmFn = confirm ?? (async () => true)
  const baseTools = getTools(
    workspace,
    onEvent,
    confirmFn,
    mcpTools ?? [],
    mode === 'plan',
    skills ?? [],
    memoryStore,
    takeSnapshot
  )
  // 真机验证钩子：设 AGENT_TEST_SUB_CONTEXT_MAX 可缩小子 agent 的 context 上限，
  // 让 sub-compact 在真实 pnpm dev 运行中快速撞阈（否则需积累 ~80% 真实窗口的 token）。
  // 不设或值非法 → undefined → delegate 内走 MODEL_MAX_CONTEXT 原逻辑。
  const testSubContextMax = Number(process.env.AGENT_TEST_SUB_CONTEXT_MAX)
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
            roles,
            snapshot: takeSnapshot,
            contextMax:
              Number.isFinite(testSubContextMax) && testSubContextMax > 0
                ? testSubContextMax
                : undefined
          })
        ]
      : baseTools
  const checkpointer = getCheckpointer()
  const agent = createReactAgent({
    llm,
    tools,
    prompt: systemPrompt,
    checkpointer
  })

  // One ReAct run segment. startMessages is the input for THIS segment only:
  // the first segment is [new user message] (or [history + new message] when
  // no checkpoint exists — see the attempt loop), continuation segments pass []
  // to resume from the checkpointed thread. Throws on failure; the outer loop
  // classifies and decides whether to retry (or continue past a recursion limit).
  const executeOnce = async (startMessages: BaseMessage[]): Promise<void> => {
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
      { messages: startMessages },
      {
        streamMode: ['values', 'messages'],
        recursionLimit: effectiveRecursionLimit,
        signal,
        configurable: { thread_id: conversationId }
      }
    )

    emit({ type: 'context-usage', used: initialTokens, max: contextMax })

    let step = 0
    let streamedText = ''
    // 一轮内 compact-needed 只发一次:首次检测到 used/max > 80% 时通知前端,
    // 前端会在当前轮 done 后自动触发 compact。避免每个 superstep 重复发送。
    let compactNeededEmitted = false
    const maybeEmitCompactNeeded = (used: number): void => {
      if (compactNeededEmitted) return
      if (contextMax > 0 && used / contextMax > COMPACT_THRESHOLD) {
        compactNeededEmitted = true
        emit({ type: 'compact-needed', used, max: contextMax })
      }
    }
    maybeEmitCompactNeeded(initialTokens)
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
        // GLM-5.x (and other reasoning models) stream reasoning tokens into
        // additional_kwargs.reasoning_content with empty content. extractTextOrReasoning
        // owns that fallback now (sunk to compact.ts, shared with delegate).
        const text = extractTextOrReasoning(chunk)
        if (text.length > 0) {
          // delegate 窗口静音:见 delegating 声明处注释。窗口内的一切文本
          // chunk 都是子 agent 泄漏,不得进入 streamedText/emittedMsgIds。
          if (delegating) continue
          streamedText += text
          emittedMsgIds.add(chunk.id ?? '')
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
      maybeEmitCompactNeeded(used)

      // 跨续跑去重:这条 message 上一段已处理过(emit 过 tool-start/end/message),
      // 跳过。续跑首轮的 last.id == 上一段最后一条的 id。emittedMsgIds 统一承担
      // 「已流式」+「已 emit」双重去重(取代原 streamedMessageIds)。
      const lastId = last.id ?? ''
      if (lastId.length > 0) {
        if (emittedMsgIds.has(lastId)) continue
        emittedMsgIds.add(lastId)
      }

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
        } else {
          // Final answer. 已被 'messages' 模式流式过的 message,id 已在 emittedMsgIds
          // 里、被上面的 continue 挡掉;能走到这里就是未流式的最终答案(非流式模型、
          // 或 reasoning 落在 additional_kwargs 的 GLM 收尾)。
          const text = extractTextOrReasoning(aiMsg)
          if (text.length > 0) {
            console.log(`[agent] message ${text.length} chars (unstreamed fallback)`)
            emit({ type: 'message', content: text })
          } else {
            console.log('[agent] WARN: final AI message had no text content', debugMsgShape(aiMsg))
          }
        }
      } else if (lastType !== 'human') {
        // Defensive: some OpenAI-compatible providers mis-role the final answer
        // as a generic ChatMessage. Same reasoning_content fallback as above —
        // GLM-5.x lands the answer there with empty content.
        const text = extractTextOrReasoning(last)
        if (text.length > 0) {
          console.log(`[agent] message (generic) ${text.length} chars`)
          emit({ type: 'message', content: text })
        } else {
          console.log('[agent] WARN: generic message had no text content', debugMsgShape(last))
        }
      }
    }
    // 本段 stream 自然结束。终态(done/interrupted/delegate-summary fallback)由
    // 外层续跑 loop 在所有段跑完后统一发;这里只累加跨段日志计数。
    cumulativeStep += step
    cumulativeStreamedChars += streamedText.length
  }

  // Phase 3 turn-start snapshot: one baseline per user turn capturing workspace
  // state BEFORE the agent touches anything. The user can always roll back to
  // "before this turn". Placed outside the attempt loop so a transient retry
  // doesn't double it. Best-effort (takeSnapshot swallows its own errors).
  if (takeSnapshot) {
    await takeSnapshot('turn-start')
  }

  // Turn-level retry loop. The LLM layer (AsyncCaller, maxRetries=3 in llm.ts)
  // already absorbs most transient failures before we get here; this loop only
  // fires for retryable errors that escaped it AND when no tool has run yet.
  for (let attempt = 0; attempt <= MAX_TURN_RETRIES; attempt++) {
    // On a turn-level retry, the prior attempt may have checkpointed early
    // supersteps before failing. Wipe the thread so this attempt starts clean;
    // otherwise feeding history again would append on top of that partial work.
    // Safe because this branch only runs when no tool has executed yet
    // (toolStarted gate below), so nothing on disk is being rolled back.
    if (attempt > 0) {
      try {
        await checkpointer.deleteThread(conversationId)
      } catch {
        // best-effort: worst case is a duplicate message on retry, not a crash
      }
    }
    // Append contract: when a checkpoint exists for this thread (a prior turn
    // in this session), feed ONLY the new user message — the checkpointer
    // replays the prior messages itself, and feeding history would double it.
    // When no checkpoint exists (first turn, post-compact, or post-restart
    // under MemorySaver), rebuild from history.
    const hasCkpt = !!(await checkpointer.getTuple({ configurable: { thread_id: conversationId } }))
    const firstInput: BaseMessage[] = hasCkpt
      ? [new HumanMessage(userMessage)]
      : [...historyMessages, new HumanMessage(userMessage)]
    let nextInput: BaseMessage[] = firstInput
    let continuation = 0
    try {
      // 续跑 loop:撞递归上限时重启 stream、重置递归计数。checkpointer 持有 thread
      // 状态,续跑段传 messages:[](append 契约:空输入 = 恢复,不追加),让长任务无感
      // 跑到自然结束。达 maxContinuations 仍不收敛 → re-throw,由外层 catch 经
      // classifyError 发出 recursion_limit 友好错误(该 kind 已标 retryable:false)。
      while (true) {
        try {
          await executeOnce(nextInput)
          break
        } catch (err) {
          if (signal?.aborted) throw err
          const isRL =
            (err as { lc_error_code?: string } | null | undefined)?.lc_error_code ===
            'GRAPH_RECURSION_LIMIT'
          if (isRL && continuation < effectiveMaxContinuations) {
            continuation++
            console.log(
              `[agent] recursion limit hit, continuing segment ${continuation}/${effectiveMaxContinuations} (thread ${conversationId})`
            )
            nextInput = []
            continue
          }
          throw err
        }
      }
      // 所有段跑完,发终态。
      if (signal?.aborted) {
        console.log('[agent] interrupted')
        emit({ type: 'interrupted' })
      } else {
        console.log(
          `[agent] done (${cumulativeStep} steps, streamed ${cumulativeStreamedChars} chars${
            continuation > 0 ? `, ${continuation} continuations` : ''
          })`
        )
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

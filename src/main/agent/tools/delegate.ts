import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
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
import type { StructuredTool } from '@langchain/core/tools'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { createLlm } from '../llm'
import {
  compactHistory,
  COMPACT_THRESHOLD,
  chatToBaseMessages,
  baseToChatMessages,
  extractTextOrReasoning
} from '../compact'
import { buildSubTools } from './subTools'
import type { ConfirmFn } from '../confirm'
import type { SnapshotFn } from './withSnapshot'
import {
  countMessagesTokens,
  estimateTokens,
  MODEL_MAX_CONTEXT,
  DEFAULT_MAX_CONTEXT
} from '@shared/tokens'
import type { AgentEvent, AgentRole } from '@shared/types'

const SUB_RECURSION_LIMIT = 40
const MAX_SUMMARY_CHARS = 4000
// 子 agent compact 续跑上限。撞 context 上限自动 compact + 续跑，最多 2 轮；
// 仍不收敛则按 context_too_long 失败（吸收进 summary，不发根 error）。
const MAX_SUB_COMPACTS = 2
const SUB_COMPACT_THRESHOLD = COMPACT_THRESHOLD // 0.8，与根 agent 同口径
// compact 失败降级时尾部保留的消息条数（含 tool 配对）。
const SUB_FALLBACK_KEEP = 6

// compact 失败降级：硬截断尾部保 N 条，但起点不能落在 ToolMessage 上——
// ToolMessage 必须跟在 AIMessage(tool_calls) 之后，否则 ReAct 报配对错误。
// 遇到 ToolMessage 就回退到包含其调用方 AIMessage。
function keepTailPairs(msgs: BaseMessage[], keep: number): BaseMessage[] {
  if (msgs.length <= keep) return msgs.slice()
  let start = msgs.length - keep
  while (start > 0 && isToolMessage(msgs[start]!)) {
    start--
  }
  return msgs.slice(start)
}

export interface DelegateContext {
  workspace: string
  // Root-level onEvent. Root events are emitted through this directly and carry
  // no agentId; sub-agent events are stamped inside this tool before forwarding.
  emit: (event: AgentEvent) => void
  confirm: ConfirmFn
  mcpTools: StructuredTool[]
  parentModelId?: string
  parentSignal?: AbortSignal
  depth: number
  roles: AgentRole[]
  // 测试/未来配置用：注入 LLM、context 上限与 compact 上限，绕过 createLlm /
  // MODEL_MAX_CONTEXT / MAX_SUB_COMPACTS。生产路径（index.ts makeDelegate）不传。
  // 注入小 contextMax 可让 sub compact 单测快速撞阈，参照 index.ts 的
  // recursionLimit / maxContinuations 注入惯例（index.ts:42-44）。
  llm?: BaseChatModel
  contextMax?: number
  maxSubCompacts?: number
  // Phase 3:root's snapshot thunk. A sub-agent reuses the root's shadow repo
  // (same workspace) but stamps its own agentId into timeline entries.
  snapshot?: SnapshotFn
}

export function makeDelegate(ctx: DelegateContext): StructuredTool {
  const rolesById = new Map(ctx.roles.map(r => [r.id, r]))

  const description = [
    'Delegate a focused, well-scoped sub-task to a specialized sub-agent that runs with its own context and a restricted tool set, then returns only a summary.',
    'Use for independent pieces of work that benefit from a dedicated role (researching unfamiliar code, implementing an isolated module, writing tests, reviewing a diff). Keep the high-level plan and synthesis yourself; do not delegate trivial single-tool lookups.',
    'agentRoleId must be one of:',
    ...ctx.roles.map(r => `- ${r.id}: ${r.description}`)
  ].join('\n')

  return tool(
    async ({ agentRoleId, task, context }) => {
      // Defense in depth: a sub-agent's tool set never includes delegate, so this
      // branch should be unreachable. Reject explicitly if it ever is.
      if (ctx.depth > 0) {
        return 'delegate is only available to the root agent.'
      }

      const role = rolesById.get(agentRoleId)
      if (!role) {
        const available = [...rolesById.keys()].join(', ')
        return `Unknown agentRoleId "${agentRoleId}". Available: ${available}`
      }

      const agentId = `sub_${Date.now()}_${randomUUID().slice(0, 8)}`
      const roleName = role.name

      // Single injection point for sub-agent identity. context-usage is dropped
      // so a sub-agent never clobbers the root's context progress bar.
      const subEmit = (event: AgentEvent): void => {
        if (event.type === 'context-usage') return
        ctx.emit({ ...event, agentId, agentName: roleName } as AgentEvent)
      }

      // Cancel the sub-agent when the parent run is cancelled.
      const subController = new AbortController()
      const onParentAbort = (): void => subController.abort()
      if (ctx.parentSignal) {
        if (ctx.parentSignal.aborted) {
          subController.abort()
        } else {
          ctx.parentSignal.addEventListener('abort', onParentAbort, { once: true })
        }
      }

      // Sub-agent dangerous ops reuse the parent ConfirmManager, stamped with
      // this role so the dialog shows who is asking. Root dangerous ops pass no
      // origin (fileSystem.ts / shell.ts never pass the third arg), so only
      // sub-agent requests carry agentId/agentName.
      const subConfirm: ConfirmFn = (t, input) =>
        ctx.confirm(t, input, { agentId, agentName: roleName })

      ctx.emit({
        type: 'subagent-start',
        agentId,
        roleId: role.id,
        roleName,
        task
      })
      console.log(`[delegate] start role=${role.id} (${roleName}) agentId=${agentId} depth=${ctx.depth}`)

      let streamedText = ''
      let errMsg = ''
      let aborted = false
      try {
        const subModelId = role.modelId ?? ctx.parentModelId
        const llm = ctx.llm ?? createLlm(subModelId)
        // Sub-agent snapshots reuse the root repo but stamp this agentId, so the
        // timeline can attribute them to the sub-agent bubble.
        const subSnapshot: SnapshotFn | undefined = ctx.snapshot
          ? (label, toolName) => ctx.snapshot!(label, toolName, agentId)
          : undefined
        const subTools = buildSubTools({
          workspace: ctx.workspace,
          emit: subEmit,
          confirm: subConfirm,
          mcpTools: ctx.mcpTools,
          allowedTools: role.allowedTools,
          depth: ctx.depth + 1,
          snapshot: subSnapshot
        })
        const subAgent = createReactAgent({
          llm,
          tools: subTools,
          prompt: role.systemPrompt
        })

        const userText = context ? `${task}\n\nContext:\n${context}` : task
        const contextMax = ctx.contextMax ?? MODEL_MAX_CONTEXT[subModelId ?? ''] ?? DEFAULT_MAX_CONTEXT
        const maxSubCompacts = ctx.maxSubCompacts ?? MAX_SUB_COMPACTS
        const sysTokens = estimateTokens(role.systemPrompt)

        // compact 续跑载体：首轮是单条 HumanMessage；compact 后换成压缩后的 messages。
        // 每个 'values' chunk 持续刷新到最新 superstep，撞阈值 / context too long 时
        // 喂给 compactHistory，再用压缩结果启动下一段 stream。
        let lastSubMessages: BaseMessage[] = [new HumanMessage(userText)]
        let compactCount = 0
        let compacted = false
        // 跨段去重：单段内 + compact 续跑跨段都不清空。compact 后还会把续跑输入的
        // message id 预填进来，避免重 emit 压缩前的旧 tool/message（镜像根 emittedMsgIds）。
        const streamedIds = new Set<string>()

        runSubSegment: while (true) {
          const startMsgs = compacted ? lastSubMessages : [new HumanMessage(userText)]
          const stream = await subAgent.stream(
            { messages: startMsgs },
            {
              streamMode: ['values', 'messages'],
              recursionLimit: SUB_RECURSION_LIMIT,
              signal: subController.signal
            }
          )
          compacted = false
          // 主动阈值 break 标记：为 true 时 for-await 提前跳出，落到下方 compact
          // 续跑；为 false 时 for-await 自然结束 → 整个 sub 任务完成。
          let proactivelyBroke = false
          try {
            for await (const item of stream as AsyncIterable<[string, unknown]>) {
              const [mode, data] = item

              if (mode === 'messages') {
                const [chunk, meta] = data as [BaseMessage, { langgraph_node?: string }]
                if (meta?.langgraph_node === 'tools') continue
                const aiChunk = chunk as AIMessageChunk
                if ((aiChunk.tool_call_chunks?.length ?? 0) > 0) continue
                if ((aiChunk.tool_calls?.length ?? 0) > 0) continue
                // GLM-5.x reasoning models stream text into reasoning_content with
                // empty content — extractTextOrReasoning owns that fallback now.
                const text = extractTextOrReasoning(chunk)
                if (text.length > 0) {
                  streamedText += text
                  streamedIds.add(chunk.id ?? '')
                  subEmit({ type: 'message-delta', delta: text })
                }
                continue
              }

              const messages = (data as { messages?: BaseMessage[] }).messages ?? []
              // 持续刷新续跑载体：撞阈值 / context too long 时它停在最新 superstep。
              lastSubMessages = messages
              const last = messages[messages.length - 1]
              if (!last) continue

              // 跨段去重：续跑首轮会重放 lastSubMessages，其 id 已在 streamedIds
              // 里（compact 后预填），整条跳过，不重 emit 旧 tool/message。
              const lastId = last.id ?? ''
              if (lastId.length > 0 && streamedIds.has(lastId)) continue

              if (isToolMessage(last)) {
                const toolMsg = last as ToolMessage
                subEmit({
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
                    subEmit({
                      type: 'tool-start',
                      tool: tc.name,
                      toolCallId: tc.id ?? '',
                      input: tc.args
                    })
                  }
                } else {
                  const text = extractTextOrReasoning(aiMsg)
                  if (text.length > 0) {
                    streamedText += text
                    subEmit({ type: 'message', content: text })
                  }
                }
              }
              if (lastId.length > 0) streamedIds.add(lastId)

              // 主动阈值检测（静默）：超 80% 且还能 compact → 跳出 for-await，
              // 触发下方 compact 续跑。比等 LLM 报 400 context_too_long 更早、更省。
              const used = sysTokens + countMessagesTokens(messages)
              if (
                contextMax > 0 &&
                used / contextMax > SUB_COMPACT_THRESHOLD &&
                compactCount < maxSubCompacts
              ) {
                proactivelyBroke = true
                break
              }
            }
            if (!proactivelyBroke) break runSubSegment
            // 主动 break → 落到下方 compact 续跑
          } catch (err) {
            const isAbort =
              subController.signal.aborted ||
              ctx.parentSignal?.aborted === true ||
              (err instanceof Error && err.message === 'Abort')
            if (isAbort) {
              aborted = true
              break runSubSegment
            }
            // context too long 且还能 compact → 落到下方静默 compact 续跑（不设 errMsg）。
            const isCtxLong = err instanceof Error && /context length|too long/i.test(err.message)
            if (!isCtxLong || compactCount >= maxSubCompacts) {
              const isRecursionLimit =
                err instanceof Error &&
                (err as { lc_error_code?: string }).lc_error_code === 'GRAPH_RECURSION_LIMIT'
              errMsg = isRecursionLimit
                ? `子 agent 步骤过多，超出上限（${SUB_RECURSION_LIMIT} 步）已停止。可让任务更聚焦，或由主 agent 拆分后重试。`
                : err instanceof Error
                  ? err.message
                  : String(err)
              // delegate swallows sub-agent errors into the summary by design (so a
              // sub failure doesn't surface as a root error); log here so the cause
              // is visible in the dev shell.
              console.error(`[delegate] sub-agent "${roleName}" (${agentId}) failed:`, err)
              break runSubSegment
            }
            // isCtxLong && 还能 compact → 落到下方 compact 续跑
          }

          // 静默 compact 续跑：onEvent 为 noop，不发 compact-* 事件，保持「子 agent
          // 不污染根面板」的既有设计。传入已创建的 llm（生产复用、测试走注入的
          // fakeModel），避免 compactHistory 另起一个 createLlm 实例。
          const chatHist = baseToChatMessages(lastSubMessages)
          const res = await compactHistory(chatHist, {
            workspace: ctx.workspace,
            modelId: subModelId,
            llm,
            signal: subController.signal,
            onEvent: () => {}
          })
          if (!res.history) {
            // compact 失败降级：硬截断尾部保 N 条（含 tool 配对），避免整任务失败。
            lastSubMessages = keepTailPairs(lastSubMessages, SUB_FALLBACK_KEEP)
          } else {
            lastSubMessages = chatToBaseMessages(res.history)
          }
          // 预填跨段去重：续跑首轮会重放这些 message，登记其 id 让上面 values 分支
          // 的 streamedIds 检查整条跳过，杜绝重 emit 压缩前的旧 tool/message 卡片。
          for (const m of lastSubMessages) {
            const id = m.id ?? ''
            if (id.length > 0) streamedIds.add(id)
          }
          compactCount++
          compacted = true
          console.log(`[delegate] sub compact ${compactCount}/${maxSubCompacts}`)
        }
      } catch (err) {
        // 外层兜底：setup 阶段（createLlm / buildSubTools / createReactAgent）异常，
        // 或 compact 续跑 loop 内未被内层 catch 覆盖的意外错误。compactHistory 自身
        // 已吞 LLM 错误，正常不会到这——保留作安全网，行为与原单 try/catch 一致。
        aborted =
          subController.signal.aborted ||
          ctx.parentSignal?.aborted === true ||
          (err instanceof Error && err.message === 'Abort')
        if (!aborted) {
          errMsg = err instanceof Error ? err.message : String(err)
          console.error(`[delegate] sub-agent "${roleName}" (${agentId}) failed:`, err)
        }
      } finally {
        if (ctx.parentSignal) {
          ctx.parentSignal.removeEventListener('abort', onParentAbort)
        }
      }

      // Keep failure localized to this sub-agent card — do NOT emit a root-level
      // error event (that would surface in the main conversation). The summary
      // carries the failure; the tool return value hands it to the root agent.
      const summary = aborted
        ? 'interrupted'
        : streamedText || (errMsg ? `Error: ${errMsg}` : '(no output)')
      ctx.emit({
        type: 'subagent-end',
        agentId,
        roleId: role.id,
        roleName,
        summary,
        ok: !aborted && errMsg.length === 0
      })
      console.log(
        `[delegate] end role=${role.id} (${roleName}) agentId=${agentId} ok=${!aborted && errMsg.length === 0} aborted=${aborted} summary=${summary.length} chars`
      )

      if (aborted) return `子 agent "${roleName}" 被中断了。`
      if (errMsg) return `子 agent "${roleName}" 失败：${errMsg}`
      const clipped =
        summary.length > MAX_SUMMARY_CHARS
          ? summary.slice(0, MAX_SUMMARY_CHARS) + '\n…[truncated]'
          : summary
      return `=== ${roleName} 子任务完成 ===\n${clipped}`
    },
    {
      name: 'delegate',
      description,
      schema: z.object({
        agentRoleId: z.string().describe('One of the role ids listed above'),
        task: z.string().describe('A crisp, self-contained description of the sub-task'),
        context: z
          .string()
          .optional()
          .describe('Extra context to pass to the sub-agent (file paths, findings, constraints)')
      })
    }
  )
}

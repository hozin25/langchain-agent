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
import { createLlm } from '../llm'
import { buildSubTools } from './subTools'
import type { ConfirmFn } from '../confirm'
import type { AgentEvent, AgentRole } from '@shared/types'

const SUB_RECURSION_LIMIT = 40
const MAX_SUMMARY_CHARS = 4000

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
        const llm = createLlm(role.modelId ?? ctx.parentModelId)
        const subTools = buildSubTools({
          workspace: ctx.workspace,
          emit: subEmit,
          confirm: subConfirm,
          mcpTools: ctx.mcpTools,
          allowedTools: role.allowedTools,
          depth: ctx.depth + 1
        })
        const subAgent = createReactAgent({
          llm,
          tools: subTools,
          prompt: role.systemPrompt
        })

        const userText = context ? `${task}\n\nContext:\n${context}` : task
        const stream = await subAgent.stream(
          { messages: [new HumanMessage(userText)] },
          {
            streamMode: ['values', 'messages'],
            recursionLimit: SUB_RECURSION_LIMIT,
            signal: subController.signal
          }
        )

        const streamedIds = new Set<string>()
        for await (const item of stream as AsyncIterable<[string, unknown]>) {
          const [mode, data] = item

          if (mode === 'messages') {
            const [chunk, meta] = data as [BaseMessage, { langgraph_node?: string }]
            if (meta?.langgraph_node === 'tools') continue
            const aiChunk = chunk as AIMessageChunk
            if ((aiChunk.tool_call_chunks?.length ?? 0) > 0) continue
            if ((aiChunk.tool_calls?.length ?? 0) > 0) continue
            let text = extractText(chunk.content as MessageContent)
            // GLM-5.x reasoning models stream text into reasoning_content with
            // empty content — same fallback as the root agent (index.ts).
            if (text.length === 0) {
              const rk = aiChunk.additional_kwargs?.reasoning_content
              if (typeof rk === 'string' && rk.length > 0) text = rk
            }
            if (text.length > 0) {
              streamedText += text
              streamedIds.add(chunk.id ?? '')
              subEmit({ type: 'message-delta', delta: text })
            }
            continue
          }

          const messages = (data as { messages?: BaseMessage[] }).messages ?? []
          const last = messages[messages.length - 1]
          if (!last) continue

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
            } else if (!streamedIds.has(aiMsg.id ?? '')) {
              const text = extractText(aiMsg.content as MessageContent)
              if (text.length > 0) {
                streamedText += text
                subEmit({ type: 'message', content: text })
              }
            }
          }
        }
      } catch (err) {
        aborted =
          subController.signal.aborted ||
          ctx.parentSignal?.aborted === true ||
          (err instanceof Error && err.message === 'Abort')
        if (!aborted) {
          const isRecursionLimit =
            err instanceof Error &&
            (err as { lc_error_code?: string }).lc_error_code === 'GRAPH_RECURSION_LIMIT'
          if (isRecursionLimit) {
            errMsg = `子 agent 步骤过多，超出上限（${SUB_RECURSION_LIMIT} 步）已停止。可让任务更聚焦，或由主 agent 拆分后重试。`
          } else {
            errMsg = err instanceof Error ? err.message : String(err)
          }
          // delegate swallows sub-agent errors into the summary by design (so a
          // sub failure doesn't surface as a root error); log here so the cause
          // is visible in the dev shell.
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

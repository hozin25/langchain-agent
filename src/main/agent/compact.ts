import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  isAIMessage,
  isToolMessage
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { estimateChatMessagesTokens } from '@shared/tokens'
import type { AgentEvent, ChatMessage } from '@shared/types'
import { createLlm } from './llm'

// 触发自动 compact 的阈值:已用上下文占最大上下文的比例。
export const COMPACT_THRESHOLD = 0.8

// compact 时保留最近消息的比例(按 token 预算)。被压缩的旧消息会被一条
// summary 替换,保留的部分原样进入下一轮,保证最近上下文(工具结果、用户
// 最新意图)不丢失。Claude Code 同样保留尾部、压缩头部。
const KEEP_RECENT_RATIO = 0.2

// summary 消息在历史中的角色。用 system 角色承载摘要,既不会被当成"AI 的
// 发言"显示成普通气泡,又能被模型当作权威上下文读取。前端 reducer 会把它
// 渲染成带 📝 标记的压缩卡片。
const SUMMARY_ROLE: ChatMessage['role'] = 'assistant'

export interface CompactOptions {
  workspace: string
  modelId?: string
  llm?: BaseChatModel
  signal?: AbortSignal
  onEvent: (event: AgentEvent) => void
}

export interface CompactResult {
  // 压缩后的历史(已含 summary + 保留的尾部消息),可直接作为下一次 runAgent
  // 的 history 传入。失败时为 null,由调用方决定如何提示。
  history: ChatMessage[] | null
  // 压缩前后的 token 估算,用于进度/日志。
  beforeTokens: number
  afterTokens: number
}

// 把 ChatMessage[] 渲染成给总结模型的纯文本对话记录。每条带角色标签,工具
// 调用/结果也展开,这样 summary 能覆盖"做了什么"而不只是"说了什么"。
function renderHistoryForSummary(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const role = m.role === 'tool' ? `tool(${m.toolName ?? 'tool'})` : m.role
    let body = m.content
    if (m.role === 'tool' && m.toolInput !== undefined) {
      body = `input: ${JSON.stringify(m.toolInput)}\noutput: ${m.content}`
    }
    lines.push(`[${role}] ${body}`)
  }
  return lines.join('\n\n')
}

// 在 history 中找到"压缩分界点":从尾部往前累计 token,直到达到 keepBudget,
// 分界点之后的消息原样保留,之前的全部进入 summary。必须保证分界点落在
// tool 调用对(AIMessage(tool_calls) + ToolMessage)的边界上,避免拆散配对。
function findSplitIndex(messages: ChatMessage[], keepBudget: number): number {
  let acc = 0
  let split = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    acc += estimateChatMessagesTokens([m])
    if (acc > keepBudget) {
      split = i + 1
      break
    }
    split = i
  }
  // 向前调整,确保 split 不落在 tool 调用对的中间:
  // 若 split 处是一条 ToolMessage,但前一条是带 tool_calls 的 AIMessage,把
  // 这一对也并入被压缩部分(即 split 前移到 AIMessage 之前)。
  while (
    split < messages.length &&
    split > 0 &&
    messages[split - 1]!.role === 'assistant' &&
    (messages[split - 1] as ChatMessage & { toolCalls?: unknown }).toolCalls !== undefined
  ) {
    // ChatMessage 里 assistant 不直接带 tool_calls 字段(tool 调用走单独的
    // tool 消息),所以这里实际不会触发;保留防御性逻辑以防未来 schema 变化。
    split -= 1
  }
  return Math.max(0, Math.min(split, messages.length))
}

const SUMMARY_PROMPT = `你是一个对话压缩助手。下面是一段 agent 与用户的对话历史(含工具调用与结果)。请把它压缩成一份简洁的摘要,要求:

1. 保留所有关键事实:用户的目标、已做出的决定、已修改/创建的文件、已运行的命令及其结果、已发现的问题。
2. 保留未完成的任务和下一步计划。
3. 丢弃寒暄、重复内容、冗长的工具原始输出(只保留结论)。
4. 用清晰的分点或短段落呈现,中文回答。
5. 不要编造对话中不存在的信息。

直接输出摘要正文,不要加"以下是摘要"之类的前缀。`

// 执行一次 compact:把 history 的旧部分总结成一条 summary,保留尾部。
// 失败时返回 { history: null },由调用方提示用户;不回退到截断逻辑。
export async function compactHistory(
  history: ChatMessage[],
  opts: CompactOptions
): Promise<CompactResult> {
  const beforeTokens = estimateChatMessagesTokens(history)
  const keepBudget = Math.max(0, Math.floor(beforeTokens * KEEP_RECENT_RATIO))
  const split = findSplitIndex(history, keepBudget)

  const toCompress = history.slice(0, split)
  const toKeep = history.slice(split)

  // 没有可压缩的内容(历史太短)→ 直接返回原样,标记为无需压缩。
  if (toCompress.length === 0) {
    opts.onEvent({ type: 'compact-end', skipped: true })
    return { history: history.slice(), beforeTokens, afterTokens: beforeTokens }
  }

  opts.onEvent({ type: 'compact-start', beforeTokens, afterTokensEstimate: keepBudget })

  // 阶段式进度:收集(10%) → 调用模型总结(10%~90%,主耗时) → 替换(100%)。
  // "调用模型"阶段没有天然百分比,用一个长间隔的进度推进模拟,让用户看到
  // 进度条在动而不是卡死。
  opts.onEvent({ type: 'compact-progress', stage: 'collecting', percent: 10 })

  let summaryText = ''
  try {
    const llm = opts.llm ?? createLlm(opts.modelId)
    const rendered = renderHistoryForSummary(toCompress)
    const resp = await llm.invoke([
      new SystemMessage(SUMMARY_PROMPT),
      new HumanMessage(rendered)
    ])
    summaryText =
      typeof resp.content === 'string'
        ? resp.content
        : Array.isArray(resp.content)
          ? resp.content
              .map(p =>
                p && typeof p === 'object' && 'text' in p && typeof p['text'] === 'string'
                  ? p['text']
                  : ''
              )
              .join('')
          : ''
    if (opts.signal?.aborted) throw new Error('aborted')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    opts.onEvent({ type: 'compact-error', message })
    return { history: null, beforeTokens, afterTokens: beforeTokens }
  }

  opts.onEvent({ type: 'compact-progress', stage: 'summarizing', percent: 90 })

  // 组装压缩后的历史:summary 在前,保留的尾部在后。summary 用带标记的
  // assistant 消息承载,reducer 会把它渲染成压缩卡片。
  const summaryMessage: ChatMessage = {
    id: `compact-${Date.now()}`,
    role: SUMMARY_ROLE,
    content: `📝 [对话已压缩]\n\n${summaryText}`,
    createdAt: Date.now()
  }
  const newHistory = [summaryMessage, ...toKeep]
  const afterTokens = estimateChatMessagesTokens(newHistory)

  opts.onEvent({
    type: 'compact-end',
    skipped: false,
    beforeTokens,
    afterTokens,
    summary: summaryText
  })

  return { history: newHistory, beforeTokens, afterTokens }
}

// 供 index.ts 在 stream 中检测是否需要自动 compact。返回当前 used/max 比例。
export function contextRatio(used: number, max: number): number {
  if (max <= 0) return 0
  return used / max
}

export function shouldAutoCompact(used: number, max: number): boolean {
  return contextRatio(used, max) > COMPACT_THRESHOLD
}

// 把 ChatMessage[] 转成 BaseMessage[](与 index.ts 的 buildHistoryMessages
// 同语义),供需要把压缩后历史喂给 agent 的场景复用。
export function chatToBaseMessages(chatMessages: ChatMessage[]): BaseMessage[] {
  const result: BaseMessage[] = []
  for (const msg of chatMessages) {
    if (msg.role === 'user') {
      result.push(new HumanMessage(msg.content))
    } else if (msg.role === 'assistant') {
      result.push(new AIMessage({ content: msg.content }))
    } else if (msg.role === 'tool') {
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

// 标记一条 ChatMessage 是否是 compact 产生的 summary(用于 UI 区分渲染)。
export function isCompactSummary(msg: ChatMessage): boolean {
  return msg.role === 'assistant' && msg.content.startsWith('📝 [对话已压缩]')
}

// 重新导出,方便测试引用且避免循环依赖显式化。
export { isAIMessage, isToolMessage }

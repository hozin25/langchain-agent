import type { BaseMessage, AIMessage } from '@langchain/core/messages'
import type { ChatMessage } from './types'

// 模型最大上下文窗口（tokens）
export const MODEL_MAX_CONTEXT: Record<string, number> = {
  'glm-5.2': 1_048_576,
  'glm-5.1': 204_800,
  'glm-4.5': 131_072,
  'deepseek-v4-pro': 1_048_576,
  'deepseek-v4-flash': 1_048_576
}

export const DEFAULT_MAX_CONTEXT = 1_048_576

export interface ContextUsage {
  used: number
  max: number
}

// 中英文混合 token 估算
// 中文: 1 token ≈ 1.5 字符 → 权重 0.67
// 英文/数字: 1 token ≈ 4 字符 → 权重 0.25
// 其他: 权重 0.33
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const ch of text) {
    if (/[一-鿿㐀-䶿]/.test(ch)) {
      tokens += 1 / 1.5
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      tokens += 1 / 4
    } else {
      tokens += 1 / 3
    }
  }
  return Math.ceil(tokens)
}

// 估算 ChatMessage[] 的 token 数，口径与 compact.ts 的 countChatTokens 一致：
// 每条按 [role] content 估算，tool 消息额外计入 toolInput 的 JSON。供前端在
// 非 runAgent 时机（打开旧对话 / compact 后 / 切换 model）刷新进度条——这些
// 场景没有 context-usage 事件。比真实 used 偏小（不含 system prompt / memory），
// 作进度指引够用，下一轮 runAgent 会用真实值覆盖。
export function estimateChatMessagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const m of messages) {
    let text = `[${m.role}] ${m.content}`
    if (m.role === 'tool' && m.toolInput !== undefined) {
      text += `\n${JSON.stringify(m.toolInput)}`
    }
    total += estimateTokens(text)
  }
  return total
}

// 估算 BaseMessage[] 的 token 数，供 runAgent 与 delegate 在 stream 中途判断
// context 用量（是否触发 compact）。口径：每条按 [role] content 估算，带
// tool_calls 的 AIMessage 额外计入 tool_calls 的 JSON。与 estimateChatMessagesTokens
// 语义不同（一个吃 ChatMessage、一个吃 BaseMessage），各保留不合并。
// 类型用 `import type`，渲染进程 import 本文件的其它函数时不会把 langchain
// 运行时打进 web bundle（type-only 在编译期擦除）。
export function countMessagesTokens(messages: BaseMessage[]): number {
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

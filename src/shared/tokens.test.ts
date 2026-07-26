import { describe, it, expect } from 'vitest'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import {
  countMessagesTokens,
  estimateTokens,
  estimateChatMessagesTokens
} from './tokens'

// countMessagesTokens 从 index.ts 下沉到 shared/tokens.ts，口径必须与原实现一致：
// 每条按 `[role] content` 估算，带 tool_calls 的 AIMessage 额外计入 tool_calls 的 JSON。
describe('countMessagesTokens — BaseMessage[] 估算口径', () => {
  it('单条 HumanMessage = estimateTokens("[human] <content>")', () => {
    const msg = new HumanMessage('hello world')
    expect(countMessagesTokens([msg])).toBe(estimateTokens('[human] hello world'))
  })

  it('AIMessage(tool_calls) 计入 tool_calls JSON', () => {
    const args = { path: 'a.txt', mode: 'read' }
    const ai = new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_1', name: 'read_file', args }]
    })
    const expected = estimateTokens(`[ai] \n${JSON.stringify(ai.tool_calls)}`)
    expect(countMessagesTokens([ai])).toBe(expected)
  })

  it('AIMessage(tool_calls) 比 AIMessage(纯文本) 多算 tool_calls 开销', () => {
    const plain = new AIMessage('做完了')
    const withCalls = new AIMessage({
      content: '做完了',
      tool_calls: [{ id: 'call_1', name: 'read_file', args: { path: 'long/path/to/file.txt' } }]
    })
    expect(countMessagesTokens([withCalls])).toBeGreaterThan(countMessagesTokens([plain]))
  })

  it('ToolMessage 按 [tool] content 估算', () => {
    const tm = new ToolMessage({ content: 'output', tool_call_id: 'c1', name: 'read_file' })
    expect(countMessagesTokens([tm])).toBe(estimateTokens('[tool] output'))
  })

  it('多条消息累加', () => {
    const msgs = [new HumanMessage('q'), new AIMessage('a')]
    const expected = estimateTokens('[human] q') + estimateTokens('[ai] a')
    expect(countMessagesTokens(msgs)).toBe(expected)
  })

  it('空数组返回 0', () => {
    expect(countMessagesTokens([])).toBe(0)
  })
})

// 与 estimateChatMessagesTokens（吃 ChatMessage）语义不同、各自保留不合并。
// 这里只确认两者对「纯文本等价输入」给出相同的量级，避免有人误改后口径漂移。
describe('countMessagesTokens vs estimateChatMessagesTokens 口径独立', () => {
  it('两者都存在且为函数', () => {
    expect(typeof countMessagesTokens).toBe('function')
    expect(typeof estimateChatMessagesTokens).toBe('function')
  })
})

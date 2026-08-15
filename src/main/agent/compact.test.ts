import { describe, it, expect } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage
} from '@langchain/core/messages'
import {
  baseToChatMessages,
  chatToBaseMessages,
  extractTextOrReasoning
} from './compact'

// baseToChatMessages 是 chatToBaseMessages 的「语义逆」：正向把 1 条 tool
// ChatMessage 拆成 AIMessage(tool_calls) + ToolMessage 一对；反向则把这对
// 还原成两条 tool ChatMessage（一条记 input、一条记 output）。所以 tool 消息
// 在 base→chat→base 上不是 1:1 恒等，但配对信息（name / tool_call_id / args /
// output）必须完整保留——这是子 agent compact 复用 compactHistory 的前提。
describe('baseToChatMessages — BaseMessage[] → ChatMessage[]', () => {
  it('HumanMessage → role:user', () => {
    const chat = baseToChatMessages([new HumanMessage('你好')])
    expect(chat).toHaveLength(1)
    expect(chat[0]!.role).toBe('user')
    expect(chat[0]!.content).toBe('你好')
  })

  it('AIMessage(纯文本) → role:assistant', () => {
    const chat = baseToChatMessages([new AIMessage('done')])
    expect(chat[0]!.role).toBe('assistant')
    expect(chat[0]!.content).toBe('done')
  })

  it('AIMessage(tool_calls) → 每个调用一条 role:tool（记 input，content 空）', () => {
    const ai = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'call_1', name: 'read_file', args: { path: 'a.txt' } },
        { id: 'call_2', name: 'list_files', args: { dir: '.' } }
      ]
    })
    const chat = baseToChatMessages([ai])
    expect(chat).toHaveLength(2)
    expect(chat.every(m => m.role === 'tool')).toBe(true)
    expect(chat[0]).toMatchObject({ toolName: 'read_file', toolCallId: 'call_1', toolInput: { path: 'a.txt' } })
    expect(chat[1]).toMatchObject({ toolName: 'list_files', toolCallId: 'call_2' })
  })

  it('ToolMessage → role:tool（记 output）', () => {
    const tm = new ToolMessage({ content: 'hello world', tool_call_id: 'call_1', name: 'read_file' })
    const chat = baseToChatMessages([tm])
    expect(chat).toHaveLength(1)
    expect(chat[0]).toMatchObject({
      role: 'tool',
      toolName: 'read_file',
      toolCallId: 'call_1',
      content: 'hello world'
    })
  })

  it('SystemMessage 兜底落 assistant（保留内容不丢）', () => {
    const chat = baseToChatMessages([new SystemMessage('system prompt')])
    expect(chat[0]!.role).toBe('assistant')
    expect(chat[0]!.content).toBe('system prompt')
  })

  it('GLM-5.x reasoning：content 空 + reasoning_content → 提取 reasoning', () => {
    const ai = new AIMessage({
      content: '',
      additional_kwargs: { reasoning_content: '真正的答案' }
    })
    const chat = baseToChatMessages([ai])
    expect(chat[0]!.role).toBe('assistant')
    expect(chat[0]!.content).toBe('真正的答案')
  })
})

describe('baseToChatMessages roundtrip — 配对信息保留', () => {
  it('user / assistant 文本消息 base→chat→base 恒等', () => {
    const base = [new HumanMessage('q'), new AIMessage('a')]
    const round = chatToBaseMessages(baseToChatMessages(base))
    expect(round).toHaveLength(2)
    expect(round[0]).toBeInstanceOf(HumanMessage)
    expect(round[1]).toBeInstanceOf(AIMessage)
    expect(round[0]!.content).toBe('q')
    expect(round[1]!.content).toBe('a')
  })

  it('tool_calls 配对：base→chat→base 后 name/id/args/output 全部保留', () => {
    const base = [
      new HumanMessage('请读文件'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }]
      }),
      new ToolMessage({ content: 'hello world', tool_call_id: 'call_1', name: 'read_file' })
    ]
    const round = chatToBaseMessages(baseToChatMessages(base))
    // 还原后仍包含 AIMessage(tool_calls) 与 ToolMessage 的配对（按 tool_call_id 对齐）。
    const aiCalls = round.filter(
      m => m instanceof AIMessage && (m as AIMessage).tool_calls && (m as AIMessage).tool_calls!.length > 0
    ) as AIMessage[]
    const tools = round.filter(m => m instanceof ToolMessage) as ToolMessage[]
    expect(aiCalls.length).toBeGreaterThan(0)
    expect(tools.length).toBeGreaterThan(0)
    const call = aiCalls[0]!.tool_calls![0]!
    expect(call.name).toBe('read_file')
    expect(call.id).toBe('call_1')
    expect(call.args).toEqual({ path: 'a.txt' })
    expect(tools.some(t => t.tool_call_id === 'call_1' && t.name === 'read_file' && t.content === 'hello world')).toBe(true)
  })
})

describe('chatToBaseMessages — compact summary 转 HumanMessage', () => {
  // 回归:summary 以 assistant 角色存储,若按 assistant 转 BaseMessage,会与
  // 其后的 tool 对形成连续 assistant 消息,GLM anthropic 兼容端点 400/1214。
  it('summary 消息 → HumanMessage，后跟 tool 对仍配对完整', () => {
    const base = chatToBaseMessages([
      {
        id: 'compact-1',
        role: 'assistant',
        content: '📝 [对话已压缩]\n\n摘要内容',
        createdAt: 0
      },
      {
        id: 't1',
        role: 'tool',
        toolName: 'read_file',
        toolCallId: 'c1',
        toolInput: { path: 'a.txt' },
        content: 'hello',
        createdAt: 0
      }
    ])
    expect(base[0]).toBeInstanceOf(HumanMessage)
    expect(String(base[0]!.content)).toContain('摘要内容')
    expect(base[1]).toBeInstanceOf(AIMessage)
    expect(base[2]).toBeInstanceOf(ToolMessage)
  })

  it('普通 assistant 消息仍转 AIMessage（不受 summary 前缀匹配影响）', () => {
    const base = chatToBaseMessages([
      { id: 'a1', role: 'assistant', content: '回答正文', createdAt: 0 }
    ])
    expect(base[0]).toBeInstanceOf(AIMessage)
  })
})

describe('extractTextOrReasoning', () => {
  it('普通文本 content 直接返回（AIMessage / HumanMessage）', () => {
    expect(extractTextOrReasoning(new AIMessage('hello'))).toBe('hello')
    expect(extractTextOrReasoning(new HumanMessage('hi'))).toBe('hi')
  })

  it('content 空 + reasoning_content → 回落到 reasoning', () => {
    const ai = new AIMessage({ content: '', additional_kwargs: { reasoning_content: 'reasoned answer' } })
    expect(extractTextOrReasoning(ai)).toBe('reasoned answer')
  })

  it('content 空 + 无 reasoning_content → 返回空串', () => {
    expect(extractTextOrReasoning(new AIMessage(''))).toBe('')
  })

  it('数组形态 content（text 块）正确拼接', () => {
    const ai = new AIMessage({ content: [{ type: 'text', text: 'part1 ' }, { type: 'text', text: 'part2' }] })
    expect(extractTextOrReasoning(ai)).toBe('part1 part2')
  })
})

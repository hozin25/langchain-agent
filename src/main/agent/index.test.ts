import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { fakeModel, type FakeBuiltModel } from '@langchain/core/testing'
import { runAgent } from './index'
import { getCheckpointer } from './checkpointer'
import type { AgentEvent, ChatMessage } from '@shared/types'

let workspace: string
let events: AgentEvent[]

// Unique thread_id per runAgent call. getCheckpointer() is a process-wide
// MemorySaver singleton, so reusing a conversationId across tests (or across
// calls in one test) would leak checkpoint state and skew the append-contract
// branch (hasCkpt would be true on the second call). A monotonic counter keeps
// each call isolated.
let threadSeq = 0
const nextThreadId = (): string => `test-thread-${++threadSeq}`

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'agent-int-'))
  events = []
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

// runAgent 在 stream 开始前及每个 superstep 都会发一次 context-usage
// (index.ts 的事件循环),与被测逻辑无关。过滤掉后只断言业务事件序列,
// 避免被逐 step 的 token 估算发射次数扰动。
const businessEvents = (): AgentEvent[] => events.filter(e => e.type !== 'context-usage')

const eventOfType = <T extends AgentEvent['type']>(type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
const firstEvent = <T extends AgentEvent['type']>(type: T) => eventOfType(type)[0]

const run = (message: string, llm: FakeBuiltModel): Promise<void> =>
  runAgent({ conversationId: nextThreadId(), message, workspace, llm, onEvent: e => events.push(e) })

// An error that classifyError reads as HTTP 429 (transient rate limit → retryable).
// fakeModel.respond() accepts an Error to throw on the next invoke; we attach a
// numeric status so classifyError's duck-typed branch fires.
const rateLimitError = (): Error => {
  const e = new Error('rate limit exceeded')
  Object.assign(e, { status: 429, name: 'RateLimitError' })
  return e
}

describe('runAgent — ReAct loop 集成', () => {
  it('golden path:纯文本回复,无工具调用', async () => {
    const llm = fakeModel().respond(new AIMessage('你好,我能帮你做什么?'))

    await run('hello', llm)

    expect(businessEvents().map(e => e.type)).toEqual(['message-delta', 'done'])
    expect(firstEvent('message-delta')?.delta).toBe('你好,我能帮你做什么?')
    expect(llm.callCount).toBe(1)
  })

  it('单轮真实工具调用:read_file 后总结', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hello world')
    const llm = fakeModel()
      .respondWithTools([{ name: 'read_file', args: { path: 'a.txt' } }])
      .respond(new AIMessage('文件内容是 hello world'))

    await run('读 a.txt', llm)

    expect(businessEvents().map(e => e.type)).toEqual([
      'tool-start',
      'tool-end',
      'message-delta',
      'done'
    ])
    expect(firstEvent('tool-start')?.tool).toBe('read_file')
    expect(firstEvent('tool-start')?.input).toEqual({ path: 'a.txt' })
    expect(firstEvent('tool-end')?.output).toBe('hello world')
    expect(llm.callCount).toBe(2)
  })

  it('多轮工具调用:连续两次 read_file', async () => {
    await writeFile(join(workspace, 'a.txt'), 'AAA')
    await writeFile(join(workspace, 'b.txt'), 'BBB')
    const llm = fakeModel()
      .respondWithTools([{ name: 'read_file', args: { path: 'a.txt' } }])
      .respondWithTools([{ name: 'read_file', args: { path: 'b.txt' } }])
      .respond(new AIMessage('读完两个文件'))

    await run('读 a.txt 和 b.txt', llm)

    expect(businessEvents().map(e => e.type)).toEqual([
      'tool-start',
      'tool-end',
      'tool-start',
      'tool-end',
      'message-delta',
      'done'
    ])
    const outputs = eventOfType('tool-end').map(e => e.output)
    expect(outputs).toEqual(['AAA', 'BBB'])
    expect(llm.callCount).toBe(3)
  })

  it('错误路径:LLM 抛错时发 error 事件且不发 done', async () => {
    const llm = fakeModel().alwaysThrow(new Error('LLM 不可用'))

    await run('hello', llm)

    const biz = businessEvents()
    expect(biz.map(e => e.type)).toEqual(['error'])
    expect(biz.some(e => e.type === 'done')).toBe(false)
    expect(firstEvent('error')?.message.length).toBeGreaterThan(0)
  })

  it('todo_write 事件穿透:getTools 的 emit 回调到达 onEvent', async () => {
    const todos = [{ id: '1', content: '步骤一', status: 'in_progress' as const }]
    const llm = fakeModel()
      .respondWithTools([{ name: 'todo_write', args: { todos } }])
      .respond(new AIMessage('已规划任务'))

    await run('规划任务', llm)

    // LangGraph values stream 等一个 superstep 的全部 node 执行完才批量 yield 各
    // 中间 message,因此 todo_write 工具体内的 emit(todo-update)先于 runAgent
    // 消费到 agent 的 AIMessage chunk(发 tool-start)。副作用事件因此排在 tool-start
    // 前面。无 emit 副作用的工具(如 read_file)不受影响,见上一个测试。
    expect(businessEvents().map(e => e.type)).toEqual([
      'todo-update',
      'tool-start',
      'tool-end',
      'message-delta',
      'done'
    ])
    expect(firstEvent('todo-update')?.todos).toEqual(todos)
    expect(firstEvent('tool-end')?.tool).toBe('todo_write')
  })
})

// 未覆盖路径(本次范围外,留作后续):
// - abort/interrupted(时序敏感,需在 onEvent 回调里触发 controller.abort)
// - recursion limit(RECURSION_LIMIT=50 硬编码,跑满 50 步较慢)
// - 防御性 generic ChatMessage 分支(fakeModel 只发 AIMessage,难触发)

describe('runAgent — 分层重试', () => {
  it('可重试错误(429)、尚未执行工具 → 发 retry 事件后重试成功', async () => {
    const llm = fakeModel().respond(rateLimitError()).respond(new AIMessage('重试后成功了'))

    await run('hello', llm)

    const types = businessEvents().map(e => e.type)
    // 首次失败(429) → retry → 第二次成功流式回复 → done
    expect(types).toContain('retry')
    expect(types).toContain('message-delta')
    expect(types[types.length - 1]).toBe('done')
    const retry = firstEvent('retry')!
    expect(retry.attempt).toBe(1)
    expect(retry.maxAttempts).toBe(2)
    expect(retry.reason.length).toBeGreaterThan(0)
    expect(retry.delayMs).toBeGreaterThan(0)
    // 两次 invoke:首次抛错,第二次成功
    expect(llm.callCount).toBe(2)
  })

  it('已执行工具后失败 → 不自动重试,直接发 error(retryable 仍为 true 供手动重试)', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hi')
    const llm = fakeModel()
      .respondWithTools([{ name: 'read_file', args: { path: 'a.txt' } }])
      .respond(rateLimitError()) // 工具已执行后再抛 429

    await run('读 a.txt', llm)

    const types = businessEvents().map(e => e.type)
    expect(types).not.toContain('retry') // toolStarted 闸挡住自动重试
    expect(types).toContain('tool-start')
    expect(types).toContain('tool-end')
    expect(types).toContain('error')
    const err = firstEvent('error')!
    // 429 本可重试,但因已执行工具,turn 层不再自动重试
    expect(err.kind).toBe('rate_limit')
    expect(err.retryable).toBe(true)
  })

  it('API key 缺失(injectedLlm 为空且 env 无 key)→ 发 auth error,不进 stream', async () => {
    const before = process.env['GLM_API_KEY']
    delete process.env['GLM_API_KEY']
    try {
      events = []
      await runAgent({
        conversationId: nextThreadId(),
        message: 'hello',
        workspace,
        modelId: 'glm-5.2',
        onEvent: e => events.push(e)
      })

      const types = businessEvents().map(e => e.type)
      expect(types).toEqual(['error'])
      const err = firstEvent('error')!
      expect(err.kind).toBe('auth')
      expect(err.retryable).toBe(false)
      expect(err.guidance).toBeTruthy()
    } finally {
      if (before !== undefined) process.env['GLM_API_KEY'] = before
    }
  })

  it('不可重试错误(裸 Error)→ 不发 retry,直接 error', async () => {
    const llm = fakeModel().alwaysThrow(new Error('boom'))

    await run('hello', llm)

    const types = businessEvents().map(e => e.type)
    expect(types).not.toContain('retry')
    expect(types).toEqual(['error'])
    expect(firstEvent('error')!.kind).toBe('unknown')
    expect(firstEvent('error')!.retryable).toBe(false)
  })
})

// recursionLimit 与 superstep 的精确对应依赖 LangGraph 内部计数;这里用宽松但有意义
// 的不变量断言(最终 done / tool-start 跨段累加 / 达上限报 recursion_limit),细节靠
// verbose 跑时 [agent] step N 日志确认。
describe('runAgent — 递归上限自动续跑', () => {
  // 续跑跨多段、每段重建 LangGraph stream 有固有开销,放宽超时。
  const CONTINUATION_TIMEOUT = 30000

  it('撞上限后跨段续跑,最终收敛 → done(不发 error)', async () => {
    await writeFile(join(workspace, 'a.txt'), 'X')
    // recursionLimit=6 每段约 3 次工具调用后撞限;4 次 tool_calls 迫使跨段,
    // 第 5 次 invoke 收尾收敛。
    const llm = fakeModel()
    for (let i = 0; i < 4; i++) {
      llm.respondWithTools([{ name: 'read_file', args: { path: 'a.txt' } }])
    }
    llm.respond(new AIMessage('续跑后收敛了'))

    await runAgent({
      conversationId: nextThreadId(),
      message: 'loop',
      workspace,
      llm,
      recursionLimit: 6,
      maxContinuations: 3,
      onEvent: e => events.push(e)
    })

    const types = businessEvents().map(e => e.type)
    expect(types[types.length - 1]).toBe('done')
    expect(types).not.toContain('error')
    // 单段 recursionLimit=6 容纳不下全部 4 次工具调用;tool-start > 3 证明跨段续跑
    expect(eventOfType('tool-start').length).toBeGreaterThan(3)
    expect(llm.callCount).toBeGreaterThan(1)
  }, CONTINUATION_TIMEOUT)

  it('达 maxContinuations 仍不收敛 → 发 recursion_limit error', async () => {
    await writeFile(join(workspace, 'a.txt'), 'X')
    const llm = fakeModel()
    for (let i = 0; i < 30; i++) {
      llm.respondWithTools([{ name: 'read_file', args: { path: 'a.txt' } }])
    }

    await runAgent({
      conversationId: nextThreadId(),
      message: 'loop',
      workspace,
      llm,
      recursionLimit: 6,
      maxContinuations: 2,
      onEvent: e => events.push(e)
    })

    const types = businessEvents().map(e => e.type)
    expect(types).toContain('error')
    expect(types[types.length - 1]).not.toBe('done')
    const err = firstEvent('error')!
    expect(err.kind).toBe('recursion_limit')
    expect(err.retryable).toBe(false)
  }, CONTINUATION_TIMEOUT)
})

// Phase 2:checkpointer 注入后,跨轮 append 契约与 deleteThread 清理。这些测试用
// getCheckpointer() 单例直接观察 checkpoint 状态,锁死架构层:runAgent 真的把 graph
// 接到了 checkpointer,thread_id 真的 = conversationId,次轮只 append 新消息(不
// 重建/不翻倍),deleteThread 真的清状态(compact 协调依赖它)。
describe('runAgent — checkpointer append 契约', () => {
  const CONTINUATION_TIMEOUT = 30000

  // 取 checkpoint 里的消息列表(channel_values.messages)。跨 LangGraph 版本用
  // 宽松访问 + 兜底空数组,断言只看长度增减,不依赖具体形状。
  const threadMessages = async (threadId: string): Promise<BaseMessage[]> => {
    const tuple = await getCheckpointer().getTuple({ configurable: { thread_id: threadId } })
    const ckpt = tuple?.checkpoint as unknown as
      | { channel_values?: { messages?: BaseMessage[] } }
      | undefined
    return ckpt?.channel_values?.messages ?? []
  }

  it('同 thread 跨轮:首轮建 checkpoint,次轮 append(只 +新消息,不翻倍)', async () => {
    const conversationId = nextThreadId()
    await writeFile(join(workspace, 'a.txt'), 'X')

    // 轮1:工具调用 + 收尾 → HumanMessage + AIMessage(tool_call) + ToolMessage + AIMessage
    const llm1 = fakeModel()
    llm1.respondWithTools([{ name: 'read_file', args: { path: 'a.txt' } }])
    llm1.respond(new AIMessage('首轮完成'))
    await runAgent({
      conversationId,
      message: '读 a.txt',
      workspace,
      llm: llm1,
      onEvent: e => events.push(e)
    })

    const msgs1 = await threadMessages(conversationId)
    expect(msgs1.length).toBeGreaterThan(0)

    // 轮2:同 thread。故意传一份「错误且冗长」的降级 history(模拟 renderer 总传
    // 完整 history)。有 checkpoint 时 main 必须忽略它、只 append 新消息 —— 否则这
    // 些假消息会进 context 造成翻倍。断言 msgs2 = msgs1 + 2(1 HumanMessage + 1
    // 最终 AIMessage),若误用 history 重建会多出 bogus 消息 → 长度远大于 +2。
    events = []
    const fakeHistory: ChatMessage[] = Array.from({ length: 5 }, (_, i) => ({
      id: `fake-${i}`,
      role: 'user' as const,
      content: `bogus history ${i}`,
      createdAt: 0
    }))
    const llm2 = fakeModel()
    llm2.respond(new AIMessage('次轮完成'))
    await runAgent({
      conversationId,
      message: '继续',
      workspace,
      llm: llm2,
      history: fakeHistory,
      onEvent: e => events.push(e)
    })

    const msgs2 = await threadMessages(conversationId)
    expect(msgs2.length).toBe(msgs1.length + 2)

    const types = businessEvents().map(e => e.type)
    expect(types[types.length - 1]).toBe('done')
  }, CONTINUATION_TIMEOUT)

  it('deleteThread 清掉 checkpoint → 同 thread 下次视为无 checkpoint(compact 协调依赖)', async () => {
    const conversationId = nextThreadId()
    const llm = fakeModel()
    llm.respond(new AIMessage('ok'))
    await runAgent({
      conversationId,
      message: 'first',
      workspace,
      llm,
      onEvent: e => events.push(e)
    })
    expect(
      await getCheckpointer().getTuple({ configurable: { thread_id: conversationId } })
    ).toBeDefined()

    await getCheckpointer().deleteThread(conversationId)
    expect(
      await getCheckpointer().getTuple({ configurable: { thread_id: conversationId } })
    ).toBeUndefined()
  })
})

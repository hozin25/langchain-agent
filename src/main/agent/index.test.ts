import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage } from '@langchain/core/messages'
import { fakeModel, type FakeBuiltModel } from '@langchain/core/testing'
import { runAgent } from './index'
import type { AgentEvent } from '@shared/types'

let workspace: string
let events: AgentEvent[]

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
  runAgent({ message, workspace, llm, onEvent: e => events.push(e) })

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

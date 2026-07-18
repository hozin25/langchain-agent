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

    expect(businessEvents().map(e => e.type)).toEqual(['tool-start', 'tool-end', 'message-delta', 'done'])
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

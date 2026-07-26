import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { makeDelegate, type DelegateContext } from './delegate'
import type { AgentEvent, AgentRole } from '@shared/types'

// 子 agent compact 续跑集成测试。drive 真实的 createReactAgent + ReAct 循环，
// 用 fakeModel 注入 + 注入小 contextMax / maxSubCompacts 让 compact 快速触发
// （参照 index.ts 的 recursionLimit / maxContinuations 注入惯例）。
// CLAUDE.md 铁律：vitest 应用自己的 interop，运行时行为还须靠 probe + pnpm dev 复核。

let workspace: string
let events: AgentEvent[]

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'delegate-'))
  events = []
})
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const coderRole: AgentRole = {
  id: 'coder',
  name: 'Coder',
  description: 'writes code',
  systemPrompt: 'You are a coder.',
  allowedTools: ['read_file'],
  builtin: true
}

// 让 compactHistory 真正执行摘要（而非 skipped）：KEEP_RECENT_RATIO=0.2，需要
// history 的前 80% 有内容可压缩。注入一段长 context 使 HumanMessage 足够大，
// 否则 compact 会判定 toCompress 为空直接返回原历史（compact 变 no-op，后续
// fakeModel 的 respond 顺序错位）。
const BIG_CONTEXT = '基准上下文：这是一段需要被子 agent 处理的长文本。'.repeat(60)

const mkCtx = (overrides: Partial<DelegateContext>): DelegateContext => ({
  workspace,
  emit: (e: AgentEvent) => events.push(e),
  confirm: async () => true,
  mcpTools: [],
  depth: 0,
  roles: [coderRole],
  ...overrides
})

const subagentEnd = (): Extract<AgentEvent, { type: 'subagent-end' }> | undefined =>
  events.find((e): e is Extract<AgentEvent, { type: 'subagent-end' }> => e.type === 'subagent-end')

// 两条路径都把 context 错误吸收为静默 compact，最终 subagent-end ok:true、
// 根 agent 收到完整结果（不把 context_too_long 漏成根 error）。
describe('makeDelegate — 子 agent compact 续跑', () => {
  it('路径 A：LLM 抛 context-too-long → 静默 compact 续跑 → 成功', async () => {
    await writeFile(join(workspace, 'a.txt'), 'file content')
    const ctxErr = new Error('This model maximum context length exceeded')
    const llm = fakeModel()
      .respondWithTools([{ name: 'read_file', args: { path: 'a.txt' } }]) // seg1: agent 调工具
      .respond(ctxErr) // seg1: 工具后 agent 再调 → 抛 context too long
      .respond(new AIMessage('compacted summary')) // compact 的 llm.invoke
      .respond(new AIMessage('final answer after compact')) // seg2: agent 收尾

    const delegateTool = makeDelegate(mkCtx({ llm, maxSubCompacts: 1 }))
    const result = (await delegateTool.invoke({
      agentRoleId: 'coder',
      task: '读 a.txt',
      context: BIG_CONTEXT
    })) as string

    expect(result).toContain('子任务完成')
    expect(result).toContain('final answer after compact')
    const end = subagentEnd()
    expect(end).toBeTruthy()
    expect(end!.ok).toBe(true)
  }, 30000)

  it('路径 B：主动阈值检测（注入小 contextMax）→ 静默 compact 续跑 → 成功', async () => {
    await writeFile(join(workspace, 'a.txt'), 'X')
    const llm = fakeModel()
      .respondWithTools([{ name: 'read_file', args: { path: 'a.txt' } }]) // seg1: agent → AIM(tool_calls)，首轮即撞阈
      .respond(new AIMessage('proactive summary')) // compact 的 llm.invoke
      .respond(new AIMessage('final after proactive compact')) // seg2: agent 收尾

    const delegateTool = makeDelegate(mkCtx({ llm, contextMax: 10, maxSubCompacts: 1 }))
    const result = (await delegateTool.invoke({
      agentRoleId: 'coder',
      task: '读 a.txt',
      context: BIG_CONTEXT
    })) as string

    expect(result).toContain('子任务完成')
    expect(result).toContain('final after proactive compact')
    const end = subagentEnd()
    expect(end).toBeTruthy()
    expect(end!.ok).toBe(true)
  }, 30000)

  it('对照：未注入 contextMax（默认大）+ 一次工具调用 → 正常完成，不触发 compact', async () => {
    await writeFile(join(workspace, 'a.txt'), 'hi')
    const llm = fakeModel()
      .respondWithTools([{ name: 'read_file', args: { path: 'a.txt' } }])
      .respond(new AIMessage('done without compact'))

    const delegateTool = makeDelegate(mkCtx({ llm }))
    const result = (await delegateTool.invoke({
      agentRoleId: 'coder',
      task: '读 a.txt',
      context: ''
    })) as string

    expect(result).toContain('子任务完成')
    expect(result).toContain('done without compact')
    // 没有任何子 compact 事件泄漏到根（compact 静默：onEvent noop）
    expect(events.some(e => e.type.startsWith('compact'))).toBe(false)
  }, 30000)
})

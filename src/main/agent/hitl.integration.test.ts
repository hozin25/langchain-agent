import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { runAgent } from './index'
import { ConfirmManager } from './confirm'
import type { AgentEvent } from '@shared/types'

// 这一层集成测试夹在 confirm.test.ts(纯 ConfirmManager 单元)和手工 UI 测试
// 之间:用 fakeModel 驱动真实的 runAgent ReAct 循环,验证 confirm gate 真的
// 介入了工具执行体——放行才执行、拒绝则短路返回取消说明、异步挂起直到
// 用户 respond、等待期间 abort 走 interrupted。不调用真实 LLM,确定性可复现。

let workspace: string
let events: AgentEvent[]

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'agent-hitl-'))
  events = []
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

const businessEvents = (): AgentEvent[] => events.filter(e => e.type !== 'context-usage')
const firstEvent = <T extends AgentEvent['type']>(type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)[0]

const exists = async (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false
  )

describe('runAgent — 危险操作人工确认 (集成)', () => {
  it('delete_file 放行:confirm 返回 true,文件被删,事件序列正确', async () => {
    await writeFile(join(workspace, 'victim.txt'), 'bye')
    const confirmCalls: Array<[string, unknown]> = []
    const llm = fakeModel()
      .respondWithTools([{ name: 'delete_file', args: { path: 'victim.txt' } }])
      .respond(new AIMessage('已删除 victim.txt'))

    await runAgent({
      message: '删除 victim.txt',
      workspace,
      llm,
      confirm: async (tool, input) => {
        confirmCalls.push([tool, input])
        return true
      },
      onEvent: e => events.push(e)
    })

    // confirm 以 (工具名, 参数) 被调用一次
    expect(confirmCalls).toEqual([['delete_file', { path: 'victim.txt' }]])
    expect(businessEvents().map(e => e.type)).toEqual([
      'tool-start',
      'tool-end',
      'message-delta',
      'done'
    ])
    expect(firstEvent('tool-end')?.output).toMatch(/Moved .* to trash/)
    expect(await exists(join(workspace, 'victim.txt'))).toBe(false)
  })

  it('delete_file 拒绝:confirm 返回 false,文件保留,工具返回取消说明', async () => {
    await writeFile(join(workspace, 'keep.txt'), 'stay')
    const llm = fakeModel()
      .respondWithTools([{ name: 'delete_file', args: { path: 'keep.txt' } }])
      .respond(new AIMessage('用户拒绝,未删除'))

    await runAgent({
      message: '删除 keep.txt',
      workspace,
      llm,
      confirm: async () => false,
      onEvent: e => events.push(e)
    })

    expect(firstEvent('tool-end')?.output).toMatch(/用户取消了删除/)
    expect(await exists(join(workspace, 'keep.txt'))).toBe(true)
  })

  it('run_shell_command 拒绝:命令不执行(无副作用文件生成)', async () => {
    const llm = fakeModel()
      .respondWithTools([
        { name: 'run_shell_command', args: { command: 'echo LEAK > proof.txt' } }
      ])
      .respond(new AIMessage('已取消命令'))

    await runAgent({
      message: '跑命令',
      workspace,
      llm,
      confirm: async () => false,
      onEvent: e => events.push(e)
    })

    expect(firstEvent('tool-end')?.output).toMatch(/用户取消了命令/)
    expect(await exists(join(workspace, 'proof.txt'))).toBe(false)
  })

  it('异步确认:真实 ConfirmManager 挂起工具,直到 respond 才放行执行', async () => {
    await writeFile(join(workspace, 'pending.txt'), 'data')
    const controller = new AbortController()
    const manager = new ConfirmManager(controller.signal, e => events.push(e))
    const llm = fakeModel()
      .respondWithTools([{ name: 'delete_file', args: { path: 'pending.txt' } }])
      .respond(new AIMessage('已删除'))

    // 不 await:工具会在 confirm gate 上挂起,runAgent 不返回
    const runP = runAgent({
      message: '删 pending.txt',
      workspace,
      llm,
      confirm: manager.request.bind(manager),
      onEvent: e => events.push(e)
    })

    // 工具已挂起:confirm-request 已发出,但文件还在(尚未删除)
    await vi.waitFor(() => {
      expect(events.some(e => e.type === 'confirm-request')).toBe(true)
    })
    expect(await exists(join(workspace, 'pending.txt'))).toBe(true)

    const req = firstEvent('confirm-request')!
    manager.respond(req.id, true, false)

    await runP

    expect(firstEvent('tool-end')?.output).toMatch(/Moved .* to trash/)
    expect(await exists(join(workspace, 'pending.txt'))).toBe(false)
  })

  it('异步确认:等待期间 abort 走 interrupted,文件未删', async () => {
    await writeFile(join(workspace, 'abort.txt'), 'data')
    const controller = new AbortController()
    const manager = new ConfirmManager(controller.signal, e => events.push(e))
    const llm = fakeModel().respondWithTools([
      { name: 'delete_file', args: { path: 'abort.txt' } }
    ])

    const runP = runAgent({
      message: '删 abort.txt',
      workspace,
      llm,
      signal: controller.signal,
      confirm: manager.request.bind(manager),
      onEvent: e => events.push(e)
    })

    await vi.waitFor(() => {
      expect(events.some(e => e.type === 'confirm-request')).toBe(true)
    })
    // 模拟用户在确认框等待时点了「停止」
    controller.abort()

    await runP

    expect(businessEvents().some(e => e.type === 'interrupted')).toBe(true)
    expect(await exists(join(workspace, 'abort.txt'))).toBe(true)
  })
})

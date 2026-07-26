/**
 * checkpointer 探针(MemorySaver) — Phase 2 Spike
 *
 * 用法:ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/probe-checkpointer.cjs
 *
 * 目的:在 Electron ABI 下验证 LangGraph checkpointer 的核心语义,
 * 决定 index.ts 重构方案。要回答:
 *   1. MemorySaver + createReactAgent 兼容吗?
 *   2. append 语义:同 thread_id 二次 invoke,messages 追加还是替换?
 *   3. 撞 recursionLimit 后,同 thread_id invoke({ messages: [] }) 能否续跑?
 *      (调研说自然结束后传 [] 是空跑;撞限强制停后能否续未验证 —— 最关键)
 *   4. deleteThread 清空
 *
 * 为什么 .cjs + 动态 import(CLAUDE.md 铁律):
 *   @langchain/langgraph 是纯 ESM,静态 require 在 cjs 下抛 ERR_REQUIRE_ESM。
 *   动态 import() 是 Node 24 原生 ES feature,在 ELECTRON_RUN_AS_NODE 下可用。
 *   用 fakeModel 避开真 LLM;MemorySaver 进程内无持久化,SqliteSaver 切换后
 *   语义一致(都实现 BaseCheckpointSaver),这里验证的 4 点对 sqlite 同样成立。
 */
async function main() {
  const { MemorySaver } = await import('@langchain/langgraph')
  const { createReactAgent } = await import('@langchain/langgraph/prebuilt')
  const { HumanMessage, AIMessage } = await import('@langchain/core/messages')
  const { tool } = await import('@langchain/core/tools')
  const { fakeModel } = await import('@langchain/core/testing')
  const { z } = await import('zod')

  let pass = 0
  let fail = 0
  const check = (name, cond) => {
    if (cond) {
      pass++
      console.log(`  ✓ ${name}`)
    } else {
      fail++
      console.error(`  ✗ ${name}`)
    }
  }
  const msgsOf = (tuple) => tuple?.checkpoint?.channel_values?.messages ?? []

  const echo = tool(
    async ({ text }) => `echo:${text}`,
    { name: 'echo', schema: z.object({ text: z.string() }) }
  )

  console.log('=== probe-checkpointer:MemorySaver 语义验证 ===')

  // [1] MemorySaver 构造 + createReactAgent 兼容 + 单轮 checkpoint
  console.log('\n[1] MemorySaver + createReactAgent 单轮')
  {
    const cp = new MemorySaver()
    const cfg = { configurable: { thread_id: 't1' } }
    const agent = createReactAgent({
      llm: fakeModel().respond(new AIMessage('answer-1')),
      tools: [echo],
      checkpointer: cp
    })
    await agent.invoke({ messages: [new HumanMessage('q1')] }, cfg)
    const tuple = await cp.getTuple(cfg)
    check('MemorySaver 构造 + agent 跑通无抛错', true)
    check('checkpoint 存在(tuple 非空)', !!tuple)
    const msgs = msgsOf(tuple)
    check('单轮后含 user q1', msgs.some((m) => m._getType() === 'human' && m.content === 'q1'))
    check('单轮后含 assistant answer-1', msgs.some((m) => m._getType() === 'ai' && m.content === 'answer-1'))
  }

  // [2] append 语义:同 thread_id 二次 invoke,messages 追加(非替换)
  console.log('\n[2] 同 thread_id 二次 invoke → append 语义')
  {
    const cp = new MemorySaver()
    const cfg = { configurable: { thread_id: 't2' } }
    const agentA = createReactAgent({
      llm: fakeModel().respond(new AIMessage('a1')),
      tools: [echo],
      checkpointer: cp
    })
    await agentA.invoke({ messages: [new HumanMessage('first')] }, cfg)
    const lenAfter1 = msgsOf(await cp.getTuple(cfg)).length

    const agentB = createReactAgent({
      llm: fakeModel().respond(new AIMessage('a2')),
      tools: [echo],
      checkpointer: cp
    })
    await agentB.invoke({ messages: [new HumanMessage('second')] }, cfg)
    const msgs2 = msgsOf(await cp.getTuple(cfg))
    check('二次 invoke 后 messages 数 > 一次后(追加非替换)', msgs2.length > lenAfter1)
    check('append:仍含第一轮 user "first"', msgs2.some((m) => m.content === 'first'))
    check('append:含第二轮 user "second"', msgs2.some((m) => m.content === 'second'))
    check('append:含第一轮 assistant "a1"', msgs2.some((m) => m.content === 'a1'))
  }

  // [3] 撞 recursionLimit → 同 thread_id messages:[] 续跑(Phase 2 最关键)
  console.log('\n[3] 撞 recursionLimit → messages:[] 续跑')
  {
    const cp = new MemorySaver()
    const tid = 't3'
    const cfgSmall = { configurable: { thread_id: tid }, recursionLimit: 3 }
    // fakeModel 一直调工具制造撞限;末尾留最终答案供续跑消费
    const llm = fakeModel()
      .respondWithTools([{ name: 'echo', args: { text: 'a' } }])
      .respondWithTools([{ name: 'echo', args: { text: 'b' } }])
      .respondWithTools([{ name: 'echo', args: { text: 'c' } }])
      .respondWithTools([{ name: 'echo', args: { text: 'd' } }])
      .respond(new AIMessage('final-after-continue'))
    const agent = createReactAgent({ llm, tools: [echo], checkpointer: cp })

    let hitLimit = false
    try {
      await agent.invoke({ messages: [new HumanMessage('go')] }, cfgSmall)
    } catch (e) {
      const code = e.code ?? e.lc_error_code ?? ''
      hitLimit = code === 'GRAPH_RECURSION_LIMIT' || /recursion|limit/i.test(e.message ?? '')
    }
    check('小 recursionLimit 触发撞限', hitLimit)

    const msgsMid = msgsOf(await cp.getTuple({ configurable: { thread_id: tid } }))
    console.log(`  撞限时 checkpoint messages 数: ${msgsMid.length}`)

    // 续跑:同 thread_id,messages:[],恢复正常 recursionLimit
    const cfgResume = { configurable: { thread_id: tid }, recursionLimit: 25 }
    let resumeOk = false
    let resumeFinalText = ''
    try {
      const result = await agent.invoke({ messages: [] }, cfgResume)
      resumeOk = true
      const finalMsgs = result.messages ?? []
      const last = finalMsgs[finalMsgs.length - 1]
      resumeFinalText = typeof last?.content === 'string' ? last.content : ''
    } catch (e) {
      console.error('  续跑抛错:', e.message)
    }
    check('撞限后 messages:[] 续跑未抛错', resumeOk)
    check('续跑后到达最终答案(final-after-continue)', resumeFinalText === 'final-after-continue')
  }

  // [4] deleteThread
  console.log('\n[4] deleteThread 清空 checkpoint')
  {
    const cp = new MemorySaver()
    const cfg = { configurable: { thread_id: 't4' } }
    const agent = createReactAgent({
      llm: fakeModel().respond(new AIMessage('x')),
      tools: [echo],
      checkpointer: cp
    })
    await agent.invoke({ messages: [new HumanMessage('seed')] }, cfg)
    check('deleteThread 前 checkpoint 存在', !!(await cp.getTuple(cfg)))
    await cp.deleteThread('t4')
    check('deleteThread 后 checkpoint 清空', !(await cp.getTuple(cfg)))
  }

  console.log(`\n=== 结果:${pass} passed, ${fail} failed ===`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('probe 抛错:', err)
  process.exit(1)
})

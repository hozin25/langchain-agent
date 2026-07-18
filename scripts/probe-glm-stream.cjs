/**
 * GLM-5.x 流式诊断脚本（plan 阶段 1）
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/probe-glm-stream.cjs
 *
 * 目的：对比三条路径在 GLM-5.2 reasoning model + tool call 场景下，
 * "最终回答 content" 是否丢失，并记录 chunk.content 的真实形态。
 *
 *   路径 1（老协议）：ChatOpenAI streaming:true + bindTools + invoke
 *       —— 预期复现 CLAUDE.md 记录的 bug（最终 content 为空 / 被误判为 generic）
 *   路径 2（新协议直调）：_streamChatModelEvents，直接消费 convertOpenAICompletionsStream 事件
 *       —— 预期 content 完整（验证新协议不丢）
 *   路径 3（集成）：createReactAgent + streamMode: ['values','messages']
 *       —— 预期 content 完整 + tool call 正常（端到端验证新协议在 LangGraph 下生效）
 *
 * 判据：路径 1 丢、路径 2/3 完整 → 走情况 A（切 streamMode，不改底层 LLM）
 *       路径 3 也丢 → 走情况 B（自定义 ChatOpenAI 子类）
 */

require('dotenv').config()

const { ChatOpenAI } = require('@langchain/openai')
const { HumanMessage, ToolMessage } = require('@langchain/core/messages')
const { tool } = require('@langchain/core/tools')
const { createReactAgent } = require('@langchain/langgraph/prebuilt')
const { z } = require('zod')

const MODEL = process.env.PROBE_MODEL || 'glm-5.2'
const API_KEY = process.env.GLM_API_KEY
const BASE_URL = process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4'

if (!API_KEY) {
  console.error('GLM_API_KEY missing in .env')
  process.exit(1)
}

const TOOL_PROMPT = '请调用 get_project_name 工具查出项目名，然后用一句话告诉我结果。'

const getProjectName = tool(
  async () => 'langchain-agent-desktop',
  { name: 'get_project_name', schema: z.object({}), description: '返回当前项目名' }
)

function makeLlm(opts = {}) {
  return new ChatOpenAI({
    model: MODEL,
    apiKey: API_KEY,
    configuration: { baseURL: BASE_URL },
    ...opts
  })
}

async function path1LegacyStreaming() {
  console.log('\n=== Path 1: 老协议 streaming:true + invoke ===')
  const llm = makeLlm({ streaming: true })
  const bound = llm.bindTools([getProjectName])

  const r1 = await bound.invoke([new HumanMessage(TOOL_PROMPT)])
  console.log('  step1 type:', r1._getType(), '| tool_calls:', JSON.stringify(r1.tool_calls ?? []))
  console.log('  step1 content:', JSON.stringify(r1.content))

  const tc = r1.tool_calls?.[0]
  if (!tc) {
    console.log('  ⚠️ step1 未产生 tool_call，无法模拟 tool round-trip')
    return
  }
  const r2 = await bound.invoke([
    new HumanMessage(TOOL_PROMPT),
    r1,
    new ToolMessage({ content: 'langchain-agent-desktop', tool_call_id: tc.id })
  ])
  console.log('  step2 (final) type:', r2._getType())
  console.log('  step2 content:', JSON.stringify(r2.content))
  console.log('  step2 content length:', typeof r2.content === 'string' ? r2.content.length : 'non-string')
}

async function path2NewProtocolDirect() {
  console.log('\n=== Path 2: 新协议 _streamChatModelEvents 直调 ===')
  const llm = makeLlm()
  const events = llm._streamChatModelEvents(
    [new HumanMessage('用一句话解释 ReAct 模式（思考后回答）')],
    {}
  )
  let text = ''
  let reasoning = ''
  const seenEvents = new Set()
  for await (const evt of events) {
    seenEvents.add(evt.event)
    if (evt.event === 'content-block-delta') {
      if (evt.delta?.type === 'text-delta' && typeof evt.delta.text === 'string') {
        text += evt.delta.text
        process.stdout.write('.')
      } else if (evt.delta?.type === 'reasoning-delta' && typeof evt.delta.reasoning === 'string') {
        reasoning += evt.delta.reasoning
      }
    }
  }
  console.log('\n  events seen:', [...seenEvents].join(', '))
  console.log('  reasoning chars:', reasoning.length)
  console.log('  final text:', JSON.stringify(text))
  console.log('  final text length:', text.length)
}

async function path3LanggraphMessagesMode() {
  console.log('\n=== Path 3: createReactAgent + streamMode [values,messages] ===')
  const llm = makeLlm()
  const agent = createReactAgent({ llm, tools: [getProjectName] })
  const stream = await agent.stream(
    { messages: [new HumanMessage(TOOL_PROMPT)] },
    { streamMode: ['values', 'messages'] }
  )

  let text = ''
  let reasoning = ''
  let toolCallChunks = 0
  let contentShapes = new Set()
  let valuesMsgs = 0
  let chunkIdx = 0

  for await (const item of stream) {
    const [mode, data] = item
    if (mode === 'values') {
      valuesMsgs++
      const msgs = data?.messages ?? []
      const last = msgs[msgs.length - 1]
      if (last) {
        console.log(`  [values] ${last.constructor.name} type=${last._getType()} calls=${last.tool_calls?.length ?? 0}`)
      }
    } else if (mode === 'messages') {
      const [chunk, meta] = data
      chunkIdx++
      const c = chunk?.content
      const shape = typeof c === 'string' ? 'string' : Array.isArray(c) ? `array[${(c || []).map(b => b?.type).join(',')}]` : typeof c
      contentShapes.add(shape)
      if (chunkIdx <= 40) {
        const rk = chunk?.additional_kwargs?.reasoning_content
        const cPreview = typeof c === 'string' ? JSON.stringify(c.slice(0, 50)) : JSON.stringify(c)
        console.log(
          `  [msg#${chunkIdx}] node=${meta?.langgraph_node} type=${chunk?._getType()} shape=${shape} ` +
          `tcc=${chunk?.tool_call_chunks?.length ?? 0} content=${cPreview} ` +
          `reasoning_kw=${typeof rk === 'string' ? rk.length + 'c' : typeof rk}`
        )
      }
      if (chunk?.tool_call_chunks?.length > 0) {
        toolCallChunks += chunk.tool_call_chunks.length
        continue
      }
      if (typeof c === 'string') {
        if (c.length > 0) {
          text += c
          process.stdout.write(c)
        }
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'text' && typeof b.text === 'string') {
            text += b.text
            process.stdout.write(b.text)
          } else if (b?.type === 'reasoning' && typeof b.reasoning === 'string') {
            reasoning += b.reasoning
          }
        }
      }
    }
  }
  console.log('')
  console.log('  values chunks:', valuesMsgs, '| tool_call_chunks:', toolCallChunks)
  console.log('  content shapes seen:', [...contentShapes].join(', '))
  console.log('  reasoning chars:', reasoning.length)
  console.log('  final text:', JSON.stringify(text))
  console.log('  final text length:', text.length)
}

;(async () => {
  console.log(`model=${MODEL} baseURL=${BASE_URL}`)
  await path1LegacyStreaming().catch(e => console.error('  path1 ERROR:', e?.message || e))
  await path2NewProtocolDirect().catch(e => console.error('  path2 ERROR:', e?.message || e))
  await path3LanggraphMessagesMode().catch(e => console.error('  path3 ERROR:', e?.message || e))
  console.log('\n=== done ===')
})()

/**
 * 子 agent compact 续跑 — 运行时探针（plan Phase 1）
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/probe-sub-compact.cjs
 *
 * 目的：在 Electron ABI 下用真实的 @langchain/core/messages 对象验证
 *   baseToChatMessages → chatToBaseMessages 的 roundtrip 配对一致性、
 *   以及 GLM-5.x reasoning_content 回落（extractTextOrReasoning）。
 *
 * 为什么要这个探针（CLAUDE.md 铁律）：vitest 应用自己的 interop / module 系统，
 * 可能掩盖运行时 BaseMessage 字段布局的差异。本探针在 Electron 主进程的真实
 * require('@langchain/core/messages') 下构造 AIMessage(tool_calls) / ToolMessage，
 * 确认字段（tool_calls / tool_call_id / additional_kwargs.reasoning_content）
 * 在运行时与逻辑预期一致。
 *
 * 注：baseToChatMessages / chatToBaseMessages / extractTextOrReasoning 是
 * src/main/agent/compact.ts 的内部函数（未从 main 入口导出），无法直接
 * require 编译产物。这里内联镜像其逻辑（与源文件同步），权威行为以 vitest
 * + pnpm dev 真实跑为准。Phase 1 不引入新 ESM 依赖，无 interop 风险。
 */

const {
  AIMessage,
  HumanMessage,
  ToolMessage
} = require('@langchain/core/messages')

// ---- 镜像 src/main/agent/compact.ts（保持同步）----
function extractTextOrReasoning(msg) {
  let content = msg.content
  let text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(p => typeof p === 'string' ? p : (p && typeof p === 'object' ? (p.text || (p.type === 'text' ? p.content : '')) : '')).join('')
    : ''
  if (text.length === 0) {
    const rk = msg.additional_kwargs && msg.additional_kwargs.reasoning_content
    if (typeof rk === 'string' && rk.length > 0) text = rk
  }
  return text
}

function baseToChatMessages(msgs) {
  const out = []
  const ts = Date.now()
  for (const m of msgs) {
    const type = m._getType()
    if (type === 'human') {
      out.push({ id: `b2c-${ts}-${out.length}`, role: 'user', content: extractTextOrReasoning(m), createdAt: ts })
    } else if (type === 'tool') {
      const tm = m
      out.push({ id: `b2c-${ts}-${out.length}`, role: 'tool', toolName: tm.name ?? 'tool', toolCallId: tm.tool_call_id ?? '', content: typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content), createdAt: ts })
    } else if (type === 'ai') {
      const ai = m
      if (ai.tool_calls && ai.tool_calls.length > 0) {
        for (const tc of ai.tool_calls) {
          out.push({ id: `b2c-${ts}-${out.length}`, role: 'tool', toolName: tc.name, toolCallId: tc.id ?? '', toolInput: tc.args, content: '', createdAt: ts })
        }
      } else {
        out.push({ id: `b2c-${ts}-${out.length}`, role: 'assistant', content: extractTextOrReasoning(m), createdAt: ts })
      }
    } else {
      out.push({ id: `b2c-${ts}-${out.length}`, role: 'assistant', content: extractTextOrReasoning(m), createdAt: ts })
    }
  }
  return out
}

function chatToBaseMessages(chatMessages) {
  const result = []
  for (const msg of chatMessages) {
    if (msg.role === 'user') {
      result.push(new HumanMessage(msg.content))
    } else if (msg.role === 'assistant') {
      result.push(new AIMessage({ content: msg.content }))
    } else if (msg.role === 'tool') {
      result.push(new AIMessage({ content: '', tool_calls: [{ id: msg.toolCallId ?? '', name: msg.toolName ?? 'tool', args: msg.toolInput ?? {} }] }))
      result.push(new ToolMessage({ content: msg.content, tool_call_id: msg.toolCallId ?? '', name: msg.toolName ?? 'tool' }))
    }
  }
  return result
}
// ---- 镜像结束 ----

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}`) }
}

async function main() {
  console.log('=== probe-sub-compact：roundtrip + reasoning_content 运行时验证 ===')
  console.log(`  AIMessage ctor: ${!!AIMessage}, ToolMessage ctor: ${!!ToolMessage}`)

  // 1. tool_calls 配对 roundtrip
  console.log('\n[1] 含 tool_calls 的 BaseMessage[] → chat → base')
  const base = [
    new HumanMessage('请读文件'),
    new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 'read_file', args: { path: 'a.txt' } }] }),
    new ToolMessage({ content: 'hello world', tool_call_id: 'call_1', name: 'read_file' })
  ]
  const chat = baseToChatMessages(base)
  const round = chatToBaseMessages(chat)
  const aiCalls = round.filter(m => m instanceof AIMessage && m.tool_calls && m.tool_calls.length > 0)
  const tools = round.filter(m => m instanceof ToolMessage)
  check('chat 含 user/assistant/tool 三类角色', chat.some(m => m.role === 'user') && chat.some(m => m.role === 'tool'))
  check('roundtrip 后仍含 AIMessage(tool_calls)', aiCalls.length > 0)
  check('roundtrip 后仍含 ToolMessage', tools.length > 0)
  check('tool_call id 保留 (call_1)', aiCalls.some(a => a.tool_calls[0].id === 'call_1') && tools.some(t => t.tool_call_id === 'call_1'))
  check('tool name 保留 (read_file)', aiCalls.some(a => a.tool_calls[0].name === 'read_file'))
  check('tool args 保留 ({path:"a.txt"})', aiCalls.some(a => JSON.stringify(a.tool_calls[0].args) === JSON.stringify({ path: 'a.txt' })))
  check('tool output 保留 (hello world)', tools.some(t => t.content === 'hello world'))

  // 2. reasoning_content 回落
  console.log('\n[2] GLM-5.x reasoning：content 空 + reasoning_content')
  const aiReasoning = new AIMessage({ content: '', additional_kwargs: { reasoning_content: '真正的答案' } })
  check('extractTextOrReasoning 回落到 reasoning_content', extractTextOrReasoning(aiReasoning) === '真正的答案')
  const chatR = baseToChatMessages([aiReasoning])
  check('baseToChatMessages 保留 reasoning 文本', chatR[0].role === 'assistant' && chatR[0].content === '真正的答案')

  // 3. 纯文本 roundtrip 恒等
  console.log('\n[3] 纯文本 base→chat→base 恒等')
  const plain = [new HumanMessage('q'), new AIMessage('a')]
  const plainRound = chatToBaseMessages(baseToChatMessages(plain))
  check('user 文本保留', plainRound[0] instanceof HumanMessage && plainRound[0].content === 'q')
  check('assistant 文本保留', plainRound[1] instanceof AIMessage && plainRound[1].content === 'a')

  console.log(`\n=== 结果：${pass} passed, ${fail} failed ===`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(err => {
  console.error('probe 抛错:', err)
  process.exit(1)
})

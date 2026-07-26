# 长任务可靠性实施计划（Checkpoint/Resume + Shadow Git 回滚 + 子 Agent Compaction）

## Overview

本项目（Electron + LangGraph ReAct agent 桌面应用）的长任务基础设施已接近业界一线：Claude Code 风格 compaction（`compact.ts`，80% 阈值）、recursion auto-continue（`index.ts` 续跑 loop）、三层错误重试（`errors.ts`）、HITL + 记住选择、父子 abort 联动都已就位。但业界长任务 checklist 10 项里有三项硬伤：

1. **无 LangGraph checkpointer** —— 崩溃/重启/切窗后只能从 ChatMessage 历史硬重启，丢失未完成 superstep 和 tool 中间态。
2. **无工作区回滚** —— agent 误删/误改后用户无法回到任意 checkpoint（Cline/Cursor/VSCode 标配）。
3. **子 agent 不做 compaction** —— 长子任务撞 context 上限直接失败被吸收为 summary。

本计划分三个独立 Phase 解决这三项，按「投入递增」顺序实施：**Phase 1 = C（子 agent compaction，小投入热身）→ Phase 2 = A（Checkpoint/Resume，核心价值）→ Phase 3 = B（Shadow Git 回滚，最大投入）**。

## Current State Analysis

### 已有（不动）
- **根 agent compaction**：`src/main/agent/compact.ts` 的 `compactHistory()`（compact.ts:103-176），`COMPACT_THRESHOLD = 0.8`（compact.ts:16），`KEEP_RECENT_RATIO = 0.2`（compact.ts:21）。触发链路：`runAgent` 每 superstep 调 `maybeEmitCompactNeeded`（index.ts:354-361）发 `compact-needed` 事件，**不打断 stream**，前端在当前轮 `done` 后异步走 `agent:compact` IPC（chat.ts:236-242 → ipc/index.ts:166-198），压缩完作为下一轮输入。
- **Auto-continue**：根 `RECURSION_LIMIT = 50`（index.ts:47），`MAX_CONTINUATIONS = 5`（续跑 loop index.ts:474-492）；子 `SUB_RECURSION_LIMIT = 40`（delegate.ts:20）。续跑用 `lastMessagesSnapshot`（index.ts:291,395）跨段衔接，**不清历史**。
- **三层重试**：LLM `maxRetries=3`（llm.ts）、turn `MAX_TURN_RETRIES=2`（index.ts:467-546）、续跑 5 段。`classifyError`（errors.ts:78-142）分 `aborted/auth/quota/rate_limit/overloaded/network/context_too_long/recursion_limit`。
- **中断**：`agent:cancel` → `controller.abort('user')`（ipc/index.ts:158-161），按 webContents.id 存 controller；父子 abort 联动（delegate.ts:89-97）；`runAgent` 检 `signal?.aborted` 发 `interrupted`（index.ts:494-496）。
- **HITL**：`ConfirmManager`（confirm.ts），危险工具 `delete_file`（fileSystem.ts:127）/`run_shell_command`（shell.ts:31），"记住选择"（confirm.ts:80-86），bypass mode（confirm.ts:69）。
- **持久化**：`<userDataDir>/conversations/<id>.json` + `index.json`（conversations/store.ts），每轮 done/error/interrupted 后一次 IO；conversation id 由 renderer 生成（`crypto.randomUUID()`，chat.ts:88）。

### 缺失（本计划补齐）
- LangGraph checkpointer（全仓库无 `SqliteSaver`/`MemorySaver` 使用，`createReactAgent` 未传 checkpointer）。
- 工作区快照与回滚。
- 子 agent compaction（`subEmit` 显式丢弃子 agent 的 `context-usage`，delegate.ts:83-86；`maybeEmitCompactNeeded` 不对子 agent 触发）。

### Key Discoveries
- **`createReactAgent` 接受 `checkpointer?: BaseCheckpointSaver | boolean`**（react_agent_executor.d.ts:95），A 项技术可行。
- **`MemorySaver`/`BaseCheckpointSaver` 从 `@langchain/langgraph` 主包 re-export**（dist/index.d.ts:48-49），无需额外装接口包。
- **`@langchain/langgraph-checkpoint-sqlite`（底层 better-sqlite3，native addon）当前未安装**，需 `pnpm add` + electron-rebuild。
- **子 agent 的 `values` chunk 同样携带完整 messages**（delegate.ts:169），可在 stream 中途估算 context 用量 → 子 compact 可行。
- **snapshot 不能在 `runAgent` 的 emit 钩子里做**（那时工具已在执行）——LangGraph 内部直接 invoke 工具，必须把 snapshot 织进每个写工具工厂函数内部、执行前。
- **`compactHistory` 接收 `ChatMessage[]`，子 agent 内部是 `BaseMessage[]`**——需新增反向转换器 `baseToChatMessages`（目前只有正向 `chatToBaseMessages`，compact.ts:190-220）。

## Desired End State

- 长任务在 Electron 崩溃/重启/切窗后，重新打开会话能从最后完成的 superstep 续跑，不丢已完成工具的中间态。
- agent 每次执行写操作前对 workspace 做一次 shadow git 快照，前端有 timeline，可一键 Restore 到任意快照，且**绝不污染用户原 git 仓库**。
- 子 agent 撞 context 上限时自动 compact 并续跑，而非直接失败；compact 静默进行，不污染根面板。

**验证总则（CLAUDE.md 铁律）**：任何运行时行为必须对照编译产物 `out/main/index.js` + 真实 `ELECTRON_RUN_AS_NODE=1 pnpm exec electron <probe>.cjs` + `pnpm dev` 验证，**不能只靠 vitest**（vitest 应用自己的 interop 会掩盖 ESM/CJS bug）。

## What We're NOT Doing

为防止 scope creep，以下明确排除（即诊断报告中的第二、第三梯队，留待后续）：
- HITL 确认超时机制（D）
- 整体 turn wall-clock 超时 + 防卡死探测（E）
- 子 agent todo 独立视图（F）
- Compaction 与续跑协调优化（G）—— 本计划 Phase 2 会处理 compact/续跑/checkpointer 的必要协调，但不做"续跑前预 compact"等增强
- Compaction 阈值可配（H）
- deny 双向 remember、background 进程注册表、中断后部分结果保存、shell 输出 head+tail、工具级重试（第三梯队）

## Implementation Approach

三个 Phase 彼此独立，无强依赖。按投入递增实施，每个 Phase 完成全部自动化验证后，**暂停等待人工手动验证**（implement_plan 的强制 pause 点），确认后再进下一 Phase。

**贯穿所有 Phase 的约束（CLAUDE.md gotchas，实施时必须遵守）**：
- **ESM/CJS interop**：主进程输出 CJS + externalizeDepsPlugin（electron.vite.config.ts:7），纯 ESM 包必须用动态 import `const x = (await import('pkg')).default`。
- **`streaming: true` load-bearing**（llm.ts），不能关。
- **GLM-5.x 流式文本在 `additional_kwargs.reasoning_content`**，`content` 为空——任何处理 messages 的代码都要 fallback（index.ts:379-384）。
- **版本钉死**：vite 7 + plugin-react 5 + electron-vite 5，不随意 bump。
- **TS7 + 两 tsconfig**：无 `baseUrl`，`paths` 须以 `./` 开头；改 `shared/types.ts` 会同时影响 node/web 两个项目，`pnpm typecheck` 必须全过。
- **workspace 沙箱**：所有 fs 工具走 `resolveInWorkspace()`（fileSystem.ts:7-15），新代码同样不能把用户/agent 路径直传 `fs`。

---

## Phase 1: 子 Agent Compaction（C）

### Overview
让子 agent 在 stream 中途检测 context 用量，撞 80% 阈值时主动 compact 并续跑，复用根 agent 的 `compactHistory`。子 compact 静默进行（不发事件），保持现有"子 agent 不污染根面板"设计。

### Changes Required

#### 1. `src/main/agent/compact.ts` — 新增反向转换器
**改动**：在 `chatToBaseMessages`（compact.ts:190）后新增 `baseToChatMessages`，把子 agent stream 内的 `BaseMessage[]` 还原成 `compactHistory` 能吃的 `ChatMessage[]`。AIMessage(tool_calls) + ToolMessage 配对拆成两条 tool 消息（镜像 index.ts `buildHistoryMessages` 的逆）。

```typescript
// BaseMessage[] → ChatMessage[]：供子 agent compact 复用 compactHistory
export function baseToChatMessages(msgs: BaseMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of msgs) {
    const type = m._getType()
    if (type === 'human') {
      out.push({ id: `b2c-${Date.now()}-${out.length}`, role: 'user',
        content: extractTextOrReasoning(m), createdAt: Date.now() })
    } else if (isToolMessage(m)) {
      const tm = m as ToolMessage
      out.push({ id: `b2c-${Date.now()}-${out.length}`, role: 'tool',
        toolName: tm.name ?? 'tool', toolCallId: tm.tool_call_id ?? '',
        content: typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content),
        createdAt: Date.now() })
    } else if (isAIMessage(m)) {
      const ai = m as AIMessage
      if (ai.tool_calls && ai.tool_calls.length > 0) {
        for (const tc of ai.tool_calls) out.push({
          id: `b2c-${Date.now()}-${out.length}`, role: 'tool',
          toolName: tc.name, toolCallId: tc.id ?? '', toolInput: tc.args,
          content: '', createdAt: Date.now() })
      } else {
        out.push({ id: `b2c-${Date.now()}-${out.length}`, role: 'assistant',
          content: extractTextOrReasoning(m), createdAt: Date.now() })
      }
    }
  }
  return out
}
```

**同时**：把 index.ts:79-86 的 `messageText`（含 reasoning_content fallback）下沉为 `extractTextOrReasoning` 导出到 compact.ts，消除重复。

#### 2. `src/main/agent/tools/delegate.ts` — 子 stream loop 改造为 compact 续跑 loop
**改动**：把 delegate.ts:135-202 的单次 `subAgent.stream(...)` 包进 `while(true)` 续跑 loop，镜像根续跑（index.ts:474-492）。

```typescript
import { compactHistory, COMPACT_THRESHOLD, chatToBaseMessages, baseToChatMessages } from '../compact'
import { countMessagesTokens } from '@shared/tokens'  // 下沉见下条

const MAX_SUB_COMPACTS = 2
const SUB_COMPACT_THRESHOLD = COMPACT_THRESHOLD  // 0.8

// 在 delegate 工具 invoke 体内（替换原 135-202 的 stream 调用）
const contextMax = MODEL_MAX_CONTEXT[role.modelId ?? ctx.parentModelId ?? ''] ?? DEFAULT_MAX_CONTEXT
let lastSubMessages: BaseMessage[] = [new HumanMessage(userText)]
let compactCount = 0
let compacted = false

runSubSegment: while (true) {
  const startMsgs = compacted ? lastSubMessages : [new HumanMessage(userText)]
  const stream = await subAgent.stream(
    { messages: startMsgs },
    { streamMode: ['values', 'messages'], recursionLimit: SUB_RECURSION_LIMIT, signal: subController.signal }
  )
  compacted = false
  try {
    for await (const item of stream as AsyncIterable<[string, unknown]>) {
      // ...保留现有 145-201 的 messages/values 处理与 subEmit...
      // values 分支内新增：刷新 lastSubMessages + 主动阈值检测（静默）
      if (mode === 'values') {
        const all = (data as { messages?: BaseMessage[] }).messages ?? []
        lastSubMessages = all
        // ...现有 isToolMessage/isAIMessage dispatch（保留）...
        const used = countMessagesTokens(all)  // 与根 agent 同口径
        if (contextMax > 0 && used / contextMax > SUB_COMPACT_THRESHOLD && compactCount < MAX_SUB_COMPACTS) {
          break  // 主动跳出 for-await，触发下方 compact 续跑（比等 LLM 报 400 省）
        }
      }
    }
    break runSubSegment  // stream 自然结束
  } catch (err) {
    if (isAbort(err)) { aborted = true; break runSubSegment }
    const isCtxLong = err instanceof Error && /context length|too long/i.test(err.message)
    if (!isCtxLong || compactCount >= MAX_SUB_COMPACTS) {
      // 落入现有 catch 逻辑（errMsg 设置等），break
      break runSubSegment
    }
    // isCtxLong 且还能 compact → 落到下方 compact 续跑
  }
  // compact 续跑（静默：onEvent 为 noop，不污染根面板）
  const chatHist = baseToChatMessages(lastSubMessages)
  const res = await compactHistory(chatHist, {
    workspace: ctx.workspace,
    modelId: role.modelId ?? ctx.parentModelId,
    signal: subController.signal,
    onEvent: () => {}  // 静默
  })
  if (!res.history) {
    // compact 失败降级：硬截断尾部保 6 条（含 tool 配对），避免整任务失败
    lastSubMessages = keepTailPairs(lastSubMessages, 6)
  } else {
    lastSubMessages = chatToBaseMessages(res.history)
  }
  compactCount++; compacted = true
  console.log(`[delegate] sub compact ${compactCount}/${MAX_SUB_COMPACTS}`)
}
```

**关键易错点 —— 跨段去重**：delegate.ts 现有 `streamedIds`（约 144 行）是单段内去重。compact 续跑跨段必须把 `streamedIds` 提到 loop 外、compact 后**不清空**，避免重 emit 压缩前的旧消息（镜像根的 `emittedMsgIds` index.ts:218）。

**abort 联动不变**：`subController.signal` 每段都传（stream + compactHistory 的 llm.invoke 都接受 signal，compact.ts:147）。

#### 3. `src/shared/tokens.ts` — 下沉 `countMessagesTokens`
**改动**：把 index.ts:165-178 的 module-local `countMessagesTokens` 下沉到 `src/shared/tokens.ts`（与 `estimateChatMessagesTokens` 同位），从 index.ts 和 delegate.ts 共同 import。注意口径：`countMessagesTokens` 估 `BaseMessage`（含 tool_calls JSON），`estimateChatMessagesTokens` 估 `ChatMessage`——两者语义不同，各保留，不合并。

#### 4. `src/renderer/src/stores/chatReducer.ts` 与 `src/shared/types.ts` — **无需改动**
子 compact 静默（onEvent 为 noop），不发新事件；现有 `agentId` 隔离已正确处理子 agent 的 message-delta/tool 事件。

### Success Criteria

#### Automated Verification
- [x] `pnpm typecheck` 通过（`baseToChatMessages`/`extractTextOrReasoning`/`countMessagesTokens` 导出类型正确，shared types 无变化）
- [x] `pnpm test` 通过：compact 现有用例不回归；新增 `baseToChatMessages` roundtrip 用例（含 tool_calls 的 BaseMessage[] → chat → base，断言配对一致）；新增子续跑用例（注入小 `contextMax` 让单测快速撞阈，参照 index.ts:42-44 的注入惯例）

#### Manual Verification
- [ ] `ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/probe-sub-compact.cjs`（新探针）：构造含 tool_calls 的 BaseMessage[]，验证 `baseToChatMessages → chatToBaseMessages` roundtrip 配对一致、reasoning_content 被保留
- [ ] `pnpm dev`（配 GLM-5.x key），让 coder 子 agent 执行「读取并改写某大文件多次」类长任务，观察：累积 token 超 80% 时 dev console 出现 `[delegate] sub compact 1/2`，子 agent **续跑而非 `subagent-end ok:false`**，最终根 agent 收到完整结果
- [ ] 对照：改造前同样任务 → `subagent-end ok:false`，summary 为 `Error: ...context length...`
- [ ] delegate 气泡下无重复 tool 卡片（验证跨段去重）

**Implementation Note**: 完成本 Phase 全部自动化验证后暂停，等待人工确认上述手动验证通过，再进 Phase 2。

---

## Phase 2: Checkpoint/Resume（A，SqliteSaver 后端）

### Overview
接入 `@langchain/langgraph-checkpoint-sqlite`（better-sqlite3），每个会话（conversation）一个 `thread_id`（= conversation id），崩溃/重启/切窗后从最后完成的 superstep 续跑。新增 `agent:resume` IPC 与「可恢复」UI。

### Spike（必须在写业务代码前完成，对照 CLAUDE.md 验证铁律）
1. `pnpm add @langchain/langgraph-checkpoint-sqlite @electron/rebuild`
2. `pnpm exec electron-rebuild -f -w better-sqlite3`（确认在 pnpm symlink 结构下能正确定位 better-sqlite3 模块；Windows 下可能需 `--module-dir`）
3. 新探针 `scripts/probe-sqlite.cjs`，`ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/probe-sqlite.cjs` 验证：
   - `const { SqliteSaver } = require('@langchain/langgraph-checkpoint-sqlite')` 能在 Electron ABI 下加载 `.node`
   - **核实 SqliteSaver 构造签名**（`new SqliteSaver(db)` vs `SqliteSaver.fromConnPath(path)` vs `SqliteSaver.fromConn(...)`），记录到本计划
   - 把 saver 传给 `createReactAgent` 跑一轮，确认 sync/async saver 与 react agent 兼容

### Spike 结论（2026-07-26，调研 + 安装实验；探针实测待 native 跑通）

**已确认（静态事实，来自 web 调研 + 本地核实）**：
- **SqliteSaver 构造签名**：只有 `new SqliteSaver(db)`（db = better-sqlite3 `Database` 实例）和 `SqliteSaver.fromConnString(path)`（传路径串，内部 `new Database(path)`）。**`fromConnPath` / `fromConn` 不存在**——下方改动 #2 占位 `new SqliteSaver(dbPath)` 须改为 `SqliteSaver.fromConnString(dbPath)` 或 `new SqliteSaver(new Database(dbPath))`。
- **sync/async**：JS 版只有一个 `SqliteSaver` 类（async 接口），与 `createReactAgent({ checkpointer })` 兼容（形参类型 `boolean | BaseCheckpointSaver`）。`BaseCheckpointSaver` / `MemorySaver` 已从 `@langchain/langgraph` 主包 re-export（dist/index.d.ts:48），无需显式装 `@langchain/langgraph-checkpoint` 接口包。
- **recursionLimit 是 per-invoke**（每次 stream 重新计数），撞限后用同 thread_id 再 stream 计数重置——与现有续跑 loop 不冲突。
- **有 `await checkpointer.deleteThread(threadId)` API**（camelCase），compact 协调可直接删旧 thread 复用同 id（不必换新 id）。
- **messages 是 append 语义**（reducer = `operator.add`）：同 thread_id 再 stream 时新 messages 追加到 checkpoint 旧 messages。**架构冲击**：当前 `runAgent` 每轮从 renderer 传完整 `history` 重建 BaseMessage[]，接入 checkpointer 后会**翻倍**——必须改契约：`agent.run` 首参加 `conversationId`(= thread_id)，撞限续跑不再传 `lastMessagesSnapshot`。传 `messages: []` 在自然结束后是空跑；撞限强制停后能否续跑**须探针实测**。

**阻塞点（安装实验，2026-07-26）**：
- 本机 Electron 43.1.0，`process.versions.modules = 148`。better-sqlite3 **v12.11.1 与 v13.0.1 均无 ABI 148 的 Electron prebuilt**（N-API 只保证 Node 版本间 ABI 稳定，不跨 Electron 专属 ABI 148）。
- electron-rebuild fallback 到本地编译，**需 VS Build Tools 2022 + "Desktop development with C++" workload**；本机原未装 → electron-rebuild 报 `Could not find any Visual Studio installation to use`。
- **当前状态**：`package.json` 已加 `@langchain/langgraph-checkpoint-sqlite@^1.0.3`(deps) + `@electron/rebuild@^4.2.0`(devDeps) + `pnpm.overrides` 强升 `better-sqlite3@^13.0.1`（v13 是 N-API 重写，更现代；编译出来后用 v13）。**用户正在装 VS Build Tools**（`winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`）。
- **装机后下一步**：重跑 `pnpm exec electron-rebuild -f -w better-sqlite3` → 写 `scripts/probe-sqlite.cjs` 实测 ABI 加载 / SqliteSaver 构造 / createReactAgent 兼容 / append 语义 / 撞限续跑 / deleteThread，把实测结论回填本段。

### 方向调整：切 MemorySaver（2026-07-26，装机受阻后）

VS Build Tools 装机连续受阻（msstore 源网络错误 → "组织策略正在阻止安装" → 退出码 8007）。机器无 VS 安装、本地注册表无对应策略键（`HKLM\SOFTWARE\Policies\Microsoft\VisualStudio\Setup` 不存在）→ **公司/组织管理镜像**，安装策略由更高层 GPO/MDM 锁死。native sqlite 在本机走不通。

**决策**：Phase 2 切 `MemorySaver`（`@langchain/langgraph` 已 re-export，零编译、零系统依赖）。已卸载 `@langchain/langgraph-checkpoint-sqlite` + `@electron/rebuild` + 回滚 `pnpm.overrides`。native sqlite 持久化（崩溃恢复价值）待以后本机解禁或换机器装 VS Build Tools 后补——届时 `checkpointer.ts` 的 `getCheckpointer()` 改一处实现 + 重跑 electron-rebuild 即可，业务代码零改动（写成 sqlite-ready 形态）。

**探针 `scripts/probe-checkpointer.cjs` 实测 13/13 通过**（`ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/probe-checkpointer.cjs`），核心语义全部确认：
- **append 语义成立**：同 thread_id 二次 invoke，messages 追加（非替换）。→ 确认改动 #3 的架构冲击：main 每轮传完整 history 会翻倍，`agent.run` 必须改契约（首参加 `conversationId`=thread_id，每轮只传新 user message）。
- **撞 recursionLimit 后 `invoke({ messages: [] }, { configurable: { thread_id } })` 能续跑到最终答案** ✓ —— 改动 #3 续跑协调方案验证可行：撞限续跑传 `messages: []`，checkpointer 从撞限 superstep 续，**不再传 `lastMessagesSnapshot`**（那会 append 翻倍）。撞限时 checkpoint 停在最后完成的 superstep（探针实测 4 条 messages）。
- **`deleteThread(threadId)` 工作**：compact 协调用它删旧 thread（复用同 thread_id），不必换新 id。
- 上述语义对 SqliteSaver 同样成立（同 `BaseCheckpointSaver` 接口），切 sqlite 无需改业务逻辑。

### Changes Required

#### 1. 依赖与打包
**`package.json`**：
```json
"dependencies": {
  "@langchain/langgraph-checkpoint": "^1.1.3",
  "@langchain/langgraph-checkpoint-sqlite": "1.0.3"
},
"devDependencies": {
  "@electron/rebuild": "<latest>"
},
"scripts": {
  "postinstall": "electron-rebuild -f -w better-sqlite3",
  "rebuild:native": "electron-rebuild -f -w better-sqlite3"
}
```

**`electron-builder.yml`**（native addon 必须解包出 asar，require 无法从 asar 加载 .node）：
```yaml
asar: true
asarUnpack:
  - '**/*.node'
  - '**/better-sqlite3/**'
```
**待 Spike 核实**：electron-builder 26 是否还需在 `files` 显式列 `node_modules/@langchain/langgraph-checkpoint-sqlite/**` 与 `node_modules/better-sqlite3/**`，或默认 production deps 已覆盖。

**`electron.vite.config.ts`**：better-sqlite3 必须保持 external（externalizeDepsPlugin 默认 externalize 所有 dependencies，无需额外配置；**不要**把它加进 bundle exclude）。

#### 2. `src/main/agent/checkpointer.ts` — 新建单例
```typescript
import { app } from 'electron'
import { join } from 'node:path'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'

let saverPromise: Promise<BaseCheckpointSaver> | null = null

export async function getCheckpointer(): Promise<BaseCheckpointSaver> {
  if (!saverPromise) {
    saverPromise = (async () => {
      // 动态 import：符合 CLAUDE.md interop 规则（即便该包是 CJS 也安全）
      const { SqliteSaver } = await import('@langchain/langgraph-checkpoint-sqlite')
      const dbPath = join(app.getPath('userData'), 'checkpoints.sqlite')
      // 构造签名以 Spike 结论为准
      return new SqliteSaver(dbPath)  // 占位，Spike 后修正
    })()
  }
  return saverPromise
}
```

#### 3. `src/main/agent/index.ts` — 根 agent 重构（核心难点）
**现状**：`createReactAgent` 在 `executeOnce`（index.ts:326-330）内每段新建，无跨 turn 复用。
**改动**：把 `createReactAgent` 提到 `runAgent` 顶层（attempt 循环外），注入 checkpointer。

```typescript
const checkpointer = await getCheckpointer()
const agent = createReactAgent({
  llm: injectedLlm ?? createLlm(modelId),   // 必须稳定，不能每段新建
  tools,                                     // 提到顶层（闭包 emit/confirm，仍属当前 run）
  prompt: systemPrompt,
  checkpointer
})

// stream 调用加 thread_id（index.ts:342-345）
const stream = await agent.stream(
  { messages: startMessages },
  {
    streamMode: ['values', 'messages'],
    recursionLimit: effectiveRecursionLimit,
    signal,
    configurable: { thread_id }   // 新增，= conversationId
  }
)
```

**续跑 loop 协调（index.ts:474-492）**：撞 `GRAPH_RECURSION_LIMIT` 时，**不再传 `lastMessagesSnapshot`**（会重复 messages），改为 `agent.stream({ messages: [] }, { configurable: { thread_id } })` 让 checkpointer 续跑。**Spike 核实**：LangGraph 的 recursion_limit 是 per-invoke 还是 per-thread（决定续跑是否重置计数；若不重置，需调大单次 recursionLimit 替代续跑 loop）。

#### 4. `src/shared/types.ts` — thread_id 透传 + resume 事件
```typescript
// RunPayload 加 conversationId（= thread_id）
interface RunPayload { conversationId: string; message: string; workspace: string; /* ... */ }

// Conversation schema 加 threadId（compact 换 thread 时更新）
interface Conversation { id: string; threadId: string; /* ... */ }

// AgentApi.agent.run 首参加 conversationId；新增 agent.resume / agent.hasCheckpoint
interface AgentApi {
  agent: {
    run(conversationId: string, message: string, workspace: string, ...): Promise<void>
    resume(conversationId: string, workspace: string, modelId?: string, mode?: AgentMode): Promise<void>
    hasCheckpoint(conversationId: string): Promise<boolean>
    /* ... */
  }
}
```

#### 5. `src/main/ipc/index.ts` — 新增 `agent:resume` / `agent:hasCheckpoint`
平行于 `agent:run`（ipc/index.ts:96-158）注册：
- `agent:hasCheckpoint(conversationId)`：查 checkpointer 是否有该 thread 的 checkpoint。
- `agent:resume(payload)`：同样建 controller/ConfirmManager，调 `runAgent` 的 resume 变体（用同 thread_id 重新 stream，LangGraph 自动续）。

#### 6. `src/preload/index.ts` + `src/renderer/src/stores/chat.ts`
- preload `agent.run`/`agent.resume`/`agent.hasCheckpoint` 转发。
- chat.ts `runTurn`（chat.ts:149,524）传 `conversationId`；`openConversation`（chat.ts:441）后调 `hasCheckpoint`，store 设 `resumable: boolean`；新增 `resume()` action 调 `agent.resume`，事件流复用 `onEvent` + `reduceChatEvent`（复用 running placeholder 模式 chat.ts:508-515，但不重发 user message）。
- UI：会话头部显示「上次中断，点击恢复」按钮（当 `resumable` 为 true）。

#### 7. compact 协调（防 messages 冲突）
compact 用 summary 替换 messages（compact.ts:164），但 checkpointer 存的是完整未压缩 messages。若 compact 后用同 thread_id 续跑，旧 checkpoint 的 messages 会淹没 summary。
**决策**：compact 成功后**换新 thread_id** = `<convId>:after-compact-<ts>`。`Conversation.schema` 加 `threadId`（types.ts:73-76），compact IPC（ipc/index.ts:166）返回新 threadId，renderer 持久化。**Spike 核实**：SqliteSaver 是否暴露按 thread_id 删除 checkpoint 的 API（若有，可改为删旧 thread 而非换新）。

### Success Criteria

#### Automated Verification
- [x] `pnpm typecheck` 通过（types.ts/preload 签名同步,2026-07-26 验证)
- [x] `pnpm test` 通过（2026-07-26 验证,139 tests):注入 fake llm + 真实 `getCheckpointer()` 单例覆盖:**续跑**(index.test.ts 既有续跑用例 + 撞限 messages:[] 续跑到收敛/到上限报错)、**append 契约**(同 thread 跨轮只 +新消息,不翻倍)、**deleteThread 清状态**(compact 协调依赖)。abort-then-resume 与 compact-换-thread 的端到端用例待 sqlite 接入后补(见下方 MemorySaver 实施结论)

#### Manual Verification
- [ ] `ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/probe-sqlite.cjs`：验证 better-sqlite3 在 Electron ABI 加载、SqliteSaver 构造、传给 createReactAgent 跑通
- [ ] `pnpm dev`：发长任务（连续 5+ 工具调用），工具执行中途用任务管理器 kill Electron → 重启 → 打开该会话 → UI 显示「可恢复」→ 点恢复 → agent 从中断 superstep 续跑（不重发已完成工具事件，对照 `emittedMsgIds` 去重 index.ts:218,410-414）→ 正常 `done`
- [ ] compact 后确认换 thread_id，旧 checkpoint 不污染续跑
- [ ] `pnpm package:win`，安装产物，确认 `resources/app.asar.unpacked/` 下有 better-sqlite3 的 `.node`、能加载、resume 功能在打包版可用（**MemorySaver 路径下 N/A** —— 无 native addon；打包验证推迟到切 sqlite 后）
- [x] 对照 `out/main/index.js` 验证 checkpointer 注入与 thread_id 透传在编译产物中正确（2026-07-26:agent 级 `checkpointer` @ line 1654、stream `configurable.thread_id` @ 1663、attempt 重试 `deleteThread` @ 1750、`getTuple` append 分支 @ 1754、compact handler `deleteThread` @ 13473）

### MemorySaver 实施结论（2026-07-26）

Phase 2 架构层已用 `MemorySaver` 跑通(零编译、零系统依赖),写成 sqlite-ready 形态,切 sqlite 时业务代码零改动。**已交付**:
- `checkpointer.ts` 单例 `getCheckpointer()`(切 sqlite 只改这一处实现)
- `index.ts`:`createReactAgent` 提到 runAgent 顶层注入 checkpointer;stream 配置加 `configurable: { thread_id: conversationId }`;attempt 循环加 `deleteThread`(重试前清 thread)+ `getTuple` 判 hasCkpt 的 append 契约分支(有 ckpt → 只传新消息;无 → 从 history 重建);撞限续跑改传 `messages: []`(checkpointer 续跑,不再传 snapshot)
- 契约透传:`AgentRunOptions.conversationId` / `RunPayload.conversationId` / `AgentApi.agent.run(convId,…)` / preload / chat.ts `runTurn.convId`;compact: `AgentApi.agent.compact(convId,…)` + ipc 压缩成功后 `getCheckpointer().deleteThread(convId)`
- 验证:typecheck 全过(node+web)、139 tests 全过(+2 append/deleteThread 契约用例)、build 通过、`out/main/index.js` 含全部接线、`probe-checkpointer.cjs` 13/13

**已推迟(依赖 sqlite 持久化,本机 native 受阻)**:
- `agent:resume` / `agent:hasCheckpoint` IPC 与「可恢复」UI —— MemorySaver 进程内,崩溃即丢,kill-then-resume 无法验证;同会话跨轮 append 已工作(架构就绪),跨进程恢复待 sqlite
- compact 协调:原方案「换 thread_id」已改为「`deleteThread` 复用同 id」(探针确认 deleteThread 工作,更简单),契约用例已锁
- 打包版 resume 验证 —— 待 sqlite

**切 sqlite 步骤(本机解禁后)**:`pnpm add @langchain/langgraph-checkpoint-sqlite` + electron-rebuild(需 VS Build Tools 2022) → `checkpointer.ts` 的 `getCheckpointer()` 改返回 `SqliteSaver.fromConnString(dbPath)`(dbPath = `join(app.getPath('userData'),'checkpoints.sqlite')`) → 加 `agent:resume`/`hasCheckpoint` IPC + UI → 业务逻辑零改动跑通 kill-then-resume。

**Implementation Note**: 完成本 Phase 全部自动化验证后暂停，等待人工确认上述手动验证（尤其 kill-then-resume 与打包版）通过，再进 Phase 3。

---

## Phase 3: Shadow Git 工作区回滚（B）

### Overview
在 `<userDataDir>/agent-snapshots/<workspaceHash>/` 建独立 git-dir 的 shadow 仓库，agent 每次执行写操作前做一次快照，前端提供 timeline + 一键 Restore。**绝不触碰用户原 git 仓库**（吸取 Cline #1213 删文件教训），restore 用文件拷贝而非 `git checkout`。

### Changes Required

#### 1. `src/main/snapshots/shadowRepo.ts` — 新建 shadow git 封装
**布局**：git-dir 放 `<userDataDir>/agent-snapshots/<workspaceHash>/.git`（workspace 绝对路径 sha1 前 16 位），work-tree 指向用户 workspace。**不引入 simple-git，直接 `spawn('git', ...)`**（与 shell.ts 一致，无 interop 风险）。

```typescript
export interface SnapshotCommit { sha: string; message: string; createdAt: number }
export interface ShadowRepo {
  init(): Promise<void>                      // git init + 写 .git/info/exclude
  snapshot(message: string): Promise<string> // git add -A; git commit → sha（无变化则返回上一 sha）
  listFiles(sha: string): Promise<string[]>
  readFile(sha: string, rel: string): Promise<Buffer>
  listCommits(since?: number): Promise<SnapshotCommit[]>
}
export function createShadowRepo(userDataDir: string, workspace: string): ShadowRepo
```

**关键隔离**：所有 git 子进程只设 `GIT_DIR=<userData>/.../.git`、`GIT_WORK_TREE=<workspace>`、`GIT_CONFIG_NOSYSTEM=1`、`-c core.hooksPath=`（禁 hook），用 `--git-dir`/`--work-tree` 显式参数，绝不继承 workspace 的 `.git`。`.git/info/exclude` 写入 `node_modules/`、`out/`、`release/`、`.git/`、`dist/`、`build/`。

#### 2. Snapshot 时机 — 写工具工厂包装
**决策**：每个写工具执行**前**做一次 snapshot（粒度=单工具，对应前端每个 tool 气泡一个 checkpoint）；shell 命令也视为写工具（保守）。**不能在 `runAgent` 的 emit 钩子做**（那时工具已在执行），必须织进工具工厂内部。

- `src/main/agent/tools/index.ts`：`getTools` 增参 `snapshot?: SnapshotFn`；`makeWriteFile/EditFile/CreateDirectory/MoveFile/MakeDeleteFile/MakeRunShellCommand` 用 `wrapWithSnapshot(tool, repo, emit)` 包一层——执行前 `await repo.snapshot(...)`，**失败不阻塞工具**（catch + 记日志，best-effort）。
- `src/main/agent/tools/subTools.ts`：`SubToolContext` 增 `snapshot?`，同包装（子 agent 沿用主 repo，同一 workspace）。
- `src/main/agent/index.ts`：`AgentRunOptions` 增 `snapshot?`，`runAgent` 顶部 `createShadowRepo` 并传给 `getTools`；turn 前也调一次 `snapshot('turn-start')`。

#### 3. Timeline 数据模型 + 事件
```typescript
// src/shared/types.ts 新增
export interface SnapshotEntry {
  id: string; sha: string; workspace: string; conversationId: string
  messageId?: string; toolName?: string; agentId?: string; turnLabel?: string; createdAt: number
}
// AgentEvent 新增分支
type AgentEvent = /* ... */ | { type: 'snapshot-taken'; entry: SnapshotEntry }
  | { type: 'restore-start' } | { type: 'restore-progress'; percent: number }
  | { type: 'restore-end'; preRestoreSha?: string } | { type: 'restore-error'; message: string }
// ChatMessage 增 snapshotId?: string（types.ts:38-63，挂在触发 snapshot 的 tool 消息上）
```
索引落盘：`<userDataDir>/agent-snapshots/<workspaceHash>/index.json`（原子写，参照 conversations/store.ts:91-112，SAFE_ID 校验 workspaceHash）。按 workspace scope，timeline 列表带 conversationId 过滤。

#### 4. `src/main/snapshots/restore.ts` — 安全 Restore（最危险）
**核心原则：绝不在用户 workspace 跑 `git checkout`/`git reset`/`git clean`，用文件拷贝。**
```typescript
export interface RestoreOptions { sha: string; mode: 'conservative' | 'full' }  // 默认 conservative
// 1. git --git-dir=... --work-tree=<ws> ls-tree -r --name-only <sha> → snapshot 文件清单
// 2. 对每个文件: git --git-dir=... show <sha>:<rel> → Buffer → fs.writeFile（路径经 resolveInWorkspace 校验）
// 3. conservative: 不动 workspace 中 snapshot 没有的文件（保留用户新增）
// 4. full: 额外删除 workspace 中存在但 snapshot 没有的文件（仅限非排除清单的普通文件，绝不递归删 workspace 根）
// 5. 恢复前先做 pre-restore snapshot（可逆，用户后悔能 undo）
```
全程用 Node fs API + shadow git 的 `show`/`cat-file`，不碰用户 repo 的任何 git 命令。删除（full 模式）只针对非排除清单普通文件，`resolveInWorkspace` 校验后 `fs.rm({force:true})`。

#### 5. IPC + 前端 Timeline UI
**`src/shared/types.ts` AgentApi 增 `snapshots` 命名空间**：
```typescript
snapshots: {
  list(workspace: string, conversationId?: string): Promise<SnapshotEntry[]>
  restore(workspace: string, sha: string, mode?: 'conservative'|'full'): Promise<{ok: boolean; preRestoreSha?: string}>
  diff(workspace: string, sha: string): Promise<{files: {path: string; status: 'added'|'modified'|'deleted'}[]}>
}
```
**`src/main/ipc/snapshots.ts`**（新建，仿 conversations.ts 风格），在 `registerIpc()`（ipc/index.ts:88-246）末尾 `registerSnapshotIpc()`。preload 增 `snapshots` 绑定。

**前端**：
- `src/renderer/src/stores/chat.ts`：`ChatState` 增 `snapshots`/`isRestoring`/`restoreProgress`；`loadSnapshots()`/`restore(sha,mode)` action。
- `src/renderer/src/stores/chatReducer.ts`：处理 `snapshot-taken`（追加 + 在 tool 消息记 `snapshotId`）、`restore-*`。
- `src/renderer/src/components/CheckpointTimeline.tsx`（新建）：侧边栏折叠区，列表 + 时间 + 触发工具 + Restore 按钮（带 ConfirmDialog 二次确认）。
- `src/renderer/src/components/MessageList.tsx`（MessageList.tsx:182-200 tool 分支）：当 `message.snapshotId` 存在且非 running 时渲染「⏪ 回滚到此」按钮。

#### 6. 与 HITL/abort 交互
- restore 是危险操作：**必须 ConfirmDialog 二次确认**（用户主动触发，不走 ConfirmManager）。
- restore 期间 disable 发送/restore 按钮；若 agent 正在 running，前端先 `interrupt()`（cancel 当前 turn）再 restore，restore 完成后插入 assistant 系统消息「已回滚到 <sha>，请告知下一步」。

### Success Criteria

#### Automated Verification
- [x] `pnpm typecheck` 通过（2026-07-26，node+web 全过）
- [x] `pnpm test` 通过（2026-07-26，166 tests，+27 Phase 3）：
  - `src/main/snapshots/shadowRepo.test.ts`：临时目录 + 真实 git 二进制，断言 snapshot 返回 sha、listFiles/readFile 正确、无变化时跳过（7 用例，含 `--allow-empty` 空仓基线 + exclude node_modules/out）
  - `src/main/snapshots/restore.test.ts`：**纯逻辑单测**（mock ShadowRepo），断言 conservative 不删新增文件、full 只删白名单外文件、`resolveInWorkspace` 拒绝逃逸路径、pre-restore snapshot 被创建（6 用例，含 nested 父目录重建 + EXCLUDE_DIRS 不误删 node_modules）
  - `src/main/snapshots/index-store.test.ts`：SAFE_ID 校验、workspaceHash 隔离、损坏 index.json 自愈（6 用例；并发说明：生产 snapshot 串行——每写工具 await 一次，与 conversations/store 同 shape 的非原子读改写，不测真并发）
  - `src/renderer/src/stores/chatReducer.test.ts`：`snapshot-taken`（追加 + toolName 匹配才 stamp）/`restore-start|progress|end|error`（8 用例）
- [x] 对照 `out/main/index.js`：snapshot 接线完整（`snapshots:list`/`snapshots:restore` IPC + `takeSnapshot` + `wrapWithSnapshot` + `agent-snapshots` 共 15 处标记）
- [x] `ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/probe-shadow-git.cjs` 16/16：workspace 是真实 git repo → shadow 操作后真实 repo `HEAD`/`status`/`log` 零变化，**隔离核心保证成立**

#### Manual Verification
- [ ] `ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/probe-shadow-git.cjs`：在 workspace cwd 下打印 `git rev-parse --git-dir`，确认指向 userData 而非 workspace/.git（验证环境变量隔离）
- [ ] `pnpm dev`，选一个**真实 git workspace**（记录基线 `git rev-parse HEAD` + `git status --porcelain`）：
  1. 让 agent 改 3 个文件（write_file/edit_file/delete_file 各一）→ timeline 出现 3+ checkpoint（含 turn-start）
  2. 再让 agent 改 2 个文件
  3. 点第 2 个 checkpoint「⏪ 回滚到此」→ 确认 → workspace 文件回到第 2 个 snapshot 状态（第 3-5 步改动消失，第 1-2 步保留）
  4. **断言用户原 git 仓库不受污染**：`git rev-parse HEAD` 不变、`git status --porcelain` 仅反映 restore 后文件状态、无 git 内部状态变化
  5. restore 全程有进度提示、可 undo（pre-restore checkpoint 存在且能 restore 回去）

**Implementation Note**: 完成本 Phase 全部自动化验证后暂停，等待人工确认上述手动验证（尤其「不污染用户原 git 仓库」）通过。本 Phase 为最后一个 Phase。

---

## Testing Strategy

### Unit Tests
- `compact.test.ts`：`baseToChatMessages` roundtrip（含 tool_calls 配对、reasoning_content 保留）。
- `tokens.test.ts`：下沉后的 `countMessagesTokens` 与原 index.ts 口径一致。
- `checkpointer.test.ts`（Phase 2）：注入 fake llm + `MemorySaver`（避开 native），覆盖续跑、abort-resume、compact-换-thread。
- `shadowRepo.test.ts` / `restore.test.ts` / `index-store.test.ts`（Phase 3）：见上。

### Integration Tests
- Phase 2 的 kill-then-resume 难以自动化（需 kill 进程），主要靠手动；可用 vitest 模拟「同 thread_id 二次 stream」覆盖 checkpointer 续跑逻辑。
- Phase 3 的 restore 安全性靠纯逻辑单测 + 手动真实 git workspace 验证。

### Manual Testing Steps
见各 Phase 的 Manual Verification。**强制**遵守 CLAUDE.md：所有运行时行为对照 `out/main/index.js` + `ELECTRON_RUN_AS_NODE=1 pnpm exec electron <probe>.cjs` + `pnpm dev`，不能只靠 vitest。

## Performance Considerations
- **Phase 1**：子 compact 的 `llm.invoke`（compact.ts:131）可能 5-10s，子 agent 看似「卡住」。当前选择静默；若手动验证发现体验差，可补一个轻量 `sub-compact-progress` 事件挂在 delegate 气泡下（不改根 reducer）。`MAX_SUB_COMPACTS = 2` 限制总开销。
- **Phase 2**：SqliteSaver 每 superstep 写一次 sqlite，better-sqlite3 是同步 API——长任务（多 superstep）的 IO 开销需观察；必要时调 checkpoint 的 `write` 频率（待核实 SqliteSaver 是否支持）。
- **Phase 3**：大 workspace 的 `git add -A` + commit 可能慢。`.git/info/exclude` 排除 node_modules/out/release 是关键；必要时设单文件大小上限跳过（待核实）。snapshot 是 best-effort、异步、失败不阻塞工具。

## Migration Notes
- **Phase 2**：现有 `conversations/<id>.json` 不含 `threadId` 字段。旧会话首次打开时 `threadId` 默认 = `id`（conversation id），无需迁移脚本。旧会话没有 checkpoint，`hasCheckpoint` 返回 false，不显示「可恢复」。
- **Phase 3**：首次在某 workspace 跑 agent 时初始化 shadow repo（无历史 snapshot），timeline 为空，属正常。
- **better-sqlite3 打包变更**：加 `postinstall: electron-rebuild` 后，所有协作者 `pnpm install` 会自动 rebuild；CI（若有）需确保有编译工具链。

## References
- 业界调研来源：[LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)、[Cline Checkpoints](https://docs.cline.bot/core-workflows/checkpoints)、[Cline #1213 restore bug](https://github.com/cline/cline/issues/1213)、[Claude Code auto-compact](https://github.com/anthropics/claude-code/issues/65379)、[LangGraph recursion_limit](https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT)
- 本项目研究文档：`thoughts/shared/research/2026-07-21-multi-agent-collaboration.md`
- 关键实现位置：
  - `src/main/agent/index.ts` — runAgent 主体、续跑 loop（474-492）、retry（467-546）、compact 触发（354-361）、context 上报（395-405）、createReactAgent（326-330）
  - `src/main/agent/compact.ts` — compactHistory（103-176）、chatToBaseMessages（190-220）
  - `src/main/agent/tools/delegate.ts` — 子 stream（135-202）、subEmit 丢弃 context-usage（83-86）、abort 联动（89-97）
  - `src/main/agent/confirm.ts` — ConfirmManager、bypass、记住选择
  - `src/main/agent/tools/fileSystem.ts` — 写工具、resolveInWorkspace（7-15）、delete_file HITL（127）
  - `src/main/conversations/store.ts` — 会话持久化、SAFE_ID（12）
  - `src/main/ipc/index.ts` — IPC entry、AbortController/ConfirmManager 绑定
  - `src/shared/types.ts` — AgentEvent/AgentApi/ChatMessage 单一真相源
  - `electron-builder.yml` / `electron.vite.config.ts` — 打包与构建配置

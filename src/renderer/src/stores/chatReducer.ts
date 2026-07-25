import type { AgentEvent, ChatMessage, TodoItem } from '@shared/types'

export interface ChatReducerState {
  messages: ChatMessage[]
  todos: TodoItem[]
  contextUsed: number
  contextMax: number
  pendingConfirm: {
    id: string
    tool: string
    input: unknown
    agentId?: string
    agentName?: string
  } | null
  // compact(对话压缩)状态。null=未进行中;对象=正在进行中,UI 据此显示横幅
  // + 进度条。error 在 compact 结束后单独保留一条,供 UI 显示失败提示。
  // 注意:字段名是 compactState(不是 compact),避免与 store 里的 compact()
  // action 重名导致 TS 报错。
  compactState: {
    active: boolean
    stage: 'collecting' | 'summarizing' | 'replacing' | null
    percent: number
    beforeTokens?: number
    afterTokensEstimate?: number
  } | null
  compactError: string | null
  // 自动 compact 待执行标志:runAgent 在 stream 中检测到 >80% 时置 true,
  // store 在当前轮 done 后消费它触发 compact。
  compactNeeded: boolean
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2)
}

// Last assistant message still streaming for a given agent. agentId undefined
// means the root agent; a sub-agent's messages carry their own agentId, so the
// strict equality correctly separates the two streams.
function lastRunningAssistant(messages: ChatMessage[], agentId?: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.status === 'running' && m.agentId === agentId) {
      return i
    }
  }
  return -1
}

function lastRunningTool(messages: ChatMessage[], agentId?: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'tool' && m.status === 'running' && m.agentId === agentId) {
      return i
    }
  }
  return -1
}

function appendOrCreateAssistant(
  messages: ChatMessage[],
  agentId: string | undefined,
  agentName: string | undefined,
  chunk: string
): ChatMessage[] {
  const idx = lastRunningAssistant(messages, agentId)
  // Only absorb text into an existing running placeholder while it is still the
  // LAST message. A tool-start pushes a tool card after the placeholder; any
  // text the model emits AFTER that tool (e.g. the final success summary in a
  // plan→act turn) must start a fresh bubble below the tool, otherwise it gets
  // swallowed back into the pre-tool placeholder and the UI shows only the tool
  // card with no conclusion.
  if (idx >= 0 && idx === messages.length - 1) {
    const copy = messages.slice()
    const cur = copy[idx]!
    copy[idx] = { ...cur, content: cur.content + chunk }
    return copy
  }
  return [
    ...messages,
    {
      id: uid(),
      role: 'assistant',
      content: chunk,
      status: 'running' as const,
      agentId,
      agentName,
      createdAt: Date.now()
    }
  ]
}

// Pure reducer over the chat slice of state. Kept separate from the Zustand
// store so it can be unit-tested without React.
export function reduceChatEvent(state: ChatReducerState, event: AgentEvent): ChatReducerState {
  switch (event.type) {
    case 'message':
      return {
        ...state,
        messages: appendOrCreateAssistant(
          state.messages,
          event.agentId,
          event.agentName,
          event.content
        )
      }

    case 'message-delta':
      return {
        ...state,
        messages: appendOrCreateAssistant(
          state.messages,
          event.agentId,
          event.agentName,
          event.delta
        )
      }

    case 'todo-update':
      // A sub-agent's todos must never overwrite the root plan.
      if (event.agentId !== undefined) return state
      return { ...state, todos: event.todos }

    case 'context-usage':
      // Sub-agent context-usage is dropped at the source (delegate.ts); defend
      // here too so a stray one can't clobber the root progress bar.
      if (event.agentId !== undefined) return state
      return { ...state, contextUsed: event.used, contextMax: event.max }

    case 'compact-needed':
      // 自动 compact 信号:标记待执行,由 store 在当前轮结束后消费。
      return { ...state, compactNeeded: true }

    case 'compact-start':
      return {
        ...state,
        compactState: {
          active: true,
          stage: null,
          percent: 0,
          beforeTokens: event.beforeTokens,
          afterTokensEstimate: event.afterTokensEstimate
        },
        compactError: null
      }

    case 'compact-progress':
      return {
        ...state,
        compactState: state.compactState
          ? { ...state.compactState, stage: event.stage, percent: event.percent }
          : { active: true, stage: event.stage, percent: event.percent }
      }

    case 'compact-end': {
      // 成功结束:清空 compact 状态。历史替换由 store 在收到返回值后完成
      // (reducer 只负责 UI 状态,不直接改 messages,因为需要 IPC 返回值)。
      // skipped=true 表示无需压缩(历史太短),同样清空状态。
      return { ...state, compactState: null }
    }

    case 'compact-error':
      // 失败:清空进行中状态,保留错误信息供 UI 提示。不回退截断逻辑。
      return { ...state, compactState: null, compactError: event.message }

    case 'tool-start':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: uid(),
            role: 'tool',
            toolName: event.tool,
            toolCallId: event.toolCallId,
            toolInput: event.input,
            content: JSON.stringify(event.input, null, 2),
            status: 'running' as const,
            agentId: event.agentId,
            agentName: event.agentName,
            createdAt: Date.now()
          }
        ]
      }

    case 'tool-end': {
      const idx = lastRunningTool(state.messages, event.agentId)
      if (idx < 0) return state
      const copy = state.messages.slice()
      const cur = copy[idx]!
      copy[idx] = {
        ...cur,
        content: event.output,
        status: 'done' as const,
        durationMs: event.durationMs
      }
      return { ...state, messages: copy }
    }

    case 'subagent-start': {
      // The root's delegate tool already pushed a tool message via tool-start;
      // decorate that anchor with the role being delegated to.
      const idx = lastRunningTool(state.messages, undefined)
      if (idx < 0) return state
      const cur = state.messages[idx]!
      if (cur.toolName !== 'delegate') return state
      const copy = state.messages.slice()
      copy[idx] = {
        ...cur,
        content: `委派给 ${event.roleName}：${event.task}`
      }
      return { ...state, messages: copy }
    }

    case 'subagent-end': {
      // Fill the anchor with the summary if tool-end hasn't landed yet.
      const idx = lastRunningTool(state.messages, undefined)
      if (idx < 0) return state
      const cur = state.messages[idx]!
      if (cur.toolName !== 'delegate' || cur.status !== 'running') return state
      const copy = state.messages.slice()
      copy[idx] = { ...cur, content: event.summary }
      return { ...state, messages: copy }
    }

    case 'confirm-request':
      return {
        ...state,
        pendingConfirm: {
          id: event.id,
          tool: event.tool,
          input: event.input,
          agentId: event.agentId,
          agentName: event.agentName
        }
      }

    case 'retry': {
      // Turn-level retry in progress (root agent only). Clear any partial text
      // in the root running assistant so the retried stream doesn't append to
      // (and double) it. Keep status 'running' so the existing Thinking
      // animation shows during the backoff delay.
      const idx = lastRunningAssistant(state.messages, undefined)
      if (idx < 0) return state
      const copy = state.messages.slice()
      const cur = copy[idx]!
      copy[idx] = { ...cur, content: '', status: 'running' as const }
      return { ...state, messages: copy }
    }

    case 'error': {
      // Agent-scoped errors stay scoped (delegate surfaces them via subagent-end
      // + the tool return value); only root errors hit the main conversation.
      if (event.agentId !== undefined) return state
      const idx = lastRunningAssistant(state.messages, undefined)
      if (idx >= 0) {
        const copy = state.messages.slice()
        const cur = copy[idx]!
        copy[idx] = {
          ...cur,
          content: `⚠️ ${event.message}`,
          status: 'error' as const,
          errorKind: event.kind,
          guidance: event.guidance,
          retryable: event.retryable
        }
        return { ...state, messages: copy }
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: uid(),
            role: 'assistant',
            content: `⚠️ ${event.message}`,
            status: 'error' as const,
            errorKind: event.kind,
            guidance: event.guidance,
            retryable: event.retryable,
            createdAt: Date.now()
          }
        ]
      }
    }

    case 'interrupted': {
      // Finalize only root running messages; sub-agent termination is owned by
      // subagent-end.
      const msgs = state.messages
        .filter(
          m =>
            !(
              m.agentId === undefined &&
              m.status === 'running' &&
              m.role === 'assistant' &&
              m.content.length === 0
            )
        )
        .map(m =>
          m.agentId === undefined && m.status === 'running' ? { ...m, status: 'done' as const } : m
        )
      return {
        ...state,
        messages: [
          ...msgs,
          {
            id: uid(),
            role: 'assistant' as const,
            content: '⏹ 已停止生成',
            status: 'done' as const,
            createdAt: Date.now()
          }
        ]
      }
    }

    case 'done': {
      // Drop an empty root placeholder only if the turn produced content
      // somewhere; finalize root running messages; surface "no response" only
      // for the root. Sub-agent messages are left untouched.
      const hasContent = state.messages.some(m => m.role === 'assistant' && m.content.length > 0)
      const messages = state.messages
        .filter(
          m =>
            !(
              m.agentId === undefined &&
              m.role === 'assistant' &&
              m.status === 'running' &&
              m.content.length === 0 &&
              hasContent
            )
        )
        .map(m => {
          if (m.agentId !== undefined) return m
          if (m.status !== 'running') return m
          if (m.role === 'assistant' && m.content.length === 0) {
            return {
              ...m,
              content:
                '⚠️ No response received. Check the terminal running `pnpm dev` for `[agent]` logs.',
              status: 'error' as const
            }
          }
          return { ...m, status: 'done' as const }
        })
      return { ...state, messages }
    }
  }
}

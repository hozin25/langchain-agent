import { create } from 'zustand'
import type {
  AgentEvent,
  AgentMode,
  ChatMessage,
  Conversation,
  ConversationMeta,
  FileAttachment,
  ModelOption,
  TodoItem
} from '@shared/types'
import { reduceChatEvent } from './chatReducer'

const TITLE_MAX = 40

interface ChatState {
  messages: ChatMessage[]
  workspace: string | null
  isRunning: boolean
  models: ModelOption[]
  modelId: string
  mode: AgentMode
  todos: TodoItem[]
  conversations: ConversationMeta[]
  currentConversationId: string | null
  contextUsed: number
  contextMax: number
  pendingConfirm: {
    id: string
    tool: string
    input: unknown
    agentId?: string
    agentName?: string
  } | null
  // Snapshot of the most recent failed turn so the error card's "retry" button
  // can re-run it. Cleared on success; set whenever a turn ends with an error.
  // `mode` preserves the operating mode so a failed plan-mode turn retries as a
  // plan, not an act.
  lastFailedTurn: { message: string; attachments?: FileAttachment[]; mode: AgentMode } | null
  setWorkspace: (path: string | null) => Promise<void>
  setModels: (models: ModelOption[], defaultId: string) => void
  setModelId: (id: string) => void
  setMode: (mode: AgentMode) => void
  send: (text: string, attachments?: FileAttachment[]) => Promise<void>
  retry: () => Promise<void>
  approvePlan: (planMessageId: string) => Promise<void>
  revisePlan: (planMessageId: string) => void
  interrupt: () => void
  respondConfirmation: (approved: boolean, remember: boolean) => void
  loadConversationList: () => Promise<void>
  openConversation: (id: string) => Promise<void>
  startNewConversation: () => void
  deleteConversation: (id: string) => Promise<void>
}

function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2)
}

function deriveTitle(text: string): string {
  const firstLine = (text.trim().split('\n')[0] ?? '').trim()
  if (!firstLine) return 'New conversation'
  return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX)}…` : firstLine
}

function upsertMeta(list: ConversationMeta[], meta: ConversationMeta): ConversationMeta[] {
  const idx = list.findIndex(c => c.id === meta.id)
  const next = idx >= 0 ? [...list.slice(0, idx), meta, ...list.slice(idx + 1)] : [meta, ...list]
  return next.sort((a, b) => b.updatedAt - a.updatedAt)
}

// For retry: drop every message belonging to the failed turn (the last user
// message and anything after it) so history handed to the rerun is clean.
function dropFailedTurn(messages: ChatMessage[]): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return messages.slice(0, i)
  }
  return messages.slice()
}

export const useChatStore = create<ChatState>((set, get) => {
  // Shared run lifecycle for send() and retry(). Owns the event subscription,
  // the IPC call, lastFailedTurn bookkeeping, and persistence. Callers prepare
  // the message list (user msg + running assistant placeholder) and pass the
  // clean history (everything before the current user message).
  const runTurn = async (args: {
    text: string
    attachments?: FileAttachment[]
    convId: string
    workspace: string
    history: ChatMessage[]
    existing: ConversationMeta | null
    now: number
    mode: AgentMode
  }): Promise<void> => {
    const off = window.api.agent.onEvent((event: AgentEvent) => {
      set(s =>
        reduceChatEvent(
          {
            messages: s.messages,
            todos: s.todos,
            contextUsed: s.contextUsed,
            contextMax: s.contextMax,
            pendingConfirm: s.pendingConfirm
          },
          event
        )
      )
    })

    try {
      await window.api.agent.run(
        args.text,
        args.workspace,
        get().modelId || undefined,
        args.attachments,
        args.history,
        args.mode
      )
    } catch (e) {
      // IPC-level rejection (agent:run handler threw before any event fired).
      // Surface on the last running assistant and keep it retryable.
      const msg = e instanceof Error ? e.message : String(e)
      set(s => {
        const last = s.messages[s.messages.length - 1]
        if (last && last.role === 'assistant' && last.status === 'running') {
          const copy = s.messages.slice()
          copy[copy.length - 1] = {
            ...last,
            content: `❌ ${msg}`,
            status: 'error' as const,
            retryable: true
          }
          return { messages: copy }
        }
        return {
          messages: [
            ...s.messages,
            {
              id: uid(),
              role: 'assistant',
              content: `❌ ${msg}`,
              status: 'error' as const,
              retryable: true,
              createdAt: Date.now()
            }
          ]
        }
      })
    } finally {
      // Let pending IPC events (done/error/interrupted) flush before
      // unsubscribing — webContents.send and ipcRenderer.invoke resolve
      // on different channels and can race.
      await new Promise(resolve => setTimeout(resolve, 0))
      off()

      const beforePersist = get()
      const failed = beforePersist.messages.some(
        m => m.role === 'assistant' && m.status === 'error'
      )
      set({
        isRunning: false,
        lastFailedTurn: failed
          ? { message: args.text, attachments: args.attachments, mode: args.mode }
          : null
      })

      // Persist once the run reaches a terminal state (done/error/interrupted all
      // land here after updating messages). Streaming deltas are not written to
      // disk — one IO per turn, not per token.
      const finalState = get()
      const conv: Conversation = {
        id: args.convId,
        title: args.existing?.title ?? deriveTitle(args.text),
        workspace: args.workspace,
        createdAt: args.existing?.createdAt ?? args.now,
        updatedAt: Date.now(),
        messages: finalState.messages,
        todos: finalState.todos
      }
      try {
        await window.api.conversations.save(conv)
        const meta: ConversationMeta = {
          id: conv.id,
          title: conv.title,
          workspace: conv.workspace,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt
        }
        set(s => ({ conversations: upsertMeta(s.conversations, meta) }))
      } catch {
        // persistence failure must not break the in-memory session
      }
    }
  }

  return {
    messages: [],
    workspace: null,
    isRunning: false,
    models: [],
    modelId: '',
    mode: 'act',
    todos: [],
    conversations: [],
    currentConversationId: null,
    contextUsed: 0,
    contextMax: 0,
    pendingConfirm: null,
    lastFailedTurn: null,

    setWorkspace: async path => {
      // ignore workspace switches while a run is in flight — clearing messages mid-run
      // would mix the in-flight stream into the new workspace's view
      if (get().isRunning) return
      set({
        workspace: path,
        messages: [],
        todos: [],
        currentConversationId: null,
        conversations: [],
        contextUsed: 0,
        lastFailedTurn: null
      })
      if (!path) return
      // remember last workspace so the app reopens into it, then load its history
      await window.api.app.setLastWorkspace(path)
      const list = await window.api.conversations.list(path)
      set({ conversations: list })
    },

    setModels: (models, defaultId) =>
      set(s => {
        const modelId = s.modelId || defaultId
        const model = models.find(m => m.id === modelId)
        return {
          models,
          modelId,
          contextMax: model?.maxContextTokens ?? 0
        }
      }),

    setModelId: id => {
      const model = get().models.find(m => m.id === id)
      set({ modelId: id, contextMax: model?.maxContextTokens ?? 0, contextUsed: 0 })
    },

    setMode: mode => {
      if (get().isRunning) return
      set({ mode })
    },

    loadConversationList: async () => {
      const ws = get().workspace
      if (!ws) {
        set({ conversations: [] })
        return
      }
      const list = await window.api.conversations.list(ws)
      set({ conversations: list })
    },

    openConversation: async id => {
      if (get().isRunning) return
      const conv = await window.api.conversations.load(id)
      if (!conv) return
      set({
        messages: conv.messages,
        todos: conv.todos,
        currentConversationId: id,
        contextUsed: 0,
        lastFailedTurn: null
      })
    },

    startNewConversation: () => {
      if (get().isRunning) return
      set({
        messages: [],
        todos: [],
        currentConversationId: null,
        contextUsed: 0,
        lastFailedTurn: null
      })
    },

    deleteConversation: async id => {
      await window.api.conversations.delete(id)
      set(s => {
        const conversations = s.conversations.filter(c => c.id !== id)
        if (s.currentConversationId !== id) return { conversations }
        return {
          conversations,
          messages: [],
          todos: [],
          currentConversationId: null,
          contextUsed: 0,
          lastFailedTurn: null
        }
      })
    },

    send: async (text, attachments) => {
      const state = get()
      const workspace = state.workspace
      if (!workspace || !text.trim() || state.isRunning) return

      const now = Date.now()
      const convId = state.currentConversationId ?? uid()
      const isNew = state.currentConversationId === null
      const existing = isNew ? null : (state.conversations.find(c => c.id === convId) ?? null)
      // History is the conversation BEFORE this user message — snapshot before push.
      const history = state.messages

      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content: text,
        attachments: attachments?.map(a => ({ name: a.name })),
        createdAt: now
      }
      const assistantMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        status: 'running',
        plan: state.mode === 'plan' ? 'pending' : undefined,
        createdAt: now
      }
      set(s => ({
        messages: [...s.messages, userMsg, assistantMsg],
        isRunning: true,
        todos: [],
        currentConversationId: convId,
        lastFailedTurn: null
      }))

      await runTurn({
        text,
        attachments,
        convId,
        workspace,
        history,
        existing,
        now,
        mode: state.mode
      })
    },

    retry: async () => {
      const failed = get().lastFailedTurn
      if (!failed || get().isRunning) return
      const workspace = get().workspace
      if (!workspace) return

      const now = Date.now()
      const convId = get().currentConversationId ?? uid()
      const existing = get().conversations.find(c => c.id === convId) ?? null
      // Drop the failed turn (last user msg + everything after) so the rerun's
      // history is clean, then re-add a fresh user msg + running placeholder.
      const history = dropFailedTurn(get().messages)

      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content: failed.message,
        attachments: failed.attachments?.map(a => ({ name: a.name })),
        createdAt: now
      }
      const assistantMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        status: 'running',
        plan: failed.mode === 'plan' ? 'pending' : undefined,
        createdAt: now
      }
      set({
        messages: [...history, userMsg, assistantMsg],
        isRunning: true,
        todos: [],
        currentConversationId: convId,
        lastFailedTurn: null
      })

      await runTurn({
        text: failed.message,
        attachments: failed.attachments,
        convId,
        workspace,
        history,
        existing,
        now,
        mode: failed.mode
      })
    },

    interrupt: () => {
      if (!get().isRunning) return
      void window.api.agent.cancel()
    },

    respondConfirmation: (approved, remember) => {
      const pending = get().pendingConfirm
      if (!pending) return
      void window.api.agent.respondConfirmation(pending.id, approved, remember)
      set({ pendingConfirm: null })
    },

    approvePlan: async planMessageId => {
      const state = get()
      const workspace = state.workspace
      if (!workspace || state.isRunning) return
      const target = state.messages.find(m => m.id === planMessageId)
      if (!target || target.plan !== 'pending') return

      // Flip the plan message to approved and drop into act mode, then launch an
      // act-mode turn carrying the full conversation (incl. the plan) as history
      // so the agent executes the plan it just proposed.
      set(s => ({
        mode: 'act',
        messages: s.messages.map(m =>
          m.id === planMessageId ? { ...m, plan: 'approved' as const } : m
        )
      }))

      const now = Date.now()
      const convId = state.currentConversationId ?? uid()
      const existing = state.conversations.find(c => c.id === convId) ?? null
      const history = get().messages
      const text = '（计划已批准，请按上述计划开始执行。）'
      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content: text,
        createdAt: now
      }
      const assistantMsg: ChatMessage = {
        id: uid(),
        role: 'assistant',
        content: '',
        status: 'running',
        createdAt: now
      }
      set(s => ({
        messages: [...s.messages, userMsg, assistantMsg],
        isRunning: true,
        todos: [],
        currentConversationId: convId,
        lastFailedTurn: null
      }))

      await runTurn({ text, convId, workspace, history, existing, now, mode: 'act' })
    },

    revisePlan: planMessageId => {
      // Dismiss the approve bar without executing; mode stays 'plan' so the user
      // can type a refinement and produce a revised plan.
      set(s => ({
        messages: s.messages.map(m =>
          m.id === planMessageId && m.plan === 'pending' ? { ...m, plan: 'closed' as const } : m
        )
      }))
    }
  }
})

import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { TodoList } from './TodoList'
import { ConfirmDialog } from './ConfirmDialog'
import { BypassWarningDialog } from './BypassWarningDialog'
import { CompactBanner } from './CompactBanner'
import { RestoreDialog } from './RestoreDialog'
import { RestoreOverlay } from './RestoreOverlay'
import { useChatStore } from '../stores/chat'

export function ChatPanel() {
  const workspace = useChatStore(s => s.workspace)
  const messages = useChatStore(s => s.messages)
  const todos = useChatStore(s => s.todos)
  const isRunning = useChatStore(s => s.isRunning)
  const isCompacting = useChatStore(s => s.isCompacting)
  const isRestoring = useChatStore(s => s.isRestoring)

  return (
    <div className="chat">
      <header className="chat__header">
        <h1>Chat</h1>
        {workspace ? (
          <span className="chat__hint">● Workspace ready</span>
        ) : (
          <span className="chat__hint chat__hint--warn">○ Select a workspace to begin</span>
        )}
      </header>
      <MessageList messages={messages} />
      <TodoList todos={todos} />
      <CompactBanner />
      <RestoreOverlay />
      <MessageInput disabled={!workspace || isRunning || isCompacting || isRestoring} />
      <ConfirmDialog />
      <BypassWarningDialog />
      <RestoreDialog />
    </div>
  )
}

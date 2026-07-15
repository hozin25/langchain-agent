import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { TodoList } from './TodoList'
import { useChatStore } from '../stores/chat'

export function ChatPanel() {
  const workspace = useChatStore(s => s.workspace)
  const messages = useChatStore(s => s.messages)
  const todos = useChatStore(s => s.todos)
  const isRunning = useChatStore(s => s.isRunning)

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
      <MessageInput disabled={!workspace || isRunning} />
    </div>
  )
}

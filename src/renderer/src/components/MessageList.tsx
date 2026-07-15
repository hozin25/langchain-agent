import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../stores/chat'

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="messages messages--empty">
        <p>
          Pick a workspace, then ask the agent to read, edit, or search files — or run shell
          commands in that folder.
        </p>
      </div>
    )
  }

  return (
    <div className="messages">
      {messages.map(m => (
        <MessageBubble key={m.id} message={m} />
      ))}
      <div ref={endRef} />
    </div>
  )
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'tool') {
    return (
      <div className={`msg msg--tool msg--${message.status ?? 'done'}`}>
        <div className="msg__role">🔧 {message.toolName}</div>
        <div className="msg__content">{message.content}</div>
      </div>
    )
  }

  const isStreaming = message.role === 'assistant' && message.status === 'running'

  return (
    <div className={`msg msg--${message.role} msg--${message.status ?? 'done'}`}>
      <div className="msg__role">{message.role === 'user' ? 'You' : 'Agent'}</div>
      <div className={`msg__content${message.role === 'assistant' ? ' msg__content--md' : ''}`}>
        {message.role === 'assistant' ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        ) : (
          message.content
        )}
        {isStreaming && (
          <span className="stream-cursor" aria-hidden>
            ▋
          </span>
        )}
      </div>
    </div>
  )
}

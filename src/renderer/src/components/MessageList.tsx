import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '@shared/types'

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
      <div
        className={`msg msg--tool msg--${message.status ?? 'done'}${message.agentName ? ' msg--subagent' : ''}`}
      >
        <div className="msg__role">
          🔧 {message.toolName}
          {message.agentName && <span className="msg__agent-tag">{message.agentName}</span>}
        </div>
        <div className="msg__content">{message.content}</div>
      </div>
    )
  }

  const isStreaming = message.role === 'assistant' && message.status === 'running'
  const isThinking = isStreaming && message.content.length === 0

  return (
    <div
      className={`msg msg--${message.role} msg--${message.status ?? 'done'}${message.agentName ? ' msg--subagent' : ''}`}
    >
      <div className="msg__role">{message.role === 'user' ? 'You' : message.agentName ?? 'Agent'}</div>
      <div className={`msg__content${message.role === 'assistant' ? ' msg__content--md' : ''}`}>
        {isThinking ? (
          <span className="thinking" aria-live="polite">
            <span className="thinking__text">Thinking</span>
            <span className="thinking__dots" aria-hidden>
              <span className="thinking__dot" />
              <span className="thinking__dot" />
              <span className="thinking__dot" />
            </span>
          </span>
        ) : message.role === 'assistant' ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        ) : (
          message.content
        )}
        {isStreaming && !isThinking && (
          <span className="stream-cursor" aria-hidden>
            ▋
          </span>
        )}
      </div>
      {message.attachments && message.attachments.length > 0 && (
        <div className="msg__attachments">
          {message.attachments.map((a, i) => (
            <span key={`${a.name}-${i}`} className="input__chip input__chip--readonly">
              📄 {a.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { ChatMessage } from '@shared/types'
import { useChatStore } from '../stores/chat'
import { formatDuration } from '../utils/time'
import { diffLines } from 'diff'

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

// Tool wall-clock: ticks "Xs" every second while running (cheap local interval,
// only mounted while status==='running'), then shows the final durationMs once
// the tool-end lands.
function ToolDuration({ message }: { message: ChatMessage }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (message.status !== 'running') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [message.status])

  if (message.status === 'running') {
    return <span className="msg__duration">· {formatDuration(now - message.createdAt)}</span>
  }
  if (message.durationMs !== undefined) {
    return <span className="msg__duration">· {formatDuration(message.durationMs)}</span>
  }
  return null
}

function RetryButton() {
  const retry = useChatStore(s => s.retry)
  return (
    <button type="button" className="msg__retry" onClick={() => void retry()}>
      🔄 重试
    </button>
  )
}

function CodeBlock({ children, className, ...props }: React.ComponentPropsWithoutRef<'code'>) {
  const match = /language-(\w+)/.exec(className || '')
  if (match) {
    return (
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={match[1]}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: '6px',
          fontSize: '12.5px',
          lineHeight: '1.5',
        }}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    )
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  )
}

interface EditFileInput {
  path?: string
  oldText?: string
  newText?: string
}

function EditFileDiffView({ toolInput, content }: { toolInput: unknown; content: string }) {
  const input = toolInput as EditFileInput
  if (!input.oldText || !input.newText) {
    return <>{content}</>
  }

  const changes = diffLines(input.oldText, input.newText)

  return (
    <div className="diff-view">
      {input.path && <div className="diff-header">{input.path}</div>}
      <div className="diff-body">
        {changes.map((change, i) => {
          const lines = change.value.split('\n')
          const hasTrailingNewline = change.value.endsWith('\n')
          const count = hasTrailingNewline ? lines.length - 1 : lines.length
          return Array.from({ length: count }, (_, j) => {
            const type = change.added ? 'add' : change.removed ? 'remove' : 'context'
            return (
              <div key={`${i}-${j}`} className={`diff-line diff-line--${type}`}>
                <span className="diff-line__prefix">
                  {change.added ? '+' : change.removed ? '-' : ' '}
                </span>
                <span className="diff-line__content">{lines[j]}</span>
              </div>
            )
          })
        })}
      </div>
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
          <ToolDuration message={message} />
        </div>
        <div className="msg__content">
          {message.toolName === 'edit_file' && message.status === 'done' && message.toolInput ? (
            <EditFileDiffView toolInput={message.toolInput} content={message.content} />
          ) : (
            message.content
          )}
        </div>
      </div>
    )
  }

  const isStreaming = message.role === 'assistant' && message.status === 'running'
  const isThinking = isStreaming && message.content.length === 0
  const isError = message.status === 'error'

  return (
    <div
      className={`msg msg--${message.role} msg--${message.status ?? 'done'}${message.agentName ? ' msg--subagent' : ''}`}
    >
      <div className="msg__role">
        {message.role === 'user' ? 'You' : (message.agentName ?? 'Agent')}
      </div>
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
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CodeBlock }}>
            {message.content}
          </ReactMarkdown>
        ) : (
          message.content
        )}
        {isStreaming && !isThinking && (
          <span className="stream-cursor" aria-hidden>
            ▋
          </span>
        )}
      </div>
      {isError && message.guidance && <p className="msg__guidance">{message.guidance}</p>}
      {isError && message.retryable && <RetryButton />}
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

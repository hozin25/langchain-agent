import type { ErrorKind } from '@shared/types'

export interface ClassifiedError {
  kind: ErrorKind
  message: string
  retryable: boolean
  guidance?: string
}

const AUTH_GUIDANCE =
  'API key 未配置或无效。请检查 .env 里的 GLM_API_KEY / DEEPSEEK_API_KEY，保存后重启应用生效。'
const QUOTA_GUIDANCE = '账户额度已耗尽，请前往对应开放平台充值后重试。'
const NETWORK_GUIDANCE = '网络连接失败。请检查 HTTPS_PROXY 配置与代理/网络后重试。'
const CONTEXT_GUIDANCE = '对话历史过长，超出模型上下文。请新建会话或精简历史后重试。'

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : ''
}

function lcErrorCode(err: unknown): string | undefined {
  return (err as { lc_error_code?: string } | null | undefined)?.lc_error_code
}

function httpStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null | undefined)?.status
  return typeof s === 'number' ? s : undefined
}

// True when the provider signaled the rate limit is a hard quota ceiling (no
// amount of retrying will help) vs. a transient throttle. LangChain renames
// openai's insufficient_quota to InsufficientQuotaError; GLM/DeepSeek may use a
// localized body string, so we also match common keywords.
function looksLikeQuota(err: unknown, message: string): boolean {
  if (errName(err) === 'InsufficientQuotaError') return true
  const lower = message.toLowerCase()
  return (
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient quota') ||
    lower.includes('额度') ||
    lower.includes('余额') ||
    lower.includes('exhausted')
  )
}

function looksLikeContextTooLong(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('context length') ||
    lower.includes('maximum context') ||
    lower.includes('context window') ||
    lower.includes('token limit') ||
    lower.includes('too long')
  )
}

function looksLikeNetwork(err: unknown, message: string): boolean {
  const name = errName(err)
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true
  if (name === 'APIUserAbortError') return false
  const lower = message.toLowerCase()
  return (
    lower.includes('fetch failed') ||
    lower.includes('econn') ||
    lower.includes('etimedout') ||
    lower.includes('und_err') ||
    lower.includes('socket hang up')
  )
}

// Map any thrown value to a structured category the UI can act on. Abort and
// recursion-limit are detected first (they have stable signals); HTTP status is
// duck-typed so we never need to import the openai SDK (keeps this testable with
// plain mock objects and avoids any ESM interop surprises in the CJS main bundle).
export function classifyError(err: unknown, signal?: AbortSignal): ClassifiedError {
  const message = errMessage(err)

  // 1. Abort — authoritative via signal, plus the two shapes LangGraph/openai use.
  const aborted =
    signal?.aborted === true ||
    message === 'Abort' ||
    errName(err) === 'AbortError' ||
    errName(err) === 'APIUserAbortError'
  if (aborted) return { kind: 'aborted', message: '已停止', retryable: false }

  // 2. LangGraph recursion ceiling.
  if (lcErrorCode(err) === 'GRAPH_RECURSION_LIMIT') {
    return {
      kind: 'recursion_limit',
      message: '任务步骤过多，已超出递归上限。请尝试拆分任务或简化指令后重试。',
      retryable: false
    }
  }

  // 3. HTTP status (openai APIError carries .status through LangChain's AsyncCaller).
  const status = httpStatus(err)
  if (typeof status === 'number') {
    if (status === 401 || status === 403) {
      return { kind: 'auth', message, retryable: false, guidance: AUTH_GUIDANCE }
    }
    if (status === 402) {
      return { kind: 'quota', message, retryable: false, guidance: QUOTA_GUIDANCE }
    }
    if (status === 429) {
      if (looksLikeQuota(err, message)) {
        return { kind: 'quota', message, retryable: false, guidance: QUOTA_GUIDANCE }
      }
      return {
        kind: 'rate_limit',
        message,
        retryable: true,
        guidance: '触发了服务限流，正在自动退避重试…'
      }
    }
    if (status === 408 || status >= 500) {
      return {
        kind: 'overloaded',
        message,
        retryable: true,
        guidance: '服务暂时过载，正在自动重试…'
      }
    }
    if (status === 400) {
      if (looksLikeContextTooLong(message)) {
        return { kind: 'context_too_long', message, retryable: false, guidance: CONTEXT_GUIDANCE }
      }
      return { kind: 'unknown', message, retryable: false }
    }
  }

  // 4. Connection / timeout / proxy failures (no HTTP status).
  if (looksLikeNetwork(err, message)) {
    return { kind: 'network', message, retryable: true, guidance: NETWORK_GUIDANCE }
  }

  // 5. Anything else — including bare `new Error(...)` from tests/fakes — is not
  // retried. This is what keeps the existing index.test.ts error-path stable.
  return { kind: 'unknown', message, retryable: false }
}

export interface BackoffOptions {
  baseMs?: number
  capMs?: number
  jitter?: number
}

// Exponential backoff with full jitter, matching openai SDK's shape (initial
// delay scaled up, capped, multiplied by (1 - rand*jitter)). Pure & synchronous
// so it can be unit-tested without timers.
export function backoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? 1000
  const capMs = opts.capMs ?? 8000
  const jitter = opts.jitter ?? 0.25
  const exp = Math.min(capMs, baseMs * 2 ** attempt)
  const factor = 1 - Math.random() * jitter
  return Math.max(0, Math.round(exp * factor))
}

// Promise-based sleep that resolves immediately if the signal aborts, so the
// retry loop can be cancelled mid-backoff. Resolves (never rejects) — the next
// executeOnce iteration sees signal.aborted and emits `interrupted`.
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal?.aborted === true) return resolve()
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

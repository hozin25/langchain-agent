import { describe, it, expect } from 'vitest'
import { classifyError, backoffMs, sleep } from './errors'

const mkErr = (props: Record<string, unknown> = {}, message = 'something went wrong'): Error => {
  const e = new Error(message)
  Object.assign(e, props)
  return e
}

describe('classifyError', () => {
  describe('abort', () => {
    it('signal already aborted', () => {
      const c = new AbortController()
      c.abort()
      const r = classifyError(new Error('x'), c.signal)
      expect(r.kind).toBe('aborted')
      expect(r.retryable).toBe(false)
    })

    it('message === "Abort" (LangGraph shape)', () => {
      const r = classifyError(new Error('Abort'))
      expect(r.kind).toBe('aborted')
    })

    it('name === "AbortError"', () => {
      const r = classifyError(mkErr({ name: 'AbortError' }))
      expect(r.kind).toBe('aborted')
    })

    it('name === "APIUserAbortError"', () => {
      const r = classifyError(mkErr({ name: 'APIUserAbortError' }))
      expect(r.kind).toBe('aborted')
    })
  })

  it('recursion limit via lc_error_code', () => {
    const r = classifyError(mkErr({ lc_error_code: 'GRAPH_RECURSION_LIMIT' }))
    expect(r.kind).toBe('recursion_limit')
    expect(r.retryable).toBe(false)
  })

  describe('HTTP status mapping', () => {
    it('401 → auth, not retryable, with guidance', () => {
      const r = classifyError(mkErr({ status: 401 }))
      expect(r.kind).toBe('auth')
      expect(r.retryable).toBe(false)
      expect(r.guidance).toBeTruthy()
    })

    it('403 → auth', () => {
      expect(classifyError(mkErr({ status: 403 })).kind).toBe('auth')
    })

    it('402 → quota, not retryable', () => {
      const r = classifyError(mkErr({ status: 402 }))
      expect(r.kind).toBe('quota')
      expect(r.retryable).toBe(false)
    })

    it('429 transient → rate_limit, retryable', () => {
      const r = classifyError(mkErr({ status: 429, name: 'RateLimitError' }, 'Too many requests'))
      expect(r.kind).toBe('rate_limit')
      expect(r.retryable).toBe(true)
    })

    it('429 + insufficient_quota → quota, not retryable', () => {
      const r = classifyError(
        mkErr({ status: 429, name: 'InsufficientQuotaError' }, 'insufficient_quota')
      )
      expect(r.kind).toBe('quota')
      expect(r.retryable).toBe(false)
    })

    it('429 + localized 余额 → quota', () => {
      const r = classifyError(mkErr({ status: 429 }, '账户余额不足'))
      expect(r.kind).toBe('quota')
    })

    it('500 → overloaded, retryable', () => {
      const r = classifyError(mkErr({ status: 500 }))
      expect(r.kind).toBe('overloaded')
      expect(r.retryable).toBe(true)
    })

    it('503 → overloaded', () => {
      expect(classifyError(mkErr({ status: 503 })).kind).toBe('overloaded')
    })

    it('408 → overloaded', () => {
      expect(classifyError(mkErr({ status: 408 })).kind).toBe('overloaded')
    })

    it('400 context length → context_too_long, not retryable', () => {
      const r = classifyError(
        mkErr({ status: 400 }, 'This model maximum context length is exceeded')
      )
      expect(r.kind).toBe('context_too_long')
      expect(r.retryable).toBe(false)
    })

    it('400 other → unknown, not retryable', () => {
      const r = classifyError(mkErr({ status: 400 }, 'bad request'))
      expect(r.kind).toBe('unknown')
      expect(r.retryable).toBe(false)
    })
  })

  describe('network (no HTTP status)', () => {
    it('APIConnectionError name', () => {
      const r = classifyError(mkErr({ name: 'APIConnectionError' }, 'fetch failed'))
      expect(r.kind).toBe('network')
      expect(r.retryable).toBe(true)
    })

    it('APIConnectionTimeoutError name', () => {
      expect(classifyError(mkErr({ name: 'APIConnectionTimeoutError' })).kind).toBe('network')
    })

    it('fetch failed message', () => {
      expect(
        classifyError(new Error('Request failed: fetch failed (UND_ERR_CONNECT_TIMEOUT)')).kind
      ).toBe('network')
    })
  })

  it('bare Error → unknown, not retryable (keeps existing index.test.ts stable)', () => {
    const r = classifyError(new Error('LLM 不可用'))
    expect(r.kind).toBe('unknown')
    expect(r.retryable).toBe(false)
    expect(r.message).toBe('LLM 不可用')
  })
})

describe('backoffMs', () => {
  it('attempt 0 → [750, 1000]', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffMs(0)
      expect(d).toBeGreaterThanOrEqual(750)
      expect(d).toBeLessThanOrEqual(1000)
    }
  })

  it('attempt 1 → [1500, 2000]', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffMs(1)
      expect(d).toBeGreaterThanOrEqual(1500)
      expect(d).toBeLessThanOrEqual(2000)
    }
  })

  it('attempt 2 → [3000, 4000]', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffMs(2)
      expect(d).toBeGreaterThanOrEqual(3000)
      expect(d).toBeLessThanOrEqual(4000)
    }
  })

  it('never exceeds cap', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      for (let i = 0; i < 20; i++) {
        expect(backoffMs(attempt)).toBeLessThanOrEqual(8000)
      }
    }
  })

  it('jitter=0 yields exact exponential (capped)', () => {
    expect(backoffMs(0, { jitter: 0 })).toBe(1000)
    expect(backoffMs(1, { jitter: 0 })).toBe(2000)
    expect(backoffMs(2, { jitter: 0 })).toBe(4000)
    expect(backoffMs(3, { jitter: 0 })).toBe(8000)
    expect(backoffMs(4, { jitter: 0 })).toBe(8000) // capped
  })
})

describe('sleep', () => {
  it('resolves after the delay', async () => {
    const start = Date.now()
    await sleep(60)
    expect(Date.now() - start).toBeGreaterThanOrEqual(50)
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('resolves immediately when signal already aborted', async () => {
    const c = new AbortController()
    c.abort()
    const start = Date.now()
    await sleep(1000, c.signal)
    expect(Date.now() - start).toBeLessThan(100)
  })

  it('resolves when signal aborts mid-sleep', async () => {
    const c = new AbortController()
    setTimeout(() => c.abort(), 20)
    const start = Date.now()
    await sleep(2000, c.signal)
    expect(Date.now() - start).toBeLessThan(500)
  })
})

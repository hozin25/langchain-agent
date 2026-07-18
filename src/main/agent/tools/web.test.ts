import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('undici', () => ({
  fetch: vi.fn(),
  ProxyAgent: vi.fn((url: string) => ({ __proxyUrl: url }))
}))

import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { makeWebFetch, makeWebSearch, resolveProxyDispatcher } from './web'

const mockedFetch = vi.mocked(undiciFetch)
const mockedProxyAgent = vi.mocked(ProxyAgent)

function mockResponse(opts: {
  ok?: boolean
  status?: number
  statusText?: string
  contentType?: string
  body: string
}) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    headers: {
      get: (k: string) =>
        k.toLowerCase() === 'content-type' ? (opts.contentType ?? 'text/html; charset=utf-8') : null
    },
    text: () => Promise.resolve(opts.body)
  }
}

describe('resolveProxyDispatcher', () => {
  beforeEach(() => mockedProxyAgent.mockClear())

  it('returns undefined when no proxy env is set', () => {
    expect(resolveProxyDispatcher({})).toBeUndefined()
    expect(mockedProxyAgent).not.toHaveBeenCalled()
  })

  it('builds a ProxyAgent from HTTPS_PROXY', () => {
    resolveProxyDispatcher({ HTTPS_PROXY: 'http://127.0.0.1:7892' })
    expect(mockedProxyAgent).toHaveBeenCalledWith('http://127.0.0.1:7892')
  })

  it('reads lowercase http_proxy', () => {
    resolveProxyDispatcher({ http_proxy: 'http://127.0.0.1:7892' })
    expect(mockedProxyAgent).toHaveBeenCalledWith('http://127.0.0.1:7892')
  })

  it('prefers HTTPS_PROXY over HTTP_PROXY', () => {
    resolveProxyDispatcher({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' })
    expect(mockedProxyAgent).toHaveBeenCalledWith('http://a:1')
  })

  it('falls back to undefined on an invalid proxy URL', () => {
    mockedProxyAgent.mockImplementationOnce(() => {
      throw new Error('Invalid URL')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = resolveProxyDispatcher({ HTTPS_PROXY: 'not-a-url' })
    expect(d).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid proxy URL'))
    warn.mockRestore()
  })
})

describe('web_fetch', () => {
  beforeEach(() => mockedFetch.mockReset())

  it('converts HTML to markdown', async () => {
    mockedFetch.mockResolvedValue(mockResponse({ body: '<h1>Title</h1><p>Hi</p>' }) as never)
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com' })
    expect(out).toMatch(/Title/)
    expect(out).toMatch(/Hi/)
    expect(out).not.toContain('<')
  })

  it('returns text format verbatim for non-HTML', async () => {
    mockedFetch.mockResolvedValue(
      mockResponse({ contentType: 'text/plain', body: 'plain text' }) as never
    )
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com', format: 'text' })
    expect(out).toBe('plain text')
  })

  it('reports non-2xx as failure', async () => {
    mockedFetch.mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'Not Found', body: '' }) as never
    )
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com' })
    expect(out).toMatch(/HTTP 404/)
  })

  it('maps an aborted request to a timeout message', async () => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    mockedFetch.mockImplementationOnce(() => {
      throw abortError
    })
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com' })
    expect(out).toMatch(/timed out/)
  })

  it('exposes the underlying cause code on fetch failure', async () => {
    const err = new TypeError('fetch failed')
    ;(err as unknown as { cause: unknown }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' }
    mockedFetch.mockImplementationOnce(() => {
      throw err
    })
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com' })
    expect(out).toMatch(/fetch failed/)
    expect(out).toMatch(/UND_ERR_CONNECT_TIMEOUT/)
  })
})

describe('web_search', () => {
  const prevKey = process.env['TAVILY_API_KEY']
  beforeEach(() => {
    mockedFetch.mockReset()
  })
  afterEach(() => {
    if (prevKey === undefined) delete process.env['TAVILY_API_KEY']
    else process.env['TAVILY_API_KEY'] = prevKey
  })

  it('returns formatted results', async () => {
    process.env['TAVILY_API_KEY'] = 'test-key'
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ results: [{ title: 'T1', url: 'https://a', content: 'Snip A' }] })
    } as never)
    const t = makeWebSearch()
    const out = await t.invoke({ query: 'hello' })
    expect(out).toContain('T1')
    expect(out).toContain('https://a')
    expect(out).toContain('Snip A')
  })

  it('reports missing API key', async () => {
    delete process.env['TAVILY_API_KEY']
    const t = makeWebSearch()
    const out = await t.invoke({ query: 'hello' })
    expect(out).toMatch(/TAVILY_API_KEY/)
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('reports non-2xx', async () => {
    process.env['TAVILY_API_KEY'] = 'test-key'
    mockedFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: () => Promise.resolve({})
    } as never)
    const t = makeWebSearch()
    const out = await t.invoke({ query: 'hello' })
    expect(out).toMatch(/HTTP 401/)
  })
})

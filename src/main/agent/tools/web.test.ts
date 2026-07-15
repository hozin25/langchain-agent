import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeWebFetch, makeWebSearch } from './web'

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

describe('web_fetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('converts HTML to markdown', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ body: '<h1>Title</h1><p>Hi</p>' }) as never
    )
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com' })
    expect(out).toMatch(/Title/)
    expect(out).toMatch(/Hi/)
    expect(out).not.toContain('<')
  })

  it('returns text format verbatim for non-HTML', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ contentType: 'text/plain', body: 'plain text' }) as never
    )
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com', format: 'text' })
    expect(out).toBe('plain text')
  })

  it('reports non-2xx as failure', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'Not Found', body: '' }) as never
    )
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com' })
    expect(out).toMatch(/HTTP 404/)
  })

  it('maps an aborted request to a timeout message', async () => {
    const abortError = new Error('aborted')
    abortError.name = 'AbortError'
    vi.mocked(globalThis.fetch).mockRejectedValue(abortError as never)
    const t = makeWebFetch()
    const out = await t.invoke({ url: 'https://example.com' })
    expect(out).toMatch(/timed out/)
  })
})

describe('web_search', () => {
  const prevKey = process.env['TAVILY_API_KEY']
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    if (prevKey === undefined) delete process.env['TAVILY_API_KEY']
    else process.env['TAVILY_API_KEY'] = prevKey
  })

  it('returns formatted results', async () => {
    process.env['TAVILY_API_KEY'] = 'test-key'
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ results: [{ title: 'T1', url: 'https://a', content: 'Snip A' }] })
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
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('reports non-2xx', async () => {
    process.env['TAVILY_API_KEY'] = 'test-key'
    vi.mocked(globalThis.fetch).mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', json: () => Promise.resolve({}) } as never)
    const t = makeWebSearch()
    const out = await t.invoke({ query: 'hello' })
    expect(out).toMatch(/HTTP 401/)
  })
})

import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import * as turndownNs from 'turndown'
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici'

const TurndownService = turndownNs.default
const MAX_LEN = 20000
const TIMEOUT_MS = 15000

type ProxyEnv = Record<string, string | undefined>

// Node's global fetch (undici) ignores both the Windows system proxy and the
// HTTP(S)_PROXY env vars. Without an explicit dispatcher, every web_fetch /
// web_search in the main process fails with UND_ERR_CONNECT_TIMEOUT in any
// environment that requires a proxy to reach the network. We build one
// ProxyAgent from the env (read once at module load, after dotenv has run) and
// pass it as a per-request dispatcher — verified working under Electron's
// bundled Node (see CLAUDE.md gotchas).
export function resolveProxyDispatcher(env: ProxyEnv = process.env): Dispatcher | undefined {
  const proxy = env['HTTPS_PROXY'] ?? env['https_proxy'] ?? env['HTTP_PROXY'] ?? env['http_proxy']
  if (!proxy) return undefined
  try {
    return new ProxyAgent(proxy)
  } catch (e) {
    console.warn(
      `web: invalid proxy URL "${proxy}", falling back to direct: ${e instanceof Error ? e.message : e}`
    )
    return undefined
  }
}

const proxyDispatcher = resolveProxyDispatcher()

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n…[truncated]' : s
}

function describeFetchError(e: unknown, prefix: string): string {
  const msg = e instanceof Error ? e.message : String(e)
  const cause = (e as { cause?: unknown } | null | undefined)?.cause
  let causeStr = ''
  if (cause && typeof cause === 'object') {
    const c = cause as { code?: string; message?: string; name?: string }
    causeStr = ` (${c.code ?? c.message ?? c.name ?? 'unknown'})`
  } else if (typeof cause === 'string') {
    causeStr = ` (${cause})`
  }
  return `${prefix}: ${msg}${causeStr}`
}

export const makeWebFetch = () =>
  tool(
    async ({ url, format, maxLength }) => {
      const max = maxLength ?? MAX_LEN
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
      try {
        const res = await undiciFetch(url, {
          dispatcher: proxyDispatcher,
          signal: ctrl.signal,
          redirect: 'follow',
          headers: { 'User-Agent': 'LangChainAgentDesktop/0.1 (+desktop code agent)' }
        })
        if (!res.ok) {
          return `Request failed: HTTP ${res.status} ${res.statusText}`
        }
        const body = await res.text()
        const type = res.headers.get('content-type') ?? ''
        if (format === 'text' || !type.includes('html')) {
          return clip(body, max)
        }
        const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
        return clip(td.turndown(body), max)
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          return `Request timed out after ${TIMEOUT_MS / 1000}s`
        }
        return describeFetchError(e, 'Request failed')
      } finally {
        clearTimeout(timer)
      }
    },
    {
      name: 'web_fetch',
      description:
        'Fetch a URL and return its content as markdown (HTML pages) or plain text. Use to read a specific page or doc. 15s timeout; output capped at 20k chars by default.',
      schema: z.object({
        url: z.string().url(),
        format: z
          .enum(['markdown', 'text'])
          .optional()
          .describe('Output format; defaults to markdown for HTML'),
        maxLength: z.number().int().positive().optional()
      })
    }
  )

export const makeWebSearch = () =>
  tool(
    async ({ query, maxResults }) => {
      const apiKey = process.env['TAVILY_API_KEY']
      if (!apiKey) {
        return 'web_search is not configured: set TAVILY_API_KEY in .env'
      }
      try {
        const res = await undiciFetch('https://api.tavily.com/search', {
          dispatcher: proxyDispatcher,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, max_results: maxResults ?? 5, api_key: apiKey })
        })
        if (!res.ok) {
          return `Search failed: HTTP ${res.status} ${res.statusText}`
        }
        const data = (await res.json()) as {
          results?: Array<{ title?: string; url?: string; content?: string }>
        }
        const results = data.results ?? []
        if (results.length === 0) return 'No results found'
        return results
          .map((r, i) => `${i + 1}. ${r.title ?? '(no title)'}\n${r.url ?? ''}\n${(r.content ?? '').trim()}`)
          .join('\n\n')
      } catch (e) {
        return describeFetchError(e, 'Search failed')
      }
    },
    {
      name: 'web_search',
      description:
        'Search the web with Tavily and return ranked results (title, url, snippet). Use when the answer may need up-to-date or external information.',
      schema: z.object({
        query: z.string(),
        maxResults: z.number().int().min(1).max(10).optional()
      })
    }
  )

import { randomUUID } from 'node:crypto'
import type { AgentEvent } from '@shared/types'

// `origin` is set when a confirm request comes from a delegated sub-agent, so
// the dialog can name the role asking. Undefined = the root agent.
export interface ConfirmOrigin {
  agentId: string
  agentName: string
}

export type ConfirmFn = (
  tool: string,
  input: unknown,
  origin?: ConfirmOrigin
) => Promise<boolean>

interface Pending {
  resolve: (approved: boolean) => void
  key: string
}

// Stable serialization so `{ b: 1, a: 2 }` and `{ a: 2, b: 1 }` share a key.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys(obj[k])
        return acc
      }, {})
  }
  return value
}

function makeKey(tool: string, input: unknown): string {
  return `${tool}:${JSON.stringify(sortKeys(input))}`
}

// Per-run gate that pauses dangerous tools until the user decides. Bound to the
// run's AbortSignal: on abort every pending request resolves false (treated as
// denied), so tools return cleanly and the stream's own abort surfaces as
// `interrupted`. `allowed` memoizes exact tool+input pairs the user opted to
// skip next time — it lives only in memory for this process.
export class ConfirmManager {
  private readonly allowed = new Set<string>()
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly signal: AbortSignal,
    private readonly emit: (event: AgentEvent) => void
  ) {
    signal.addEventListener('abort', this.handleAbort, { once: true })
  }

  private readonly handleAbort = (): void => {
    for (const p of this.pending.values()) p.resolve(false)
    this.pending.clear()
  }

  request(tool: string, input: unknown, origin?: ConfirmOrigin): Promise<boolean> {
    const key = makeKey(tool, input)
    if (this.allowed.has(key)) return Promise.resolve(true)
    const id = randomUUID()
    const promise = new Promise<boolean>(resolve => {
      this.pending.set(id, { resolve, key })
    })
    this.emit({
      type: 'confirm-request',
      id,
      tool,
      input,
      agentId: origin?.agentId,
      agentName: origin?.agentName
    })
    return promise
  }

  respond(id: string, approved: boolean, remember: boolean): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (approved && remember) this.allowed.add(entry.key)
    entry.resolve(approved)
  }
}

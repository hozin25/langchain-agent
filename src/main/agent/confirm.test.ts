import { describe, it, expect, vi } from 'vitest'
import { ConfirmManager } from './confirm'

type ConfirmEvent = { id: string; type: string; tool: string; input: unknown }

function setup() {
  const controller = new AbortController()
  const emit = vi.fn()
  const manager = new ConfirmManager(controller.signal, emit)
  return { controller, emit, manager }
}

function lastRequest(emit: ReturnType<typeof vi.fn>): ConfirmEvent {
  return emit.mock.calls.at(-1)![0] as ConfirmEvent
}

describe('ConfirmManager', () => {
  it('emits a confirm-request and resolves true when approved', async () => {
    const { emit, manager } = setup()
    const pending = manager.request('delete_file', { path: 'a.txt' })
    expect(emit).toHaveBeenCalledTimes(1)
    const evt = lastRequest(emit)
    expect(evt.type).toBe('confirm-request')
    expect(evt.tool).toBe('delete_file')
    manager.respond(evt.id, true, false)
    await expect(pending).resolves.toBe(true)
  })

  it('resolves false when denied', async () => {
    const { emit, manager } = setup()
    const pending = manager.request('delete_file', { path: 'a.txt' })
    manager.respond(lastRequest(emit).id, false, false)
    await expect(pending).resolves.toBe(false)
  })

  it('skips the prompt for a remembered exact operation', async () => {
    const { emit, manager } = setup()
    const first = manager.request('run_shell_command', { command: 'npm test', background: false })
    manager.respond(lastRequest(emit).id, true, true)
    await first
    emit.mockClear()
    const second = manager.request('run_shell_command', { command: 'npm test', background: false })
    expect(emit).not.toHaveBeenCalled()
    await expect(second).resolves.toBe(true)
  })

  it('re-prompts when the args differ from the remembered op', async () => {
    const { emit, manager } = setup()
    const first = manager.request('run_shell_command', { command: 'npm test' })
    manager.respond(lastRequest(emit).id, true, true)
    await first
    emit.mockClear()
    manager.request('run_shell_command', { command: 'npm run build' })
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('resolves a pending request as false when the signal aborts', async () => {
    const { controller, manager } = setup()
    const pending = manager.request('delete_file', { path: 'a.txt' })
    controller.abort()
    await expect(pending).resolves.toBe(false)
  })

  it('does not throw when responding to an unknown id', () => {
    const { manager } = setup()
    expect(() => manager.respond('nope', true, false)).not.toThrow()
  })
})

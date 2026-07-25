import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsStore } from './config-store'

describe('SettingsStore', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'settings-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('read() returns null when the file is missing', async () => {
    const store = createSettingsStore(dir)
    expect(await store.read()).toBe(null)
  })

  it('write + read round-trips mode and bypassAcknowledged', async () => {
    const store = createSettingsStore(dir)
    const ok = await store.write({ mode: 'bypass', bypassAcknowledged: true })
    expect(ok).toEqual({ ok: true })
    expect(await store.read()).toEqual({ mode: 'bypass', bypassAcknowledged: true })
  })

  it('persisted path is userDataDir/settings.json', async () => {
    const store = createSettingsStore(dir)
    await store.write({ mode: 'plan', bypassAcknowledged: false })
    const raw = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual({ mode: 'plan', bypassAcknowledged: false })
  })

  it('read() returns null for corrupt JSON', async () => {
    await writeFile(join(dir, 'settings.json'), '{ not valid json', 'utf8')
    expect(await createSettingsStore(dir).read()).toBe(null)
  })

  it('read() returns null when mode is not a known value', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ mode: 'ninja', bypassAcknowledged: true }),
      'utf8'
    )
    expect(await createSettingsStore(dir).read()).toBe(null)
  })

  it('read() returns null when bypassAcknowledged is the wrong type', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ mode: 'act', bypassAcknowledged: 'yes' }),
      'utf8'
    )
    expect(await createSettingsStore(dir).read()).toBe(null)
  })
})

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentMode, AppSettings } from '@shared/types'

const VALID_MODES: readonly AgentMode[] = ['plan', 'act', 'bypass']

function isSettings(value: unknown): value is AppSettings {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as AppSettings).bypassAcknowledged === 'boolean' &&
    VALID_MODES.includes((value as AppSettings).mode)
  )
}

export interface SettingsStore {
  read(): Promise<AppSettings | null>
  write(settings: AppSettings): Promise<{ ok: boolean }>
}

// userData/settings.json — persists the operating mode and the one-time bypass
// acknowledgment. Read returns null for a missing/corrupt/invalid file so the
// caller (hydrateSettings) falls back to the safe 'act' default instead of
// trusting bad data. Write is a full overwrite (settings is small and the only
// writer is the UI mode toggle).
export function createSettingsStore(userDataDir: string): SettingsStore {
  const filePath = join(userDataDir, 'settings.json')

  return {
    async read(): Promise<AppSettings | null> {
      try {
        const raw = await readFile(filePath, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        return isSettings(parsed) ? parsed : null
      } catch {
        return null
      }
    },

    async write(settings: AppSettings): Promise<{ ok: boolean }> {
      try {
        await mkdir(userDataDir, { recursive: true })
        await writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8')
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }
  }
}

import { ipcMain } from 'electron'
import type { AppSettings } from '@shared/types'
import { createSettingsStore, type SettingsStore } from './config-store'

// Module-level lazy singleton, mirroring roles/index.ts and skills/index.ts.
// The Electron app's userDataDir is constant for the process lifetime, so the
// first call wins.
let instance: SettingsStore | null = null

export function getSettingsStore(userDataDir: string): SettingsStore {
  if (!instance) {
    instance = createSettingsStore(userDataDir)
  }
  return instance
}

export type { SettingsStore }

// Registers app:getSettings / app:setSettings. Handlers read/write the singleton
// store; bad payloads are rejected to { ok: false } / null rather than throwing
// so the renderer's fire-and-forget persistence calls never reject the IPC.
export function registerSettingsIpc(userDataDir: string): void {
  const store = getSettingsStore(userDataDir)

  ipcMain.handle('app:getSettings', () => store.read())

  ipcMain.handle('app:setSettings', (_event, settings: unknown) => {
    if (
      !settings ||
      typeof settings !== 'object' ||
      typeof (settings as AppSettings).bypassAcknowledged !== 'boolean' ||
      !['plan', 'act', 'bypass'].includes((settings as AppSettings).mode)
    ) {
      return { ok: false }
    }
    return store.write(settings as AppSettings)
  })
}

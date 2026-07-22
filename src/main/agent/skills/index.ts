import { createSkillConfigStore, type SkillConfigStore } from './config-store'

// Module-level lazy singleton, mirroring roles/index.ts. The Electron app's
// userDataDir is constant for the process lifetime, so the first call wins.
let instance: SkillConfigStore | null = null

export function getSkillStore(userDataDir: string): SkillConfigStore {
  if (!instance) {
    instance = createSkillConfigStore(userDataDir)
  }
  return instance
}

export type { SkillConfigStore }
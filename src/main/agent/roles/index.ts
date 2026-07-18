import { createRoleConfigStore, type RoleConfigStore } from './config-store'

// Module-level lazy singleton, mirroring mcp/manager.ts. The Electron app's
// userDataDir is constant for the process lifetime, so the first call wins.
let instance: RoleConfigStore | null = null

export function getRoleStore(userDataDir: string): RoleConfigStore {
  if (!instance) {
    instance = createRoleConfigStore(userDataDir)
  }
  return instance
}

export type { RoleConfigStore }

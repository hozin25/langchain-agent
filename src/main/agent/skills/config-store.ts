import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillConfig } from '@shared/types'

interface SkillConfigFile {
  skills: SkillConfig[]
}

export interface SkillConfigStore {
  list(): Promise<SkillConfig[]>
  add(config: Omit<SkillConfig, 'id'>): Promise<SkillConfig>
  update(config: SkillConfig): Promise<SkillConfig>
  remove(id: string): Promise<{ ok: boolean }>
}

export function createSkillConfigStore(userDataDir: string): SkillConfigStore {
  const configPath = join(userDataDir, 'skills-config.json')

  async function readAll(): Promise<SkillConfig[]> {
    try {
      const raw = await readFile(configPath, 'utf8')
      const parsed = JSON.parse(raw) as SkillConfigFile
      if (!parsed || !Array.isArray(parsed.skills)) return []
      return parsed.skills.filter(
        s =>
          s &&
          typeof s.id === 'string' &&
          typeof s.name === 'string' &&
          typeof s.description === 'string' &&
          typeof s.filePath === 'string' &&
          typeof s.enabled === 'boolean'
      )
    } catch {
      return []
    }
  }

  async function writeAll(skills: SkillConfig[]): Promise<void> {
    await mkdir(userDataDir, { recursive: true })
    const data: SkillConfigFile = { skills }
    await writeFile(configPath, JSON.stringify(data, null, 2), 'utf8')
  }

  return {
    async list() {
      return readAll()
    },

    async add(config) {
      const skills = await readAll()
      if (skills.some(s => s.name === config.name)) {
        throw new Error(`Skill name already exists: ${config.name}`)
      }
      const entry: SkillConfig = { ...config, id: crypto.randomUUID() }
      skills.push(entry)
      await writeAll(skills)
      return entry
    },

    async update(config) {
      const skills = await readAll()
      const idx = skills.findIndex(s => s.id === config.id)
      if (idx < 0) throw new Error(`Skill not found: ${config.id}`)
      if (skills.some((s, i) => i !== idx && s.name === config.name)) {
        throw new Error(`Skill name already exists: ${config.name}`)
      }
      const normalized: SkillConfig = { ...config }
      skills[idx] = normalized
      await writeAll(skills)
      return normalized
    },

    async remove(id) {
      const skills = await readAll()
      const len = skills.length
      const filtered = skills.filter(s => s.id !== id)
      if (filtered.length !== len) {
        await writeAll(filtered)
      }
      return { ok: filtered.length !== len }
    }
  }
}
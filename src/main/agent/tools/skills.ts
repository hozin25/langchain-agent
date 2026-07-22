import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import type { SkillConfig } from '@shared/types'

// read_skill bypasses the workspace sandbox by design: skill .md files live at
// user-curated absolute paths (registered in Settings), not agent-supplied ones.
// The agent can only request skills by name from the registered list — it can
// never pass an arbitrary path here — so the escape risk that resolveInWorkspace
// guards against does not apply.

export const makeListSkills = (skills: SkillConfig[]) =>
  tool(
    async () => {
      const enabled = skills.filter(s => s.enabled)
      if (enabled.length === 0) return 'No skills available.'
      return enabled.map(s => `${s.name} — ${s.description}`).join('\n')
    },
    {
      name: 'list_skills',
      description:
        'List the user-defined skills available in this app. Each line is "name — description". Call this first to discover what skills exist, then call read_skill with a chosen name to load its full instructions.',
      schema: z.object({})
    }
  )

export const makeReadSkill = (skills: SkillConfig[]) =>
  tool(
    async ({ name }) => {
      const skill = skills.find(s => s.name === name && s.enabled)
      if (!skill) {
        const available = skills.filter(s => s.enabled).map(s => s.name).join(', ')
        throw new Error(
          `Skill "${name}" not found or disabled. Available: ${available || '(none)'}`
        )
      }
      return await readFile(skill.filePath, 'utf8')
    },
    {
      name: 'read_skill',
      description:
        'Load the full Markdown body of a skill by its name (the name returned by list_skills). Follow the loaded instructions to complete the current task.',
      schema: z.object({ name: z.string().describe('The skill name returned by list_skills') })
    }
  )
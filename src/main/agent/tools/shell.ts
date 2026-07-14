import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { spawn } from 'node:child_process'

const TIMEOUT_MS = 30_000
const MAX_OUTPUT = 20_000

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n...[truncated]' : s
}

export const makeRunShellCommand = (workspace: string) =>
  tool(
    async ({ command }) => {
      return await new Promise<string>((done) => {
        const proc = spawn(command, [], {
          cwd: workspace,
          shell: true,
          timeout: TIMEOUT_MS,
          env: process.env
        })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (d: Buffer) => {
          stdout += d.toString()
        })
        proc.stderr.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        proc.on('error', (e) => done(`Error launching command: ${e.message}`))
        proc.on('close', (code) => {
          done(`[exit ${code}]\nstdout:\n${clip(stdout)}\nstderr:\n${clip(stderr)}`)
        })
      })
    },
    {
      name: 'run_shell_command',
      description:
        'Run a shell command in the workspace directory (30s timeout). Use for build, test, git, and other CLI tasks. Output beyond 20k chars is truncated.',
      schema: z.object({ command: z.string() })
    }
  )

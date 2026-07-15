import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { spawn } from 'node:child_process'

const TIMEOUT_MS = 30_000
const MAX_OUTPUT = 20_000

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n...[truncated]' : s
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      timeout: 5000
    })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // process may have already exited
    }
  }
}

export const makeRunShellCommand = (workspace: string) =>
  tool(
    async ({ command, background }) => {
      if (background) {
        const proc = spawn(command, [], {
          cwd: workspace,
          shell: true,
          env: process.env,
          detached: true,
          stdio: 'ignore'
        })
        proc.unref()
        return await new Promise<string>(resolve => {
          let resolved = false
          const settle = (msg: string) => {
            if (!resolved) {
              resolved = true
              resolve(msg)
            }
          }
          const grace = setTimeout(() => {
            settle(
              `Started in background (pid: ${proc.pid}). It runs detached. Verify with a separate command, then stop it with taskkill /F /T /PID ${proc.pid} (Windows) or kill ${proc.pid} (Unix).`
            )
          }, 500)
          proc.on('exit', code => {
            clearTimeout(grace)
            settle(
              `Background process exited immediately (code: ${code}). The command likely failed — check it.`
            )
          })
          proc.on('error', e => {
            clearTimeout(grace)
            settle(`Error launching command: ${e.message}`)
          })
        })
      }

      return await new Promise<string>(done => {
        const proc = spawn(command, [], {
          cwd: workspace,
          shell: true,
          env: process.env
        })
        let stdout = ''
        let stderr = ''
        let timedOut = false

        const timer = setTimeout(() => {
          timedOut = true
          killTree(proc.pid!)
        }, TIMEOUT_MS)

        proc.stdout.on('data', (d: Buffer) => {
          stdout += d.toString()
        })
        proc.stderr.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        proc.on('error', e => {
          clearTimeout(timer)
          done(`Error launching command: ${e.message}`)
        })
        proc.on('close', code => {
          clearTimeout(timer)
          if (timedOut) {
            done(`Command timed out after ${TIMEOUT_MS / 1000}s`)
            return
          }
          done(`[exit ${code}]\nstdout:\n${clip(stdout)}\nstderr:\n${clip(stderr)}`)
        })
      })
    },
    {
      name: 'run_shell_command',
      description:
        'Run a shell command in the workspace directory. Blocking mode (default) has a 30s timeout. For servers, watchers, and daemons that run indefinitely, set background:true — the process starts detached and the tool returns immediately. Output beyond 20k chars is truncated.',
      schema: z.object({
        command: z.string(),
        background: z
          .boolean()
          .optional()
          .describe(
            'Set true for long-lived processes (servers, watchers, daemons). Starts detached with no output capture and returns immediately. Redirect output in the command if you need logs.'
          )
      })
    }
  )

import { spawn } from 'node:child_process'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

// Shadow git 仓库封装:在 <userDataDir>/agent-snapshots/<workspaceHash>/.git 建一个
// 独立 git-dir 的仓库,work-tree 指向用户 workspace。用于 agent 每次写操作前的快照
// 与一键 Restore。**绝不触碰用户原 git 仓库**:所有 git 子进程只设 GIT_DIR=<shadow>、
// GIT_WORK_TREE=<workspace>、GIT_CONFIG_NOSYSTEM=1、-c core.hooksPath=(禁 hook),用
// 环境变量 + -c 显式隔离,git 自己的 repo 发现机制完全不介入(probe-shadow-git.cjs
// 实测:workspace 是真实 git repo 时,shadow 操作后真实 repo 的 HEAD/status/log 零变化)。
//
// 不引 simple-git,直接 spawn('git')(与 shell.ts 一致,无 interop 风险)。

export interface SnapshotCommit {
  sha: string
  message: string
  createdAt: number
}

export interface ShadowRepo {
  init(): Promise<void>
  /** add -A + commit。无变化时返回上一 sha(不抛错);首快照空仓库用 --allow-empty 建基线。 */
  snapshot(message: string): Promise<string>
  listFiles(sha: string): Promise<string[]>
  readFile(sha: string, rel: string): Promise<Buffer>
  listCommits(): Promise<SnapshotCommit[]>
}

const EXCLUDE_PATTERNS = ['node_modules/', 'out/', 'release/', '.git/', 'dist/', 'build/', '']

// workspaceHash = sha1(规范化的 workspace 绝对路径)前 16 位。同一 workspace 稳定映射到
// 同一 shadow 目录(跨会话复用 timeline)。SAFE_ID 友好(16 位 hex)。
function workspaceHash(workspace: string): string {
  return createHash('sha1').update(resolve(workspace)).digest('hex').slice(0, 16)
}

export function createShadowRepo(userDataDir: string, workspace: string): ShadowRepo {
  const hash = workspaceHash(workspace)
  const root = join(userDataDir, 'agent-snapshots', hash)
  const gitDir = join(root, '.git')

  // 所有 git 调用的公共 env:GIT_DIR/GIT_WORK_TREE 强制指向 shadow + workspace,
  // GIT_CONFIG_NOSYSTEM 忽略系统级 git 配置(防机器全局 config 干扰)。
  const baseEnv = {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workspace,
    GIT_CONFIG_NOSYSTEM: '1'
  }

  // commit 专用 -c 参数:禁 hook(core.hooksPath=)+ 注入稳定身份(不写全局/仓库 config,
  // 只作用于本次命令,零副作用)。身份是 shadow-agent 固定值,与用户 git 身份无关。
  const commitConfig = ['-c', 'core.hooksPath=', '-c', 'user.email=agent@shadow', '-c', 'user.name=shadow-agent']

  // 跑一条 git 命令,失败抛(exit≠0)。stdout 原样返回 Buffer,binary-safe(restore 读
  // 二进制文件靠这个)。
  function gitRaw(args: string[]): Promise<Buffer> {
    return new Promise((resolveP, rejectP) => {
      const proc = spawn('git', args, {
        cwd: workspace,
        env: { ...process.env, ...baseEnv },
        windowsHide: true
      })
      const chunks: Buffer[] = []
      let stderr = ''
      proc.stdout.on('data', (d: Buffer) => chunks.push(d))
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      proc.on('error', rejectP)
      proc.on('close', code => {
        if (code !== 0) {
          rejectP(new Error(`git ${args.join(' ')} exit ${code}: ${stderr.trim()}`))
        } else {
          resolveP(Buffer.concat(chunks))
        }
      })
    })
  }

  const git = (args: string[]): Promise<string> => gitRaw(args).then(b => b.toString('utf8'))

  let initialized = false

  async function ensureInit(): Promise<void> {
    if (initialized) return
    await mkdir(join(gitDir, 'info'), { recursive: true })
    // git init 幂等:已有 repo 时无副作用。
    await git(['init'])
    // 写 exclude:node_modules/out/release/.git/dist/build 不纳入快照(大目录噪音 +
    // .git 自身)。append 模式避免覆盖 git init 默认生成的 sample。
    await writeFile(join(gitDir, 'info', 'exclude'), EXCLUDE_PATTERNS.join('\n'), 'utf8')
    // 字节保真:repo 级 attributes 优先级最高(info/attributes > 工作树 .gitattributes
    // > 全局 config),把所有文件标记为非文本,禁用 autocrlf / text 属性的 clean/smudge
    // 换行转换。否则在全局 core.autocrlf=true 的机器上,GIT_CONFIG_NOSYSTEM 只屏蔽
    // 系统级配置、用户级 ~/.gitconfig 仍生效:add 时 CRLF→LF 入库,restore 写回 LF,
    // 工作区换行符漂移(git status 假 M;含 \r\n 的类二进制文件甚至会被 clean 损坏)。
    await writeFile(join(gitDir, 'info', 'attributes'), '* -text\n', 'utf8')
    initialized = true
  }

  return {
    async init(): Promise<void> {
      await ensureInit()
    },

    async snapshot(message: string): Promise<string> {
      await ensureInit()
      await git(['add', '-A'])
      try {
        await git([...commitConfig, 'commit', '-m', message])
      } catch {
        // nothing to commit(无变化)。已有历史 → 返回上一 sha;无历史(空仓库首次)→
        // --allow-empty 建基线。
        try {
          return (await git(['rev-parse', 'HEAD'])).trim()
        } catch {
          await git([...commitConfig, 'commit', '-m', message, '--allow-empty'])
        }
      }
      return (await git(['rev-parse', 'HEAD'])).trim()
    },

    async listFiles(sha: string): Promise<string[]> {
      await ensureInit()
      const out = await git(['ls-tree', '-r', '--name-only', sha])
      return out.split('\n').map(l => l.trim()).filter(Boolean)
    },

    async readFile(sha: string, rel: string): Promise<Buffer> {
      await ensureInit()
      // git show <sha>:<rel>。rel 是 ls-tree 给出的相对路径,由 snapshot 写入,可信;
      // 调用方(restore.ts)仍会过 resolveInWorkspace 校验落盘路径。
      return await gitRaw(['show', `${sha}:${rel}`])
    },

    async listCommits(): Promise<SnapshotCommit[]> {
      await ensureInit()
      const out = await git(['log', '--format=%H|%s|%ct'])
      return out
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
          const [sha, message, ts] = line.split('|')
          return { sha, message: message ?? '', createdAt: Number(ts ?? 0) }
        })
    }
  }
}

// 导出供 index-store.ts 复用:workspace → hash 的同一算法(timeline 索引按 hash 落盘)。
export { workspaceHash }

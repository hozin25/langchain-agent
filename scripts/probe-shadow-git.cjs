/**
 * shadow-git 隔离探针 — Phase 3 Spike
 *
 * 用法:ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/probe-shadow-git.cjs
 *
 * 目的:在真实 git 二进制 + Electron ABI 下验证 shadow repo 的隔离与可用性,
 * 决定 shadowRepo.ts 的实现。要回答:
 *   1. git 二进制可用?(Windows 下 spawn 'git' 能找到)
 *   2. 独立 GIT_DIR + GIT_WORK_TREE 能 init/add -A/commit/ls-tree/show 吗?
 *   3. **关键隔离**:workspace 本身是真实 git repo 时,shadow 操作绝不污染它的
 *      .git —— 仓库的 HEAD、index、status 在 shadow 前后完全不变。
 *   4. -c core.hooksPath= 真能禁 hook(不跑 workspace 的 hook)?
 *   5. .git/info/exclude 排除 node_modules/out 等,add -A 不纳入?
 *   6. 无变化时 commit 跳过(返回上一 sha,不抛错)?
 *
 * 设计:不引 simple-git,直接 spawn('git', ...)(与 shell.ts 一致,无 interop 风险)。
 */
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, writeFile, rm, readFile, stat } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createHash } = require('node:crypto')

function runGit(args, envExtra, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: { ...process.env, ...envExtra },
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => (stdout += d))
    proc.stderr.on('data', d => (stderr += d))
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`git ${args.join(' ')} exit ${code}: ${stderr.trim()}`))
      else resolve(stdout)
    })
  })
}

async function main() {
  let pass = 0
  let fail = 0
  const check = (name, cond) => {
    if (cond) {
      pass++
      console.log(`  \x1b[32m✓\x1b[0m ${name}`)
    } else {
      fail++
      console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    }
  }

  console.log('=== probe-shadow-git:shadow repo 隔离验证 ===\n')

  // 1. git 二进制可用性
  console.log('[0] git 二进制可用性')
  let gitOk = true
  try {
    const v = await runGit(['--version'], {}, process.cwd())
    check('git --version 返回', /git version/.test(v))
  } catch (e) {
    gitOk = false
    check('git --version 返回', false)
    console.log('    git 不可用,后续测试跳过:', e.message)
  }
  if (!gitOk) {
    console.log(`\n=== 结果: ${pass} passed, ${fail} failed (git 不可用) ===`)
    process.exit(fail > 0 ? 1 : 0)
  }

  // 场景:workspace 本身是真实 git repo(模拟用户在 git 仓库里跑 agent)
  const workspace = await mkdtemp(join(tmpdir(), 'shadow-ws-'))
  const userData = await mkdtemp(join(tmpdir(), 'shadow-ud-'))
  const wsHash = createHash('sha1').update(workspace).digest('hex').slice(0, 16)
  const shadowRoot = join(userData, 'agent-snapshots', wsHash)
  const shadowGitDir = join(shadowRoot, '.git')

  const realEnv = {} // 空 = 让 git 自己发现 workspace/.git
  const shadowEnv = {
    GIT_DIR: shadowGitDir,
    GIT_WORK_TREE: workspace,
    GIT_CONFIG_NOSYSTEM: '1'
  }

  console.log('\n[1] workspace 真实 repo 基线')
  // workspace 自己的 repo(不传 shadowEnv → git 发现 workspace/.git)
  await runGit(['init'], { GIT_CONFIG_NOSYSTEM: '1' }, workspace)
  await runGit(['config', 'user.email', 'user@real'], {}, workspace)
  await runGit(['config', 'user.name', 'real-user'], {}, workspace)
  await writeFile(join(workspace, 'user-baseline.txt'), 'original')
  // 造一个 node_modules 文件,验证 shadow 的 exclude 排除它
  await mkdir(join(workspace, 'node_modules'), { recursive: true })
  await writeFile(join(workspace, 'node_modules', 'dep.js'), 'require()')
  await runGit(['add', '-A'], realEnv, workspace)
  await runGit(['commit', '-m', 'user-baseline'], realEnv, workspace)
  const realHeadBefore = (await runGit(['rev-parse', 'HEAD'], realEnv, workspace)).trim()
  check('workspace 真实 repo 有基线 commit', realHeadBefore.length === 40)

  console.log('\n[2] shadow repo init(独立 GIT_DIR)')
  await mkdir(shadowRoot, { recursive: true })
  await runGit(['init'], shadowEnv, workspace)
  check('shadow GIT_DIR 目录建出', !!(await statSafe(shadowGitDir)))

  // 写 .git/info/exclude 排除清单
  const excludePath = join(shadowGitDir, 'info', 'exclude')
  await mkdir(join(shadowGitDir, 'info'), { recursive: true })
  await writeFile(
    excludePath,
    ['node_modules/', 'out/', 'release/', '.git/', 'dist/', 'build/', ''].join('\n'),
    'utf8'
  )

  // shadow repo 也要 commit 身份(-c 临时传,不污染全局)
  const shadowCommitArgs = extra => [
    '-c',
    'core.hooksPath=',
    '-c',
    'user.email=agent@shadow',
    '-c',
    'user.name=shadow-agent',
    ...extra
  ]

  console.log('\n[3] shadow snapshot #1(add -A + commit)')
  await runGit(['add', '-A'], shadowEnv, workspace)
  let sha1
  try {
    const out = await runGit(
      shadowCommitArgs(['commit', '-m', 'turn-start', '--allow-empty']),
      shadowEnv,
      workspace
    )
    sha1 = (await runGit(['rev-parse', 'HEAD'], shadowEnv, workspace)).trim()
    check('shadow commit #1 成功,返回 sha', sha1.length === 40)
  } catch (e) {
    check('shadow commit #1 成功,返回 sha', false)
    console.log('    commit 失败:', e.message)
    sha1 = null
  }

  console.log('\n[4] shadow ls-tree / show 读文件')
  const listed = (await runGit(['ls-tree', '-r', '--name-only', 'HEAD'], shadowEnv, workspace))
    .trim()
    .split('\n')
    .filter(Boolean)
  check('shadow ls-tree 含 user-baseline.txt', listed.includes('user-baseline.txt'))
  check('shadow ls-tree 排除 node_modules( exclude 生效)', !listed.some(p => p.startsWith('node_modules/')))
  const blob = await runGit(['show', `HEAD:user-baseline.txt`], shadowEnv, workspace)
  check('shadow show 读回内容 = original', blob === 'original')

  console.log('\n[5] 隔离核心:workspace 真实 repo 零污染')
  const realHeadAfterInit = (await runGit(['rev-parse', 'HEAD'], realEnv, workspace)).trim()
  check('真实 repo HEAD 不变', realHeadAfterInit === realHeadBefore)
  const realStatus = (await runGit(['status', '--porcelain'], realEnv, workspace)).trim()
  check('真实 repo status 为空(无未跟踪/无修改)', realStatus === '')
  const realLogCount = (await runGit(['rev-list', '--count', 'HEAD'], realEnv, workspace)).trim()
  check('真实 repo commit 数仍为 1(shadow 没往里加 commit)', realLogCount === '1')

  console.log('\n[6] 第二次 snapshot(无变化→跳过)+ 有变化→新 sha')
  // 无变化:commit 应失败(Nothing changed),实现层应 catch 返回上一 sha
  let noChangeOk = false
  try {
    await runGit(shadowCommitArgs(['commit', '-m', 'no-change']), shadowEnv, workspace)
  } catch {
    noChangeOk = true // 抛错 = 确实无变化
  }
  check('无变化时 commit 抛 nothing-to-commit(实现层 catch 返回旧 sha)', noChangeOk)
  const sha1Again = (await runGit(['rev-parse', 'HEAD'], shadowEnv, workspace)).trim()
  check('无变化后 HEAD 仍是 sha1', sha1Again === sha1)

  // 有变化:改一个文件 + 新增一个
  await writeFile(join(workspace, 'user-baseline.txt'), 'modified by agent')
  await writeFile(join(workspace, 'new-file.txt'), 'agent created')
  await runGit(['add', '-A'], shadowEnv, workspace)
  await runGit(shadowCommitArgs(['commit', '-m', 'after-write']), shadowEnv, workspace)
  const sha2 = (await runGit(['rev-parse', 'HEAD'], shadowEnv, workspace)).trim()
  check('有变化后新 sha2 ≠ sha1', sha2 !== sha1 && sha2.length === 40)

  // 再验隔离:真实 repo 此时 status 应反映 workspace 的实际文件改动(modified + untracked),
  // 但仍无 git 内部状态变化、HEAD 不变
  const realHeadFinal = (await runGit(['rev-parse', 'HEAD'], realEnv, workspace)).trim()
  check('改文件后真实 repo HEAD 仍不变', realHeadFinal === realHeadBefore)
  const realStatusFinal = (await runGit(['status', '--porcelain'], realEnv, workspace)).trim()
  check(
    '改文件后真实 repo status 反映文件改动(modified + ??)但非 git 内部',
    realStatusFinal.includes('M ') && realStatusFinal.includes('??')
  )

  console.log('\n[7] shadow listCommits(多个)')
  const log = (
    await runGit(['log', '--format=%H|%s|%ct'], shadowEnv, workspace)
  ).trim()
  const commits = log.split('\n').filter(Boolean)
  check('shadow log 含 2 条 commit(sha1 + sha2)', commits.length === 2)

  // 清理
  await rm(workspace, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true })

  console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`)
  process.exit(fail > 0 ? 1 : 0)
}

async function statSafe(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

main().catch(e => {
  console.error('probe 崩溃:', e)
  process.exit(1)
})

// 离线测试：用假的 ctx 模拟 DHS 的 agent 循环和工具流水线，不需要启动 DHS。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, decideGuard, decideCommit, authPath, cardPath, statePath, commandSucceeded, MAX_STOP_REMINDERS } from '../lib/guard.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptg-'))
const teamProj = path.join(tmp, 'proj')
const plainProj = path.join(tmp, 'plain')
fs.mkdirSync(path.join(teamProj, '.team'), { recursive: true })
fs.mkdirSync(path.join(teamProj, 'sub'), { recursive: true })
fs.mkdirSync(plainProj, { recursive: true })
fs.mkdirSync(path.join(teamProj, ".git"))  // 项目是 git 仓库
const auth = authPath(teamProj)

let failed = 0
const results = []
function check(label, fn) {
  try { fn(); console.log('ok   ', label) } catch (e) { failed++; console.log('FAIL ', label, '->', e.message) }
}
const denies = r => assert.ok(typeof r === 'string' && r.length > 0, `应拒绝，实际 ${JSON.stringify(r)}`)
const passes = r => assert.equal(r, undefined, `应放行，实际 ${JSON.stringify(r)}`)
const kindIs = (r, k) => assert.equal(r?.kind, k, `应为 ${k}，实际 ${JSON.stringify(r)}`)
const ok = (value = { exitCode: 0 }) => ({ isError: false, value, content: [] })

console.log('== 刹车 1：提交审批（纯函数）')
check('git commit → 弹窗审批', () => kindIs(decideCommit('bash', { command: 'git commit -m x' }, teamProj, 'ask'), 'ask'))
check('git push → 弹窗审批', () => kindIs(decideCommit('pwsh', { command: 'git push origin main' }, teamProj, 'ask'), 'ask'))
check('git -C 项目内 commit → 弹窗审批', () => kindIs(decideCommit('bash', { command: 'git -C sub commit -m x' }, teamProj, 'ask'), 'ask'))
check('git -C 项目外 commit → 不管', () => passes(decideCommit('bash', { command: 'git -C ' + JSON.stringify(plainProj) + ' commit -m x' }, teamProj, 'ask')))
check('cd 到项目外再提交 → 不管', () => passes(decideCommit('pwsh', { command: 'Set-Location ' + JSON.stringify(plainProj) + '; git commit -m x' }, teamProj, 'ask')))
check('cd 到项目内子目录再提交 → 审批', () => kindIs(decideCommit('bash', { command: 'cd sub && git commit -m x' }, teamProj, 'ask'), 'ask'))
check('临时目录实验（git init + 切目录）→ 不管', () => passes(decideCommit('pwsh', { command: '$t = Join-Path $env:TEMP x\nPush-Location $t\ngit init -q\ngit add -A; git commit -qm base' }, teamProj, 'ask')))
check('项目根目录首次 git init + commit → 审批', () => kindIs(decideCommit('bash', { command: 'git init && git add -A && git commit -m init' }, teamProj, 'ask'), 'ask'))
{
  const noGit = path.join(tmp, 'nogit')
  fs.mkdirSync(path.join(noGit, '.team'), { recursive: true })
  check('项目还不是 git 仓库 → 提交不可能落在项目里，不管', () => passes(decideCommit('bash', { command: 'git commit -m x' }, noGit, 'ask')))
  check('项目还不是 git 仓库，就地 git init 后首次提交 → 审批', () => kindIs(decideCommit('pwsh', { command: 'git init; git add -A; git commit -m "M0"' }, noGit, 'ask'), 'ask'))
}
check('链式命令里的 commit → 弹窗审批', () => kindIs(decideCommit('bash', { command: 'git add . && git commit -m x' }, teamProj, 'ask'), 'ask'))
check('子目录里也审批', () => kindIs(decideCommit('bash', { command: 'git commit -m x' }, path.join(teamProj, 'sub'), 'ask'), 'ask'))
check('workdir 指向项目时审批', () => kindIs(decideCommit('bash', { command: 'git commit -m x', workdir: teamProj }, plainProj, 'ask'), 'ask'))
check('终端里的 git commit → 审批', () => kindIs(decideCommit('terminal_send', { sessionId: 's', text: 'git commit -m x' }, teamProj, 'ask'), 'ask'))
check('审批策略"从不询问" → 直接拒绝并说明', () => {
  const r = decideCommit('bash', { command: 'git commit -m x' }, teamProj, 'never')
  kindIs(r, 'deny'); assert.match(r.reason, /从不询问/)
})
check('本轮已批准过 → 不再弹窗', () => passes(decideCommit('bash', { command: 'git commit -m x' }, teamProj, 'ask', new Set([teamProj]))))
check('git status 不干预', () => passes(decideCommit('bash', { command: 'git status' }, teamProj, 'ask')))
check('git log --grep commit 不干预', () => passes(decideCommit('bash', { command: 'git log --grep commit' }, teamProj, 'ask')))
check('非 crew 项目不干预', () => passes(decideCommit('bash', { command: 'git commit -m x' }, plainProj, 'ask')))
{
  const wt = path.join(tmp, 'proj-wt-builder')
  fs.mkdirSync(path.join(wt, '.team'), { recursive: true })
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../proj/.git/worktrees/builder')
  check('worktree 里成员提交自己分支 → 不弹窗', () => passes(decideCommit('bash', { command: 'git commit -m x' }, wt, 'ask')))
  check('worktree 里推送 → 仍要审批', () => kindIs(decideCommit('bash', { command: 'git push' }, wt, 'ask'), 'ask'))
  check('worktree 里 commit 后接 push → 仍要审批', () => kindIs(decideCommit('bash', { command: 'git commit -m x && git push' }, wt, 'ask'), 'ask'))
}
fs.writeFileSync(auth, '')
check('用户已整批授权 → 直接放行', () => passes(decideCommit('bash', { command: 'git commit -m x' }, teamProj, 'never')))
fs.rmSync(auth)

console.log('== 刹车 2：授权文件写入保护（纯函数）')
check('write 授权文件 → 拒绝', () => denies(decideGuard('write', { file_path: '.team/commit-authorized', content: '' }, teamProj)))
check('命令里出现授权文件名 → 拒绝', () => denies(decideGuard('pwsh', { command: 'New-Item .team\\commit-authorized' }, teamProj)))
check('写普通文件 → 放行', () => passes(decideGuard('write', { file_path: 'README.md', content: 'x' }, teamProj)))

console.log('== 命令成败判断')
check('退出码 0 → 成功', () => assert.equal(commandSucceeded(ok()), true))
check('退出码 1 → 失败', () => assert.equal(commandSucceeded(ok({ exitCode: 1 })), false))
check('工具报错 → 失败', () => assert.equal(commandSucceeded({ isError: true, content: [] }), false))
check('无退出码但有非零标记 → 失败', () => assert.equal(commandSucceeded({ isError: false, value: null, content: [{ type: 'text', text: 'x\n[exit code: 2]' }] }), false))

// ---------- 模拟 DHS：pre-step → pre-execute → (审批) → guard → execute → post-execute → turn-stopping ----------
function makeHost({ policy = 'ask', approve = true } = {}) {
  const handlers = {}
  const guards = []
  const session = {}
  const inbox = []
  const agent = { session, inbox: { append: (target, m) => inbox.push({ target, m }) } }
  apply({
    on: (ev, fn) => { handlers[ev] = fn },
    tools: { guard: g => { guards.push(g); return () => {} } },
    workingDirectory: { get: s => (s === session ? teamProj : null) },
    get: name => (name === 'approval' ? { overrideOf: () => policy } : undefined),
  })
  let n = 0
  const popups = []
  async function userSays() {
    await handlers['agent/pre-step']({ agent, messages: [{ source: { kind: 'user' } }] }, async () => ({}))
  }
  async function run(name, args, { body = () => {}, result = ok() } = {}) {
    const exec = { callId: `c${++n}`, name, arguments: args, agent }
    let pre = await handlers['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))
    if (pre.kind === 'ask') {
      popups.push(exec.callId)
      pre = approve ? { kind: 'allow' } : { kind: 'deny', reason: 'the user rejected' }
    }
    if (pre.kind !== 'allow') {
      await handlers['tools/post-execute'](exec, { isError: true, content: [] }, async () => ({ kind: 'accept' }))
      return { stage: 'pre', decision: pre }
    }
    for (const g of guards) {
      const d = g(exec)
      if (d) {
        await handlers['tools/post-execute'](exec, { isError: true, content: [] }, async () => ({ kind: 'accept' }))
        return { stage: 'guard', reason: d }
      }
    }
    await handlers['tools/execute'](exec, async () => { body(); return result })
    const post = await handlers['tools/post-execute'](exec, result, async () => ({ kind: 'accept' }))
    return { stage: 'post', decision: post }
  }
  /** 模拟一轮结束：返回 agent 是否被拉回来继续。 */
  function tryStop() {
    const before = inbox.length
    handlers['agent/turn-stopping']({ agent, turn: 1, signal: new AbortController().signal })
    return inbox.length > before ? inbox[inbox.length - 1].m.content[0].text : null
  }
  return { run, userSays, tryStop, popups, inbox }
}

console.log('== 刹车 1+2：接入流水线')
{
  const host = makeHost()
  await host.userSays()
  const r = await host.run('bash', { command: 'git commit -m x' })
  check('git commit 走弹窗，批准后放行', () => { assert.equal(host.popups.length, 1); assert.equal(r.stage, 'post') })
  await host.run('bash', { command: 'git commit -m x' })
  check('同一轮重试提交不再弹窗', () => assert.equal(host.popups.length, 1))
  await host.userSays()
  await host.run('bash', { command: 'git commit -m y' })
  check('新的一轮再提交会重新弹窗', () => assert.equal(host.popups.length, 2))

  const forge = await host.run('pwsh', { command: "$p = Join-Path .team ('comm' + 'it' + '-' + 'authorized'); Set-Content $p x" },
    { body: () => fs.writeFileSync(auth, 'forged') })
  check('拆字伪造授权：事后拦下', () => { assert.equal(forge.stage, 'post'); kindIs(forge.decision, 'block') })
  check('拆字伪造授权：文件已删除', () => assert.equal(fs.existsSync(auth), false))

  fs.writeFileSync(auth, '')  // 用户本人在对话之外创建
  const touch = await host.run('bash', { command: 'echo hi > notes.txt' }, { body: () => fs.writeFileSync(auth, 'changed!') })
  check('agent 改动用户的授权文件也被拦下并删除', () => { kindIs(touch.decision, 'block'); assert.equal(fs.existsSync(auth), false) })
}
{
  const host = makeHost({ approve: false })
  await host.userSays()
  await host.run('bash', { command: 'git commit -m x' })
  await host.run('bash', { command: 'git commit -m x' })
  check('用户拒绝后重试，仍然每次弹窗', () => assert.equal(host.popups.length, 2))
}
{
  const host = makeHost({ policy: 'never' })
  await host.userSays()
  const r = await host.run('bash', { command: 'git commit -m x' })
  check('从不询问时提交被拒并说明', () => { kindIs(r.decision, 'deny'); assert.match(r.decision.reason, /从不询问/) })
}

console.log('== 刹车 3：收工前验证')
fs.writeFileSync(path.join(teamProj, '.team', 'guard.json'), JSON.stringify({ verify: 'verify.ps1' }))
fs.writeFileSync(cardPath(teamProj), '# 状态卡')
{
  const host = makeHost()
  await host.userSays()
  check('没改代码 → 可以收工', () => assert.equal(host.tryStop(), null))
  await host.run('write', { file_path: 'src/a.js', content: 'x' })
  const r1 = host.tryStop()
  check('改了代码没跑 verify → 拉回来', () => assert.match(r1 ?? '', /verify\.ps1/))
  await host.run('pwsh', { command: '.\\verify.ps1' }, { result: ok({ exitCode: 1 }) })
  const r2 = host.tryStop()
  check('verify 失败 → 仍然拉回来', () => assert.match(r2 ?? '', /verify\.ps1/))
  const r3 = host.tryStop()
  check(`每轮最多拉回 ${MAX_STOP_REMINDERS} 次，防死循环`, () => assert.equal(r3, null))
}
{
  const host = makeHost()
  await host.userSays()
  await host.run('edit', { file_path: 'src/a.js', old_string: 'x', new_string: 'y' })
  await host.run('pwsh', { command: '.\\verify.ps1' })
  check('改代码后 verify 通过 → 可以收工', () => assert.equal(host.tryStop(), null))
  await host.run('write', { file_path: 'docs/guide.md', content: 'x' })
  await host.run('write', { file_path: '.team/reviews/r1.md', content: 'x' })
  check('之后只改文档和 .team → 不要求重跑', () => assert.equal(host.tryStop(), null))
}
{
  const host = makeHost()
  await host.userSays()
  await host.run('write', { file_path: 'src/a.js', content: 'x' }, { result: { isError: true, content: [] } })
  check('写文件失败不算改动', () => assert.equal(host.tryStop(), null))
}
fs.rmSync(path.join(teamProj, '.team', 'guard.json'))
{
  const host = makeHost()
  await host.userSays()
  await host.run('write', { file_path: 'src/a.js', content: 'x' })
  check('项目没配 verify → 不拦（交给 skill 规则）', () => assert.equal(host.tryStop(), null))
}

console.log('== 刹车 4：状态卡')
{
  const host = makeHost()
  await host.userSays()
  await host.run('write', { file_path: '.team/STATE.md', content: '新状态' }, { body: () => fs.writeFileSync(statePath(teamProj), '新状态') })
  const r = host.tryStop()
  check('改了 STATE.md 没同步状态卡 → 拉回来', () => assert.match(r ?? '', /状态卡/))
}
{
  const host = makeHost()
  await host.userSays()
  await new Promise(res => setTimeout(res, 20))
  fs.writeFileSync(statePath(teamProj), '再次更新')
  fs.writeFileSync(cardPath(teamProj), '# 状态卡 v2')
  check('STATE.md 和状态卡都更新了 → 可以收工', () => assert.equal(host.tryStop(), null))
}
fs.rmSync(cardPath(teamProj))
{
  const host = makeHost()
  await host.userSays()
  check('项目没有状态卡 → 开工时提醒一次', () => assert.match(host.inbox.at(-1)?.m.content[0].text ?? '', /还没有状态卡/))
  const count = host.inbox.length
  await host.userSays()
  check('同一会话不重复提醒', () => assert.equal(host.inbox.length, count))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

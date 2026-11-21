// 离线测试：用假的 ctx 模拟 DHS 的 agent 循环和工具流水线，不需要启动 DHS。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, decideGuard, decideCommit, decideSpawn, memberBudget, stepNoticeAt, needsRotation, authPath, cardPath, statePath, commandSucceeded, codeTouched, isDoneReport, advancedBetween, isReviewRequest, deliverablesTouched, touchesState, MAX_STOP_REMINDERS, DEFAULT_STEP_NOTICE } from '../lib/guard.js'

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
fs.writeFileSync(path.join(teamProj, '.team', 'pause'), '')
check('用户暂停（.team/pause）→ 任何工具都拦下', () => {
  for (const [name, args] of [['read', { file_path: 'README.md' }], ['bash', { command: 'npm test' }], ['subagent', { name: 'x' }], ['send_message', { agent: 'x', message: 'y' }]]) {
    const r = decideGuard(name, args, teamProj)
    denies(r); assert.match(r, /暂停/)
  }
})
check('暂停不影响别的项目', () => passes(decideGuard('bash', { command: 'npm test' }, plainProj)))
fs.rmSync(path.join(teamProj, '.team', 'pause'))
check('删掉 pause 就恢复', () => passes(decideGuard('bash', { command: 'npm test' }, teamProj)))

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
  const sessions = new Set([session])
  const makeAgent = s => ({ session: s, inbox: { append: (target, m) => inbox.push({ target, m }) } })
  const agent = makeAgent(session)
  /** A second conversation (e.g. the next milestone's lead) in the same running plugin. */
  const newAgent = () => { const s = {}; sessions.add(s); return makeAgent(s) }
  apply({
    on: (ev, fn) => { handlers[ev] = fn },
    tools: { guard: g => { guards.push(g); return () => {} } },
    workingDirectory: { get: s => (sessions.has(s) ? teamProj : null) },
    get: name => (name === 'approval' ? { overrideOf: () => policy } : undefined),
  })
  let n = 0
  const popups = []
  async function userSays() {
    await handlers['agent/pre-step']({ agent, messages: [{ source: { kind: 'user' } }] }, async () => ({}))
  }
  async function run(name, args, { body = () => {}, result = ok(), as = agent } = {}) {
    const exec = { callId: `c${++n}`, name, arguments: args, agent: as }
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
  async function step() {
    await handlers['agent/pre-step']({ agent, messages: [] }, async () => ({}))
  }
  return { run, userSays, step, tryStop, popups, inbox, newAgent }
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
{
  const saved = fs.readFileSync(statePath(teamProj))
  fs.rmSync(statePath(teamProj))
  const host = makeHost()
  await host.userSays()
  check('有 .team/ 没有 STATE.md → 提醒一次（界面靠它）', () => assert.ok(host.inbox.some(entry => /还没有 \.team\/STATE\.md/.test(entry.m.content[0].text))))
  const count = host.inbox.length
  await host.userSays()
  check('缺 STATE.md 同一会话不重复提醒', () => assert.equal(host.inbox.length, count))
  fs.writeFileSync(statePath(teamProj), saved)
}

console.log('== 刹车 4b：STATE.md 文件头')
fs.writeFileSync(cardPath(teamProj), '# 状态卡')
{
  const host = makeHost()
  await host.userSays()
  await host.run('write', { file_path: '.team/STATE.md', content: 'x' }, { body: () => {
    fs.writeFileSync(statePath(teamProj), '---\nstage: build\nmilestone: M1\nupdated: 2026-11-17T08:00+08:00\nwaiting:\n  - accept: 看一下 PROJECT.md 前五节\n---\n')
    fs.writeFileSync(cardPath(teamProj), '# 状态卡 v3')
  } })
  const r = host.tryStop()
  check('等你的事写了文件名 → 拉回来改成大白话', () => assert.match(r ?? '', /看不懂/))
}
{
  const host = makeHost()
  await host.userSays()
  await host.run('write', { file_path: '.team/STATE.md', content: 'x' }, { body: () => {
    fs.writeFileSync(statePath(teamProj), '---\nstage: build\nmilestone: M1\nupdated: 2026-11-17T08:00+08:00\nwaiting:\n  - accept: 打开网页试一遍记账流程\n---\n')
    fs.writeFileSync(cardPath(teamProj), '# 状态卡 v4')
  } })
  check('文件头正确、大白话 → 可以收工', () => assert.equal(host.tryStop(), null))
}

console.log('== 刹车 5：成员预算')
check('默认预算 3', () => assert.equal(memberBudget(teamProj), 3))
fs.writeFileSync(path.join(teamProj, '.team', 'guard.json'), JSON.stringify({ size: 'small' }))
check('小项目预算 1', () => assert.equal(memberBudget(teamProj), 1))
check('没到预算不干预', () => passes(decideSpawn('subagent', teamProj, 'ask', 0)))
check('到了预算 → 弹窗', () => kindIs(decideSpawn('subagent', teamProj, 'ask', 1), 'ask'))
check('fork 也算', () => kindIs(decideSpawn('subagent_fork', teamProj, 'ask', 1), 'ask'))
check('到了预算且从不询问 → 拒绝并说明', () => { const r = decideSpawn('subagent', teamProj, 'never', 1); kindIs(r, 'deny'); assert.match(r.reason, /members/) })
check('非 crew 项目不管', () => passes(decideSpawn('subagent', plainProj, 'ask', 9)))
check('别的工具不管', () => passes(decideSpawn('bash', teamProj, 'ask', 9)))
fs.writeFileSync(path.join(teamProj, '.team', 'guard.json'), JSON.stringify({ size: 'small', members: 5 }))
check('members 不能把上限调高（agent 自己能改这个文件）', () => assert.equal(memberBudget(teamProj), 1))
fs.writeFileSync(path.join(teamProj, '.team', 'guard.json'), JSON.stringify({ size: 'medium', members: 2 }))
check('members 可以把上限调低', () => assert.equal(memberBudget(teamProj), 2))
{
  const host = makeHost()
  await host.userSays()
  await host.run('subagent', { name: 'reviewer', prompt: 'x' })
  await host.run('subagent', { name: 'builder', prompt: 'x' })
  check('预算内派两个不弹窗', () => assert.equal(host.popups.length, 0))
  await host.run('subagent', { name: 'qa', prompt: 'x' })
  check('第三个弹窗', () => assert.equal(host.popups.length, 1))
  const next = host.newAgent()
  await host.run('subagent', { name: 'docs', prompt: 'x' }, { as: next })
  check('换会话不清零（同一里程碑）', () => assert.equal(host.popups.length, 2))
  fs.writeFileSync(statePath(teamProj), '---\nstage: build\nmilestone: M2\nupdated: 2026-11-17T08:00+08:00\nwaiting: []\n---\n')
  await host.run('subagent', { name: 'builder-2', prompt: 'x' }, { as: next })
  check('换里程碑重新计数', () => assert.equal(host.popups.length, 2))
}

console.log('== 刹车 5b：里程碑换会话提醒')
fs.writeFileSync(path.join(teamProj, '.team', 'guard.json'), JSON.stringify({ size: 'large' }))
check('大项目 M0→M1 → 该换会话', () => assert.equal(needsRotation(teamProj, 'M0', 'M1'), true))
check('还没到里程碑（none）→ 不提醒', () => assert.equal(needsRotation(teamProj, 'none', 'M0'), false))
check('同一个里程碑 → 不提醒', () => assert.equal(needsRotation(teamProj, 'M1', 'M1'), false))
fs.writeFileSync(path.join(teamProj, '.team', 'guard.json'), JSON.stringify({ size: 'small' }))
check('小项目 → 不提醒', () => assert.equal(needsRotation(teamProj, 'M0', 'M1'), false))
fs.writeFileSync(path.join(teamProj, '.team', 'guard.json'), JSON.stringify({ size: 'large' }))
{
  const header = m => `---\nstage: build\nmilestone: ${m}\nupdated: 2026-11-17T08:00+08:00\nwaiting: []\n---\n`
  fs.writeFileSync(statePath(teamProj), header('M0'))
  fs.writeFileSync(cardPath(teamProj), '# 状态卡 r0')
  const host = makeHost()
  await host.userSays()
  await host.run('write', { file_path: '.team/STATE.md', content: 'x' }, { body: () => {
    fs.writeFileSync(statePath(teamProj), header('M1'))
    fs.writeFileSync(cardPath(teamProj), '# 状态卡 r1')
  } })
  check('Lead 在这段对话里把 M0 改成 M1 → 收工时提醒换会话', () => assert.match(host.tryStop() ?? '', /换一个新会话/))
  await host.userSays()
  await host.run('write', { file_path: '.team/STATE.md', content: 'x' }, { body: () => {
    fs.writeFileSync(statePath(teamProj), header('M1').replace('build', 'deliver'))
    fs.writeFileSync(cardPath(teamProj), '# 状态卡 r2')
  } })
  check('同一会话只提醒一次', () => assert.equal(host.tryStop(), null))
  const member = makeHost()
  fs.writeFileSync(statePath(teamProj), header('M0'))
  await member.userSays()
  fs.writeFileSync(statePath(teamProj), header('M1'))
  check('没改 STATE.md 的成员 → 不提醒', () => assert.equal(member.tryStop(), null))
}

console.log('== 刹车 6：步数提醒')
check(`默认第 ${DEFAULT_STEP_NOTICE} 步提醒`, () => assert.equal(stepNoticeAt(teamProj, DEFAULT_STEP_NOTICE), 'soft'))
check('两倍时强提醒', () => assert.equal(stepNoticeAt(teamProj, DEFAULT_STEP_NOTICE * 2), 'strong'))
check('其他步数不提醒', () => assert.equal(stepNoticeAt(teamProj, 61), null))
{
  const host = makeHost()
  await host.userSays()
  const before = host.inbox.length
  // The step that reads the user's message is step 1.
  for (let i = 2; i < DEFAULT_STEP_NOTICE; i++) await host.step()
  check('走满之前不提醒', () => assert.equal(host.inbox.length, before))
  await host.step()
  check('走满提醒一次', () => { assert.equal(host.inbox.length, before + 1); assert.match(host.inbox.at(-1).m.content[0].text, /60 步/) })
  // A member reused task after task: each hand-over starts a new turn, but the conversation keeps growing.
  for (let task = 0; task < 3; task++) {
    await host.userSays()
    for (let i = 0; i < 20; i++) await host.step()
  }
  check('换了几轮也累计：到 120 步强提醒换人（实测 11-17 成员复用到 117 步、30 万上下文）', () => assert.match(host.inbox.at(-1).m.content[0].text, /120 步[\s\S]*换新成员/))
}
check('之后每满 60 步再强提醒', () => assert.equal(stepNoticeAt(teamProj, DEFAULT_STEP_NOTICE * 3), 'strong'))
fs.writeFileSync(path.join(teamProj, '.team', 'guard.json'), JSON.stringify({ steps: 0 }))
check('steps: 0 关掉提醒', () => assert.equal(stepNoticeAt(teamProj, DEFAULT_STEP_NOTICE), null))

console.log('== 刹车 7：代码地图跟着代码走')
{
  const mapFile = path.join(teamProj, '.team', 'map.md')
  const src = path.join(teamProj, 'src')
  fs.mkdirSync(src, { recursive: true })
  const done = { agent: 'lead', message: '[任务 task-1] 完成\n结果：能记账了\n偏离：无' }
  const host = makeHost()
  await host.userSays()
  await host.run('write', { file_path: 'src/new.js', content: 'x' }, { body: () => fs.writeFileSync(path.join(src, 'new.js'), 'x') })
  const r1 = await host.run('send_message', done)
  check('新建代码文件、还没有地图 → 完成回报发不出去', () => { assert.equal(r1.stage, 'guard'); assert.match(r1.reason, /代码地图/) })
  check('收工前也拉回来', () => assert.match(host.tryStop() ?? '', /还没有代码地图/))
  fs.writeFileSync(mapFile, '模块 · 目录 · 职责\n记账 · src/ · 记一笔\n\nsrc/old.js | 负责：旧 | 一起看：无 | 被依赖：无 | 别改错：无\n')
  const r2 = await host.run('send_message', done)
  check('地图里没有新文件那一行 → 仍然拦下', () => { assert.equal(r2.stage, 'guard'); assert.match(r2.reason, /src\/new\.js 没有自己那一行/) })
  fs.appendFileSync(mapFile, 'src/new.js | 负责：记一笔 | 一起看：无 | 被依赖：addEntry | 别改错：金额用分存\n')
  const r3 = await host.run('send_message', done)
  check('补上那一行 → 回报放行', () => assert.equal(r3.stage, 'post'))
  check('测试文件不进地图', () => assert.deepEqual(codeTouched('write', { file_path: 'src/new.test.js' }, teamProj), []))
  check('只有"完成"回报才查地图', () => { assert.equal(isDoneReport('send_message', { message: '[任务 task-2] 阻塞\n结果：缺接口' }), false); assert.equal(isDoneReport('send_message', done), true) })

  const del = makeHost()
  await del.userSays()
  fs.writeFileSync(path.join(src, 'old.js'), 'x')
  await del.run('apply_patch', { patch: '*** Begin Patch\n*** Delete File: src/old.js\n*** End Patch' }, { body: () => fs.rmSync(path.join(src, 'old.js')) })
  check('删了文件、地图那一行还在 → 拉回来删掉', () => assert.match(del.tryStop() ?? '', /src\/old\.js 已经删掉了/))
  fs.writeFileSync(mapFile, fs.readFileSync(mapFile, 'utf8').replace(/src\/old\.js.*\n/, ''))
  check('删掉那一行 → 可以收工', () => assert.equal(del.tryStop(), null))

  const soft = makeHost()
  await soft.userSays()
  await soft.run('edit', { file_path: 'src/new.js', old_string: 'x', new_string: 'y' }, { body: () => fs.writeFileSync(path.join(src, 'new.js'), 'y') })
  check('改了已有文件、没动地图 → 提醒确认那一行', () => assert.match(soft.tryStop() ?? '', /没动过代码地图/))
  check('这条提醒每轮只一次', () => assert.equal(soft.tryStop(), null))
}

console.log('== 刹车 8：里程碑推进后先清旧东西')
{
  const header = m => `---\nstage: build\nmilestone: ${m}\nupdated: 2026-11-17T08:00+08:00\nwaiting: []\n---\n`
  fs.writeFileSync(statePath(teamProj), header('M1'))
  const reviews = path.join(teamProj, '.team', 'reviews')
  fs.mkdirSync(reviews, { recursive: true })
  fs.writeFileSync(path.join(reviews, 'm1.md'), '评审')
  check('里程碑中途：过程文件不算问题', () => assert.equal(advancedBetween({ stage: 'build', milestone: 'M1' }, { stage: 'build', milestone: 'M1' }), null))
  check('进入交付也算推进', () => assert.deepEqual(advancedBetween({ stage: 'build', milestone: 'M2' }, { stage: 'deliver', milestone: 'M2' }), { from: 'M2', to: '交付' }))
  const host = makeHost()
  await host.userSays()
  await host.run('write', { file_path: '.team/STATE.md', content: 'x' }, { body: () => {
    fs.writeFileSync(statePath(teamProj), header('M2'))
    fs.writeFileSync(cardPath(teamProj), '# 状态卡 M2')
  } })
  const r = host.tryStop()
  check('推进到 M2、过程文件还在 → 拉回来清', () => assert.match(r ?? '', /从 M1 推进到了 M2[\s\S]*\.team\/reviews/))
  const s1 = await host.run('subagent', { name: 'builder-api' })
  check('清干净之前不让派新成员', () => { assert.equal(s1.stage, 'pre'); assert.equal(s1.decision.kind, 'deny'); assert.match(s1.decision.reason, /清完之前不能/) })
  fs.rmSync(reviews, { recursive: true })
  const s2 = await host.run('subagent', { name: 'builder-api' })
  check('清掉之后可以派人', () => assert.equal(s2.stage, 'post'))
}

console.log('== 刹车 9：改后复审（11-20 小说项目：改稿后没复审就交付）')
{
  const header = s => `---\nstage: ${s}\nmilestone: M2\nupdated: 2026-11-20T05:00-08:00\nwaiting: []\n---\n`
  fs.writeFileSync(statePath(teamProj), header('build'))
  fs.mkdirSync(path.join(teamProj, 'manuscript'), { recursive: true })
  const chapter = { file_path: 'manuscript/ch001.md', content: '正文' }
  const report = { agent: 'lead', message: '[任务 review-chapters] 完成\n结果：要改 5 条\n偏离：无' }
  const toDeliver = { file_path: '.team/STATE.md', content: 'x' }
  const deliverBody = () => { fs.writeFileSync(statePath(teamProj), header('deliver')); fs.writeFileSync(cardPath(teamProj), `# 卡 ${Math.random()}`) }

  check('派评审类成员、给评审员发消息算请复审', () => {
    assert.equal(isReviewRequest('subagent', { name: 'review-final' }), true)
    assert.equal(isReviewRequest('subagent', { name: 'x', description: '定向复核本轮改稿' }), true)
    assert.equal(isReviewRequest('send_message', { agent: 'review-chapters', message: '请复核 R1–R5' }), true)
    assert.equal(isReviewRequest('subagent', { name: 'builder-api' }), false)
    assert.equal(isReviewRequest('send_message', { agent: 'lead', message: '[任务 t] 完成' }), false)
  })
  check('过程文件、状态卡、PROJECT.md、交付报告不算交付物', () => {
    for (const f of ['.team/STATE.md', 'AGENTS.local.md', 'PROJECT.md', 'docs/delivery.md']) assert.deepEqual(deliverablesTouched('write', { file_path: f }, teamProj), [], f)
    assert.deepEqual(deliverablesTouched('write', chapter, teamProj), [teamProj])
  })

  const lead = makeHost()
  const reviewer = lead.newAgent()
  await lead.userSays()
  await lead.run('write', chapter)
  const p0 = await lead.run('present', { files: [{ path: 'manuscript/ch001.md' }] })
  check('写完从没评审过 → 不能展示交付物', () => { assert.equal(p0.stage, 'guard'); assert.match(p0.reason, /还没有人复审/) })
  await lead.run('subagent', { name: 'review-chapters' })
  await lead.run('send_message', report, { as: reviewer })
  const p1 = await lead.run('present', { files: [] })
  check('评审回报回来、之后没改 → 可以展示', () => assert.equal(p1.stage, 'post'))
  await lead.run('write', chapter)
  const p2 = await lead.run('present', { files: [] })
  check('按评审意见改了正文 → 又拦下', () => { assert.equal(p2.stage, 'guard'); assert.match(p2.reason, /send_message 给原来的评审员/) })
  await lead.run('write', toDeliver, { body: deliverBody })
  check('改完直接把阶段推到交付 → 收工前拉回来', () => assert.match(lead.tryStop() ?? '', /还没有人复审/))
  await lead.run('send_message', { agent: 'review-chapters', message: '请定向复核 R1–R5' })
  await lead.run('write', chapter)
  await lead.run('send_message', report, { as: reviewer })
  const p3 = await lead.run('present', { files: [] })
  check('请复审之后又改了一遍 → 复审只算请求那一刻的稿子，仍拦', () => assert.equal(p3.stage, 'guard'))
  await lead.run('send_message', { agent: 'review-chapters', message: '再看一次' })
  const builder = lead.newAgent()
  await lead.run('write', { file_path: 'manuscript/ch002.md', content: 'x' }, { as: builder })
  await lead.run('send_message', { agent: 'lead', message: '[任务 task-3] 完成\n结果：写完第二章\n偏离：无' }, { as: builder })
  const p4 = await lead.run('present', { files: [] })
  check('改了交付物的成员发回报不算复审', () => assert.equal(p4.stage, 'guard'))
  await lead.run('send_message', { agent: 'review-chapters', message: '第二章也看' })
  await lead.run('send_message', report, { as: reviewer })
  const p5 = await lead.run('present', { files: [] })
  check('复核回来 → 放行', () => assert.equal(p5.stage, 'post'))
  await lead.run('write', chapter)
  await lead.run('send_message', { agent: 'reviewer-m4', message: '请复核 N1–N8' })
  await lead.run('send_message', { agent: 'lead', message: '结果：还要改 1 处（N1）\n结论：可以交' }, { as: reviewer })
  const p6 = await lead.run('present', { files: [] })
  check('回报没有"[任务 …] 完成"首行、直接从"结果："开头 → 也算复核回来（11-20 实测）', () => assert.equal(p6.stage, 'post'))
  await lead.run('write', { file_path: 'docs/era-facts.md', content: 'x' })
  await lead.run('send_message', { agent: 'reviewer-m4', message: '请确认这 3 行' })
  await lead.run('send_message', { agent: 'builder-x', message: '去改第四章' })
  const p7 = await lead.run('present', { files: [] })
  check('请评审的 Lead 自己给别人发消息 → 不算复核回来', () => assert.equal(p7.stage, 'guard'))
  await lead.run('send_message', { agent: 'lead', message: '可以交：三行文档已确认改准' }, { as: reviewer })
  const p8 = await lead.run('present', { files: [] })
  check('回报只写"可以交：…" → 也算复核回来（11-20 实测）', () => assert.equal(p8.stage, 'post'))
  fs.writeFileSync(statePath(teamProj), header('build'))
}

console.log('== 刹车 10：从不询问时开工提醒')
{
  const host = makeHost({ policy: 'never' })
  await host.userSays()
  const notes = host.inbox.filter(x => /从不询问/.test(x.m.content[0].text))
  check('第一次开工提醒一次', () => { assert.equal(notes.length, 1); assert.match(notes[0].m.content[0].text, /git 提交、超出预算派成员都会被直接拒绝/) })
  await host.step()
  check('同一会话不重复提醒', () => assert.equal(host.inbox.filter(x => /从不询问/.test(x.m.content[0].text)).length, 1))
  const asking = makeHost({ policy: 'ask' })
  await asking.userSays()
  check('会询问的模式不提醒', () => assert.equal(asking.inbox.filter(x => /审批策略是"从不询问"/.test(x.m.content[0].text)).length, 0))
  check('预算满的拒绝消息指向给原评审员发消息', () => assert.match(decideSpawn('subagent', teamProj, 'never', 99).reason, /send_message 给原来的评审员/))
}

console.log('== 只读命令提到 STATE.md 不算改（11-21 实测误拦评审员）')
check('Get-Content .team/STATE.md → 不算改', () => assert.equal(touchesState('pwsh', { command: '(Get-Content .team/STATE.md).Count' }, teamProj), false))
check('cat STATE.md → 不算改', () => assert.equal(touchesState('bash', { command: 'cat .team/STATE.md | head' }, teamProj), false))
check('Set-Content 写 STATE.md → 算改', () => assert.equal(touchesState('pwsh', { command: 'Set-Content .team/STATE.md "x"' }, teamProj), true))
check('重定向写 STATE.md → 算改', () => assert.equal(touchesState('bash', { command: 'echo x > .team/STATE.md' }, teamProj), true))
check('doc-check --confirm → 算改', () => assert.equal(touchesState('bash', { command: 'node doc-check.mjs --confirm .' }, teamProj), true))

console.log('== 刹车 11：成功标准逐条打勾')
check('replace_all 一次全打勾 → 拒绝', () => denies(decideGuard('edit', { file_path: 'PROJECT.md', old_string: '- [ ] ', new_string: '- [x] ', replace_all: true }, teamProj)))
check('逐条打勾 → 放行', () => passes(decideGuard('edit', { file_path: 'PROJECT.md', old_string: '- [ ] 书名定稿', new_string: '- [x] 书名定稿' }, teamProj)))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)

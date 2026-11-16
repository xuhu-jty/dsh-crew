// project-team-guard：project-team 的硬刹车。只在带 .team/ 目录的项目里生效，其他项目完全不受影响。
//
// 刹车 1 提交审批：git commit / git push 需要用户批准。
//   - 用户本人创建的 .team/commit-authorized 存在 → 放行（里程碑验收后的整批授权）。
//   - 否则弹 DHS 审批窗；同一轮对话里批准过一次，重试同一项目的提交不再重复弹窗。
//   - 审批策略为"从不询问"时没法弹窗 → 直接拒绝并说明解决办法。
// 刹车 2 授权文件只能用户本人创建：
//   - 事前：写文件工具或命令里出现这个文件名 → 拒绝。
//   - 事后：每次工具调用结束，比对授权文件指纹；这次调用期间出现或改动 → 判定伪造，删除并拦下。
// 刹车 3 收工前验证：这一轮用文件工具改过项目文件、之后没有跑通 verify，就不让这一轮结束，
//   把 agent 拉回来先验证（每轮最多拉 2 次，防止死循环）。verify 命令写在 .team/guard.json。
// 刹车 4 状态卡：项目根的 AGENTS.local.md 是 DHS 自动注入（含压缩后重新注入）的"状态卡"。
//   - 这一轮改了 .team/STATE.md 却没同步状态卡 → 收工前提醒一次。
//   - 项目还没有状态卡 → 本会话提醒一次。
//
// 只依赖 Node 内置模块，不 import 任何 @deepseek-ai 包，降低 DHS 升级时的破坏面。

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'project-team-guard'
export const inject = ['tools', 'workingDirectory']

export const AUTH_FILE = 'commit-authorized'
export const CARD_FILE = 'AGENTS.local.md'
export const MAX_STOP_REMINDERS = 2

const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const TERMINAL_TOOLS = new Set(['terminal_send'])
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const PATCH_TOOLS = new Set(['apply_patch'])

// git [全局选项...] commit|push ；不拦 git log / git status 等只读命令。
const GIT_WRITE_RE = /(^|[\s;&|(`'"])git(\s+-\S+(\s+(?!commit\b|push\b)[^\s;&|-]\S*)?)*\s+(commit|push)\b/i
const AUTH_MENTION_RE = /commit-authorized/i

// ---------- 路径与文件 ----------

/** 从 dir 向上找含 .team 目录的项目根；找不到返回 null。 */
export function findTeamRoot(dir) {
  let cur = path.resolve(dir)
  for (;;) {
    try {
      if (fs.statSync(path.join(cur, '.team')).isDirectory()) return cur
    } catch { /* 不存在就继续向上 */ }
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

export const authPath = root => path.join(root, '.team', AUTH_FILE)
export const statePath = root => path.join(root, '.team', 'STATE.md')
export const cardPath = root => path.join(root, CARD_FILE)
export const isAuthorized = root => fs.existsSync(authPath(root))

/** 文件指纹：不存在为 null，存在为 修改时间:大小。 */
export function fingerprint(file) {
  try {
    const st = fs.statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return null
  }
}

/** 读 .team/guard.json；不存在或坏了返回 {}。 */
export function readGuardConfig(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.team', 'guard.json'), 'utf8'))
    return cfg && typeof cfg === 'object' ? cfg : {}
  } catch {
    return {}
  }
}

// ---------- 解析工具调用 ----------

function commandOf(toolName, args) {
  if (!args || typeof args !== 'object') return ''
  if (SHELL_TOOLS.has(toolName)) return typeof args.command === 'string' ? args.command : ''
  if (TERMINAL_TOOLS.has(toolName)) return typeof args.text === 'string' ? args.text : ''
  return ''
}

function writeTarget(toolName, args, cwd) {
  if (!WRITE_TOOLS.has(toolName) || !args || typeof args !== 'object') return null
  const p = args.file_path ?? args.path
  return typeof p === 'string' && p.length > 0 ? path.resolve(cwd, p) : null
}

function workdirOf(args, cwd) {
  return args && typeof args === 'object' && typeof args.workdir === 'string' ? path.resolve(cwd, args.workdir) : cwd
}

/** 这次调用可能影响的 project-team 项目根（命令的工作目录、写文件的目标）。 */
export function rootsTouched(toolName, args, cwd) {
  const roots = new Set()
  const r1 = findTeamRoot(workdirOf(args, cwd))
  if (r1) roots.add(r1)
  const target = writeTarget(toolName, args, cwd)
  if (target) {
    const r2 = findTeamRoot(path.dirname(target))
    if (r2) roots.add(r2)
  }
  return [...roots]
}

/** 用文件工具改动了哪个项目的文件（.team/ 下的过程文件和状态卡不算"代码改动"）。 */
export function editedRoot(toolName, args, cwd) {
  if (PATCH_TOOLS.has(toolName)) return findTeamRoot(cwd)
  const target = writeTarget(toolName, args, cwd)
  if (!target) return null
  const root = findTeamRoot(path.dirname(target))
  if (!root) return null
  const rel = path.relative(root, target)
  if (rel === CARD_FILE || rel.split(path.sep)[0] === '.team') return null
  if (/\.(md|markdown|txt)$/i.test(rel)) return null  // 纯文档改动不要求重跑验证
  return root
}

/** 这条命令是不是该项目配置的 verify 命令。 */
export function isVerifyCommand(toolName, args, cwd) {
  const cmd = commandOf(toolName, args)
  if (!cmd) return null
  const root = findTeamRoot(workdirOf(args, cwd))
  if (!root) return null
  const verify = readGuardConfig(root).verify
  return typeof verify === 'string' && verify.length > 0 && cmd.includes(verify) ? root : null
}

/** 命令是否成功：工具未报错，且退出码为 0（或没有退出码信息也没有非零标记）。 */
export function commandSucceeded(result) {
  if (!result || result.isError) return false
  const code = result.value && typeof result.value === 'object' ? result.value.exitCode : undefined
  if (typeof code === 'number') return code === 0
  const text = (result.content || []).map(b => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
  return !/\[exit code: [1-9]\d*\]/.test(text)
}

// ---------- 给模型看的话 ----------

export const MSG = {
  authWrite: [
    '[project-team 刹车] 不允许 agent 创建或修改提交授权文件 .team/commit-authorized。',
    '这个文件只能由用户本人创建。需要提交时直接执行 git commit，会弹窗请用户批准。',
  ].join('\n'),
  forged: [
    '[project-team 刹车] 检测到这次操作创建或改动了 .team/commit-authorized，已判定为 agent 伪造授权并删除。',
    '不要再尝试以任何方式生成这个文件。需要提交时直接执行 git commit，会弹窗请用户批准；',
    '把这次发生的事如实告诉用户。（如果确实是用户刚好在这时手动创建的，请用户重新创建一次。）',
  ].join('\n'),
  neverPolicy: [
    '[project-team 刹车] 提交需要用户批准，但当前会话的审批策略是"从不询问"，无法弹窗，提交已拒绝。',
    '现在该做的：停下提交，告诉用户做完了什么、证据在哪，并请用户二选一：',
    '① 在 DHS 权限设置里切换到会询问的模式，再让你提交（会弹窗确认）；② 用户本人创建 .team/commit-authorized。',
    '不要尝试绕过。',
  ].join('\n'),
  askReason: 'project-team：git 提交/推送需要用户批准（项目没有整批提交授权 .team/commit-authorized）',
  askDisplay: {
    en: 'project-team: this git commit/push needs your approval.',
    zh: 'project-team：agent 想执行 git 提交/推送，需要你批准。',
  },
  verifyMissing: (root, verify) => [
    `[project-team 刹车] 这一轮你改动了 ${root} 里的文件，但改动之后还没有跑通验证命令（${verify}）。`,
    '先运行它并看结果：通过了再收尾；不通过就修，修不了就把失败输出如实报告给用户。',
    '不要把"没跑"写成"通过"。',
  ].join('\n'),
  cardStale: root => [
    `[project-team 刹车] 这一轮 ${root}/.team/STATE.md 改了，但状态卡 ${CARD_FILE} 没跟着更新。`,
    '状态卡会在每次开工和上下文压缩后自动注入给所有 agent；它过期，下一个接手的人就会按旧状态干活。',
    '请把当前阶段、已拍板的事、授权与禁止、下一步同步到状态卡（保持 40 行以内），再收尾。',
  ].join('\n'),
  cardMissing: root => [
    `[project-team 提醒] 项目 ${root} 还没有状态卡 ${CARD_FILE}。`,
    '按 project-team skill 的 templates/state-card.md 建一张：它会在开工和压缩后自动注入，防止忘掉已拍板的事。',
  ].join('\n'),
}

// ---------- 纯判断（便于离线测试） ----------

/** 事前判断（守卫用）：授权文件的写入保护。返回拒绝理由或 undefined。 */
export function decideGuard(toolName, args, cwd) {
  const target = writeTarget(toolName, args, cwd)
  if (target && AUTH_MENTION_RE.test(target) && findTeamRoot(path.dirname(target))) return MSG.authWrite
  const cmd = commandOf(toolName, args)
  if (cmd && AUTH_MENTION_RE.test(cmd) && findTeamRoot(workdirOf(args, cwd))) return MSG.authWrite
  return undefined
}

/** 项目根是不是 git worktree（.git 是文件而不是目录）：成员在自己分支上的内部提交。 */
export function isLinkedWorktree(root) {
  try { return fs.statSync(path.join(root, ".git")).isFile() } catch { return false }
}

/**
 * 这次调用是不是需要审批的 git 提交/推送；是则返回项目根。
 * worktree 里的 commit 是成员在自己分支上的内部提交，不需要审批；push 一律需要。
 */
export function gitWriteRoot(toolName, args, cwd) {
  const cmd = commandOf(toolName, args)
  const m = cmd && cmd.match(new RegExp(GIT_WRITE_RE.source, 'gi'))
  if (!m) return null
  const root = findTeamRoot(workdirOf(args, cwd))
  if (!root) return null
  const hasPush = m.some(s => /push$/i.test(s))  // 每段匹配都以 commit 或 push 结尾
  if (!hasPush && isLinkedWorktree(root)) return null
  return root
}

/**
 * 提交审批（pre-execute 用）。
 * @param policy 当前会话审批策略：'ask' | 'never' | undefined
 * @param approvedRoots 本轮已经批准过的项目根
 * @returns 要覆盖的决定，或 undefined 表示不干预
 */
export function decideCommit(toolName, args, cwd, policy, approvedRoots = new Set()) {
  const root = gitWriteRoot(toolName, args, cwd)
  if (!root || isAuthorized(root) || approvedRoots.has(root)) return undefined
  if (policy === 'never') return { kind: 'deny', reason: MSG.neverPolicy }
  return { kind: 'ask', reason: MSG.askReason, displayReason: MSG.askDisplay }
}

/**
 * 收工前检查：返回要塞回给 agent 的提醒文字列表（空表示可以收工）。
 * @param turn 本轮记录：{ dirty: Set<root>, stateBefore: Map<root, fp>, cardBefore: Map<root, fp> }
 */
export function stopReminders(turn) {
  const out = []
  for (const root of turn.dirty) {
    const verify = readGuardConfig(root).verify
    if (typeof verify === 'string' && verify.length > 0) out.push(MSG.verifyMissing(root, verify))
  }
  for (const [root, before] of turn.stateBefore) {
    const stateChanged = fingerprint(statePath(root)) !== before
    const cardChanged = fingerprint(cardPath(root)) !== turn.cardBefore.get(root)
    if (stateChanged && !cardChanged && fs.existsSync(cardPath(root))) out.push(MSG.cardStale(root))
  }
  return out
}

// ---------- 接入 DHS ----------

function makeNotice(text, summary) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'project-team-guard', form: 'notice', summary },
  })
}

function approvalPolicy(ctx, session) {
  try {
    const approval = ctx.get?.('approval') ?? ctx.approval
    if (!approval) return undefined
    return approval.overrideOf?.(session) ?? approval.config?.policy
  } catch {
    return undefined
  }
}

function cwdOfAgent(ctx, agent) {
  if (!agent) return null
  try {
    const cwd = ctx.workingDirectory.get(agent.session)
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
  } catch {
    return null
  }
}

export function apply(ctx) {
  const authBefore = new Map()       // callId → [[root, fp]]：授权文件事后比对
  const askedCalls = new Map()       // callId → root：本次提交走了审批弹窗
  const turns = new WeakMap()        // agent → 本轮记录
  const cardNoticed = new WeakMap()  // agent → Set<root>：已提醒过缺状态卡

  function turnOf(agent) {
    let t = turns.get(agent)
    if (!t) {
      t = { approved: new Set(), dirty: new Set(), stateBefore: new Map(), cardBefore: new Map(), reminders: 0 }
      turns.set(agent, t)
    }
    return t
  }

  function trackState(t, root) {
    if (t.stateBefore.has(root)) return
    t.stateBefore.set(root, fingerprint(statePath(root)))
    t.cardBefore.set(root, fingerprint(cardPath(root)))
  }

  // 新的用户消息 = 新的一轮：清空本轮记录；顺带提醒缺状态卡（每会话每项目一次）。
  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent, messages } = payload
    if (messages?.some(m => m?.source?.kind === 'user')) turns.delete(agent)
    const cwd = cwdOfAgent(ctx, agent)
    const root = cwd && findTeamRoot(cwd)
    if (root) {
      trackState(turnOf(agent), root)
      let seen = cardNoticed.get(agent)
      if (!seen) cardNoticed.set(agent, (seen = new Set()))
      if (!seen.has(root) && !fs.existsSync(cardPath(root))) {
        seen.add(root)
        try { agent.inbox.append('next-step', makeNotice(MSG.cardMissing(root), '缺少状态卡')) } catch { /* 提醒失败不影响工作 */ }
      }
    }
    return next()
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const cwd = cwdOfAgent(ctx, exec.agent)
    if (cwd) {
      const roots = rootsTouched(exec.name, exec.arguments, cwd)
      if (roots.length > 0) authBefore.set(exec.callId, roots.map(root => [root, fingerprint(authPath(root))]))
      for (const root of roots) trackState(turnOf(exec.agent), root)
    }
    const downstream = await next()
    if (!cwd || downstream.kind !== 'allow') return downstream
    const decision = decideCommit(exec.name, exec.arguments, cwd, approvalPolicy(ctx, exec.agent.session), turnOf(exec.agent).approved)
    if (decision?.kind === 'ask') askedCalls.set(exec.callId, gitWriteRoot(exec.name, exec.arguments, cwd))
    return decision ?? downstream
  })

  ctx.tools.guard((exec) => {
    const cwd = cwdOfAgent(ctx, exec.agent)
    return cwd ? decideGuard(exec.name, exec.arguments, cwd) : undefined
  })

  // 只有真正放行（含用户在弹窗里点了允许）的调用才会走到这里：记下本轮已批准。
  ctx.on('tools/execute', async (exec, next) => {
    const root = askedCalls.get(exec.callId)
    if (root && exec.agent) {
      askedCalls.delete(exec.callId)
      turnOf(exec.agent).approved.add(root)
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    askedCalls.delete(exec.callId)
    const cwd = cwdOfAgent(ctx, exec.agent)

    // 收工前验证的记账：文件工具改了代码 → 脏；verify 跑通 → 干净。
    if (cwd && exec.agent && result && !result.isError) {
      const t = turnOf(exec.agent)
      const edited = editedRoot(exec.name, exec.arguments, cwd)
      if (edited) t.dirty.add(edited)
      const verified = isVerifyCommand(exec.name, exec.arguments, cwd)
      if (verified && commandSucceeded(result)) t.dirty.delete(verified)
    }

    // 授权文件事后比对。
    const snapshot = authBefore.get(exec.callId)
    if (!snapshot) return downstream
    authBefore.delete(exec.callId)
    const forged = snapshot.filter(([root, fp]) => {
      const now = fingerprint(authPath(root))
      return now !== null && now !== fp
    })
    if (forged.length === 0) return downstream
    for (const [root] of forged) {
      try { fs.rmSync(authPath(root), { force: true }) } catch { /* 删不掉也照样拦下 */ }
    }
    return {
      kind: 'block',
      feedback: [{ type: 'text', text: MSG.forged }],
      ...downstream.additionalContexts ? { additionalContexts: downstream.additionalContexts } : {},
    }
  })

  // 这一轮准备结束：有没跑的验证、过期的状态卡，就把 agent 拉回来。
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const t = turns.get(agent)
    if (!t || t.reminders >= MAX_STOP_REMINDERS) return
    const reminders = stopReminders(t)
    if (reminders.length === 0) return
    t.reminders++
    try {
      agent.inbox.append('next-step', makeNotice(reminders.join('\n\n'), '收工前检查'))
    } catch { /* 塞不进去就放行，不卡死 */ }
  })
}

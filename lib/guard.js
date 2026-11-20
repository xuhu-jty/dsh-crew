// crew-guard：crew 的硬刹车。只在带 .team/ 目录的项目里生效，其他项目完全不受影响。
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
//   - 这一轮改了 .team/STATE.md、文件头写错了或"等你的事"用户看不懂 → 收工前提醒。
//   - 项目还没有状态卡 → 本会话提醒一次。
// 刹车 5 成员预算：每个里程碑最多派几个成员（.team/guard.json 的 members，或按 size 取默认）。
//   超出预算的 subagent / subagent_fork 弹窗请用户批准；"从不询问"时直接拒绝并说明。
// 刹车 6 步数提醒：一轮里走到 steps 步（默认 60）和两倍时，各提醒一次收尾、交接。
//   花费主要来自"在很长的上下文里走很多步"：每一步都要把整个对话重新读一遍。
// 刹车 7 代码地图跟着代码走（.team/map.md，每个代码文件一行）：
//   - 用文件工具新建的代码文件没有那一行、删掉的文件那一行还在 → 成员的"完成"回报发不出去，收工前也拉回来。
//   - 改了已有文件、这一轮没动过地图 → 收工前提醒确认那几行还对。
// 刹车 8 里程碑推进（或交付）后先清旧东西：这一轮把 STATE.md 的里程碑或阶段往前推了，
//   .team 里残留的过程文件、地图对不上的行要清掉；清完之前不让派新成员，收工前也拉回来。
//
// 只依赖 Node 内置模块，不 import 任何 @deepseek-ai 包，降低 DHS 升级时的破坏面。

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerCrewSkill } from './skill.js'
import { checkStateHeader, jargonIn, parseStateHeader } from './state.js'
import { parseReport } from './reports.js'
import { MAP_REL, cleanupProblems, isMappedCode, mapPath, touchedMapProblems } from './freshness.js'

export const name = 'crew-guard'
export const inject = ['tools', 'workingDirectory']

export const AUTH_FILE = 'commit-authorized'
export const CARD_FILE = 'AGENTS.local.md'
export const MAX_STOP_REMINDERS = 2
/** 每个里程碑默认最多几个成员：小项目 Lead 自己做、只派一个独立评审。 */
export const MEMBER_BUDGET = { small: 1, medium: 3, large: 5 }
export const DEFAULT_MEMBERS = 3
export const DEFAULT_STEP_NOTICE = 60
const SPAWN_TOOLS = new Set(['subagent', 'subagent_fork'])

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

/** 这次调用可能影响的 crew 项目根（命令的工作目录、写文件的目标）。 */
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

/**
 * 这次调用用文件工具碰到的代码文件：[[项目根, 相对路径]]。命令行里建、删的文件追不到，
 * 留给里程碑推进时的全量对账。
 */
export function codeTouched(toolName, args, cwd) {
  const targets = []
  const target = writeTarget(toolName, args, cwd)
  if (target) targets.push(target)
  if (PATCH_TOOLS.has(toolName)) {
    const text = typeof args?.patch === 'string' ? args.patch : typeof args?.input === 'string' ? args.input : JSON.stringify(args ?? {})
    for (const m of text.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n\\]+)/g)) targets.push(path.resolve(cwd, m[1].trim()))
    for (const m of text.matchAll(/\*\*\* Move to: ([^\n\\]+)/g)) targets.push(path.resolve(cwd, m[1].trim()))
  }
  const out = []
  for (const abs of targets) {
    const root = findTeamRoot(path.dirname(abs))
    if (!root) continue
    const rel = path.relative(root, abs).split(path.sep).join('/')
    if (isMappedCode(rel)) out.push([root, rel])
  }
  return out
}

/** 一条 send_message 是不是成员的"完成"回报。 */
export function isDoneReport(toolName, args) {
  if (toolName !== 'send_message') return false
  const text = args?.message ?? args?.text ?? args?.content
  return typeof text === 'string' && /^\s*(?:Agent\s+\S+\s+sent a message:\s*)?\[任务[^\]]*\]\s*完成/u.test(text)
}

/** 这次调用是不是这段对话自己改了 .team/STATE.md（文件工具写它，或命令里出现它，例如 doc-check --confirm）。 */
export function touchesState(toolName, args, cwd) {
  const target = writeTarget(toolName, args, cwd)
  if (target) return /[\\/]\.team[\\/]STATE\.md$/i.test(target)
  if (PATCH_TOOLS.has(toolName)) return /\.team[\\/]STATE\.md/i.test(JSON.stringify(args ?? {}))
  return /STATE\.md|doc-check\.mjs\s+--confirm/i.test(commandOf(toolName, args))
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
  paused: root => [
    `[crew 刹车] 用户暂停了项目 ${root}（存在 .team/pause）。现在不做任何操作，也不要派人、发消息给成员。`,
    '这一轮直接结束：用一两句话说明停在哪、手上的活做到哪了。等用户删掉 .team/pause 再继续。',
  ].join('\n'),
  authWrite: [
    '[crew 刹车] 不允许 agent 创建或修改提交授权文件 .team/commit-authorized。',
    '这个文件只能由用户本人创建。需要提交时直接执行 git commit，会弹窗请用户批准。',
  ].join('\n'),
  forged: [
    '[crew 刹车] 检测到这次操作创建或改动了 .team/commit-authorized，已判定为 agent 伪造授权并删除。',
    '不要再尝试以任何方式生成这个文件。需要提交时直接执行 git commit，会弹窗请用户批准；',
    '把这次发生的事如实告诉用户。（如果确实是用户刚好在这时手动创建的，请用户重新创建一次。）',
  ].join('\n'),
  neverPolicy: [
    '[crew 刹车] 提交需要用户批准，但当前会话的审批策略是"从不询问"，无法弹窗，提交已拒绝。',
    '现在该做的：停下提交，告诉用户做完了什么、证据在哪，并请用户二选一：',
    '① 在 DHS 权限设置里切换到会询问的模式，再让你提交（会弹窗确认）；② 用户本人创建 .team/commit-authorized。',
    '不要尝试绕过。',
  ].join('\n'),
  askReason: 'crew：git 提交/推送需要用户批准（项目没有整批提交授权 .team/commit-authorized）',
  askDisplay: {
    en: 'crew: this git commit/push needs your approval.',
    zh: 'crew：agent 想执行 git 提交/推送，需要你批准。',
  },
  verifyMissing: (root, verify) => [
    `[crew 刹车] 这一轮你改动了 ${root} 里的文件，但改动之后还没有跑通验证命令（${verify}）。`,
    '先运行它并看结果：通过了再收尾；不通过就修，修不了就把失败输出如实报告给用户。',
    '不要把"没跑"写成"通过"。',
  ].join('\n'),
  cardStale: root => [
    `[crew 刹车] 这一轮 ${root}/.team/STATE.md 改了，但状态卡 ${CARD_FILE} 没跟着更新。`,
    '状态卡会在每次开工和上下文压缩后自动注入给所有 agent；它过期，下一个接手的人就会按旧状态干活。',
    '请把当前阶段、已拍板的事、授权与禁止、下一步同步到状态卡（保持 40 行以内），再收尾。',
  ].join('\n'),
  headerBad: (root, problems) => [
    `[crew 刹车] 这一轮 ${root}/.team/STATE.md 改了，但文件头有问题（界面靠它显示阶段和"等你的事"）：`,
    ...problems.slice(0, 5).map(p => `- ${p}`),
    '改好再收尾。',
  ].join('\n'),
  memberAskReason: (count, budget) => `crew：要派第 ${count + 1} 个成员，超出这个里程碑的预算（${budget} 个）`,
  memberAskDisplay: (count, budget) => ({
    en: `crew: the lead wants a member beyond this milestone's budget (${count} used, budget ${budget}). Each member re-reads the project and adds cost.`,
    zh: `crew：负责人想再派一个成员，这个里程碑已经用了 ${count} 个（预算 ${budget} 个）。每个成员都要重新读一遍项目，花费会增加。`,
  }),
  memberNever: (count, budget) => [
    `[crew 刹车] 这个里程碑已经派了 ${count} 个成员，到了预算 ${budget} 个；当前审批策略是"从不询问"，没法请用户批准，已拒绝。`,
    '现在该做的：这件事你自己做，或交给已有的成员（send_message 给它）。',
    '不用去查插件代码，规则就这几条：预算按 .team/guard.json 的 size 定（small 1 / medium 3 / large 5），members 只能往下调、往上调无效；',
    '确实需要更多人时，告诉用户原因，请用户二选一：① 切到会询问的权限模式，派人时在弹窗里批准；② 项目确实更大，由用户同意后把 size 改大。',
  ].join('\n'),
  stepNotice: (steps, strong) => [
    `[crew 提醒] 这段对话已经走了 ${steps} 步。每一步都要把整个对话重新读一遍，越往后每一步越贵。`,
    '现在：能一起查的合并成一次调用；读文件只读需要的段落（按行号或搜索），不整文件读；只做任务卡里的事。',
    strong
      ? '你的上下文已经很长了：把当前任务收个尾，按交接协议回报（没做完的写进"遗留"）。如果你是成员：回报里写上"上下文已满，请换新成员接下一个任务"；如果你是负责人：按 reference/resume.md §4 换新会话。'
      : '当前任务做完就回报，不要顺手做别的。',
  ].join('\n'),
  cardMissing: root => [
    `[crew 提醒] 项目 ${root} 还没有状态卡 ${CARD_FILE}。`,
    '按 crew skill 的 templates/state-card.md 建一张：它会在开工和压缩后自动注入，防止忘掉已拍板的事。',
  ].join('\n'),
  rotate: (root, from, to) => [
    `[crew 提醒] 这段对话开始时项目 ${root} 在 ${from}，现在已经到了 ${to}。`,
    '中/大项目每个里程碑验收后换一个新会话接着做（crew skill 的 reference/resume.md §4）：对话越长，每一步越贵，也越容易忘掉早先的约定。',
    '这一轮收尾时：存任务板快照、更新 STATE.md 和状态卡、开好"接续"会话，告诉用户去打开它。',
  ].join('\n'),
  deviation: (problems) => [
    '[crew 刹车] 这条回报的"偏离："一行会原样显示给用户看，现在用户看不懂：' + problems.join('、') + '。',
    '改成一句大白话再发：只写会影响用户的取舍，60 字以内，不带文件名、路径、命令、代码。',
    '纯技术细节（探针、脚本、目录、命令）写进报告文件；没有影响用户的取舍就只写"偏离：无"。',
  ].join('\n'),
  mapHard: (root, problems) => [
    `[crew 刹车] 代码地图 ${root}/${MAP_REL} 没跟上你改的代码：`,
    ...problems.slice(0, 8).map(p => `- ${p}`),
    '每个代码文件一行：<路径> | 负责：… | 一起看：… | 被依赖：… | 别改错：…（crew skill 的 reference/docs-and-retro.md §4）。',
    '改好再回报、再收尾：地图过期，后面的人就会照着旧的结构干活。',
  ].join('\n'),
  mapSoft: (root, files) => [
    `[crew 提醒] 这一轮你改了 ${files.slice(0, 8).join('、')}，但没动过代码地图 ${root}/${MAP_REL}。`,
    '看一眼这几个文件那一行：负责什么、一起看、被依赖、别改错，有一项变了就改掉旧的写法（只写现在的样子，不留"原来是……"）；都没变就不用动。',
  ].join('\n'),
  cleanup: (root, from, to, problems) => [
    `[crew 刹车] 项目 ${root} 从 ${from} 推进到了 ${to}，旧里程碑的东西还没清：`,
    ...problems.slice(0, 8).map(p => `- ${p}`),
    '先清：结论并进活文档，过程文件删掉，地图和代码对上；PROJECT.md 里已结束的里程碑压成履历一句话，被替代的决定和计划删掉。',
    '清完之前不能给新里程碑派成员。跑一遍 doc-check.mjs --milestone 确认干净。',
  ].join('\n'),
  stateMissing: root => [
    `[crew 提醒] 项目 ${root} 有 .team/ 但还没有 .team/STATE.md。`,
    '先按 templates/STATE.md 建好（带文件头）：用户的流水线、"等你的事"和左栏小圆点都靠它，没有它用户什么都看不到。',
  ].join('\n'),
}

// ---------- 纯判断（便于离线测试） ----------

/** 偏离一行最长多少字（给用户看的一句话；规则写 60，留一点余量）。 */
export const DEVIATION_LIMIT = 80
const NONE_RE = /^((无|没有|none|n\/a)([。.，,；;:：（(\s].*)?)?$/is

/**
 * 成员回报（send_message）里"偏离："一行的问题；没问题返回空数组。
 * 11-18 大项目实测：成员把探针、脚本路径、pwsh 命令写进偏离，原样出现在用户的"团队替你定的事"里。
 * 手册写了"60 字、大白话"没人照做，只能在发的那一刻拦。
 */
export function deviationProblems(toolName, args) {
  if (toolName !== 'send_message') return []
  const text = args?.message ?? args?.text ?? args?.content
  if (typeof text !== 'string' || !text.includes('偏离')) return []
  const body = text.replace(/^Agent\s+\S+\s+sent a message:\s*/u, '')
  const report = parseReport(body)
  const deviation = report?.deviation?.trim()
  if (!deviation || NONE_RE.test(deviation)) return []
  const problems = jargonIn(deviation)
  if (deviation.length > DEVIATION_LIMIT) problems.push(`太长（${deviation.length} 字）`)
  return problems
}

/** 事前判断（守卫用）：授权文件的写入保护。返回拒绝理由或 undefined。 */
export function decideGuard(toolName, args, cwd) {
  // 暂停：Lead、成员和它们的后台任务会互相唤醒，在界面里一个个点停止很难停干净（11-17 大项目实测）。
  // 用户在项目里建 .team/pause，所有 agent 的所有工具调用都被拦下；删掉就继续。
  const root = findTeamRoot(cwd)
  if (root && fs.existsSync(path.join(root, '.team', 'pause'))) return MSG.paused(root)
  const deviation = deviationProblems(toolName, args)
  if (deviation.length > 0) return MSG.deviation(deviation)
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

const DIR_CHANGE_RE = /(?:^|[;&|\n{(]\s*)(?:cd|chdir|pushd|sl|Set-Location|Push-Location)\s+(?:-(?:Path|LiteralPath)\s+)?("[^"]*"|'[^']*'|[^\s;&|)]+)/gi
const GIT_C_RE = /\bgit\s+-C\s+("[^"]*"|'[^']*'|\S+)/gi

/** 命令里切换到的目录（cd / Push-Location / git -C 等）的原始写法。 */
export function dirTargets(cmd) {
  const out = []
  for (const re of [DIR_CHANGE_RE, GIT_C_RE]) {
    for (const m of cmd.matchAll(re)) out.push(m[1].replace(/^["']|["']$/g, ''))
  }
  return out
}

/**
 * 这条命令的提交会不会落在项目仓库之外：
 * - 项目根本不是 git 仓库（没有 .git）→ 提交不可能落在项目里；
 * - 切到了项目外的字面路径；
 * - 命令里先 git init 新仓库、又切换了目录（典型的临时目录实验）。
 */
export function commitsOutsideProject(cmd, workdir, root) {
  const targets = dirTargets(cmd)
  const initsRepo = /\bgit\s+(?:-\S+\s+)*init\b/i.test(cmd)
  // 还不是 git 仓库：只有"就地 git init 再提交"会落在项目里（里程碑 0 的首次提交）。
  if (!fs.existsSync(path.join(root, '.git'))) return !(initsRepo && targets.length === 0)
  const outside = targets.some((t) => {
    if (/[$%]/.test(t)) return false  // 变量路径解析不了，不在这里判断
    const rel = path.relative(root, path.resolve(workdir, t))
    return rel.startsWith('..') || path.isAbsolute(rel)
  })
  if (outside) return true
  return targets.length > 0 && initsRepo
}

/**
 * 这次调用是不是需要审批的 git 提交/推送；是则返回项目根。
 * worktree 里的 commit 是成员在自己分支上的内部提交，不需要审批；push 一律需要。
 * 提交落在项目仓库之外（临时目录实验等）的不管。
 */
export function gitWriteRoot(toolName, args, cwd) {
  const cmd = commandOf(toolName, args)
  const m = cmd && cmd.match(new RegExp(GIT_WRITE_RE.source, 'gi'))
  if (!m) return null
  const workdir = workdirOf(args, cwd)
  const root = findTeamRoot(workdir)
  if (!root) return null
  if (commitsOutsideProject(cmd, workdir, root)) return null
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

/** STATE.md 文件头的问题；没有文件头（旧项目）不在这里管，交给 doc-check。 */
export function headerProblems(root) {
  let text
  try { text = fs.readFileSync(statePath(root), 'utf8') } catch { return [] }
  return /^---\r?\n/.test(text) ? checkStateHeader(text) : []
}

/** 这个项目当前里程碑的成员预算。 */
export function memberBudget(root) {
  const cfg = readGuardConfig(root)
  const bySize = MEMBER_BUDGET[cfg.size] ?? DEFAULT_MEMBERS
  // members 只能往下调：agent 自己就能改这个文件，往上调等于自己给自己松刹车（11-17 实测 Lead 把 2 改成了 3）。
  // 超出规模默认的人数一律走弹窗，由用户当场决定。
  if (Number.isInteger(cfg.members) && cfg.members >= 0) return Math.min(cfg.members, bySize)
  return bySize
}

/** 成员计数的键：项目 + 当前里程碑（换里程碑重新计数，换会话不清零）。 */
export function budgetKey(root) {
  return `${root}|${currentMilestone(root) ?? 'none'}`
}

/**
 * 派成员（pre-execute 用）：没超预算不干预；超了弹窗，"从不询问"时拒绝。
 * @param used 这个里程碑已经派了几个
 */
export function decideSpawn(toolName, cwd, policy, used) {
  if (!SPAWN_TOOLS.has(toolName)) return undefined
  const root = findTeamRoot(cwd)
  if (!root) return undefined
  const budget = memberBudget(root)
  if (used < budget) return undefined
  if (policy === 'never') return { kind: 'deny', reason: MSG.memberNever(used, budget) }
  return { kind: 'ask', reason: MSG.memberAskReason(used, budget), displayReason: MSG.memberAskDisplay(used, budget) }
}

/** STATE.md 文件头里的当前里程碑；读不到为 null。 */
export function currentMilestone(root) {
  return progressOf(root)?.milestone ?? null
}

/**
 * 该不该提醒换会话：中/大项目，这段对话开始时已经在某个里程碑上（不是 none），现在换成了另一个。
 * 小项目一般一个会话做完，不提醒。实测 11-17：大项目 Lead 验收 M0 后在同一会话直接开了 M1。
 */
export function needsRotation(root, from, to) {
  const size = readGuardConfig(root).size
  if (size !== 'medium' && size !== 'large') return false
  return Boolean(from && to && from !== 'none' && to !== 'none' && from !== to)
}

/**
 * 第几步该提醒（整段对话累计）：到 n 步提醒一次，2n 步起每满 n 步强提醒一次（该交接、换人了）。
 * n 来自 guard.json 的 steps，默认 60，0 表示关掉。
 */
export function stepNoticeAt(root, steps) {
  const cfg = readGuardConfig(root)
  const n = Number.isInteger(cfg.steps) && cfg.steps >= 0 ? cfg.steps : DEFAULT_STEP_NOTICE
  if (n === 0) return null
  if (steps === n) return 'soft'
  if (steps >= n * 2 && steps % n === 0) return 'strong'
  return null
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
  // 只查这段对话自己改了 STATE.md 的情况：成员一轮里 Lead 在别处改了它，不该把成员拉回来。
  for (const [root, before] of turn.wroteState === false ? [] : turn.stateBefore) {
    const stateChanged = fingerprint(statePath(root)) !== before
    const cardChanged = fingerprint(cardPath(root)) !== turn.cardBefore.get(root)
    if (stateChanged && !cardChanged && fs.existsSync(cardPath(root))) out.push(MSG.cardStale(root))
    if (stateChanged) {
      const problems = headerProblems(root)
      if (problems.length > 0) out.push(MSG.headerBad(root, problems))
    }
  }
  out.push(...mapReminders(turn))
  return out
}

/** 这一轮改过的代码和地图对不上：硬问题每次都报；"改了文件没看地图"每轮只提醒一次。 */
export function mapReminders(turn) {
  const out = []
  for (const [root, rels] of turn.touched ?? []) {
    const hard = touchedMapProblems(root, [...rels])
    if (hard.length > 0) { out.push(MSG.mapHard(root, hard)); continue }
    if (turn.mapSoftSent?.has(root)) continue
    const mapUntouched = fingerprint(mapPath(root)) === turn.mapBefore?.get(root)
    const edited = [...rels].filter(rel => fs.existsSync(path.join(root, rel)))
    if (mapUntouched && edited.length > 0 && fs.existsSync(mapPath(root))) {
      turn.mapSoftSent ??= new Set()
      turn.mapSoftSent.add(root)
      out.push(MSG.mapSoft(root, edited))
    }
  }
  return out
}

/** STATE.md 文件头里的阶段和里程碑；读不到为 null。 */
export function progressOf(root) {
  try {
    const h = parseStateHeader(fs.readFileSync(statePath(root), 'utf8'))
    return h.ok ? { stage: h.stage, milestone: h.milestone } : null
  } catch {
    return null
  }
}

/** 里程碑推进了，或进入交付：返回 { from, to } 文字，否则 null。 */
export function advancedBetween(before, after) {
  if (!before || !after) return null
  if (before.milestone !== after.milestone) return { from: before.milestone, to: after.milestone }
  const done = s => s === 'deliver' || s === 'delivered'
  if (done(after.stage) && !done(before.stage)) return { from: before.milestone, to: '交付' }
  return null
}

// ---------- 接入 DHS ----------

function makeNotice(text, summary) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'crew-guard', form: 'notice', summary },
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
  // The crew skill ships with this row: turning the brakes row off also removes the skill.
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : ctx.skills
  if (skills) registerCrewSkill(ctx, skills)
  const authBefore = new Map()       // callId → [[root, fp]]：授权文件事后比对
  const askedCalls = new Map()       // callId → root：本次提交走了审批弹窗
  const turns = new WeakMap()        // agent → 本轮记录
  const cardNoticed = new WeakMap()  // agent → Set<root>：已提醒过缺状态卡
  const startMilestone = new WeakMap() // agent → { root, milestone, reminded }：本会话开始时的里程碑
  const sessionSteps = new WeakMap()   // agent → 这段对话累计走了几步（不随每轮清零）
  const spawned = new Map()          // 项目|里程碑 → 已派成员数
  const spawnCalls = new Map()       // callId → 项目|里程碑：真正执行了才计数
  const pendingCleanup = new Map()   // root → { from, to }：里程碑推进后还没清干净

  function turnOf(agent) {
    let t = turns.get(agent)
    if (!t) {
      t = { approved: new Set(), dirty: new Set(), stateBefore: new Map(), cardBefore: new Map(), reminders: 0, steps: 0, wroteState: false,
        touched: new Map(), mapBefore: new Map(), progressBefore: new Map() }
      turns.set(agent, t)
    }
    return t
  }

  function trackState(t, root) {
    if (t.stateBefore.has(root)) return
    t.stateBefore.set(root, fingerprint(statePath(root)))
    t.cardBefore.set(root, fingerprint(cardPath(root)))
    t.mapBefore.set(root, fingerprint(mapPath(root)))
    t.progressBefore.set(root, progressOf(root))
  }

  /** 推进后的清理问题；清干净了就解除。 */
  function cleanupStill(root) {
    const pending = pendingCleanup.get(root)
    if (!pending) return null
    const problems = cleanupProblems(root)
    if (problems.length === 0) { pendingCleanup.delete(root); return null }
    return MSG.cleanup(root, pending.from, pending.to, problems)
  }

  // 新的用户消息 = 新的一轮：清空本轮记录；顺带提醒缺状态卡（每会话每项目一次）。
  ctx.on('agent/pre-step', async (payload, next) => {
    const { agent, messages } = payload
    if (messages?.some(m => m?.source?.kind === 'user')) turns.delete(agent)
    const cwd = cwdOfAgent(ctx, agent)
    const root = cwd && findTeamRoot(cwd)
    if (root) {
      const t = turnOf(agent)
      trackState(t, root)
      if (!startMilestone.has(agent)) startMilestone.set(agent, { root, milestone: currentMilestone(root), reminded: false })
      t.steps += 1
      // 按整段对话累计，不随每轮清零：成员被一个任务接一个任务地复用时，每轮都不到 60 步，
      // 上下文却涨到 30 万（11-17 大项目实测）。花费跟的是对话长度，不是单轮步数。
      const total = (sessionSteps.get(agent) ?? 0) + 1
      sessionSteps.set(agent, total)
      const notice = stepNoticeAt(root, total)
      if (notice) {
        try { agent.inbox.append('next-step', makeNotice(MSG.stepNotice(total, notice === 'strong'), '步数提醒')) } catch { /* 提醒失败不影响工作 */ }
      }
      let seen = cardNoticed.get(agent)
      if (!seen) cardNoticed.set(agent, (seen = new Set()))
      if (!seen.has(root) && !fs.existsSync(cardPath(root))) {
        seen.add(root)
        try { agent.inbox.append('next-step', makeNotice(MSG.cardMissing(root), '缺少状态卡')) } catch { /* 提醒失败不影响工作 */ }
      }
      if (!seen.has(`${root}|state`) && !fs.existsSync(statePath(root))) {
        seen.add(`${root}|state`)
        try { agent.inbox.append('next-step', makeNotice(MSG.stateMissing(root), '缺少 STATE.md')) } catch { /* 提醒失败不影响工作 */ }
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
    if (SPAWN_TOOLS.has(exec.name)) {
      const root = findTeamRoot(cwd)
      if (!root) return downstream
      const key = budgetKey(root)
      const dirtyOld = cleanupStill(root)
      if (dirtyOld) return { kind: 'deny', reason: dirtyOld }
      spawnCalls.set(exec.callId, key)
      return decideSpawn(exec.name, cwd, approvalPolicy(ctx, exec.agent.session), spawned.get(key) ?? 0) ?? downstream
    }
    const decision = decideCommit(exec.name, exec.arguments, cwd, approvalPolicy(ctx, exec.agent.session), turnOf(exec.agent).approved)
    if (decision?.kind === 'ask') askedCalls.set(exec.callId, gitWriteRoot(exec.name, exec.arguments, cwd))
    return decision ?? downstream
  })

  ctx.tools.guard((exec) => {
    const cwd = cwdOfAgent(ctx, exec.agent)
    if (!cwd) return undefined
    const basic = decideGuard(exec.name, exec.arguments, cwd)
    if (basic) return basic
    // 成员的"完成"回报：自己改的代码在地图里对不上，就发不出去。
    if (exec.agent && isDoneReport(exec.name, exec.arguments)) {
      for (const [root, rels] of turns.get(exec.agent)?.touched ?? []) {
        const hard = touchedMapProblems(root, [...rels])
        if (hard.length > 0) return MSG.mapHard(root, hard)
      }
    }
    return undefined
  })

  // 只有真正放行（含用户在弹窗里点了允许）的调用才会走到这里：记下本轮已批准。
  ctx.on('tools/execute', async (exec, next) => {
    const key = spawnCalls.get(exec.callId)
    if (key) {
      spawnCalls.delete(exec.callId)
      spawned.set(key, (spawned.get(key) ?? 0) + 1)
    }
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
    spawnCalls.delete(exec.callId)
    const cwd = cwdOfAgent(ctx, exec.agent)

    // 收工前验证的记账：文件工具改了代码 → 脏；verify 跑通 → 干净。
    if (cwd && exec.agent && result && !result.isError) {
      const t = turnOf(exec.agent)
      const edited = editedRoot(exec.name, exec.arguments, cwd)
      if (edited) t.dirty.add(edited)
      if (touchesState(exec.name, exec.arguments, cwd)) t.wroteState = true
      for (const [root, rel] of codeTouched(exec.name, exec.arguments, cwd)) {
        trackState(t, root)
        if (!t.touched.has(root)) t.touched.set(root, new Set())
        t.touched.get(root).add(rel)
      }
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
    // 这一轮把里程碑或阶段往前推了：先清旧东西。
    if (t.wroteState) {
      for (const [root, before] of t.progressBefore) {
        const moved = advancedBetween(before, progressOf(root))
        if (moved && !pendingCleanup.has(root)) pendingCleanup.set(root, moved)
      }
    }
    for (const root of pendingCleanup.keys()) {
      if (!t.stateBefore.has(root)) continue
      const msg = cleanupStill(root)
      if (msg) reminders.push(msg)
    }
    const start = startMilestone.get(agent)
    // Only the conversation that moved the milestone (it edited STATE.md this turn: the lead);
    // a member kept across milestones is not asked to rotate.
    const movedHere = start && t.wroteState
    if (start && !start.reminded && movedHere) {
      const now = currentMilestone(start.root)
      if (needsRotation(start.root, start.milestone, now)) {
        start.reminded = true
        reminders.push(MSG.rotate(start.root, start.milestone, now))
      }
    }
    if (reminders.length === 0) return
    t.reminders++
    try {
      agent.inbox.append('next-step', makeNotice(reminders.join('\n\n'), '收工前检查'))
    } catch { /* 塞不进去就放行，不卡死 */ }
  })
}

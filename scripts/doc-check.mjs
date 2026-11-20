#!/usr/bin/env node
// 文档检查：活文档里不应残留"待定"类标记、不应链接到不存在的文件，状态卡和 STATE.md 不应过长。
// 用法：node doc-check.mjs <项目路径>      退出码 0 = 没问题，1 = 有问题。
//       node doc-check.mjs --milestone <项目路径>
//         里程碑结束、交付时运行：另外要求 .team 里的过程文件已经清掉（只留 STATE.md、guard.json、map.md 等）。
//       代码地图 .team/map.md 每次都对账：没进地图的代码文件、指向已删除文件的行。
//       node doc-check.mjs --confirm <项目路径>
//         用户确认需求后运行：把 PROJECT.md 前五节（目的/用户与场景/成功标准/范围/假设）的指纹
//         写进 .team/STATE.md 文件头的 confirmed 字段。之后这五节被改，界面和文档检查都会提示重新确认。
import fs from 'node:fs'
import path from 'node:path'
import { requirementsFingerprint, upgradeLine } from '../lib/requirements.js'
import { checkStateHeader, parseStateHeader } from '../lib/state.js'
import { leftoverProcessFiles, scanMapProblems } from '../lib/freshness.js'

const args = process.argv.slice(2)
const confirmMode = args[0] === '--confirm'
const milestoneMode = args[0] === '--milestone'
const root = path.resolve((confirmMode || milestoneMode ? args[1] : args[0]) ?? '.')
const statePath = path.join(root, '.team', 'STATE.md')
const projectPath = path.join(root, 'PROJECT.md')

if (confirmMode) {
  const fail = (message) => { console.log(message); process.exit(1) }
  if (!fs.existsSync(projectPath)) fail(`没有 PROJECT.md：${projectPath}`)
  const fingerprint = requirementsFingerprint(fs.readFileSync(projectPath, 'utf8'))
  if (!fingerprint) fail('PROJECT.md 里没有 目的 / 用户与场景 / 成功标准 / 范围 / 假设 任何一节，没有可确认的内容')
  if (!fs.existsSync(statePath)) fail(`没有 .team/STATE.md：${statePath}`)
  const text = fs.readFileSync(statePath, 'utf8')
  const header = /^---(\r?\n)([\s\S]*?)\r?\n---\r?\n/.exec(text)
  if (!header) fail('.team/STATE.md 缺少文件头（模板见 templates/STATE.md），先补上再确认')
  const eol = header[1]
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const lines = header[2].split(/\r?\n/).filter(line => !/^confirmed:/.test(line))
  const at = lines.findIndex(line => /^waiting:/.test(line))
  lines.splice(at < 0 ? lines.length : at, 0, `confirmed: ${date} ${fingerprint}`)
  fs.writeFileSync(statePath, `---${eol}${lines.join(eol)}${eol}---${eol}${text.slice(header[0].length)}`)
  console.log(`已记下需求确认：${date} ${fingerprint}`)
  process.exit(0)
}
const LIMITS = { 'AGENTS.local.md': 40, '.team/STATE.md': 150 }
// 英文标记必须是独立的词：TODO_FILE、todos.json 这类标识符不算。
const MARKERS = /待(用户)?(拍板|确认|定|补|核实)|(?<![A-Za-z0-9_])(TODO|TBD|FIXME)(?![A-Za-z0-9_])/
const SKIP_DIRS = new Set(['node_modules', '.git', '.team', 'target', 'dist', 'build', 'tools', 'vendor'])

function liveDocs() {
  const files = []
  for (const name of ['AGENTS.local.md', 'PROJECT.md', 'PRODUCT.md', 'DESIGN.md', 'README.md', 'CHANGELOG.md']) {
    if (fs.existsSync(path.join(root, name))) files.push(name)
  }
  if (fs.existsSync(path.join(root, '.team', 'STATE.md'))) files.push('.team/STATE.md')
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel) } else if (/\.md$/i.test(e.name)) files.push(rel.split(path.sep).join('/'))
    }
  }
  if (fs.existsSync(path.join(root, 'docs'))) walk('docs')
  return files
}

const problems = []
for (const rel of liveDocs()) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8')
  const lines = text.split(/\r?\n/)
  let inFence = false
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) return
    // CHANGELOG（历史条目）和 STATE.md（专门记"等用户的事"，文件头另有检查）允许出现这些词，只查链接。
    // 实测 11-17：Lead 在 STATE.md 写"待用户确认"，把文档成员的收尾检查卡住了。
    if (rel !== 'CHANGELOG.md' && rel !== '.team/STATE.md' && MARKERS.test(line)) problems.push(`${rel}:${i + 1} 残留待定标记：${line.trim().slice(0, 80)}`)
    for (const m of line.matchAll(/\]\(([^)\s#]+)(#[^)]*)?\)/g)) {
      const target = m[1]
      if (/^[a-z]+:/i.test(target)) continue
      const abs = path.resolve(path.dirname(path.join(root, rel)), decodeURI(target))
      if (!fs.existsSync(abs)) problems.push(`${rel}:${i + 1} 链接指向不存在的文件：${target}`)
    }
  })
  const limit = LIMITS[rel]
  if (limit && lines.length > limit) problems.push(`${rel} 有 ${lines.length} 行，超过 ${limit} 行上限：把已结束的内容压成履历一句话`)
}
if (fs.existsSync(statePath)) {
  const stateText = fs.readFileSync(statePath, 'utf8')
  for (const p of checkStateHeader(stateText)) problems.push(`.team/STATE.md 文件头：${p}`)
  // 从没确认过的老项目不报（接续时由 Lead 问用户）；确认过、之后又改了才报。
  const confirmed = parseStateHeader(stateText).confirmed
  if (confirmed && fs.existsSync(projectPath) && requirementsFingerprint(fs.readFileSync(projectPath, 'utf8')) !== confirmed.fingerprint) {
    problems.push(`PROJECT.md 的需求（目的/用户与场景/成功标准/范围/假设）在 ${confirmed.date} 确认之后改过：给用户看改了什么，用户确认后运行 doc-check.mjs --confirm`)
  }
  // 界面用成功标准的勾选当进度；交付了却一条没勾，用户看到的是"0/10"（11-17 实测）。
  const stage = parseStateHeader(stateText).stage
  if ((stage === 'deliver' || stage === 'delivered') && fs.existsSync(projectPath)) {
    const open = fs.readFileSync(projectPath, 'utf8').split(/\r?\n/).filter(line => /^\s*[-*]\s+\[ \]/.test(line)).length
    if (open > 0) problems.push(`PROJECT.md 还有 ${open} 条成功标准没打勾：做到并有证据的只把 [ ] 改成 [x]（不要在后面加说明，那会被当成改需求）；做不到的留着，并在交付报告里写原因`)
  }
  // 升级是每个项目都要做的（reference/intake.md §0）；实测 11-17 两个项目一个只写了过程文件、一个没写。
  if (stage && stage !== 'intake' && fs.existsSync(projectPath) && !upgradeLine(fs.readFileSync(projectPath, 'utf8'))) {
    problems.push('PROJECT.md 缺少写好的「升级」一节：把用户原话升级成"从……到……"一行，再写推的方向（reference/intake.md §0），给用户看过')
  }
}
if (fs.existsSync(path.join(root, '.team')) && !fs.existsSync(path.join(root, 'AGENTS.local.md'))) {
  problems.push('缺少状态卡 AGENTS.local.md（模板见 skill 的 templates/state-card.md）')
}
if (fs.existsSync(path.join(root, '.team'))) {
  for (const p of scanMapProblems(root)) problems.push(`代码地图：${p}`)
  if (milestoneMode) {
    const left = leftoverProcessFiles(root)
    if (left.length > 0) problems.push(`过程文件还没清：${left.join('、')}。结论并进活文档后删掉（git 里能找回）`)
  }
}

if (problems.length === 0) {
  console.log(`文档检查通过：${root}`)
  process.exit(0)
}
console.log(`文档检查发现 ${problems.length} 个问题：`)
for (const p of problems) console.log(`- ${p}`)
process.exit(1)

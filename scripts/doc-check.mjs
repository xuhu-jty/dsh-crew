#!/usr/bin/env node
// 文档检查：活文档里不应残留"待定"类标记、不应链接到不存在的文件，状态卡和 STATE.md 不应过长。
// 用法：node doc-check.mjs <项目路径>      退出码 0 = 没问题，1 = 有问题。
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? '.')
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
    // CHANGELOG 允许出现这些词（历史条目），只查链接。
    if (rel !== 'CHANGELOG.md' && MARKERS.test(line)) problems.push(`${rel}:${i + 1} 残留待定标记：${line.trim().slice(0, 80)}`)
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
// STATE.md 文件头是给驾驶舱读的固定格式（templates/STATE.md）。
const STAGES = new Set(['intake', 'plan', 'design', 'foundation', 'build', 'deliver', 'delivered', 'paused'])
const WAIT_KINDS = new Set(['answer', 'decide', 'accept', 'authorize', 'act'])
function checkStateHeader(text) {
  const out = []
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  if (!m) return ['缺少文件头：第一行起用 --- 包住 stage / milestone / updated / waiting（模板见 templates/STATE.md）']
  const fields = {}
  let waiting = null
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue
    const item = /^\s+-\s+([a-z]+):\s*(.*)$/.exec(line)
    if (item) {
      if (waiting === null) { out.push(`列表项不在 waiting 下面：${line.trim()}`); continue }
      if (!WAIT_KINDS.has(item[1])) out.push(`waiting 类型 "${item[1]}" 不认识，只能是 ${[...WAIT_KINDS].join(' / ')}`)
      if (item[2].trim().length === 0 || /^<.*>$/.test(item[2].trim())) out.push(`waiting 有一条没写内容：${line.trim()}`)
      waiting.push(item[2])
      continue
    }
    const kv = /^([a-z]+):\s*(.*)$/.exec(line)
    if (!kv) { out.push(`文件头这一行看不懂：${line.trim()}`); continue }
    fields[kv[1]] = kv[2].trim()
    if (kv[1] === 'waiting') {
      if (kv[2].trim() === '[]') waiting = []
      else if (kv[2].trim() === '') waiting = []
      else out.push('waiting 要么写 []，要么在下面逐行写 "  - 类型: 一句话"')
    }
  }
  if (!STAGES.has(fields.stage)) out.push(`stage "${fields.stage ?? ''}" 不对，只能是 ${[...STAGES].join(' / ')}`)
  if (!/^(none|M-?\d+)$/.test(fields.milestone ?? '')) out.push(`milestone "${fields.milestone ?? ''}" 不对，写 none 或 M0、M1…`)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(fields.updated ?? '')) out.push(`updated "${fields.updated ?? ''}" 要带时区，例如 2026-11-16T20:00-08:00`)
  if (!('waiting' in fields)) out.push('缺少 waiting（没有就写 waiting: []）')
  return out
}

const statePath = path.join(root, '.team', 'STATE.md')
if (fs.existsSync(statePath)) {
  for (const p of checkStateHeader(fs.readFileSync(statePath, 'utf8'))) problems.push(`.team/STATE.md 文件头：${p}`)
}
if (fs.existsSync(path.join(root, '.team')) && !fs.existsSync(path.join(root, 'AGENTS.local.md'))) {
  problems.push('缺少状态卡 AGENTS.local.md（模板见 skill 的 templates/state-card.md）')
}

if (problems.length === 0) {
  console.log(`文档检查通过：${root}`)
  process.exit(0)
}
console.log(`文档检查发现 ${problems.length} 个问题：`)
for (const p of problems) console.log(`- ${p}`)
process.exit(1)

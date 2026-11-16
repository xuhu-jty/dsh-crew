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

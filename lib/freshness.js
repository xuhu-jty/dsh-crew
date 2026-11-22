// 文档保鲜：代码地图跟着代码走、里程碑推进时旧的过程文件清掉。插件刹车和 doc-check 共用。
// 只做程序能判断对错的部分：文件有没有那一行、行指向的文件还在不在、.team 里有没有残留。
// 每一行写得对不对（职责、依赖、约束）程序判断不了，交给评审员（roles/reviewer.md）。

import fs from 'node:fs'
import path from 'node:path'

export const MAP_REL = '.team/map.md'
export const mapPath = root => path.join(root, '.team', 'map.md')

/** .team 里允许长期留着的东西；其余都是过程文件，里程碑推进后要清掉（结论先并进活文档）。 */
export const TEAM_KEEP = new Set([
  'STATE.md', 'guard.json', 'map.md', 'brief-common.md', 'evidence', 'handoff',
  'TASKS-snapshot.md', 'skill-feedback.md', 'pause', 'commit-authorized',
])

const CODE_EXT = /\.(m?js|cjs|jsx|tsx?|mts|cts|vue|svelte|astro|py|go|rs|java|kt|kts|scala|cs|fs|cpp|cc|c|h|hpp|m|mm|swift|rb|php|lua|dart|ex|exs|erl|clj|sh|bash|ps1|psm1|bat|cmd|sql|html?|css|scss|sass|less)$/i
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', 'tools', '__pycache__', 'venv'])
const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|e2e)\//i
const TEST_FILE_RE = /[._-](test|spec)\.[^./]+$/i
const MAX_SCAN = 20000

const norm = p => p.split(path.sep).join('/').replace(/^\.\//, '')

/** 这个相对路径是不是要进地图的代码文件（测试、生成物、静态资源、.team 和隐藏目录不进）。 */
export function isMappedCode(rel) {
  const r = norm(rel)
  if (!CODE_EXT.test(r) || TEST_RE.test(r) || TEST_FILE_RE.test(r)) return false
  const parts = r.split('/')
  if (parts.length > 1 && parts.slice(0, -1).some(d => d.startsWith('.') || SKIP_DIRS.has(d))) return false
  return !r.startsWith('../')
}

/** 地图里列出的路径：每行 `<路径> | ...`；以 / 结尾的是目录行（已有大仓库还没逐个文件写时用）。 */
export function parseMap(text) {
  const files = new Set()
  const dirs = []
  let inFence = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^\s*(?:[-*]\s+|\|\s*)?`?([^\s|`]+?)`?\s*\|/.exec(line)
    if (!m || /^[-:]+$/.test(m[1]) || !/[./]/.test(m[1])) continue
    const p = norm(m[1])
    if (p.endsWith('/')) dirs.push(p)
    else files.add(p)
  }
  return { files, dirs }
}

function readMap(root) {
  try { return parseMap(fs.readFileSync(mapPath(root), 'utf8')) } catch { return null }
}

const covered = (map, rel) => map.files.has(rel) || map.dirs.some(d => rel.startsWith(d))

/**
 * 这一轮改过的代码文件在地图里的硬问题（新文件没有自己那一行、删掉的文件那一行还在、还没有地图）。
 * @param touched 项目内相对路径列表
 */
export function touchedMapProblems(root, touched) {
  const rels = [...new Set(touched.map(norm))].filter(isMappedCode)
  if (rels.length === 0) return []
  const exists = rel => fs.existsSync(path.join(root, rel))
  const map = readMap(root)
  if (!map) {
    const live = rels.filter(exists)
    return live.length > 0 ? [`还没有代码地图 ${MAP_REL}：建一个，写上模块表和这些文件各一行（${live.slice(0, 5).join('、')}）`] : []
  }
  const out = []
  for (const rel of rels) {
    if (exists(rel) && !map.files.has(rel)) out.push(`${rel} 没有自己那一行：补上`)
    if (!exists(rel) && map.files.has(rel)) out.push(`${rel} 已经删掉了，地图里那一行也删掉`)
  }
  return out
}

/** 磁盘上的代码文件（相对路径）；超过上限就截断，不卡住。 */
export function codeFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= MAX_SCAN) return
      const rel = dir ? `${dir}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(rel)
      } else if (isMappedCode(rel)) out.push(rel)
    }
  }
  walk('')
  return out
}

/** 全量对账：没进地图的代码文件、指向不存在文件的行。项目还没有代码时不要求地图。 */
export function scanMapProblems(root) {
  const files = codeFiles(root)
  const map = readMap(root)
  if (!map) return files.length > 0 ? [`还没有代码地图 ${MAP_REL}（已有 ${files.length} 个代码文件）：按 reference/docs-and-retro.md §4 建一个`] : []
  const out = []
  const missing = files.filter(rel => !covered(map, rel))
  if (missing.length > 0) out.push(`地图缺 ${missing.length} 个代码文件的行：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' 等' : ''}`)
  const stale = [...map.files].filter(rel => !fs.existsSync(path.join(root, rel)))
    .concat(map.dirs.filter(d => !fs.existsSync(path.join(root, d))))
  if (stale.length > 0) out.push(`地图里 ${stale.length} 行指向已经不存在的文件，删掉：${stale.slice(0, 8).join('、')}${stale.length > 8 ? ' 等' : ''}`)
  return out
}

/** .team 里残留的过程文件（评审、QA、演示稿、勘察、草稿等）。 */
export function leftoverProcessFiles(root) {
  try {
    return fs.readdirSync(path.join(root, '.team')).filter(name => !TEAM_KEEP.has(name)).map(name => `.team/${name}`)
  } catch {
    return []
  }
}

/** 项目有没有至少一个 git 提交。没有提交时删掉的文件找不回来。 */
export function hasGitCommits(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*(.+)$/.exec(head)
    if (!ref) return /^[0-9a-f]{40}$/i.test(head)
    if (fs.existsSync(path.join(root, '.git', ref[1]))) return true
    const packed = path.join(root, '.git', 'packed-refs')
    return fs.existsSync(packed) && fs.readFileSync(packed, 'utf8').includes(ref[1])
  } catch {
    return false
  }
}

/** 过程文件该怎么处理：有 git 提交就删（能找回）；没有提交就先打包进 evidence 再删，否则审计证据就没了。 */
export function leftoverAdvice(root) {
  return hasGitCommits(root)
    ? '有用的结论并进 PROJECT.md / STATE.md / 地图等活文档，然后删掉（git 里能找回）'
    : '有用的结论并进 PROJECT.md / STATE.md / 地图等活文档；这个项目没有 git 提交，删了找不回，先把它们打包进 .team/evidence/<上个里程碑>-process.tar.gz 再删'
}

/** 里程碑推进或交付时必须清掉的旧东西；空数组表示干净。 */
export function cleanupProblems(root) {
  const out = []
  const left = leftoverProcessFiles(root)
  if (left.length > 0) out.push(`上个里程碑的过程文件还在：${left.slice(0, 10).join('、')}${left.length > 10 ? ' 等' : ''}。${leftoverAdvice(root)}`)
  return out.concat(scanMapProblems(root))
}

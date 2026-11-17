/**
 * The machine-readable header of `.team/STATE.md` (templates/STATE.md): one place for its rules.
 *
 * - `checkStateHeader` is what scripts/doc-check.mjs reports (plain-Chinese fixes).
 * - `parseStateHeader` is what the views read. client.js is a hand-written browser module and
 *   cannot import this file, so it carries the same function; test/state.test.js runs both
 *   on the same fixtures and fails if they ever disagree.
 */

export const STAGES = ['intake', 'plan', 'design', 'foundation', 'build', 'deliver', 'delivered', 'paused']
/** Waiting kinds, most urgent first. */
export const WAIT_KINDS = ['authorize', 'accept', 'decide', 'answer', 'act']

const HEADER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

/**
 * Lenient read for display. Unknown waiting kinds are dropped; a bad stage means "no header".
 * @param {string} text - whole STATE.md text.
 * @returns {{ok: true, stage: string, milestone: string, updated: string, waiting: {kind: string, text: string}[]} | {ok: false}}
 */
export function parseStateHeader(text) {
  const match = HEADER.exec(String(text ?? ''))
  if (!match) return { ok: false }
  const fields = {}
  const waiting = []
  let inWaiting = false
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+([a-z]+):\s*(.+)$/.exec(line)
    if (item && inWaiting) {
      if (WAIT_KINDS.includes(item[1])) waiting.push({ kind: item[1], text: item[2].trim() })
      continue
    }
    const kv = /^([a-z]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    fields[kv[1]] = kv[2].trim()
    inWaiting = kv[1] === 'waiting'
  }
  if (!STAGES.includes(fields.stage)) return { ok: false }
  return { ok: true, stage: fields.stage, milestone: fields.milestone ?? 'none', updated: fields.updated ?? '', waiting }
}

/**
 * Strict check for the milestone gate: every problem as a plain-Chinese sentence.
 * @param {string} text - whole STATE.md text.
 * @returns {string[]} problems; empty when the header is valid.
 */
export function checkStateHeader(text) {
  const out = []
  const m = HEADER.exec(String(text ?? ''))
  if (!m) return ['缺少文件头：第一行起用 --- 包住 stage / milestone / updated / waiting（模板见 templates/STATE.md）']
  const fields = {}
  let waiting = null
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue
    const item = /^\s+-\s+([a-z]+):\s*(.*)$/.exec(line)
    if (item) {
      if (waiting === null) { out.push(`列表项不在 waiting 下面：${line.trim()}`); continue }
      if (!WAIT_KINDS.includes(item[1])) out.push(`waiting 类型 "${item[1]}" 不认识，只能是 ${WAIT_KINDS.join(' / ')}`)
      if (item[2].trim().length === 0 || /^<.*>$/.test(item[2].trim())) out.push(`waiting 有一条没写内容：${line.trim()}`)
      waiting.push(item[2])
      continue
    }
    const kv = /^([a-z]+):\s*(.*)$/.exec(line)
    if (!kv) { out.push(`文件头这一行看不懂：${line.trim()}`); continue }
    fields[kv[1]] = kv[2].trim()
    if (kv[1] === 'waiting') {
      if (kv[2].trim() === '[]' || kv[2].trim() === '') waiting = []
      else out.push('waiting 要么写 []，要么在下面逐行写 "  - 类型: 一句话"')
    }
  }
  if (!STAGES.includes(fields.stage)) out.push(`stage "${fields.stage ?? ''}" 不对，只能是 ${STAGES.join(' / ')}`)
  if (!/^(none|M-?\d+)$/.test(fields.milestone ?? '')) out.push(`milestone "${fields.milestone ?? ''}" 不对，写 none 或 M0、M1…`)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(fields.updated ?? '')) out.push(`updated "${fields.updated ?? ''}" 要带时区，例如 2026-11-16T20:00-08:00`)
  if (!('waiting' in fields)) out.push('缺少 waiting（没有就写 waiting: []）')
  return out
}

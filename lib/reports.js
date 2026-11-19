/**
 * Member hand-over reports, folded from the lead conversation's own log.
 *
 * When a member calls `send_message` to the lead, DHS appends a `user/message` to the lead's
 * log whose text is "Agent <name> sent a message: [任务 task-N] 完成 ...". crew fixes the body
 * format (reference/team-ops.md): one label per line — 结果 / 交付 / 检查 / 偏离 / 文档 / 未验证 / 遗留.
 * Older reports put everything on the first line after "·"; those keep a short summary only.
 */

const HEAD = /^\s*\[任务\s+(task-\d+)\]\s*(完成|阻塞|需要决定)\s*(?:[·•\-—:：]\s*)?(.*)$/u
const LABELS = { 结果: 'result', 交付: 'output', 检查: 'checks', 偏离: 'deviation', 文档: 'docs', 未验证: 'unverified', 遗留: 'leftover' }
const LABEL_LINE = new RegExp(`^\\s*(${Object.keys(LABELS).join('|')})\\s*[：:]\\s*(.*)$`, 'u')
const FIELD_LIMIT = 400
const SUMMARY_LIMIT = 240

const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text)

/** A message without the "[任务 task-N]" line still counts as a report when it has this many labels. */
const LOOSE_LABELS = 3

/**
 * Parse one report body. Returns null when the text is not a task report.
 *
 * Members sometimes drop the first line (seen live 11-17: a docs member sent 结果 / 交付 / 检查 /
 * 偏离 … without "[任务 task-2] 完成"). Such a message still counts when it has at least three
 * labelled lines; it gets `taskId: null` and status 完成, and the caller files it under its sender.
 * @param {string} text - message text, normally starting with "[任务 task-N] …".
 * @returns {null | {taskId: string|null, status: string, summary: string, result?: string, output?: string, checks?: string, deviation?: string, docs?: string, unverified?: string, leftover?: string}}
 */
export function parseReport(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const first = lines.findIndex(line => line.trim() !== '')
  if (first < 0) return null
  const head = HEAD.exec(lines[first])
  if (!head && lines.filter(line => LABEL_LINE.test(line)).length < LOOSE_LABELS) return null
  const report = head ? { taskId: head[1], status: head[2], summary: clip(head[3].trim(), SUMMARY_LIMIT) } : { taskId: null, status: '完成', summary: '' }
  let current = null
  for (const line of lines.slice(head ? first + 1 : first)) {
    const labelled = LABEL_LINE.exec(line)
    if (labelled) {
      current = LABELS[labelled[1]]
      report[current] = labelled[2].trim()
    } else if (current && line.trim() !== '' && !/^\s*#{1,6}\s/.test(line)) {
      report[current] = `${report[current]}\n${line.trim()}`.trim()
    } else if (line.trim() === '') {
      current = null
    }
  }
  for (const key of Object.values(LABELS)) if (report[key] !== undefined) report[key] = clip(report[key], FIELD_LIMIT)
  if (isOutline(report.summary)) report.summary = ''
  if (!report.summary && report.result) report.summary = clip(report.result, SUMMARY_LIMIT)
  if (!report.summary) report.summary = clip(firstBodySentence(lines.slice(first + 1)), SUMMARY_LIMIT)
  return report
}

/** Section names older reports listed on the first line ("结果 · 证据 · 文档 · 遗留与风险"). */
const OUTLINE_WORD = /^(结果|结论|摘要|证据|证据路径|文档|遗留|遗留与风险|风险|交付|检查|未验证|关键)$/u

/** True when a first-line remainder is only a list of section names, not a summary. */
function isOutline(text) {
  const parts = String(text ?? '').split(/\s*[·・/、|]\s*/u).map(part => part.trim()).filter(Boolean)
  return parts.length > 0 && parts.every(part => OUTLINE_WORD.test(part))
}

/** First real sentence of the body: skips blanks, headings, label lines and bullet marks. */
function firstBodySentence(lines) {
  for (const raw of lines) {
    const line = raw.replace(/^[\s■□●○•▪\-*#>]+/u, '').replace(/\*\*/g, '').trim()
    if (line === '' || LABEL_LINE.test(raw)) continue
    return /^(.+?[。！？.!?])/u.exec(line)?.[1] ?? line
  }
  return ''
}

/** Concatenated text parts of a `user/message` event, or '' for anything else. */
function messageText(event) {
  if (event?.type !== 'user/message') return ''
  const content = event.data?.content
  if (!Array.isArray(content)) return ''
  return content.map(part => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('')
}

/**
 * Fold step for the `crewReports` projection: keep the latest report per task.
 * A member report without a task id is kept under `@<member name>`; the view matches it to the
 * tasks that member owns. Only member messages ("Agent <name> sent a message:") may omit the id,
 * so the user's own messages are never read as reports.
 * Returns the same state reference for every event that is not a report.
 * @param {Record<string, object>} state - reports by task id (or `@member`).
 * @param {{type: string, time?: number, data?: object}} event - one session event.
 */
export function applyReport(state, event) {
  const text = messageText(event)
  const sender = /^Agent\s+(\S+)\s+sent a message:\s*/u.exec(text)
  if (!text.includes('[任务') && !sender) return state
  const report = parseReport(sender ? text.slice(sender[0].length) : text)
  if (report === null || (report.taskId === null && !sender)) return state
  const key = report.taskId ?? `@${sender[1]}`
  return { ...state, [key]: { ...report, from: sender?.[1] ?? null, at: typeof event.time === 'number' ? event.time : null } }
}

/** Plain-object guard used as the projection's state and view schema. */
export const reportsSchema = Object.freeze({
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('crewReports: expected an object of reports')
    return value
  },
})

/** The `crewReports` session projection (Host). Its wire value rides along the session list. */
export const reportsProjection = Object.freeze({
  key: 'crewReports',
  // Bump whenever parseReport changes, so DHS refolds cached rows instead of serving stale ones.
  stateVersion: 4,
  stateSchema: reportsSchema,
  init: () => ({}),
  apply: applyReport,
  wire: { viewSchema: reportsSchema, view: state => state },
})

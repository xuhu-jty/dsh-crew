/**
 * Offline tests for the `crewReports` fold: crew's fixed hand-over format, the older one-line
 * format seen in real logs, sender extraction, and "same reference for unrelated events".
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyReport, parseReport, reportsProjection, reportsSchema } from '../lib/reports.js'

const fixed = [
  '[任务 task-12] 完成',
  '结果：插件装进测试环境，三项验证都通过',
  '交付：.team/poc-evidence.md；crew-center/client.js',
  '检查：pwsh -File verify.ps1 → exit 0，27/27',
  '文档：README.md',
  '未验证：正式 DHS 里没装',
  '遗留：无',
].join('\n')

test('the format documented in reference/team-ops.md is exactly what the parser reads', async () => {
  const { readFileSync } = await import('node:fs')
  const doc = readFileSync(new URL('../reference/team-ops.md', import.meta.url), 'utf8')
  const block = /## 交接协议[\s\S]*?```\n([\s\S]*?)```/u.exec(doc)?.[1]
  assert.ok(block, 'team-ops.md keeps one fenced example of the hand-over format')
  const example = block.replace('完成 / 阻塞 / 需要决定', '完成').replace('task-N', 'task-1')
  const report = parseReport(example)
  for (const field of ['result', 'output', 'checks', 'deviation', 'docs', 'unverified', 'leftover']) {
    assert.ok(report[field], `documented label for ${field} is parsed`)
  }
})

test('parses the fixed crew hand-over format', () => {
  const report = parseReport(fixed)
  assert.equal(report.taskId, 'task-12')
  assert.equal(report.status, '完成')
  assert.equal(report.result, '插件装进测试环境，三项验证都通过')
  assert.equal(report.output, '.team/poc-evidence.md；crew-center/client.js')
  assert.equal(report.checks, 'pwsh -File verify.ps1 → exit 0，27/27')
  assert.equal(report.unverified, '正式 DHS 里没装')
  assert.equal(report.leftover, '无')
  assert.equal(report.summary, '插件装进测试环境，三项验证都通过', 'summary falls back to 结果')
})

test('keeps a short summary for the older one-line format', () => {
  const report = parseReport('[任务 task-1] 完成 · 竞品与协议全景已写入 landscape.md（344 行）。\n\n结论摘要（每条一句）：\n1. 不是空白')
  assert.equal(report.status, '完成')
  assert.equal(report.summary, '竞品与协议全景已写入 landscape.md（344 行）。')
  assert.equal(report.checks, undefined)
})

test('a first line that only lists section names falls back to the first body sentence', () => {
  const report = parseReport('[任务 task-10] 完成 · 结果 · 证据 · 文档 · 遗留与风险\n\n■ 结论：改代码约半秒页面就更新，不碰你正在用的 DSH。后面还有。\n')
  assert.equal(report.summary, '结论：改代码约半秒页面就更新，不碰你正在用的 DSH。')
  const meaningful = parseReport('[任务 task-12] 完成 · POC-1/2/3 全通过 · HMR 通过 · 证据路径 · 遗留\n\n■ 结论')
  assert.equal(meaningful.summary, 'POC-1/2/3 全通过 · HMR 通过 · 证据路径 · 遗留', 'kept when it says something')
})

test('blocked and needs-decision reports, and non-reports', () => {
  assert.equal(parseReport('[任务 task-3] 阻塞\n结果：权限被拒').status, '阻塞')
  assert.equal(parseReport('[任务 task-4] 需要决定 · 选 A 还是 B').status, '需要决定')
  assert.equal(parseReport('普通消息'), null)
  assert.equal(parseReport('[任务 x] 完成'), null)
  assert.equal(parseReport(''), null)
})

test('labelled fields can continue on following lines and are clipped', () => {
  const report = parseReport(`[任务 task-5] 完成\n检查：第一条\n第二条\n\n其他段落\n结果：${'长'.repeat(500)}`)
  assert.equal(report.checks, '第一条\n第二条')
  assert.ok(report.result.length <= 400)
})

test('a label outside the protocol ends the field above it (seen live 11-21)', () => {
  const report = parseReport('结果：十章写完\n证据：verify 通过\n偏离：第 16 章钩子改了称呼，因为排行查不到\n问题：需你定——金使未具名，按待考还是补史实库\n遗留：双评审待跑')
  assert.equal(report.deviation, '第 16 章钩子改了称呼，因为排行查不到')
  assert.equal(report.leftover, '双评审待跑')
})

const message = (text, time = 1000) => ({ type: 'user/message', time, data: { content: [{ type: 'text', text: 'Agent builder-env sent a message: ' }, { type: 'text', text }] } })

test('fold keeps the latest report per task with sender and time', () => {
  let state = reportsProjection.init()
  state = applyReport(state, message('[任务 task-12] 阻塞\n结果：缺权限', 1000))
  state = applyReport(state, message(fixed, 2000))
  assert.equal(state['task-12'].status, '完成')
  assert.equal(state['task-12'].from, 'builder-env')
  assert.equal(state['task-12'].at, 2000)
})

test('fold returns the same state for unrelated events', () => {
  const state = { 'task-1': { status: '完成' } }
  assert.equal(applyReport(state, { type: 'step/start', data: {} }), state)
  assert.equal(applyReport(state, { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } }), state)
  assert.equal(applyReport(state, { type: 'user/message', data: { content: [{ type: 'text', text: '[任务 但不是报告' }] } }), state)
})

test('projection definition is a summary-visible wire unit with an object schema', () => {
  assert.equal(reportsProjection.key, 'crewReports')
  assert.equal(reportsProjection.stateVersion, 5)
  assert.equal(reportsProjection.wire.summary, undefined, 'summary defaults to true, so the value rides along the session list')
  assert.deepEqual(reportsSchema.parse({}), {})
  assert.throws(() => reportsSchema.parse(null))
  assert.throws(() => reportsSchema.parse([]))
})

test('a member report without the task line still counts, filed under the member (seen live 11-17)', () => {
  const live = [
    'Agent docs sent a message: 结果：README 已改成一版没跑过命令行的人也能照着做的说明',
    '交付：README.md；.team/docs-coverage.md',
    '检查：`node --test` → 13/13 通过',
    '偏离：README 不再提测试用的环境变量（面向用户用不上）',
    '文档：README.md',
    '未验证：无',
    '遗留：无',
  ].join('\n')
  const event = text => ({ type: 'user/message', time: 5, data: { content: [{ type: 'text', text }] } })
  const state = applyReport({}, event(live))
  assert.equal(state['@docs'].taskId, null)
  assert.equal(state['@docs'].deviation, 'README 不再提测试用的环境变量（面向用户用不上）')
  assert.equal(state['@docs'].summary, 'README 已改成一版没跑过命令行的人也能照着做的说明')
  // A progress note with fewer labels is not a report.
  const quiet = {}
  assert.equal(applyReport(quiet, event('Agent docs sent a message: 进度：改完一半\n结果：还在写')), quiet)
  // The user's own message is never read as a loose report.
  const userText = '结果：a\n交付：b\n检查：c'
  const before = {}
  assert.equal(applyReport(before, event(userText)), before)
})

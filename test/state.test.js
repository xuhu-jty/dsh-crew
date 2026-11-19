/**
 * The STATE.md header has one set of rules (lib/state.js). client.js keeps a copy of the
 * parser because a hand-written browser module cannot import files; this test keeps the two
 * identical, and covers the strict check that doc-check.mjs reports.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { checkStateHeader, parseStateHeader, STAGES, WAIT_KINDS } from '../lib/state.js'
import { createPlugin } from './load-client.js'

const client = createPlugin().model

const FIXTURES = [
  '---\nstage: design\nmilestone: M0\nupdated: 2026-11-16T20:00-08:00\nwaiting:\n  - accept: 看看第一阶段的成果\n  - authorize: 允许第一次存档\n---\n# s\n',
  '---\nstage: build\nmilestone: M1\nupdated: 2026-11-16T20:00Z\nwaiting: []\n---\n# s\n',
  '---\r\nstage: plan\r\nmilestone: none\r\nupdated: 2026-11-16T20:00+08:00\r\nwaiting:\r\n  - decide: 选方向\r\n---\r\n',
  '---\nstage: plan\nwaiting:\n  - approve: 未知类型\n  - act: 你去开开关\n---\n',
  '---\nstage: coding\nmilestone: 1\n---\n',
  '# 没有文件头\n- 当前阶段：M0\n',
  '',
  '---\nstage: build\nmilestone: M1\nupdated: 2026-11-17T08:00-08:00\nconfirmed: 2026-11-17 9f3a2c1b\nwaiting: []\n---\n',
  '---\nstage: build\nmilestone: M1\nupdated: 2026-11-17T08:00-08:00\nconfirmed: none\nwaiting: []\n---\n',
]

test('the confirmed field: date + fingerprint, none, or a plain-Chinese problem', () => {
  assert.deepEqual(checkStateHeader(FIXTURES[7]), [])
  assert.deepEqual(checkStateHeader(FIXTURES[8]), [])
  assert.deepEqual(parseStateHeader(FIXTURES[7]).confirmed, { date: '2026-11-17', fingerprint: '9f3a2c1b' })
  assert.equal(parseStateHeader(FIXTURES[8]).confirmed, null)
  assert.equal(parseStateHeader(FIXTURES[1]).confirmed, null)
  const bad = checkStateHeader('---\nstage: build\nmilestone: M1\nupdated: 2026-11-17T08:00Z\nconfirmed: yesterday\nwaiting: []\n---\n')
  assert.equal(bad.length, 1)
  assert.match(bad[0], /--confirm/)
})

test('the views and doc-check read every fixture the same way', () => {
  for (const text of FIXTURES) assert.deepEqual(client.parseStateHeader(text), parseStateHeader(text), JSON.stringify(text))
  assert.deepEqual(client.STAGES, STAGES)
  assert.deepEqual(client.WAIT_ORDER, WAIT_KINDS)
})

test('strict check passes valid headers and explains each problem', () => {
  assert.deepEqual(checkStateHeader(FIXTURES[0]), [])
  assert.deepEqual(checkStateHeader(FIXTURES[1]), [])
  assert.match(checkStateHeader(FIXTURES[5])[0], /缺少文件头/)
  const bad = checkStateHeader('---\nstage: coding\nmilestone: 1\nupdated: 2026-11-16 20:00\nwaiting:\n  - approve: 允许提交\n  - accept: <一句大白话>\n---\n')
  assert.equal(bad.length, 5)
  for (const fragment of ['approve', '没写内容', 'coding', 'milestone', '时区']) assert.ok(bad.some(p => p.includes(fragment)), fragment)
  assert.ok(checkStateHeader('---\nstage: plan\nmilestone: none\nupdated: 2026-11-16T20:00+08:00\n---\n').some(p => p.includes('缺少 waiting')))
})

test('waiting sentences must read plainly: no file names, paths, task ids, flags or code quotes', async () => {
  const { jargonIn } = await import('../lib/state.js')
  for (const plain of ['打开网页试一遍记账流程', '允许把这一批改动存档', '在 DHS 里打开团队协作开关', '选界面方向：A 简洁 / B 卡片']) assert.deepEqual(jargonIn(plain), [], plain)
  assert.deepEqual(jargonIn('看一下 PROJECT.md 前五节'), ['文件名'])
  assert.deepEqual(jargonIn('确认 task-3 的结果'), ['任务编号'])
  assert.deepEqual(jargonIn('运行 `npm test`'), ['代码引号'])
  assert.deepEqual(jargonIn('看 D:\\dsh\\harness 里的结果'), ['路径'])
  assert.deepEqual(jargonIn('看 ./src/app 里的结果'), ['路径'])
  assert.deepEqual(jargonIn('用 --confirm 记下'), ['命令参数'])
  const problems = checkStateHeader('---\nstage: build\nmilestone: M1\nupdated: 2026-11-17T08:00+08:00\nwaiting:\n  - accept: 看一下 PROJECT.md 前五节\n---\n')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /看不懂.*文件名/)
})

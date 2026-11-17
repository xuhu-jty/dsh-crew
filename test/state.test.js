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
]

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

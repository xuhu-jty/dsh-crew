// 11-18 自评界面后补的几处：里程碑序号、项目总用量、技术性"偏离"折叠、偏离回报刹车。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createPlugin } from './load-client.js'
import { deviationProblems, decideGuard } from '../lib/guard.js'

const m = createPlugin().model

const PROJECT = [
  '# P',
  '## 里程碑',
  '',
  '| # | 内容 | 演示 |',
  '|---|---|---|',
  '| 0 | 地基 | 页面 |',
  '| 1 | 闭环 | 两台电脑 |',
  '| **2** | 多看板 | 建板 |',
  '| 5 | 交付 | 验收 |',
  '',
  '## 仍有效的决定',
  '| 2026-11-17 | 里程碑竖切 | 原因 | 用户 |',
].join('\n')

test('milestone ids come from the 里程碑 table only, and M5 is the 4th of 4 here', () => {
  assert.deepEqual(m.milestoneIds(PROJECT), ['0', '1', '2', '5'])
  assert.deepEqual(m.milestonePosition('M5', m.milestoneIds(PROJECT)), { n: 4, total: 4 })
  assert.deepEqual(m.milestonePosition('M0', ['0', '1']), { n: 1, total: 2 })
  assert.equal(m.milestonePosition('M7', ['0', '1']), null, 'not in the table: no position')
  assert.equal(m.milestonePosition('none', ['0']), null)
  assert.deepEqual(m.parseProject(PROJECT).milestones, ['0', '1', '2', '5'])
})

test('project usage adds every conversation in the folder and the members they started', () => {
  const usage = n => ({ projectionValues: { tokenUsage: { uncachedInputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } })
  const byId = {
    a: { id: 'a', cwd: 'D:\\p', ...usage(100) },
    b: { id: 'b', cwd: 'd:/p/', ...usage(50) },
    a1: { id: 'a1', parentId: 'a', ...usage(10) },
    x: { id: 'x', cwd: 'D:\\other', ...usage(999) },
  }
  assert.equal(m.projectUsage(byId, m.pathKey('D:\\p')), 160)
  assert.equal(m.projectUsage(byId, null), null)
  assert.equal(m.projectUsage({}, m.pathKey('D:\\p')), null)
})

test('deviations with paths, commands or too many words are marked technical', () => {
  const tasks = [{ id: 'task-1', subject: '验收', status: 'completed' }]
  const at = (text, n) => ({ taskId: 'task-1', deviation: text, at: n })
  const plain = m.deviations(tasks, { a: at('5000 卡性能在办公室没有演示数据时记为跳过，是否接受请验收时确认', 1) })
  assert.equal(plain[0].plain, true)
  const path = m.deviations(tasks, { a: at('回归脚本复用 .team/qa/m5-ops/lib.mjs 时截图默认落 m5-ops 目录', 1) })
  assert.equal(path[0].plain, false)
  const cmd = m.deviations(tasks, { a: at('重跑 `pwsh -NoProfile -File package.ps1` 刷新', 1) })
  assert.equal(cmd[0].plain, false)
  assert.equal(m.isPlain('很'.repeat(81)), false)
  assert.equal(m.isPlain('复验探针修正后 7/7（非产品问题）；变异重做（正确 cwd）'), false, 'process-only note seen live 11-18')
  assert.match(deviationProblems('send_message', { message: '[任务 task-3] 完成\n偏离：复验探针修正后 7/7（非产品问题）' }).join(), /过程细节/)
})

test('a member report whose 偏离 line the user cannot read is sent back', () => {
  const send = message => ['send_message', { agent: 'lead', message }]
  assert.deepEqual(deviationProblems(...send('[任务 task-3] 完成\n结果：好了\n偏离：无（按计划）')), [])
  assert.deepEqual(deviationProblems(...send('[任务 task-3] 完成\n偏离：5000 卡性能在办公室没有演示数据时记为跳过，是否接受请验收时确认')), [])
  assert.deepEqual(deviationProblems(...send('[任务 task-3] 完成\n偏离：截图默认落 .team/qa/m5-ops/ 目录，已改为 lib.mjs 参数')), ['文件名'])
  assert.match(deviationProblems(...send(`[任务 task-3] 完成\n偏离：${'很'.repeat(90)}`))[0], /太长/)
  assert.deepEqual(deviationProblems('send_message', { message: '普通聊天，不是回报' }), [])
  assert.deepEqual(deviationProblems('bash', { command: 'echo 偏离：`x`' }), [])
  const reason = decideGuard(...send('[任务 task-3] 完成\n偏离：改用 `pwsh -File x.ps1`'), process.cwd())
  assert.match(reason, /偏离/)
  assert.match(reason, /60 字/)
})

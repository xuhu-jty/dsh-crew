/**
 * The requirement-sheet fingerprint (lib/requirements.js) and its copy in client.js: what counts
 * as a change, what does not, and that both copies agree. Also the view model built on it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { requirementsFingerprint } from '../lib/requirements.js'
import { parseStateHeader } from '../lib/state.js'
import { createPlugin } from './load-client.js'

const client = createPlugin().model

const BASE = [
  '# 记账小工具',
  '',
  '> 项目全景。',
  '',
  '## 目的',
  '',
  '让我每月花 5 分钟看清钱花在哪。',
  '',
  '## 用户与场景',
  '- 我自己，每天晚上记一次。',
  '',
  '## 成功标准（可检查）',
  '- [ ] 记一笔 10 秒内完成',
  '- [ ] 月报一键导出',
  '',
  '## 范围',
  '**做**：记账、月报',
  '**不做**：多人共享',
  '',
  '## 假设',
  '- 只在电脑上用',
  '',
  '## 全景',
  '- 模块：记账、报表',
  '',
  '## 履历',
  '- 完成 2026-11-17 M0',
].join('\n')

const edit = (from, to) => BASE.replace(from, to)

const SAME = {
  'Windows line endings': BASE.replace(/\n/g, '\r\n'),
  'extra blank lines': BASE.replace('## 范围\n', '## 范围\n\n\n'),
  'spaces at line ends': BASE.replace('多人共享', '多人共享   '),
  'ticked criterion': edit('- [ ] 月报一键导出', '- [x] 月报一键导出'),
  'ticked with capital X': edit('- [ ] 记一笔 10 秒内完成', '- [X] 记一笔 10 秒内完成'),
  'edit outside the five sections': edit('- 模块：记账、报表', '- 模块：记账、报表、导出'),
  'new history line': `${BASE}\n- 完成 2026-11-18 M1`,
  'heading note changed': edit('## 成功标准（可检查）', '## 成功标准'),
  'title changed': edit('# 记账小工具', '# 记账本'),
}

const CHANGED = {
  'goal reworded': edit('5 分钟', '10 分钟'),
  'criterion added': edit('- [ ] 月报一键导出', '- [ ] 月报一键导出\n- [ ] 支持手机'),
  'scope item moved': edit('**不做**：多人共享', '**不做**：（无）'),
  'assumption changed': edit('只在电脑上用', '电脑和手机都用'),
  'users changed': edit('每天晚上', '每周一次'),
  'section removed': edit('## 假设\n- 只在电脑上用\n', ''),
}

test('formatting, ticks and other sections do not change the fingerprint', () => {
  const base = requirementsFingerprint(BASE)
  assert.match(base, /^[0-9a-f]{8}$/)
  for (const [name, text] of Object.entries(SAME)) assert.equal(requirementsFingerprint(text), base, name)
})

test('any wording change in the five sections changes the fingerprint', () => {
  const base = requirementsFingerprint(BASE)
  for (const [name, text] of Object.entries(CHANGED)) assert.notEqual(requirementsFingerprint(text), base, name)
})

test('no requirement sections means nothing to confirm', () => {
  assert.equal(requirementsFingerprint(''), null)
  assert.equal(requirementsFingerprint('# x\n## 全景\n- a\n### 目的\n- not a section\n'), null)
})

test('the views compute the same fingerprint as doc-check', () => {
  for (const text of [BASE, ...Object.values(SAME), ...Object.values(CHANGED), '', '## 目的\n一句话']) {
    assert.equal(client.requirementsFingerprint(text), requirementsFingerprint(text), JSON.stringify(text.slice(0, 40)))
  }
})

test('success criteria are listed with their ticks', () => {
  assert.deepEqual(client.successCriteria(edit('- [ ] 月报一键导出', '- [x] **月报**一键导出')), [
    { done: false, text: '记一笔 10 秒内完成' },
    { done: true, text: '月报一键导出' },
  ])
})

const header = confirmed => parseStateHeader(`---\nstage: build\nmilestone: M1\nupdated: 2026-11-17T08:00-08:00\n${confirmed}waiting:\n  - accept: 看看第一阶段\n---\n`)

test('sheet status: confirmed, changed, never confirmed', () => {
  const project = client.parseProject(BASE)
  const fp = requirementsFingerprint(BASE)
  assert.equal(client.requirementsStatus(header(`confirmed: 2026-11-17 ${fp}\n`), project), 'confirmed')
  assert.equal(client.requirementsStatus(header(`confirmed: 2026-11-17 ${fp}\n`), client.parseProject(SAME['ticked criterion'])), 'confirmed')
  assert.equal(client.requirementsStatus(header(`confirmed: 2026-11-17 ${fp}\n`), client.parseProject(CHANGED['goal reworded'])), 'changed')
  assert.equal(client.requirementsStatus(header(''), project), 'unconfirmed')
  assert.equal(client.requirementsStatus(header('confirmed: none\n'), project), 'unconfirmed')
  assert.equal(client.requirementsStatus(header(''), client.parseProject('')), null)
  assert.equal(client.requirementsStatus({ ok: false }, project), null)
})

test('only a changed sheet adds a waiting item', () => {
  const fp = requirementsFingerprint(BASE)
  const confirmed = header(`confirmed: 2026-11-17 ${fp}\n`)
  assert.equal(client.withRequirements(confirmed, client.parseProject(BASE)), confirmed)
  const unconfirmed = header('')
  assert.equal(client.withRequirements(unconfirmed, client.parseProject(BASE)), unconfirmed)
  const changed = client.withRequirements(confirmed, client.parseProject(CHANGED['scope item moved']))
  assert.equal(changed.waiting.length, 2)
  assert.deepEqual(changed.waiting[1], { kind: 'decide', text: '', code: 'requirementsChanged' })
  assert.equal(confirmed.waiting.length, 1, 'the cached header is not mutated')
  assert.equal(client.withRequirements(undefined, client.parseProject(BASE)), undefined)
})

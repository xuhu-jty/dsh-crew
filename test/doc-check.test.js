/**
 * doc-check.mjs --confirm records the requirement fingerprint in the STATE.md header, and the
 * normal check reports a sheet edited after that. Runs the real script on a temporary project.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { requirementsFingerprint } from '../lib/requirements.js'

const SCRIPT = fileURLToPath(new URL('../scripts/doc-check.mjs', import.meta.url))
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

const PROJECT = '# 小工具\n\n## 目的\n\n记账。\n\n## 成功标准\n\n- [ ] 记一笔 10 秒内\n\n## 范围\n\n**做**：记账\n'
const STATE = '---\r\nstage: build\r\nmilestone: M1\r\nupdated: 2026-11-17T08:00-08:00\r\nwaiting: []\r\n---\r\n# 项目状态\r\n\r\n正文不动。\r\n'

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doc-check-'))
  fs.mkdirSync(path.join(root, '.team'))
  fs.writeFileSync(path.join(root, 'PROJECT.md'), PROJECT)
  fs.writeFileSync(path.join(root, '.team', 'STATE.md'), STATE)
  fs.writeFileSync(path.join(root, 'AGENTS.local.md'), '# 状态卡\n')
  return root
}

test('--confirm writes the fingerprint into the header and keeps the rest of the file', (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const result = run('--confirm', root)
  assert.equal(result.status, 0, result.stdout)
  const state = fs.readFileSync(path.join(root, '.team', 'STATE.md'), 'utf8')
  const fp = requirementsFingerprint(PROJECT)
  assert.match(state, new RegExp(`\\r\\nconfirmed: \\d{4}-\\d{2}-\\d{2} ${fp}\\r\\nwaiting: \\[\\]\\r\\n---\\r\\n`))
  assert.ok(state.endsWith('# 项目状态\r\n\r\n正文不动。\r\n'))
  assert.equal(run(root).status, 0, run(root).stdout)

  // Confirming again replaces the line instead of adding a second one.
  run('--confirm', root)
  assert.equal(fs.readFileSync(path.join(root, '.team', 'STATE.md'), 'utf8').match(/confirmed:/g).length, 1)
})

test('the normal check reports a sheet edited after confirmation, not a ticked criterion', (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  run('--confirm', root)
  fs.writeFileSync(path.join(root, 'PROJECT.md'), PROJECT.replace('- [ ]', '- [x]'))
  assert.equal(run(root).status, 0)
  fs.writeFileSync(path.join(root, 'PROJECT.md'), PROJECT.replace('**做**：记账', '**做**：记账、报表'))
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /确认之后改过/)
})

test('a project that was never confirmed passes; --confirm explains what is missing', (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(run(root).status, 0)
  fs.writeFileSync(path.join(root, 'PROJECT.md'), '# 小工具\n\n## 全景\n- a\n')
  const result = run('--confirm', root)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /没有可确认的内容/)
})

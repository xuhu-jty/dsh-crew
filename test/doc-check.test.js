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

const PROJECT = '# 小工具\n\n## 目的\n\n记账。\n\n## 升级\n\n从"记账"到"10 秒记一笔、月底看清花在哪"。\n\n## 成功标准\n\n- [ ] 记一笔 10 秒内\n\n## 范围\n\n**做**：记账\n'
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

test('STATE.md may say what is waiting for the user; other live docs may not', (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, '.team', 'STATE.md'), STATE + '\n## 等用户\n- README 改写待用户确认\n')
  assert.equal(run(root).status, 0, run(root).stdout)
  fs.writeFileSync(path.join(root, 'README.md'), '# 小工具\n\n导出格式待确认\n')
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /README\.md:3 残留待定标记/)
})

test('a delivered project with unticked success criteria is reported', (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, '.team', 'STATE.md'), STATE.replace('stage: build', 'stage: delivered'))
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /1 条成功标准没打勾/)
  fs.writeFileSync(path.join(root, 'PROJECT.md'), PROJECT.replace('- [ ]', '- [x]'))
  assert.equal(run(root).status, 0, run(root).stdout)
})

test('past intake, a project without a written upgrade is reported', (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'PROJECT.md'), PROJECT.replace(/## 升级\n\n[^\n]*\n/, '## 升级\n\n从"<用户原话的要点>"到"<结果>"。\n'))
  assert.match(run(root).stdout, /缺少写好的「升级」一节/)
  fs.writeFileSync(path.join(root, 'PROJECT.md'), PROJECT.replace(/## 升级\n\n[^\n]*\n\n/, ''))
  assert.match(run(root).stdout, /缺少写好的「升级」一节/)
  fs.writeFileSync(path.join(root, 'PROJECT.md'), PROJECT)
  assert.equal(run(root).status, 0, run(root).stdout)
})

test('the code map must list every code file and drop lines for deleted ones', (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x')
  fs.writeFileSync(path.join(root, 'src', 'a.test.js'), 'x')
  let out = run(root)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /还没有代码地图/)
  fs.writeFileSync(path.join(root, '.team', 'map.md'), 'src/gone.js | 负责：旧 | 一起看：无 | 被依赖：无 | 别改错：无\n')
  out = run(root)
  assert.match(out.stdout, /缺 1 个代码文件的行：src\/a\.js/)
  assert.match(out.stdout, /指向已经不存在的文件，删掉：src\/gone\.js/)
  fs.writeFileSync(path.join(root, '.team', 'map.md'), '| src/a.js | 负责：记账 | 一起看：无 | 被依赖：无 | 别改错：无 |\n')
  assert.equal(run(root).status, 0, run(root).stdout)
})

test('--milestone also wants the process files gone', (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, '.team', 'm1-demo.md'), '演示稿')
  assert.equal(run(root).status, 0, run(root).stdout)
  const out = run('--milestone', root)
  assert.equal(out.status, 1)
  assert.match(out.stdout, /过程文件还没清：\.team\/m1-demo\.md/)
  fs.rmSync(path.join(root, '.team', 'm1-demo.md'))
  assert.equal(run('--milestone', root).status, 0)
})

test('without git commits, cleanup says archive first instead of "git can recover it" (seen live 11-21)', (t) => {
  const root = project()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, '.team', 'm1-review.md'), '评审')
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true })
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  let out = run('--milestone', root)
  assert.match(out.stdout, /没有 git 提交，删了找不回/)
  assert.doesNotMatch(out.stdout, /git 里能找回/)
  fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n')
  out = run('--milestone', root)
  assert.match(out.stdout, /git 里能找回/)
})

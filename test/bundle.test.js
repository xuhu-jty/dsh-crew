/**
 * One package, two rows: `crew` (views + reports projection, the only client row) and
 * `crew/guard` (brakes + skill, a subpath row that loads no client half).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const read = path => readFileSync(join(ROOT, path), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('package manifest: one MIT package with a client half and two entry modules', () => {
  assert.equal(pkg.name, 'crew')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['.'], './lib/center.js')
  assert.equal(pkg.exports['./guard'], './lib/guard.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dependencies ?? {}, {})
  assert.deepEqual(pkg.devDependencies ?? {}, {})
  assert.match(read('LICENSE'), /MIT License/)
})

test('every published file exists, including the skill resources', () => {
  for (const entry of pkg.files) {
    const probe = entry.endsWith('/*.json') ? entry.replace('/*.json', '') : entry
    assert.ok(existsSync(join(ROOT, probe)), `${entry} exists`)
  }
  for (const entry of Object.values(pkg.exports)) {
    if (!entry.includes('*')) assert.ok(existsSync(join(ROOT, entry)), `${entry} exists`)
  }
})

test('patch inserts the two rows, each with only the services it uses', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /id: crew\n\s+name: 'crew'\n\s+inject: \[sessionProjections\]/u)
  assert.match(patch, /id: crew-guard\n\s+name: 'crew\/guard'\n\s+inject: \[tools, workingDirectory\]/u)
  assert.equal((patch.match(/^\s+- id:/gmu) ?? []).length, 2)
})

test('host modules import no DSH package', () => {
  for (const file of ['lib/center.js', 'lib/guard.js', 'lib/skill.js', 'lib/reports.js', 'lib/state.js']) {
    assert.equal(/^import .*['"]@deepseek-ai/mu.test(read(file)), false, file)
  }
})

test('client half is hand-written lazy-CJS registered under the package name', () => {
  const source = read('client.js')
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*\n\s*id: 'crew',/u)
  assert.equal(/require\(['"](?!react)/u.test(source), false, 'only react comes from the module table')
})

test('plugin page metadata and icon', () => {
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(read(`locale/${locale}.json`)).meta
    assert.ok(meta.title.trim() && meta.description.trim().length > 20, locale)
  }
  assert.ok(statSync(join(ROOT, 'icon.svg')).size < 256 * 1024)
})

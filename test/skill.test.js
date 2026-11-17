/**
 * The crew skill is registered by the plugin with the package directory as its resource base,
 * so every relative file SKILL.md points at must exist inside the package.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseSkillFile, registerCrewSkill, SKILL_ROOT } from '../lib/skill.js'

const raw = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8')

test('SKILL.md frontmatter gives the name and description', () => {
  const skill = parseSkillFile(raw)
  assert.equal(skill.name, 'crew')
  assert.ok(skill.description.length > 50)
  assert.ok(!skill.content.startsWith('---'), 'body has no frontmatter')
  assert.throws(() => parseSkillFile('no frontmatter'))
})

test('every relative file SKILL.md mentions exists under the resource base', () => {
  const mentioned = new Set([...raw.matchAll(/`((?:reference|roles|templates|scripts)\/[\w./*-]+)`/g)].map(m => m[1]))
  assert.ok(mentioned.size > 5, 'SKILL.md points at its resources')
  for (const rel of mentioned) {
    if (rel.includes('*')) continue
    assert.ok(existsSync(join(SKILL_ROOT, rel)), `${rel} exists`)
  }
})

test('registers one provider whose skill loads from the package directory', async () => {
  let created
  const effects = []
  const ctx = { effect: fn => { effects.push(fn()) } }
  registerCrewSkill(ctx, { registerProvider: create => { created = create({}); return () => {} } })
  assert.equal(effects.length, 1, 'the provider registration is owned by ctx.effect')
  const [candidate] = await created.list()
  assert.equal(candidate.name, 'crew')
  assert.deepEqual(candidate.resourceBase, { kind: 'directory', path: SKILL_ROOT })
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true })
  const loaded = await created.get(candidate, {})
  assert.equal(loaded.name, 'crew')
  assert.equal(loaded.rank, undefined)
  assert.equal(loaded.locator, undefined)
  assert.ok(loaded.content.includes('# 项目团队'), 'skill body is SKILL.md without frontmatter')
})

/**
 * crew holds process only. Domain rules and domain roles belong in the project that produced them
 * (reference/docs-and-retro.md §3). 11-20 to 11-22 writing rules leaked into the core manual and a
 * writer contract that every project had to read; these checks keep that from coming back.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROCESS_ROLES = ['builder.md', 'critic.md', 'reviewer.md', 'scout.md']

// Words that only make sense in one kind of project. Allowed inside parentheses, where a dated case
// is cited as an example; anywhere else they turn a process rule into a domain rule.
const DOMAIN_WORDS = ['小说', '写手', '爽点', '书名', '口癖', '细纲', '写作项目', '台账里已死']

function coreFiles() {
  const out = [path.join(ROOT, 'SKILL.md')]
  for (const dir of ['reference', 'roles', 'templates']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.md')) out.push(path.join(ROOT, dir, name))
    }
  }
  return out
}

/** Drops text inside （…） and (…), nested or not, so cited examples don't count. */
function outsideParentheses(line) {
  let depth = 0
  let kept = ''
  for (const ch of line) {
    if (ch === '（' || ch === '(') depth++
    else if ((ch === '）' || ch === ')') && depth > 0) depth--
    else if (depth === 0) kept += ch
  }
  return kept
}

test('roles are the four process contracts and nothing else', () => {
  const roles = fs.readdirSync(path.join(ROOT, 'roles')).filter(n => n.endsWith('.md')).sort()
  assert.deepEqual(roles, PROCESS_ROLES)
})

test('core files use domain words only inside cited examples', () => {
  const hits = []
  for (const file of coreFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      const text = outsideParentheses(line)
      for (const word of DOMAIN_WORDS) {
        if (text.includes(word)) hits.push(`${path.relative(ROOT, file)}:${i + 1} ${word}`)
      }
    })
  }
  assert.deepEqual(hits, [])
})

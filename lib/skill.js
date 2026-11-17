/**
 * Register the crew skill from this package, the way DHS's own bundled skills do
 * (packages/sandbox/sandbox-windows-acl/src/acl-skill.ts): one provider, one candidate whose
 * resource base is this package directory, so "reference/…", "roles/…" and "templates/…" in
 * SKILL.md resolve against the installed plugin. No copy under ~/.dsh/skills is needed.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root: SKILL.md and its reference/roles/templates/scripts folders live here. */
export const SKILL_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILL_FILE = join(SKILL_ROOT, 'SKILL.md')
/** Same rank DHS gives its own bundled skills; a user or project skill of the same name still wins. */
const BUNDLED_SKILL_RANK = 600
const PROVIDER = 'crew'

/**
 * Split SKILL.md into its frontmatter fields and the instruction body.
 * @param {string} raw - file text.
 * @returns {{name: string, description: string, content: string}}
 */
export function parseSkillFile(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(raw))
  if (!match) throw new Error('crew: SKILL.md has no frontmatter')
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]] = kv[2].trim()
  }
  if (!fields.name || !fields.description) throw new Error('crew: SKILL.md frontmatter needs name and description')
  return { name: fields.name, description: fields.description, content: raw.slice(match[0].length) }
}

/**
 * Register the provider; the returned disposer is owned by ctx.effect.
 * @param {object} ctx - Host plugin context.
 * @param {{registerProvider: Function}} skills - DHS skill registry (`ctx.skills`).
 */
export function registerCrewSkill(ctx, skills) {
  const { name, description } = parseSkillFile(readFileSync(SKILL_FILE, 'utf8'))
  const candidate = {
    name,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: SKILL_ROOT },
    locator: SKILL_FILE,
  }
  const provider = {
    name: PROVIDER,
    list: () => Promise.resolve([candidate]),
    async get(entry, options) {
      const { rank: _rank, locator, ...summary } = entry
      const raw = await readFile(locator, { encoding: 'utf8', signal: options?.signal })
      return { ...summary, content: parseSkillFile(raw).content }
    },
  }
  ctx.effect(() => skills.registerProvider(() => provider), 'crew: skill')
}

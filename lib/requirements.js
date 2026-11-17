/**
 * The requirement sheet is the first five sections of PROJECT.md (templates/PROJECT.md):
 * 目的 / 用户与场景 / 成功标准 / 范围 / 假设. When the user confirms them, the lead records a
 * fingerprint of their text in the STATE.md header (`confirmed: <date> <fingerprint>`); the views
 * recompute it and say "改过，等你重新确认" when it no longer matches.
 *
 * Not a change: blank lines, spacing at line ends, ticking a success criterion ([ ] → [x]),
 * and anything outside the five sections. client.js carries the same function (a hand-written
 * browser module cannot import files); test/requirements.test.js keeps the two identical.
 */

export const REQUIREMENT_SECTIONS = ['目的', '用户与场景', '成功标准', '范围', '假设']

/**
 * Fingerprint of the requirement sections of a PROJECT.md text.
 * @param {string} text - whole PROJECT.md text.
 * @returns {string | null} 8 hex characters; null when none of the five sections exists.
 */
export function requirementsFingerprint(text) {
  const sections = new Map()
  let current = null
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const heading = /^(#{1,2})\s+(.+)$/.exec(raw.trim())
    if (heading) {
      const name = heading[1] === '##' ? heading[2].replace(/[（(：:].*$/, '').trim() : ''
      current = REQUIREMENT_SECTIONS.includes(name) ? name : null
      if (current && !sections.has(current)) sections.set(current, [])
      continue
    }
    const line = raw.trim().replace(/^([-*]\s+)\[[xX ]\]/, '$1[ ]')
    if (current && line !== '') sections.get(current).push(line)
  }
  if (sections.size === 0) return null
  const canonical = REQUIREMENT_SECTIONS.filter(name => sections.has(name)).map(name => `## ${name}\n${sections.get(name).join('\n')}`).join('\n')
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * crew-center Client plugin (hand-written lazy-CJS, no build step). M1 per DESIGN.md:
 *  A. a "waiting" dot on lead-session rows + one line in the row hover card,
 *  C. the "项目" page: waiting items, last 7 days, tidy suggestion,
 *  D. the tidy panel: batch-archive old/blank/scratch conversations through DHS's own
 *     archive, with undo.
 * Everything is read in the page from DHS's session list, workspace snapshot and each
 * project's `.team/STATE.md` header. Nothing is written into any session; the only
 * writes are `uiWorkspace.archiveSession` / `unarchiveSession`, always user-confirmed.
 * The pure logic is returned as `model` so the offline tests can drive it.
 */
window.__ModuleLoader__.load({
  id: 'crew',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useState, useSyncExternalStore } = React

    const NS = 'crewCenter'
    const PANEL_ID = 'crew-center'
    const DAY = 24 * 60 * 60 * 1000
    const STALE_DAYS = 30
    const RECENT_DAYS = 7
    const BLOCK_LIMIT = 7
    const HEADER_TTL = 60 * 1000

    // ------------------------------------------------------------------ model (pure)

    const STAGES = ['intake', 'plan', 'design', 'foundation', 'build', 'deliver', 'delivered', 'paused']
    /** Waiting kinds, most urgent first (DESIGN.md §3 C). */
    const WAIT_ORDER = ['authorize', 'accept', 'decide', 'answer', 'act']
    const SCRATCH_SEGMENTS = new Set(['downloads', 'temp', 'tmp', 'fake'])
    const DATE_LIKE = /^(19|20)\d{5,6}$/

    /**
     * Parse the machine-readable header of `.team/STATE.md` (crew templates/STATE.md).
     * @param {string} text - whole file text.
     * @returns {{ok: true, stage: string, milestone: string, updated: string, confirmed: {date: string, fingerprint: string} | null, waiting: {kind: string, text: string}[]} | {ok: false}}
     */
    function parseStateHeader(text) {
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(String(text ?? ''))
      if (!match) return { ok: false }
      const fields = {}
      const waiting = []
      let inWaiting = false
      for (const line of match[1].split(/\r?\n/)) {
        const item = /^\s+-\s+([a-z]+):\s*(.+)$/.exec(line)
        if (item && inWaiting) {
          if (WAIT_ORDER.includes(item[1])) waiting.push({ kind: item[1], text: item[2].trim() })
          continue
        }
        const kv = /^([a-z]+):\s*(.*)$/.exec(line)
        if (!kv) continue
        fields[kv[1]] = kv[2].trim()
        inWaiting = kv[1] === 'waiting'
      }
      if (!STAGES.includes(fields.stage)) return { ok: false }
      const confirmed = /^(\d{4}-\d{2}-\d{2})\s+([0-9a-f]{8})$/.exec(String(fields.confirmed ?? '').trim())
      return { ok: true, stage: fields.stage, milestone: fields.milestone ?? 'none', updated: fields.updated ?? '', confirmed: confirmed ? { date: confirmed[1], fingerprint: confirmed[2] } : null, waiting }
    }

    /** The requirement sheet: the first five sections of PROJECT.md (crew lib/requirements.js). */
    const REQUIREMENT_SECTIONS = ['目的', '用户与场景', '成功标准', '范围', '假设']

    /**
     * Fingerprint of the requirement sections; same rules as crew lib/requirements.js (blank
     * lines, line-end spacing and ticked criteria do not count). null when none exists.
     */
    function requirementsFingerprint(text) {
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

    /** Success criteria (`- [ ]` / `- [x]` lines under "## 成功标准"). */
    function successCriteria(text) {
      const out = []
      let inside = false
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const heading = /^(#{1,2})\s+(.+)$/.exec(raw.trim())
        if (heading) { inside = heading[1] === '##' && heading[2].replace(/[（(：:].*$/, '').trim() === '成功标准'; continue }
        const item = inside ? /^[-*]\s+\[([ xX])\]\s+(.+)$/.exec(raw.trim()) : null
        if (item) out.push({ done: item[1] !== ' ', text: item[2].replace(/\*\*|`/g, '') })
      }
      return out
    }

    /** First line of "## 升级" in PROJECT.md; same rules as crew lib/requirements.js upgradeLine. */
    function upgradeLine(text) {
      let inside = false
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const heading = /^(#{1,2})\s+(.+)$/.exec(raw.trim())
        if (heading) {
          if (inside) return null
          inside = heading[1] === '##' && heading[2].replace(/[（(：:].*$/, '').trim() === '升级'
          continue
        }
        const line = raw.trim()
        if (!inside || line === '' || line.startsWith('>')) continue
        if (/<[^>]+>/.test(line)) return null
        const plain = line.replace(/^[-*]\s+/, '').replace(/\*\*|`/g, '')
        return plain.length > 160 ? `${plain.slice(0, 159)}…` : plain
      }
      return null
    }

    /**
     * Milestone ids from the "## 里程碑" table of PROJECT.md ("0", "1", … or "M0", …), in order.
     * The pipeline uses them to say "milestone 6 of 6" instead of the raw id, which starts at 0.
     */
    function milestoneIds(text) {
      const out = []
      let inside = false
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const heading = /^(#{1,2})\s+(.+)$/.exec(raw.trim())
        if (heading) { inside = heading[1] === '##' && heading[2].replace(/[（(：:].*$/, '').trim() === '里程碑'; continue }
        const row = inside ? /^\|\s*\**M?(\d+)\**\s*\|/i.exec(raw.trim()) : null
        if (row && !out.includes(row[1])) out.push(row[1])
      }
      return out
    }

    /** "第 6 个，共 6 个" position of the current milestone, or null when the table does not list it. */
    function milestonePosition(milestone, ids) {
      const id = /^M?(\d+)$/i.exec(String(milestone ?? ''))?.[1]
      const index = id === undefined ? -1 : (ids ?? []).indexOf(id)
      return index < 0 ? null : { n: index + 1, total: ids.length }
    }

    /** What the views need from PROJECT.md. */
    function parseProject(text) {
      return { goal: parseGoal(text), upgrade: upgradeLine(text), fingerprint: requirementsFingerprint(text), criteria: successCriteria(text), milestones: milestoneIds(text) }
    }

    /**
     * Where the requirement sheet stands: 'confirmed', 'changed' (confirmed, then edited),
     * 'unconfirmed', or null when there is no sheet to confirm (no header or no sections).
     */
    function requirementsStatus(header, project) {
      if (!header?.ok || !project?.fingerprint) return null
      if (!header.confirmed) return 'unconfirmed'
      return header.confirmed.fingerprint === project.fingerprint ? 'confirmed' : 'changed'
    }

    /**
     * The header the views show: a changed requirement sheet adds one "decide" item, so the
     * row dot, the hover line and the projects page pick it up like any other waiting item.
     * Never confirmed adds nothing: old projects would otherwise all light up at once.
     */
    function withRequirements(header, project) {
      if (requirementsStatus(header, project) !== 'changed') return header
      return { ...header, waiting: [...header.waiting, { kind: 'decide', text: '', code: 'requirementsChanged' }] }
    }

    /** A waiting item's sentence: the lead's own words, or plugin copy for items the plugin adds. */
    function waitText(item, t) {
      return item.code ? t(item.code) : item.text
    }

    /** Case-insensitive comparison key for a Windows or POSIX directory path. */
    function pathKey(path) {
      return String(path ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
    }

    /** Downloads / temp / tmp / fake / date-named folders are not projects. */
    function isScratchPath(path) {
      return String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean)
        .some(segment => SCRATCH_SEGMENTS.has(segment.toLowerCase()) || DATE_LIKE.test(segment))
    }

    const isRoot = row => row != null && row.origin !== 'subagent' && !row.parentId
    const taskCount = row => (Array.isArray(row?.projectionValues?.agentTeam?.tasks) ? row.projectionValues.agentTeam.tasks.length : 0)
    const isLeadRow = row => isRoot(row) && taskCount(row) > 0

    /**
     * The lead conversation of the crew project in `cwd`. With a crew STATE.md header that is the
     * newest non-blank conversation in the folder: on a small project the lead often works alone
     * and never creates a team task (seen live 11-17), so "has tasks" alone would hide the
     * project. Without a header only conversations that run a task board count.
     * @returns {string|null}
     */
    function crewLead(byId, cwd, hasHeader) {
      const key = pathKey(cwd)
      if (!key) return null
      let best = null
      for (const row of Object.values(byId ?? {})) {
        if (!isRoot(row) || row.blank || pathKey(row.cwd) !== key) continue
        if (!hasHeader && !isLeadRow(row)) continue
        if (best === null || (row.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = row
      }
      return best?.id ?? null
    }

    /**
     * Group DHS data into projects (one per listed workspace).
     * @param {{byId?: Record<string, object>}} sessions - session list state.
     * @param {{items?: object[], archivedSessionIds?: string[]}} workspaces - workspace snapshot.
     * @returns {{key: string, title: string, path: string, leadId: string|null, sessionIds: string[], lastId: string|null, lastAt: number}[]}
     */
    function buildProjects(sessions, workspaces) {
      const byId = sessions?.byId ?? {}
      const archived = new Set(workspaces?.archivedSessionIds ?? [])
      const projects = []
      for (const item of workspaces?.items ?? []) {
        const rows = (item.sessionIds ?? []).filter(id => !archived.has(id)).map(id => byId[id]).filter(isRoot)
        let lead = null
        let last = null
        for (const row of rows) {
          if (isLeadRow(row) && (lead === null || row.updatedAt > lead.updatedAt)) lead = row
          if (last === null || row.updatedAt > last.updatedAt) last = row
        }
        projects.push({
          key: pathKey(item.path),
          title: item.title || item.path,
          path: item.path,
          leadId: lead?.id ?? null,
          sessionIds: rows.map(row => row.id),
          lastId: last?.id ?? null,
          lastTitle: last?.displayTitle ?? last?.title ?? null,
          lastAt: last?.updatedAt ?? 0,
        })
      }
      return projects
    }

    /** The lead session that should carry the waiting dot, per project key. */
    function leadIdsByProject(projects) {
      const out = new Map()
      for (const project of projects) if (project.leadId) out.set(project.key, project.leadId)
      return out
    }

    /**
     * All waiting items across projects, most urgent kind first.
     * @param {object[]} projects - from buildProjects.
     * @param {Map<string, object>} headers - parsed headers by project key.
     */
    function collectWaiting(projects, headers) {
      const out = []
      for (const project of projects) {
        const header = headers.get(project.key)
        if (!project.leadId || !header?.ok) continue
        for (const item of header.waiting) out.push({ project: project.title, leadId: project.leadId, kind: item.kind, text: item.text, code: item.code })
      }
      return out.sort((a, b) => WAIT_ORDER.indexOf(a.kind) - WAIT_ORDER.indexOf(b.kind) || a.project.localeCompare(b.project))
    }

    /** Projects with activity in the last 7 days, newest first. */
    function recentProjects(projects, now) {
      return projects.filter(p => p.lastAt > 0 && now - p.lastAt <= RECENT_DAYS * DAY).sort((a, b) => b.lastAt - a.lastAt)
    }

    /** Batches in the order they are offered; a conversation only appears in the first one it fits. */
    const TIDY_BATCHES = ['superseded', 'delivered', 'stale', 'blank', 'scratch']
    const SUPERSEDED_DAYS = 1
    const DELIVERED_DAYS = 3

    /**
     * Tidy candidates (DESIGN.md §3 D), by what a conversation is for, not only its age:
     * - superseded: an older lead conversation of a project that a newer lead ("接续 …") took over;
     * - delivered: conversations of a project whose STATE.md says it was delivered;
     * - stale (30+ days), blank, scratch-folder: as before, only after 7 quiet days.
     * Never: pinned, running, the lead that has waiting items, archived or member rows.
     * Conversations outside every folder (DHS's "未分组") are covered too, with `folder: null`.
     * @param {Set<string>} [deliveredKeys] - pathKey of projects whose header stage is `delivered`.
     * @returns {{superseded: object[], delivered: object[], stale: object[], blank: object[], scratch: object[]}}
     */
    function tidyCandidates({ sessions, workspaces, waitingLeadIds, deliveredKeys, now }) {
      const byId = sessions?.byId ?? {}
      const archived = new Set(workspaces?.archivedSessionIds ?? [])
      const pinned = new Set(workspaces?.pinnedSessionIds ?? [])
      const protectedIds = new Set(waitingLeadIds ?? [])
      const delivered = deliveredKeys ?? new Set()
      const batches = Object.fromEntries(TIDY_BATCHES.map(key => [key, []]))
      const grouped = new Set()
      const groups = (workspaces?.items ?? []).map(item => {
        for (const id of item.sessionIds ?? []) grouped.add(id)
        const rows = (item.sessionIds ?? []).filter(id => !archived.has(id)).map(id => byId[id]).filter(isRoot)
        const leads = rows.filter(isLeadRow).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        return { folder: item.title || item.path, rows, scratchFolder: isScratchPath(item.path) && rows.length === 1, latestLead: leads[0]?.id ?? null, delivered: delivered.has(pathKey(item.path)) }
      })
      const ungrouped = Object.values(byId).filter(row => isRoot(row) && !grouped.has(row.id) && !archived.has(row.id))
      groups.push({ folder: null, rows: ungrouped, scratchFolder: false, latestLead: null, delivered: false })
      for (const { folder, rows, scratchFolder, latestLead, delivered: projectDelivered } of groups) {
        for (const row of rows) {
          if (pinned.has(row.id) || row.running || protectedIds.has(row.id)) continue
          const idle = now - (row.updatedAt ?? 0)
          const entry = { id: row.id, title: row.title || '', folder, updatedAt: row.updatedAt ?? 0 }
          if (isLeadRow(row) && latestLead && row.id !== latestLead && idle > SUPERSEDED_DAYS * DAY) batches.superseded.push(entry)
          else if (projectDelivered && idle > DELIVERED_DAYS * DAY) batches.delivered.push(entry)
          else if (idle <= RECENT_DAYS * DAY) continue
          else if (idle > STALE_DAYS * DAY) batches.stale.push(entry)
          else if (row.blank) batches.blank.push(entry)
          else if (scratchFolder) batches.scratch.push(entry)
        }
      }
      for (const list of Object.values(batches)) list.sort((a, b) => a.updatedAt - b.updatedAt)
      return batches
    }

    /** "刚刚 / N 分钟前 / N 小时前 / N 天前" in zh, English equivalents in en. */
    function relativeTime(at, now, zh = true) {
      if (!at) return zh ? '没有记录' : 'never'
      const minutes = Math.max(0, Math.floor((now - at) / 60000))
      if (minutes < 1) return zh ? '刚刚' : 'just now'
      if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes} min ago`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`
      const days = Math.floor(hours / 24)
      return zh ? `${days} 天前` : `${days} d ago`
    }

    /**
     * Folders whose conversations are all archived (or that have none). Removing one only
     * drops DHS's folder registration; files and conversation logs stay, but it cannot be undone.
     * @returns {{id: string, title: string, path: string, archivedCount: number}[]}
     */
    function emptyFolders(workspaces) {
      const archived = new Set(workspaces?.archivedSessionIds ?? [])
      return (workspaces?.items ?? [])
        .filter(item => (item.sessionIds ?? []).every(id => archived.has(id)))
        .map(item => ({ id: item.workspaceId, title: item.title || item.path, path: item.path, archivedCount: (item.sessionIds ?? []).length }))
    }

    // ---------------------------------------------------------------- M2 pipeline model

    /** "[M0] DSH 源码 dev 环境" -> "DSH 源码 dev 环境". */
    function stripTitle(subject) {
      return String(subject ?? '').replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim()
    }

    /**
     * Which pipeline the conversation belongs to: a lead shows its own team, a member shows its
     * lead's team with its own tasks highlighted, anything else gets the short version.
     */
    function pipelineContext(sessionId, byId, hasHeaderFor = () => false) {
      const isLead = row => isLeadRow(row) || (isRoot(row) && crewLead(byId, row.cwd, hasHeaderFor(row.cwd)) === row.id)
      const row = byId?.[sessionId]
      if (isLead(row)) return { kind: 'lead', leadId: row.id }
      const parent = row?.parentId ? byId?.[row.parentId] : undefined
      if (row?.origin === 'subagent' && parent && isLead(parent)) return { kind: 'member', leadId: parent.id }
      return { kind: 'plain', leadId: null }
    }

    /**
     * Visible tasks grouped into columns by dependency depth (no unfinished-dependency
     * semantics: depth = longest chain of `blockedBy` inside the board). Cycles are cut.
     * @returns {object[][]} columns of tasks, each column ordered by task number.
     */
    function taskColumns(tasks) {
      const visible = (Array.isArray(tasks) ? tasks : []).filter(task => task && task.status !== 'deleted')
      const byId = new Map(visible.map(task => [task.id, task]))
      const depth = new Map()
      const depthOf = (task, path = new Set()) => {
        if (depth.has(task.id)) return depth.get(task.id)
        if (path.has(task.id)) return 0
        path.add(task.id)
        let value = 0
        for (const dep of task.blockedBy ?? []) {
          const parent = byId.get(dep)
          if (parent) value = Math.max(value, depthOf(parent, path) + 1)
        }
        path.delete(task.id)
        depth.set(task.id, value)
        return value
      }
      const columns = []
      for (const task of visible) {
        const d = depthOf(task)
        ;(columns[d] ??= []).push(task)
      }
      const num = id => Number(/(\d+)$/.exec(String(id))?.[1] ?? 0)
      return columns.filter(Boolean).map(column => column.sort((a, b) => num(a.id) - num(b.id)))
    }

    /**
     * Task state in plain words: problem / done / doing / waiting on earlier tasks / not started.
     * "problem" = the member's latest report says 阻塞 or 需要决定, or the board warns about
     * overlapping write scopes (DESIGN.md §3 B).
     */
    function taskState(task, byId, report) {
      if (task.status !== 'completed' && (report?.status === '阻塞' || report?.status === '需要决定')) return 'problem'
      if (Array.isArray(task.writeScopeWarnings) && task.writeScopeWarnings.length > 0) return 'problem'
      if (task.status === 'completed') return 'done'
      if (task.status === 'in_progress') return 'doing'
      const blocked = (task.blockedBy ?? []).some(dep => byId.get(dep) && byId.get(dep).status !== 'completed')
      return blocked ? 'blocked' : 'todo'
    }

    /** First sentence under "## 目的" (or "## Goal") in PROJECT.md; null when absent. */
    function parseGoal(text) {
      const lines = String(text ?? '').split(/\r?\n/)
      const start = lines.findIndex(line => /^##\s*(目的|goal|purpose)(\s|$|[（(：:])/i.test(line.trim()))
      if (start < 0) return null
      for (const raw of lines.slice(start + 1)) {
        const line = raw.trim()
        if (line.startsWith('#')) return null
        if (line === '' || line.startsWith('>')) continue
        const plain = line.replace(/\*\*|`/g, '')
        const sentence = /^(.+?[。！？.!?])/.exec(plain)?.[1] ?? plain
        return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence
      }
      return null
    }

    /** First paragraph of a task description (milestone tag removed), for the detail panel. */
    function firstParagraph(text) {
      const para = stripTitle(String(text ?? '').split(/\r?\n\s*\r?\n/).map(part => part.trim()).find(Boolean) ?? '')
      return para.length > 300 ? `${para.slice(0, 299)}…` : para
    }

    /** How many card widths a task column uses: one per six tasks, at most three. */
    function columnCards(count) {
      return Math.max(1, Math.min(3, Math.ceil(count / 6)))
    }

    /** Member names are "<role>-<scope>" (reference/team-ops.md); the role prefix becomes a plain word. */
    const ROLES = ['scout', 'critic', 'product', 'architect', 'designer', 'builder', 'reviewer', 'qa', 'docs', 'compliance']
    /** Names leads actually used before the naming rule (seen in real projects: "review-architect"). */
    const ROLE_ALIASES = { review: 'reviewer', design: 'designer', build: 'builder', test: 'qa', doc: 'docs', arch: 'architect' }
    /** The name DHS gives a member when the lead passes none (seen live 11-17). */
    const AUTO_NAME = /^agent-\d+$/i

    /**
     * Who does a task, in words the user can read: the lead itself, or the member's role plus
     * its name (so two builders stay apart). `role` is a ROLES key or null for unknown names.
     */
    function ownerInfo(ownerId, ownerName, leadId) {
      const isLead = Boolean(ownerId) && ownerId === leadId
      const name = typeof ownerName === 'string' && ownerName.trim() ? ownerName.trim() : null
      const raw = name ? name.toLowerCase().split(/[-_\d]/)[0] : ''
      const prefix = ROLE_ALIASES[raw] ?? raw
      return { id: ownerId ?? null, isLead, role: ROLES.includes(prefix) ? prefix : null, name }
    }

    // "无" may come with an explanation ("无（只写评审报告…）", seen live 11-17): still nothing.
    const NONE = /^((无|没有|none|n\/a)([。.，,；;:：（(\s].*)?)?$/is

    /**
     * Each task's latest report. Reports normally carry the task id; one a member sent without it
     * is folded under `@<member>` (lib/reports.js) and counts for the most recent unfinished-or-last
     * task that member owns, unless a newer report names the task. Reports that match no task on
     * the board stay under their own key: a lead working without a task board still sends members
     * out (seen live 11-17), and their decisions must not vanish.
     * @returns {Record<string, object>} reports keyed by task id (or their original key).
     */
    function reportsByTask(tasks, reports) {
      const out = {}
      const list = Array.isArray(tasks) ? tasks.filter(task => task && task.status !== 'deleted') : []
      for (const [key, report] of Object.entries(reports ?? {})) if (report && !key.startsWith('@')) out[key] = report
      for (const [key, report] of Object.entries(reports ?? {})) {
        if (!key.startsWith('@') || !report) continue
        const owned = list.filter(task => task.ownerName === key.slice(1))
        const task = owned.find(item => item.status !== 'completed' && !out[item.id]) ?? owned[owned.length - 1]
        if (!task) out[key] = report
        else if ((out[task.id]?.at ?? 0) <= (report.at ?? 0)) out[task.id] = { ...report, taskId: task.id }
      }
      return out
    }

    /**
     * Decisions the team made on its own while working (the "偏离" line of a hand-over report):
     * the unknowns found during implementation, shown so the user can overrule them.
     * Newest first, at most `limit`.
     */
    /**
     * Same rules as crew lib/state.js jargonIn, plus a length cap: a deviation is shown to the user
     * as written, so one with paths, file names, commands or code quotes is a technical detail.
     */
    const JARGON = [/`/, /[\w-]+\.(md|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|ps1|sh|py|html|css|toml|lock)\b/i, /[A-Za-z]:\\|(^|[\s(（])\.{0,2}\/[\w.-]+\/|\\[\w.-]+\\/, /\btask-\d+\b/i, /(^|\s)--?[a-z][\w-]*/i, /\bcwd\b|探针|变异|非产品问题/i]
    const PLAIN_LIMIT = 80
    function isPlain(text) {
      const value = String(text ?? '').trim()
      return value.length <= PLAIN_LIMIT && !JARGON.some(re => re.test(value))
    }

    function deviations(tasks, reports, limit = 5) {
      const titles = new Map((Array.isArray(tasks) ? tasks : []).map(task => [task.id, stripTitle(task.subject)]))
      // A task gone from the board (deleted) drops its report; one never on a board shows its sender.
      const deleted = new Set((Array.isArray(tasks) ? tasks : []).filter(task => task?.status === 'deleted').map(task => task.id))
      return Object.values(reports ?? {})
        .filter(report => report && typeof report.deviation === 'string' && !NONE.test(report.deviation.trim()) && !deleted.has(report.taskId))
        .filter(report => titles.has(report.taskId) || report.from)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
        .slice(0, limit)
        .map(report => ({ taskId: report.taskId ?? `@${report.from}`, title: titles.get(report.taskId) ?? report.from, text: report.deviation, plain: isPlain(report.deviation) }))
    }

    /**
     * Total tokens of one conversation from DHS's own `tokenUsage` projection, or null. The session
     * list carries its wire view, the four totals flat (DHS 0.2.2 TokenUsageProjection); the stored
     * state nests them under `totals`. Both are read.
     */
    function tokensOf(row) {
      const usage = row?.projectionValues?.tokenUsage
      const totals = usage?.totals ?? usage
      if (!totals || typeof totals !== 'object') return null
      const sum = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].reduce((acc, key) => acc + (Number(totals[key]) || 0), 0)
      return sum > 0 ? sum : null
    }

    /**
     * How much the lead and each member used, biggest first; null when DHS sent no usage.
     * @returns {{id: string, isLead: boolean, name: string|null, tokens: number}[] | null}
     */
    function teamUsage(byId, leadId, tasks) {
      const names = new Map()
      for (const task of Array.isArray(tasks) ? tasks : []) if (task.ownerId && !names.has(task.ownerId)) names.set(task.ownerId, task.ownerName ?? null)
      const ids = [leadId, ...Object.values(byId ?? {}).filter(row => row?.parentId === leadId).map(row => row.id)]
      const out = []
      for (const id of new Set(ids)) {
        const tokens = tokensOf(byId?.[id])
        if (tokens !== null) out.push({ id, isLead: id === leadId, name: names.get(id) ?? byId[id]?.projectionValues?.subagent?.name ?? null, tokens })
      }
      return out.length === 0 ? null : out.sort((a, b) => b.tokens - a.tokens)
    }

    /**
     * Everything spent in one project folder: every conversation whose folder is `key`, plus the
     * members those conversations started. The pipeline shows it next to the current stretch, so a
     * project that rotated its lead conversation does not look cheaper than it was.
     */
    function projectUsage(byId, key) {
      if (!key) return null
      const rows = Object.values(byId ?? {})
      const roots = new Set(rows.filter(row => row?.cwd && pathKey(row.cwd) === key).map(row => row.id))
      let total = 0
      for (const row of rows) {
        if (!row || !(roots.has(row.id) || roots.has(row.parentId))) continue
        total += tokensOf(row) ?? 0
      }
      return total > 0 ? total : null
    }

    /** 123456789 -> "1.2 亿" / "123.5M"; 51415000 -> "5142 万"; 35000 -> "3.5 万" / "35K". */
    function formatTokens(n, zh = true) {
      if (zh) return n >= 1e8 ? `${(n / 1e8).toFixed(1)} 亿` : n >= 1e6 ? `${Math.round(n / 1e4)} 万` : n >= 1e4 ? `${Math.round(n / 1e3) / 10} 万` : String(n)
      return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n)
    }

    const model = { parseStateHeader, pathKey, isScratchPath, buildProjects, leadIdsByProject, collectWaiting, recentProjects, tidyCandidates, emptyFolders, relativeTime, stripTitle, pipelineContext, taskColumns, taskState, parseGoal, requirementsFingerprint, successCriteria, upgradeLine, parseProject, requirementsStatus, withRequirements, firstParagraph, columnCards, ownerInfo, crewLead, reportsByTask, deviations, tokensOf, teamUsage, projectUsage, formatTokens, isPlain, milestoneIds, milestonePosition, STAGES, WAIT_ORDER }

    // ------------------------------------------------------------------ copy

    const zh = {
      panel: '项目',
      title: '项目',
      loading: '正在读取项目…',
      loadError: '暂时读不到项目信息',
      retry: '重试',
      waitingTitle: '等你的事',
      recentTitle: '最近 7 天在做的',
      tidyTitle: '整理建议',
      handle: '去处理',
      open: '打开',
      showAll: '查看全部',
      collapse: '收起',
      allEmpty: '没有事在等你，最近 7 天也没有在做的项目。',
      waitingLine: '{stage} · {n} 件事等你',
      moreWaiting: '还有 {n} 件',
      dotLabel: '有 {n} 件事等你',
      tidySummary: '{n} 段对话可以收起来',
      tidyButton: '整理一下',
      back: '返回',
      tidyIntro: '归档只是从左栏收起来，随时能在 DHS 的归档筛选里找回，不删除任何内容。',
      batch_superseded: '已经被新会话接手的旧负责人对话',
      batch_delivered: '已交付项目里的对话',
      batch_stale: '超过 30 天没动',
      batch_blank: '空对话（开了但没发过消息）',
      batch_scratch: '临时文件夹里的唯一一段对话',
      untitled: '（没有标题）',
      ungrouped: '未分组',
      archiveN: '归档 {n} 段',
      archiving: '正在归档…',
      archived: '已归档 {n} 段',
      undo: '撤销',
      undone: '已撤销，{n} 段回到左栏',
      failed: '{n} 段没归档成功，已保留在左栏',
      nothingToTidy: '没有需要整理的对话。',
      foldersTitle: '空文件夹',
      foldersSummary: '{n} 个文件夹已经空了',
      listSeparator: '；',
      foldersIntro: '这些文件夹里的对话都已归档。移除只是从左栏去掉文件夹登记，文件和对话都不删；里面的对话以后取消归档，会出现在“未分组”里。这一步不能撤销，所以默认一个都不选。',
      foldersArchivedCount: '{n} 段已归档',
      foldersRemove: '移除 {n} 个文件夹…',
      foldersConfirm: '确认移除 {n} 个（不能撤销）',
      foldersRemoving: '正在移除…',
      foldersRemoved: '已移除 {n} 个文件夹',
      foldersFailed: '{n} 个没移除成功，还在左栏',
      cancel: '取消',
      pipelineTab: '流水线',
      leadName: '负责人',
      role: { scout: '勘察', critic: '方案评审', product: '产品评审', architect: '架构评审', designer: '设计', builder: '实现', reviewer: '评审', qa: '测试', docs: '文档', compliance: '合规' },
      none: '—',
      goalLabel: '目标',
      upgradeLabel: '升级',
      noGoal: '还没有写下目标',
      requirementsChanged: '需求改过了，等你重新确认',
      sheetConfirmed: '需求已确认 · {date}',
      sheetChanged: '确认后改过',
      sheetUnconfirmed: '需求还没确认',
      criteriaLine: '成功标准 {done}/{total} 条已做到',
      sheetChangedHint: '你确认过的需求（目的、用户、成功标准、范围、假设）后来被改了。在负责人对话里说“把改了什么给我看”，没问题再说“需求确认”。',
      sheetUnconfirmedHint: '需求（目的、用户、成功标准、范围、假设）还没经过你确认。在负责人对话里说“把需求确认单给我看”，没问题再说“需求确认”。',
      progressLine: '现在：{stage}',
      progressMilestone: '现在：{stage} · 第 {n} 个里程碑（共 {total} 个）',
      progressMilestoneRaw: '现在：{stage} · 里程碑 {m}',
      decisionsTitle: '团队替你定的事',
      decisionsHint: '做的过程中遇到计划没写到的情况，团队按稳妥的做法先定了。不同意就在负责人对话里说。',
      tasksTitle: '在做的任务',
      doneTasks: '已完成 {n} 个 ▸',
      hideDone: '收起已完成的',
      allDone: '任务都完成了。',
      usageTitle: '用量',
      usageLine: '用量：一共约 {total}，最多的是{top}（{share}%）',
      usageProject: '用量：这个项目一共约 {project}；这一段约 {total}，最多的是{top}（{share}%）',
      decisionsTechnical: '另有 {n} 条技术细节，不影响你怎么用，在负责人对话里。',
      usageHint: '单位是模型读写的文字量。数字越大越贵；一个成员占得特别多，通常是它在很长的对话里走了很多步。',
      noTasks: '没有拆成任务：负责人自己在做，进度看上面的成功标准。',
      detailWhat: '做什么',
      detailWho: '谁在做',
      detailOutput: '改了哪些文件',
      detailResult: '结果',
      detailEvidence: '证据',
      detailDeviation: '自己定的事',
      openChat: '回到这段对话',
      noTeam: '这段对话没有用团队方式推进',
      yourTask: '你在这段对话里负责的',
      task_done: '完成',
      task_doing: '正在做',
      task_blocked: '等前面的任务',
      task_todo: '还没开始',
      task_problem: '有问题',
      detailUnverified: '没验证的',
      detailLeftover: '遗留',
      evidenceNotListed: '回报里没写检查结果，点“回到这段对话”看全文',
      noReport: '还没收到回报',
      reportsPending: '回报要在负责人对话打开过一次之后才显示',
      openLead: '打开负责人对话',
      stage: { intake: '想清楚要做什么', plan: '定方案', design: '定界面样子', foundation: '打地基', build: '做功能', deliver: '交付', delivered: '已交付', paused: '暂停' },
      kind: { answer: '回答', decide: '决定', accept: '验收', authorize: '允许', act: '需要你动手' },
    }
    const en = {
      panel: 'Projects',
      title: 'Projects',
      loading: 'Reading projects…',
      loadError: 'Project information is not available right now',
      retry: 'Retry',
      waitingTitle: 'Waiting for you',
      recentTitle: 'Active in the last 7 days',
      tidyTitle: 'Tidy up',
      handle: 'Handle',
      open: 'Open',
      showAll: 'Show all',
      collapse: 'Collapse',
      allEmpty: 'Nothing is waiting for you and no project was active in the last 7 days.',
      waitingLine: '{stage} · {n} waiting for you',
      moreWaiting: '{n} more',
      dotLabel: '{n} waiting for you',
      tidySummary: '{n} conversations can be put away',
      tidyButton: 'Tidy up',
      back: 'Back',
      tidyIntro: 'Archiving only hides conversations from the sidebar. They stay in DHS’s archived filter and nothing is deleted.',
      batch_superseded: 'Old lead conversations a newer one took over',
      batch_delivered: 'Conversations of delivered projects',
      batch_stale: 'Idle for more than 30 days',
      batch_blank: 'Empty (never sent a message)',
      batch_scratch: 'The only conversation in a scratch folder',
      untitled: '(untitled)',
      ungrouped: 'Ungrouped',
      archiveN: 'Archive {n}',
      archiving: 'Archiving…',
      archived: 'Archived {n}',
      undo: 'Undo',
      undone: 'Undone, {n} back in the sidebar',
      failed: '{n} could not be archived and stay in the sidebar',
      nothingToTidy: 'Nothing to tidy.',
      foldersTitle: 'Empty folders',
      foldersSummary: '{n} folders are empty',
      listSeparator: '; ',
      foldersIntro: 'Every conversation in these folders is archived. Removing a folder only drops it from the sidebar; files and conversations are kept, and unarchived conversations will show under Ungrouped. This cannot be undone, so nothing is preselected.',
      foldersArchivedCount: '{n} archived',
      foldersRemove: 'Remove {n} folders…',
      foldersConfirm: 'Confirm removing {n} (cannot be undone)',
      foldersRemoving: 'Removing…',
      foldersRemoved: 'Removed {n} folders',
      foldersFailed: '{n} could not be removed and stay in the sidebar',
      cancel: 'Cancel',
      pipelineTab: 'Pipeline',
      leadName: 'Lead',
      role: { scout: 'Scout', critic: 'Plan review', product: 'Product review', architect: 'Architecture review', designer: 'Design', builder: 'Build', reviewer: 'Review', qa: 'Testing', docs: 'Docs', compliance: 'Compliance' },
      none: '—',
      goalLabel: 'Goal',
      upgradeLabel: 'Raised to',
      noGoal: 'No goal written down yet',
      requirementsChanged: 'The requirements changed and need your confirmation again',
      sheetConfirmed: 'Requirements confirmed · {date}',
      sheetChanged: 'Changed since you confirmed',
      sheetUnconfirmed: 'Requirements not confirmed yet',
      criteriaLine: 'Success criteria: {done} of {total} met',
      sheetChangedHint: 'The requirements you confirmed (goal, users, success criteria, scope, assumptions) changed since. Ask the lead "show me what changed", then say "requirements confirmed" if it looks right.',
      sheetUnconfirmedHint: 'You have not confirmed the requirements (goal, users, success criteria, scope, assumptions) yet. Ask the lead "show me the requirement sheet", then say "requirements confirmed" if it looks right.',
      progressLine: 'Now: {stage}',
      progressMilestone: 'Now: {stage} · milestone {n} of {total}',
      progressMilestoneRaw: 'Now: {stage} · milestone {m}',
      decisionsTitle: 'Decided for you by the team',
      decisionsHint: 'The plan did not cover these, so the team took the safe option. Say so in the lead conversation if you disagree.',
      tasksTitle: 'Tasks in progress',
      doneTasks: '{n} done ▸',
      hideDone: 'Hide finished',
      allDone: 'All tasks are done.',
      usageTitle: 'Usage',
      usageLine: 'Usage: about {total} in all, most of it by {top} ({share}%)',
      usageProject: 'Usage: about {project} for this project; this stretch about {total}, most of it by {top} ({share}%)',
      decisionsTechnical: '{n} more technical notes that do not change how you use it are in the lead conversation.',
      usageHint: 'Counted in text the model read and wrote. Bigger is more expensive; one member taking far more usually means it ran many steps in a very long conversation.',
      noTasks: 'Not split into tasks: the lead is doing it alone. Progress is the success criteria above.',
      detailWhat: 'What',
      detailWho: 'Who',
      detailOutput: 'Files changed',
      detailResult: 'Result',
      detailEvidence: 'Evidence',
      detailDeviation: 'Decided on its own',
      openChat: 'Open this conversation',
      noTeam: 'This conversation is not run as a team project',
      yourTask: 'Handled in this conversation',
      task_done: 'Done',
      task_doing: 'In progress',
      task_blocked: 'Waiting on earlier tasks',
      task_todo: 'Not started',
      task_problem: 'Needs attention',
      detailUnverified: 'Not verified',
      detailLeftover: 'Left over',
      evidenceNotListed: 'The report lists no checks; open the conversation for the full text',
      noReport: 'No report received yet',
      reportsPending: 'Reports show up after the lead conversation has been opened once',
      openLead: 'Open the lead conversation',
      stage: { intake: 'Figure out the goal', plan: 'Choose the plan', design: 'Shape the interface', foundation: 'Lay the foundation', build: 'Build features', deliver: 'Deliver', delivered: 'Delivered', paused: 'Paused' },
      kind: { answer: 'Answer', decide: 'Decide', accept: 'Accept', authorize: 'Allow', act: 'Your action' },
    }
    const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
    /** DHS locale lookups are flat: turn `stage.design` groups into `stage_design` keys. */
    const flatten = dictionary => {
      const out = {}
      for (const [key, value] of Object.entries(dictionary)) {
        if (value !== null && typeof value === 'object') for (const [sub, text] of Object.entries(value)) out[`${key}_${sub}`] = text
        else out[key] = value
      }
      return out
    }

    // ------------------------------------------------------------------ header store (shared)

    /**
     * Project files read through a project's lead session, shared by the row dots, the page and
     * the pipeline view: parsed STATE.md headers and PROJECT.md (goal, requirement sheet).
     * Cached for one minute. Headers come back with `withRequirements` applied.
     */
    function createHeaderStore(remote) {
      const entries = new Map()
      const projects = new Map()
      // `.team/guard.json` marks a crew folder before STATE.md exists: the lead writes it first
      // and may spend minutes on design before the state file (seen live 11-17).
      const markers = new Map()
      const listeners = new Set()
      let version = 0
      const notify = () => { version += 1; for (const listener of listeners) listener() }
      const projectFile = (cwd, ...parts) => {
        const separator = String(cwd).includes('\\') ? '\\' : '/'
        return [String(cwd).replace(/[\\/]+$/, ''), ...parts].join(separator)
      }
      const load = (map, key, sessionId, path, parse, field, force) => {
        const current = map.get(key)
        if (current && (current.loading || (!force && Date.now() - current.at < HEADER_TTL))) return
        map.set(key, { ...current, loading: true, at: Date.now() })
        Promise.resolve()
          .then(() => remote.workspaceFiles.read(sessionId, path, { offset: 1 }))
          .then(result => (result && result.ok ? parse(result.value?.text ?? '') : parse('')))
          .catch(() => parse(''))
          .then(value => {
            const changed = !(field in (current ?? {})) || JSON.stringify(current[field]) !== JSON.stringify(value)
            map.set(key, { [field]: value, loading: false, at: Date.now() })
            if (changed) notify()
          })
      }
      const known = new Map()
      const ensure = (key, cwd, sessionId, force = false) => {
        known.set(key, [cwd, sessionId])
        load(entries, key, sessionId, projectFile(cwd, '.team', 'STATE.md'), parseStateHeader, 'header', force)
        load(projects, key, sessionId, projectFile(cwd, 'PROJECT.md'), parseProject, 'project', force)
        load(markers, key, sessionId, projectFile(cwd, '.team', 'guard.json'), text => String(text).trim() !== '', 'crew', force)
      }
      // While any crew view is on screen, re-read the known projects once a minute, so an edit
      // made in the conversation (or by hand) shows up without navigating. Views redraw only
      // when a parsed value actually changed.
      let timer = null
      const refresh = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        for (const [key, [cwd, sessionId]] of known) ensure(key, cwd, sessionId, true)
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          if (timer === null && typeof setInterval === 'function') timer = setInterval(refresh, HEADER_TTL)
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0 && timer !== null) { clearInterval(timer); timer = null }
          }
        },
        version: () => version,
        get: key => withRequirements(entries.get(key)?.header, projects.get(key)?.project),
        project: key => projects.get(key)?.project ?? null,
        /** A crew folder: it has a STATE.md header, or at least the brakes' `.team/guard.json`. */
        isCrew: key => Boolean(entries.get(key)?.header?.ok || markers.get(key)?.crew),
        snapshot() {
          const out = new Map()
          for (const [key, entry] of entries) if (entry.header) out.set(key, withRequirements(entry.header, projects.get(key)?.project))
          return out
        },
        /** Load `<cwd>/.team/STATE.md` and `<cwd>/PROJECT.md` through the lead session. */
        ensure(key, cwd, sessionId) { ensure(key, cwd, sessionId) },
      }
    }

    // ------------------------------------------------------------------ styles (DHS variables only)

    const v = name => `var(--dsw-alias-${name})`
    const font = name => `var(--dsw-font-${name})`
    const S = {
      page: { boxSizing: 'border-box', height: '100%', overflow: 'auto', padding: '24px', background: v('bg-base'), color: v('label-primary'), display: 'flex', flexDirection: 'column', gap: '24px' },
      h1: { margin: 0, font: font('m-18') },
      block: { display: 'flex', flexDirection: 'column', gap: '8px' },
      h2: { margin: 0, font: font('s-strong-14') },
      card: { border: `1px solid ${v('border-l1')}`, borderRadius: 'var(--dsw-radius-md)', background: v('card-fill'), padding: '4px 12px' },
      row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 0', borderTop: `1px solid ${v('border-l1')}`, font: font('xs-13') },
      rowFirst: { borderTop: 'none' },
      grow: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      muted: { color: v('label-tertiary'), font: font('xxs-12') },
      secondary: { color: v('label-secondary'), font: font('xxs-12') },
      kind: { color: v('brand-primary'), font: font('xxs-strong-12'), flex: '0 0 auto' },
      pill: { border: `1px solid ${v('border-l2')}`, borderRadius: '999px', padding: '0 8px', font: font('xxxs-11'), color: v('label-secondary'), flex: '0 0 auto' },
      button: { appearance: 'none', border: `1px solid ${v('border-l2')}`, borderRadius: 'var(--dsw-radius-sm)', background: v('button-elevated-fill'), color: v('label-primary'), padding: '4px 12px', font: font('xxs-12'), cursor: 'pointer', flex: '0 0 auto' },
      primary: { appearance: 'none', border: 'none', borderRadius: 'var(--dsw-radius-sm)', background: v('button-primary-fill'), color: v('label-on-color'), padding: '4px 12px', font: font('xxs-strong-12'), cursor: 'pointer' },
      link: { appearance: 'none', border: 'none', background: 'none', color: v('link'), padding: 0, font: font('xxs-12'), cursor: 'pointer' },
      skeleton: { height: '48px', borderRadius: 'var(--dsw-radius-md)', background: v('bg-skeleton') },
      notice: { border: `1px solid ${v('border-l2')}`, borderRadius: 'var(--dsw-radius-md)', padding: '8px 12px', font: font('xs-13'), display: 'flex', gap: '12px', alignItems: 'center' },
      dot: { display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: v('brand-primary'), flex: '0 0 auto' },
      hover: { display: 'flex', flexDirection: 'column', gap: '4px', font: font('xxs-12'), color: v('hovercard-label-secondary') },
      hoverStrong: { color: v('hovercard-label-primary') },
    }

    // ------------------------------------------------------------------ shared hooks

    function useHeaders(store) {
      useSyncExternalStore(store.subscribe, store.version)
      return store.snapshot()
    }

    /** Projects + waiting, and kick header loads for every lead. */
    function useProjectData(props, store) {
      const sessions = props.useSessions(state => state)
      const workspaces = props.useWorkspaces(state => state)
      const listed = useMemo(() => buildProjects(sessions, workspaces), [sessions, workspaces])
      useEffect(() => {
        // Every folder may be a crew project: read its header through any of its conversations.
        for (const project of listed) {
          const via = project.leadId ?? project.lastId
          if (via) store.ensure(project.key, project.path, via)
        }
      }, [listed, store])
      const headers = useHeaders(store)
      // A folder with a crew header has a lead even when no team task was ever created.
      const projects = listed.map(project => (store.isCrew(project.key) ? { ...project, leadId: crewLead(sessions?.byId, project.path, true) ?? project.leadId } : project))
      return { sessions, workspaces, projects, headers }
    }

    // ------------------------------------------------------------------ A. row dot + hover line

    function leadHeaderFor(props, store) {
      const row = props.useSessions(state => state.byId?.[props.sessionId])
      const key = isRoot(row) && row.cwd ? pathKey(row.cwd) : null
      useEffect(() => { if (key) store.ensure(key, row.cwd, row.id) }, [key, row, store])
      useSyncExternalStore(store.subscribe, store.version)
      const header = key ? store.get(key) : undefined
      // A primitive selector: the row re-renders only when the folder's lead changes.
      const leadId = props.useSessions(state => (key ? crewLead(state.byId, row.cwd, store.isCrew(key)) : null))
      return leadId === props.sessionId ? header : undefined
    }

    function makeRowDot(store, t) {
      return function CrewWaitingDot(props) {
        const header = leadHeaderFor(props, store)
        if (!header?.ok || header.waiting.length === 0) return null
        const label = fill(t('dotLabel'), { n: header.waiting.length })
        return h('span', { role: 'img', 'aria-label': label, title: label, style: S.dot })
      }
    }

    function makeRowHover(store, t) {
      return function CrewWaitingHover(props) {
        const header = leadHeaderFor(props, store)
        if (!header?.ok || header.waiting.length === 0) return null
        const shown = [...header.waiting].sort((a, b) => WAIT_ORDER.indexOf(a.kind) - WAIT_ORDER.indexOf(b.kind)).slice(0, 2)
        const rest = header.waiting.length - shown.length
        return h('div', { style: S.hover },
          h('div', { style: S.hoverStrong }, fill(t('waitingLine'), { stage: t(`stage_${header.stage}`), n: header.waiting.length })),
          ...shown.map((item, index) => h('div', { key: index }, `${t(`kind_${item.kind}`)}：${waitText(item, t)}`)),
          rest > 0 ? h('div', null, fill(t('moreWaiting'), { n: rest })) : null,
        )
      }
    }

    // ------------------------------------------------------------------ C. projects page + D. tidy panel

    function Block({ title, items, render, t }) {
      const [all, setAll] = useState(false)
      if (items.length === 0) return null
      const shown = all ? items : items.slice(0, BLOCK_LIMIT)
      return h('section', { style: S.block },
        h('h2', { style: S.h2 }, title),
        h('div', { style: S.card }, shown.map((item, index) => render(item, index))),
        items.length > BLOCK_LIMIT ? h('div', null, h('button', { type: 'button', style: S.link, onClick: () => setAll(!all) }, all ? t('collapse') : t('showAll'))) : null,
      )
    }

    /** Empty-folder removal: nothing preselected, and a second click confirms because it cannot be undone. */
    function EmptyFolders({ folders, workspacesApi, t }) {
      const [selected, setSelected] = useState(() => new Set())
      const [confirming, setConfirming] = useState(false)
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      if (folders.length === 0 && result === null) return null
      const toggle = id => { setConfirming(false); setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next }) }
      const chosen = folders.filter(folder => selected.has(folder.id))
      const run = async () => {
        setBusy(true)
        let done = 0
        let failed = 0
        for (const folder of chosen) { try { await workspacesApi.delete(folder.id); done += 1 } catch { failed += 1 } }
        setBusy(false)
        setConfirming(false)
        setSelected(new Set())
        setResult({ done, failed })
      }
      return h('section', { style: S.block },
        h('h2', { style: S.h2 }, `${t('foldersTitle')} · ${folders.length}`),
        h('p', { style: { ...S.secondary, margin: 0 } }, t('foldersIntro')),
        result === null ? null : h('div', { role: 'status', style: S.notice },
          h('span', { style: S.grow }, fill(t('foldersRemoved'), { n: result.done })),
          result.failed > 0 ? h('span', { style: S.secondary }, fill(t('foldersFailed'), { n: result.failed })) : null),
        folders.length === 0 ? null : h('div', { style: S.card }, folders.map((folder, index) => h('label', { key: folder.id, style: { ...S.row, ...(index === 0 ? S.rowFirst : null), cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: selected.has(folder.id), disabled: busy, onChange: () => toggle(folder.id) }),
          h('span', { style: S.grow, title: folder.path }, folder.title),
          h('span', { style: S.muted }, fill(t('foldersArchivedCount'), { n: folder.archivedCount })),
        ))),
        chosen.length === 0 ? null : h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          confirming
            ? h('button', { type: 'button', style: S.primary, disabled: busy, onClick: () => { void run() } }, busy ? t('foldersRemoving') : fill(t('foldersConfirm'), { n: chosen.length }))
            : h('button', { type: 'button', style: S.button, onClick: () => setConfirming(true) }, fill(t('foldersRemove'), { n: chosen.length })),
          confirming && !busy ? h('button', { type: 'button', style: S.link, onClick: () => setConfirming(false) }, t('cancel')) : null,
        ),
      )
    }

    function TidyPanel({ batches, folders, ui, workspacesApi, t, now, isZh, onBack }) {
      const all = TIDY_BATCHES.flatMap(key => batches[key])
      const [selected, setSelected] = useState(() => new Set(all.map(item => item.id)))
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const toggle = id => setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
      const run = async () => {
        setBusy(true)
        const done = []
        let failed = 0
        for (const item of all) {
          if (!selected.has(item.id)) continue
          try { await ui.archiveSession(item.id); done.push(item.id) } catch { failed += 1 }
        }
        setBusy(false)
        setResult({ done, failed, undone: false })
      }
      const undo = async () => {
        setBusy(true)
        for (const id of result.done) { try { await ui.unarchiveSession(id) } catch { /* stays archived; DHS filter still has it */ } }
        setBusy(false)
        setResult({ ...result, undone: true })
      }
      const batch = key => batches[key].length === 0 ? null : h('section', { key, style: S.block },
        h('h2', { style: S.h2 }, `${t(`batch_${key}`)} · ${batches[key].length}`),
        h('div', { style: S.card }, batches[key].map((item, index) => h('label', { key: item.id, style: { ...S.row, ...(index === 0 ? S.rowFirst : null), cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: selected.has(item.id), disabled: busy || result !== null, onChange: () => toggle(item.id) }),
          h('span', { style: S.grow }, item.title || t('untitled')),
          h('span', { style: S.secondary }, item.folder ?? t('ungrouped')),
          h('span', { style: S.muted, title: item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '' }, relativeTime(item.updatedAt, now, isZh)),
        ))),
      )
      const count = all.filter(item => selected.has(item.id)).length
      return h('div', { style: S.page },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('button', { type: 'button', style: S.button, onClick: onBack, disabled: busy }, t('back')),
          h('h1', { style: S.h1 }, t('tidyTitle')),
        ),
        result === null ? null : h('div', { role: 'status', style: S.notice },
          h('span', { style: S.grow }, result.undone ? fill(t('undone'), { n: result.done.length }) : fill(t('archived'), { n: result.done.length })),
          result.failed > 0 ? h('span', { style: S.secondary }, fill(t('failed'), { n: result.failed })) : null,
          !result.undone && result.done.length > 0 ? h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => { void undo() } }, t('undo')) : null,
        ),
        h('p', { style: { ...S.secondary, margin: 0 } }, t('tidyIntro')),
        all.length === 0 ? h('div', { style: S.notice }, t('nothingToTidy')) : null,
        ...TIDY_BATCHES.map(batch),
        all.length > 0 && result === null
          ? h('div', null, h('button', { type: 'button', style: S.primary, disabled: busy || count === 0, onClick: () => { void run() } }, busy ? t('archiving') : fill(t('archiveN'), { n: count })))
          : null,
        workspacesApi && typeof workspacesApi.delete === 'function' ? h(EmptyFolders, { folders, workspacesApi, t }) : null,
      )
    }

    function makeProjectsPage(store) {
      return function CrewProjectsPage(props) {
        const { t, crew } = props
        const isZh = t('panel') === zh.panel
        const [view, setView] = useState('home')
        const { sessions, workspaces, projects, headers } = useProjectData(props, store)
        const now = Date.now()
        if (workspaces?.state === 'error') {
          return h('div', { style: S.page }, h('h1', { style: S.h1 }, t('title')),
            h('div', { role: 'alert', style: S.notice }, h('span', { style: S.grow }, t('loadError')), h('button', { type: 'button', style: S.button, onClick: () => window.location.reload() }, t('retry'))))
        }
        if (sessions?.phase !== 'ready' || workspaces?.phase === 'pending') {
          return h('div', { style: S.page }, h('h1', { style: S.h1 }, t('title')), h('div', { role: 'status', 'aria-label': t('loading'), style: S.skeleton }), h('div', { style: S.skeleton }))
        }
        const waiting = collectWaiting(projects, headers)
        const waitingLeadIds = new Set(waiting.map(item => item.leadId))
        const deliveredKeys = new Set([...headers].filter(([, header]) => header?.ok && header.stage === 'delivered').map(([key]) => key))
        const batches = tidyCandidates({ sessions, workspaces, waitingLeadIds, deliveredKeys, now })
        const folders = emptyFolders(workspaces)
        if (view === 'tidy') return h(TidyPanel, { batches, folders, ui: crew.ui, workspacesApi: crew.workspaces, t, now, isZh, onBack: () => setView('home') })
        const recent = recentProjects(projects, now)
        const tidyTotal = TIDY_BATCHES.reduce((sum, key) => sum + batches[key].length, 0)
        const summary = [
          tidyTotal > 0 ? fill(t('tidySummary'), { n: tidyTotal }) : null,
          folders.length > 0 ? fill(t('foldersSummary'), { n: folders.length }) : null,
        ].filter(Boolean).join(t('listSeparator'))
        const open = id => { if (id) crew.ui.openSession(id) }
        return h('div', { style: S.page },
          h('h1', { style: S.h1 }, t('title')),
          h(Block, { t, title: t('waitingTitle'), items: waiting, render: (item, index) => h('div', { key: index, style: { ...S.row, ...(index === 0 ? S.rowFirst : null) } },
            h('span', { style: S.kind }, t(`kind_${item.kind}`)),
            h('span', { style: S.grow, title: waitText(item, t) }, `${item.project} · ${waitText(item, t)}`),
            h('button', { type: 'button', style: S.button, onClick: () => open(item.leadId) }, t('handle')),
          ) }),
          h(Block, { t, title: t('recentTitle'), items: recent, render: (project, index) => {
            const header = headers.get(project.key)
            return h('div', { key: project.key, style: { ...S.row, ...(index === 0 ? S.rowFirst : null) } },
              h('span', { style: { ...S.grow, flex: '0 1 auto', maxWidth: '40%' } }, project.title),
              header?.ok ? h('span', { style: S.pill }, t(`stage_${header.stage}`)) : null,
              h('span', { style: { ...S.grow, ...S.secondary }, title: project.lastTitle ?? '' }, project.lastTitle && project.lastTitle !== project.title ? project.lastTitle : ''),
              h('span', { style: S.muted, title: new Date(project.lastAt).toLocaleString() }, relativeTime(project.lastAt, now, isZh)),
              h('button', { type: 'button', style: S.button, onClick: () => open(project.leadId ?? project.lastId) }, t('open')),
            )
          } }),
          summary === '' ? null : h('section', { style: S.block },
            h('h2', { style: S.h2 }, t('tidyTitle')),
            h('div', { style: S.notice },
              h('span', { style: S.grow }, summary),
              h('button', { type: 'button', style: S.button, onClick: () => setView('tidy') }, t('tidyButton')),
            ),
          ),
          waiting.length === 0 && recent.length === 0 ? h('div', { style: S.notice }, t('allEmpty')) : null,
        )
      }
    }

    // ------------------------------------------------------------------ B. pipeline view

    const P = {
      // Bottom padding keeps the last row clear of DHS's docked composer.
      wrap: { boxSizing: 'border-box', height: '100%', overflow: 'auto', padding: '16px 24px 160px', background: v('bg-base'), color: v('label-primary'), display: 'flex', flexDirection: 'column', gap: '16px' },
      goal: { display: 'flex', gap: '8px', alignItems: 'baseline', font: font('s-strong-14') },
      sheet: { display: 'flex', flexDirection: 'column', gap: '6px' },
      sheetPill: { confirmed: { color: v('state-success-primary'), borderColor: v('state-success-primary') }, changed: { color: v('state-warn-label'), borderColor: v('state-warn-primary') }, unconfirmed: {} },
      sheetWarn: { borderColor: v('state-warn-primary') },
      criteriaToggle: { alignSelf: 'flex-start', appearance: 'none', border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: v('label-secondary'), font: font('xxs-12') },
      criteria: { margin: 0, paddingLeft: '16px', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '2px', font: font('xxs-12'), color: v('label-primary') },
      criterionDone: { color: v('label-tertiary') },
      goalLabel: { flex: '0 0 auto', whiteSpace: 'nowrap', color: v('label-tertiary'), font: font('xxs-12') },
      strip: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap', font: font('xxs-12') },
      clamp: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
      files: { color: v('label-tertiary'), font: font('xxs-12') },
      rowButton: { appearance: 'none', width: '100%', background: 'none', borderLeft: 'none', borderRight: 'none', borderBottom: 'none', textAlign: 'left', cursor: 'pointer', color: v('label-primary') },
      sep: { color: v('label-tertiary') },
      body: { display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'flex-start' },
      flow: { flex: '1 1 420px', minWidth: 0, overflowX: 'auto' },
      cols: { display: 'flex', gap: '8px', alignItems: 'flex-start', minWidth: 'min-content' },
      // A column with many independent tasks wraps into up to three card widths instead of one tall strip.
      col: cards => ({ display: 'grid', gridTemplateColumns: `repeat(${cards}, 200px)`, gap: '8px', flex: '0 0 auto', alignContent: 'start' }),
      arrow: { alignSelf: 'flex-start', marginTop: '16px', color: v('label-tertiary'), font: font('xs-13') },
      node: { appearance: 'none', textAlign: 'left', border: `1px solid ${v('border-l1')}`, borderLeftWidth: '3px', borderRadius: 'var(--dsw-radius-md)', background: v('card-fill'), padding: '8px 10px', cursor: 'pointer', color: v('label-primary'), font: font('xs-13') },
      nodeTitle: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
      nodeMeta: { display: 'block', marginTop: '4px', color: v('label-tertiary'), font: font('xxs-12') },
      nodeSelected: { borderColor: v('border-selected') },
      nodeMine: { background: v('interactive-bg-hover-accent') },
      detail: { flex: '0 0 280px', border: `1px solid ${v('border-l1')}`, borderRadius: 'var(--dsw-radius-md)', background: v('card-fill'), padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px', font: font('xs-13') },
      dt: { color: v('label-tertiary'), font: font('xxs-12') },
      dd: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    }
    const STATE_COLOR = { done: v('state-success-primary'), doing: v('brand-primary'), blocked: v('state-idle-primary'), todo: v('state-idle-primary'), problem: v('state-warn-primary') }

    function makePipelineView(store, crew) {
      return function CrewPipelineView(props) {
        const { t, sessionId } = props
        const isZh = t('pipelineTab') === zh.pipelineTab
        const sessions = props.useSessions(state => state)
        const liveTeam = typeof props.useProjection === 'function' ? props.useProjection('agentTeam') : undefined
        const liveReports = typeof props.useProjection === 'function' ? props.useProjection('crewReports') : undefined
        const [picked, setPicked] = useState(null)
        const [showDone, setShowDone] = useState(false)
        const [showCriteria, setShowCriteria] = useState(false)
        const [showUsage, setShowUsage] = useState(false)
        const byId = sessions?.byId ?? {}
        // Read the folder's crew header first (through this conversation, or its lead for a
        // member): it decides whether a conversation without a task board is a crew lead.
        const self = byId[sessionId]
        const home = isRoot(self) ? self : self?.parentId ? byId[self.parentId] : null
        const homeKey = home?.cwd ? pathKey(home.cwd) : null
        useEffect(() => {
          if (homeKey) store.ensure(homeKey, home.cwd, home.id)
        }, [homeKey, home, store])
        useSyncExternalStore(store.subscribe, store.version)
        const context = pipelineContext(sessionId, byId, cwd => store.isCrew(pathKey(cwd)))
        const leadRow = context.leadId ? byId[context.leadId] : null
        const key = leadRow?.cwd ? pathKey(leadRow.cwd) : null
        const open = id => { if (id) crew.ui.openSession(id) }

        // A plain conversation has nothing to track: one quiet line, no copy of the chat.
        if (context.kind === 'plain') return h('div', { style: P.wrap }, h('p', { style: { ...P.dt, margin: 0 } }, t('noTeam')))

        const team = context.kind === 'lead' && liveTeam ? liveTeam : leadRow?.projectionValues?.agentTeam
        // Reports are folded on the lead conversation by the Host half (lib/reports.js).
        const reportSource = context.kind === 'lead' && liveReports ? liveReports : leadRow?.projectionValues?.crewReports
        // undefined = DHS has not folded the lead's log with this plugin yet (e.g. right after install or an upgrade).
        const reportsKnown = reportSource !== undefined
        const reports = reportsByTask(team?.tasks, reportSource)
        const tasks = Array.isArray(team?.tasks) ? team.tasks : []
        const taskById = new Map(tasks.map(task => [task.id, task]))
        const visible = tasks.filter(task => task && task.status !== 'deleted')
        const doneCount = visible.filter(task => task.status === 'completed').length
        // Finished work is history: it folds away so what is moving now stays in view.
        const columns = taskColumns(showDone ? visible : visible.filter(task => task.status !== 'completed'))
        const mine = new Set(context.kind === 'member' ? tasks.filter(task => task.ownerId === sessionId).map(task => task.id) : [])
        const selectedId = picked ?? (mine.size > 0 ? [...mine][0] : null)
        const selected = selectedId ? taskById.get(selectedId) : null
        const header = key ? store.get(key) : undefined
        const project = key ? store.project(key) : null
        const goal = project?.goal ?? null
        const sheet = requirementsStatus(header, project)
        const criteria = project?.criteria ?? []
        // The sheet below already says when the requirements changed; do not list it twice.
        const waiting = header?.ok ? header.waiting.filter(item => item.code !== 'requirementsChanged').sort((a, b) => WAIT_ORDER.indexOf(a.kind) - WAIT_ORDER.indexOf(b.kind)) : []
        const decided = deviations(tasks, reports)
        const usage = teamUsage(byId, context.leadId, tasks)
        // A member DHS named itself ("agent-1", no name passed) falls back to its description.
        const who = owner => {
          if (owner.isLead) return t('leadName')
          if (owner.role) return `${t(`role_${owner.role}`)}（${owner.name}）`
          const label = owner.id ? byId[owner.id]?.projectionValues?.subagent?.label : null
          return (!owner.name || AUTO_NAME.test(owner.name)) && typeof label === 'string' && label.trim() ? label.trim() : owner.name
        }
        const isNone = text => !text || NONE.test(String(text).trim())

        const nodeView = task => {
          const state = taskState(task, taskById, reports[task.id])
          const isMine = mine.has(task.id)
          return h('button', {
            key: task.id, type: 'button', 'aria-pressed': selectedId === task.id,
            style: { ...P.node, borderLeftColor: STATE_COLOR[state], ...(selectedId === task.id ? P.nodeSelected : null), ...(isMine ? P.nodeMine : null), borderLeftWidth: '3px', borderLeftStyle: 'solid' },
            title: stripTitle(task.subject),
            onClick: () => setPicked(task.id),
          },
          h('span', { style: P.nodeTitle }, stripTitle(task.subject)),
          h('span', { style: P.nodeMeta }, [t(`task_${state}`), who(ownerInfo(task.ownerId, task.ownerName, context.leadId))].filter(Boolean).join(' · ')))
        }

        const field = (label, text, style) => isNone(text) ? [] : [h('span', { key: `${label}-l`, style: P.dt }, t(label)), h('p', { key: `${label}-v`, style: { ...P.dd, ...style } }, text)]
        const detailView = selected == null ? null : (() => {
          const report = reports[selected.id]
          const evidence = report?.checks || (report ? t('evidenceNotListed') : reportsKnown ? t('noReport') : t('reportsPending'))
          return h('aside', { style: P.detail, 'aria-label': stripTitle(selected.subject) },
            h('strong', null, stripTitle(selected.subject)),
            mine.has(selected.id) ? h('span', { style: P.dt }, t('yourTask')) : null,
            ...field('detailWhat', firstParagraph(selected.description)),
            ...field('detailWho', who(ownerInfo(selected.ownerId, selected.ownerName, context.leadId))),
            ...field('detailResult', report?.result || report?.summary),
            h('span', { style: P.dt }, t('detailEvidence')), h('p', { style: P.dd }, evidence),
            ...field('detailUnverified', report?.unverified, { color: v('state-warn-label') }),
            ...field('detailDeviation', report?.deviation),
            ...field('detailLeftover', report?.leftover),
            ...field('detailOutput', report?.output || (selected.writeScopes ?? []).join('；'), P.files),
            !reportsKnown && context.kind === 'member' ? h('div', null, h('button', { type: 'button', style: S.button, onClick: () => open(context.leadId) }, t('openLead'))) : null,
            selected.ownerId ? h('div', null, h('button', { type: 'button', style: S.button, onClick: () => open(selected.ownerId) }, t('openChat'))) : null,
          )
        })()

        // Milestone ids start at 0, so "M5" is the sixth: say "6 of 6" when PROJECT.md lists them.
        const position = header?.ok ? milestonePosition(header.milestone, project?.milestones) : null
        const progress = !header?.ok ? null
          : position ? fill(t('progressMilestone'), { stage: t(`stage_${header.stage}`), ...position })
            : header.milestone && header.milestone !== 'none' ? fill(t('progressMilestoneRaw'), { stage: t(`stage_${header.stage}`), m: header.milestone })
              : fill(t('progressLine'), { stage: t(`stage_${header.stage}`) })
        const usageTotal = usage ? usage.reduce((sum, item) => sum + item.tokens, 0) : 0
        // A rotated project spreads over several lead conversations: show the folder's total too.
        const projectTotal = projectUsage(byId, key)
        const showProject = projectTotal !== null && projectTotal > usageTotal * 1.05
        // Paths, commands and long technical notes stay in the lead conversation; only the count shows.
        const plainDecided = decided.filter(item => item.plain)
        const technicalCount = decided.length - plainDecided.length

        return h('div', { style: P.wrap },
          // 1. What is waiting for the user comes first (DESIGN.md principle 2).
          waiting.length === 0 ? null : h('section', { style: S.block },
            h('h2', { style: S.h2 }, t('waitingTitle')),
            h('div', { style: S.card }, waiting.map((item, index) => h('div', { key: index, style: { ...S.row, ...(index === 0 ? S.rowFirst : null) } },
              h('span', { style: S.kind }, t(`kind_${item.kind}`)),
              h('span', { style: S.grow, title: item.text }, item.text),
              context.kind === 'member' ? h('button', { type: 'button', style: S.button, onClick: () => open(context.leadId) }, t('handle')) : null,
            )))),
          // 2. The goal, whether it is confirmed, and how far it is: success criteria are the progress.
          h('section', { style: P.sheet, 'aria-label': t('goalLabel') },
            h('div', { style: P.goal },
              h('span', { style: P.goalLabel }, t('goalLabel')),
              h('span', { style: { ...P.clamp, flex: '1 1 auto', minWidth: 0 }, title: goal ?? '' }, goal ?? t('noGoal')),
              sheet ? h('span', { style: { ...S.pill, ...P.sheetPill[sheet] } }, sheet === 'confirmed' ? fill(t('sheetConfirmed'), { date: header.confirmed.date }) : t(sheet === 'changed' ? 'sheetChanged' : 'sheetUnconfirmed')) : null),
            // How the lead raised the request (PROJECT.md "## 升级"), so the user can correct it.
            project?.upgrade ? h('div', { style: { ...P.goal, font: font('xs-13') } },
              h('span', { style: P.goalLabel }, t('upgradeLabel')),
              h('span', { style: { ...P.clamp, flex: '1 1 auto', minWidth: 0, color: v('label-secondary') }, title: project.upgrade }, project.upgrade)) : null,
            h('div', { style: P.strip },
              criteria.length === 0 ? null : h('button', { type: 'button', style: P.criteriaToggle, 'aria-expanded': showCriteria, onClick: () => setShowCriteria(!showCriteria) },
                `${showCriteria ? '▾' : '▸'} ${fill(t('criteriaLine'), { done: criteria.filter(item => item.done).length, total: criteria.length })}`),
              criteria.length > 0 && progress ? h('span', { style: P.sep }, '·') : null,
              progress ? h('span', { style: S.secondary }, progress) : null),
            showCriteria ? h('ul', { style: P.criteria }, criteria.map((item, index) => h('li', { key: index, style: item.done ? P.criterionDone : null }, `${item.done ? '✓' : '○'} ${item.text}`))) : null,
            sheet === 'changed' || sheet === 'unconfirmed' ? h('div', { style: { ...S.notice, ...(sheet === 'changed' ? P.sheetWarn : null) } },
              h('span', { style: S.grow }, t(sheet === 'changed' ? 'sheetChangedHint' : 'sheetUnconfirmedHint')),
              context.kind === 'member' ? h('button', { type: 'button', style: S.button, onClick: () => open(context.leadId) }, t('openLead')) : null) : null),
          // 3. Calls the team made on its own while building: the unknowns the plan missed.
          decided.length === 0 ? null : h('section', { style: S.block },
            h('h2', { style: S.h2 }, t('decisionsTitle')),
            plainDecided.length === 0 ? null : h('p', { style: { ...S.secondary, margin: 0 } }, t('decisionsHint')),
            technicalCount === 0 ? null : h('p', { style: { ...S.secondary, margin: 0 } }, fill(t('decisionsTechnical'), { n: technicalCount })),
            plainDecided.length === 0 ? null : h('div', { style: S.card }, plainDecided.map((item, index) => h('button', { key: item.taskId, type: 'button', style: { ...S.row, ...P.rowButton, ...(index === 0 ? S.rowFirst : null) }, onClick: () => setPicked(item.taskId) },
              h('span', { style: { ...S.grow, ...P.clamp, whiteSpace: 'normal' }, title: item.text }, item.text),
              h('span', { style: S.muted }, item.title))))),
          // 4. Tasks still moving; finished ones fold into one link.
          h('section', { style: S.block },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '12px' } },
              h('h2', { style: S.h2 }, t('tasksTitle')),
              doneCount > 0 ? h('button', { type: 'button', style: S.link, onClick: () => setShowDone(!showDone) }, showDone ? t('hideDone') : fill(t('doneTasks'), { n: doneCount })) : null),
            visible.length === 0 ? h('div', { style: S.notice }, t('noTasks'))
              : columns.length === 0 ? h('div', { style: S.notice }, t('allDone'))
                : h('div', { style: P.body },
                  h('div', { style: P.flow }, h('div', { style: P.cols }, columns.flatMap((column, index) => [
                    index > 0 ? h('span', { key: `a${index}`, style: P.arrow, 'aria-hidden': true }, '→') : null,
                    h('div', { key: `c${index}`, style: P.col(columnCards(column.length)) }, column.map(nodeView)),
                  ]))),
                  detailView),
            columns.length === 0 && detailView ? detailView : null),
          // 5. Usage, folded: one line, the breakdown on demand.
          usage === null ? null : h('section', { style: S.block },
            h('button', { type: 'button', style: P.criteriaToggle, 'aria-expanded': showUsage, onClick: () => setShowUsage(!showUsage) },
              `${showUsage ? '▾' : '▸'} ${fill(t(showProject ? 'usageProject' : 'usageLine'), { project: showProject ? formatTokens(projectTotal, isZh) : '', total: formatTokens(usageTotal, isZh), top: who(ownerInfo(usage[0].isLead ? context.leadId : usage[0].id, usage[0].name, context.leadId)), share: Math.round(usage[0].tokens / usageTotal * 100) })}`),
            showUsage ? h('p', { style: { ...S.secondary, margin: 0 } }, t('usageHint')) : null,
            showUsage ? h('div', { style: S.card }, usage.map((item, index) => h('div', { key: item.id, style: { ...S.row, ...(index === 0 ? S.rowFirst : null) } },
              h('span', { style: S.grow }, who(ownerInfo(item.isLead ? context.leadId : item.id, item.name, context.leadId)) ?? t('none')),
              h('span', { style: S.secondary }, formatTokens(item.tokens, isZh))))) : null),
        )
      }
    }

    /** Sidebar entry icon drawn in the host's current color. */
    function CrewIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' },
        h('rect', { x: 3, y: 4, width: 7, height: 16, rx: 1.5 }),
        h('rect', { x: 13, y: 4, width: 8, height: 7, rx: 1.5 }),
        h('rect', { x: 13, y: 14, width: 8, height: 6, rx: 1.5 }))
    }

    return {
      model,
      inject: ['slots', 'locale', 'remote', 'remote.workspaceFiles', 'uiWorkspace', 'workspaces'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: flatten(zh), en: flatten(en) }), 'crew-center: dictionaries')
        const t = ctx.locale.bind(NS)
        const store = createHeaderStore(ctx.remote)
        const crew = { ui: ctx.get('uiWorkspace'), workspaces: ctx.get('workspaces') }
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ crew }) }, makeProjectsPage(store)))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, CrewIcon))
        ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({ name: 'sidebar.session.row.trailing', id: 'crew-center.waiting', order: 1 }, makeRowDot(store, t)))
        ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({ name: 'sidebar.session.row.hover', id: 'crew-center.waiting', order: 1, locale: NS }, makeRowHover(store, t)))
        // Between DHS's own "对话" (order 0) and "轨迹" (order 10).
        ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'crew-center.pipeline', order: 5, label: () => t('pipelineTab'), locale: NS }, makePipelineView(store, crew)))
      },
    }
  },
})

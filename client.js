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
     * @returns {{ok: true, stage: string, milestone: string, updated: string, waiting: {kind: string, text: string}[]} | {ok: false}}
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
      return { ok: true, stage: fields.stage, milestone: fields.milestone ?? 'none', updated: fields.updated ?? '', waiting }
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
        for (const item of header.waiting) out.push({ project: project.title, leadId: project.leadId, kind: item.kind, text: item.text })
      }
      return out.sort((a, b) => WAIT_ORDER.indexOf(a.kind) - WAIT_ORDER.indexOf(b.kind) || a.project.localeCompare(b.project))
    }

    /** Projects with activity in the last 7 days, newest first. */
    function recentProjects(projects, now) {
      return projects.filter(p => p.lastAt > 0 && now - p.lastAt <= RECENT_DAYS * DAY).sort((a, b) => b.lastAt - a.lastAt)
    }

    /**
     * Tidy candidates (DESIGN.md §3 D). Never: pinned, running, a lead with waiting items,
     * anything active in the last 7 days, archived or subagent rows. First matching batch wins.
     * Conversations that belong to no folder (DHS's "未分组") are covered too, with `folder: null`.
     * @returns {{stale: object[], blank: object[], scratch: object[]}}
     */
    function tidyCandidates({ sessions, workspaces, waitingLeadIds, now }) {
      const byId = sessions?.byId ?? {}
      const archived = new Set(workspaces?.archivedSessionIds ?? [])
      const pinned = new Set(workspaces?.pinnedSessionIds ?? [])
      const protectedIds = new Set(waitingLeadIds ?? [])
      const batches = { stale: [], blank: [], scratch: [] }
      const grouped = new Set()
      const groups = (workspaces?.items ?? []).map(item => {
        for (const id of item.sessionIds ?? []) grouped.add(id)
        const rows = (item.sessionIds ?? []).filter(id => !archived.has(id)).map(id => byId[id]).filter(isRoot)
        return { folder: item.title || item.path, rows, scratchFolder: isScratchPath(item.path) && rows.length === 1 }
      })
      const ungrouped = Object.values(byId).filter(row => isRoot(row) && !grouped.has(row.id) && !archived.has(row.id))
      groups.push({ folder: null, rows: ungrouped, scratchFolder: false })
      for (const { folder, rows, scratchFolder } of groups) {
        for (const row of rows) {
          if (pinned.has(row.id) || row.running || protectedIds.has(row.id)) continue
          const idle = now - (row.updatedAt ?? 0)
          if (idle <= RECENT_DAYS * DAY) continue
          const entry = { id: row.id, title: row.title || '', folder, updatedAt: row.updatedAt ?? 0 }
          if (idle > STALE_DAYS * DAY) batches.stale.push(entry)
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

    /** The seven pipeline stages shown on the strip (`paused` is a state, not a step). */
    const PIPELINE = STAGES.filter(stage => stage !== 'paused')

    /** "[M0] DSH 源码 dev 环境" -> "DSH 源码 dev 环境". */
    function stripTitle(subject) {
      return String(subject ?? '').replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim()
    }

    /**
     * Which pipeline the conversation belongs to: a lead shows its own team, a member shows its
     * lead's team with its own tasks highlighted, anything else gets the short version.
     */
    function pipelineContext(sessionId, byId) {
      const row = byId?.[sessionId]
      if (isLeadRow(row)) return { kind: 'lead', leadId: row.id }
      const parent = row?.parentId ? byId?.[row.parentId] : undefined
      if (row?.origin === 'subagent' && isLeadRow(parent)) return { kind: 'member', leadId: parent.id }
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

    /** Stage strip: finished steps (collapsed in the view), the current one, and what is left. */
    function stageStrip(stage) {
      const index = PIPELINE.indexOf(stage)
      if (index < 0) return { done: [], current: stage ?? null, upcoming: stage === 'paused' ? [] : PIPELINE }
      return { done: PIPELINE.slice(0, index), current: stage, upcoming: PIPELINE.slice(index + 1) }
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

    /**
     * Member name and model from the owner conversation's list row. A task owned by the lead
     * itself returns `isLead: true` so the view can say "负责人" instead of an internal name.
     */
    function ownerInfo(byId, ownerId, ownerName, leadId) {
      const row = ownerId ? byId?.[ownerId] : undefined
      const label = row?.projectionValues?.subagent?.label
      return {
        isLead: Boolean(ownerId) && ownerId === leadId,
        name: typeof label === 'string' && label.trim() ? label.trim() : (ownerName ?? null),
        model: row?.projectionValues?.modelSelection?.lastUsed?.model ?? null,
      }
    }

    const model = { parseStateHeader, pathKey, isScratchPath, buildProjects, leadIdsByProject, collectWaiting, recentProjects, tidyCandidates, emptyFolders, relativeTime, stripTitle, pipelineContext, taskColumns, taskState, stageStrip, parseGoal, firstParagraph, columnCards, ownerInfo, STAGES, WAIT_ORDER, PIPELINE }

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
      tidySummary: '{stale} 段对话超过 30 天没动，{blank} 段是空对话，{scratch} 段在临时文件夹里',
      tidyButton: '整理一下',
      back: '返回',
      tidyIntro: '归档只是从左栏收起来，随时能在 DHS 的归档筛选里找回，不删除任何内容。',
      batchStale: '超过 30 天没动',
      batchBlank: '空对话（开了但没发过消息）',
      batchScratch: '临时文件夹里的唯一一段对话',
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
      none: '—',
      goalLabel: '目标',
      noGoal: '还没有写下目标',
      doneSteps: '✓ 已完成 {n} 步',
      stageUnknown: '阶段未知',
      tasksTitle: '任务',
      noTasks: '还没有任务。',
      detailHint: '点一个任务看详情。',
      detailWhat: '做什么',
      detailWho: '谁在做',
      detailOutput: '交了什么',
      detailEvidence: '证据',
      openChat: '回到这段对话',
      noTeam: '这段对话没有用团队方式推进',
      saidFirst: '你说的话',
      turnsCount: '{n} 轮',
      lastActive: '最后活动',
      yourTask: '你在这段对话里负责的',
      task_done: '完成',
      task_doing: '正在做',
      task_blocked: '等前面的任务',
      task_todo: '还没开始',
      task_problem: '有问题',
      detailReport: '最新回报',
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
      tidySummary: '{stale} conversations idle for 30+ days, {blank} empty, {scratch} in scratch folders',
      tidyButton: 'Tidy up',
      back: 'Back',
      tidyIntro: 'Archiving only hides conversations from the sidebar. They stay in DHS’s archived filter and nothing is deleted.',
      batchStale: 'Idle for more than 30 days',
      batchBlank: 'Empty (never sent a message)',
      batchScratch: 'The only conversation in a scratch folder',
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
      none: '—',
      goalLabel: 'Goal',
      noGoal: 'No goal written down yet',
      doneSteps: '✓ {n} steps done',
      stageUnknown: 'Stage unknown',
      tasksTitle: 'Tasks',
      noTasks: 'No tasks yet.',
      detailHint: 'Pick a task to see details.',
      detailWhat: 'What',
      detailWho: 'Who',
      detailOutput: 'Delivers',
      detailEvidence: 'Evidence',
      openChat: 'Open this conversation',
      noTeam: 'This conversation is not run as a team project',
      saidFirst: 'What you said',
      turnsCount: '{n} turns',
      lastActive: 'Last active',
      yourTask: 'Handled in this conversation',
      task_done: 'Done',
      task_doing: 'In progress',
      task_blocked: 'Waiting on earlier tasks',
      task_todo: 'Not started',
      task_problem: 'Needs attention',
      detailReport: 'Latest report',
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
     * the pipeline view: parsed STATE.md headers and the PROJECT.md goal. Cached for one minute.
     */
    function createHeaderStore(remote) {
      const entries = new Map()
      const goals = new Map()
      const listeners = new Set()
      let version = 0
      const notify = () => { version += 1; for (const listener of listeners) listener() }
      const projectFile = (cwd, ...parts) => {
        const separator = String(cwd).includes('\\') ? '\\' : '/'
        return [String(cwd).replace(/[\\/]+$/, ''), ...parts].join(separator)
      }
      const load = (map, key, sessionId, path, parse, field) => {
        const current = map.get(key)
        if (current && (current.loading || Date.now() - current.at < HEADER_TTL)) return
        map.set(key, { ...current, loading: true, at: Date.now() })
        Promise.resolve()
          .then(() => remote.workspaceFiles.read(sessionId, path, { offset: 1 }))
          .then(result => (result && result.ok ? parse(result.value?.text ?? '') : parse('')))
          .catch(() => parse(''))
          .then(value => { map.set(key, { [field]: value, loading: false, at: Date.now() }); notify() })
      }
      return {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        version: () => version,
        get: key => entries.get(key)?.header,
        goal: key => goals.get(key)?.goal ?? null,
        snapshot() {
          const out = new Map()
          for (const [key, entry] of entries) if (entry.header) out.set(key, entry.header)
          return out
        },
        /** Load `<cwd>/.team/STATE.md` through the lead session. */
        ensure(key, cwd, sessionId) { load(entries, key, sessionId, projectFile(cwd, '.team', 'STATE.md'), parseStateHeader, 'header') },
        /** Load the goal sentence from `<cwd>/PROJECT.md`. */
        ensureGoal(key, cwd, sessionId) { load(goals, key, sessionId, projectFile(cwd, 'PROJECT.md'), parseGoal, 'goal') },
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
      const projects = useMemo(() => buildProjects(sessions, workspaces), [sessions, workspaces])
      useEffect(() => {
        for (const project of projects) if (project.leadId) store.ensure(project.key, project.path, project.leadId)
      }, [projects, store])
      const headers = useHeaders(store)
      return { sessions, workspaces, projects, headers }
    }

    // ------------------------------------------------------------------ A. row dot + hover line

    function leadHeaderFor(props, store) {
      const row = props.useSessions(state => state.byId?.[props.sessionId])
      const isLead = isLeadRow(row)
      const key = isLead ? pathKey(row.cwd) : null
      useEffect(() => { if (isLead && row.cwd) store.ensure(key, row.cwd, row.id) }, [isLead, key, row, store])
      useSyncExternalStore(store.subscribe, store.version)
      return isLead ? store.get(key) : undefined
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
          ...shown.map((item, index) => h('div', { key: index }, `${t(`kind_${item.kind}`)}：${item.text}`)),
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
      const all = [...batches.stale, ...batches.blank, ...batches.scratch]
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
      const batch = (key, label) => batches[key].length === 0 ? null : h('section', { key, style: S.block },
        h('h2', { style: S.h2 }, `${label} · ${batches[key].length}`),
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
        batch('stale', t('batchStale')),
        batch('blank', t('batchBlank')),
        batch('scratch', t('batchScratch')),
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
        const batches = tidyCandidates({ sessions, workspaces, waitingLeadIds, now })
        const folders = emptyFolders(workspaces)
        if (view === 'tidy') return h(TidyPanel, { batches, folders, ui: crew.ui, workspacesApi: crew.workspaces, t, now, isZh, onBack: () => setView('home') })
        const recent = recentProjects(projects, now)
        const tidyTotal = batches.stale.length + batches.blank.length + batches.scratch.length
        const summary = [
          tidyTotal > 0 ? fill(t('tidySummary'), { stale: batches.stale.length, blank: batches.blank.length, scratch: batches.scratch.length }) : null,
          folders.length > 0 ? fill(t('foldersSummary'), { n: folders.length }) : null,
        ].filter(Boolean).join(t('listSeparator'))
        const open = id => { if (id) crew.ui.openSession(id) }
        return h('div', { style: S.page },
          h('h1', { style: S.h1 }, t('title')),
          h(Block, { t, title: t('waitingTitle'), items: waiting, render: (item, index) => h('div', { key: index, style: { ...S.row, ...(index === 0 ? S.rowFirst : null) } },
            h('span', { style: S.kind }, t(`kind_${item.kind}`)),
            h('span', { style: S.grow, title: item.text }, `${item.project} · ${item.text}`),
            h('button', { type: 'button', style: S.button, onClick: () => open(item.leadId) }, t('handle')),
          ) }),
          h(Block, { t, title: t('recentTitle'), items: recent, render: (project, index) => {
            const header = headers.get(project.key)
            return h('div', { key: project.key, style: { ...S.row, ...(index === 0 ? S.rowFirst : null) } },
              h('span', { style: { ...S.grow, flex: '0 1 auto', maxWidth: '40%' } }, project.title),
              header?.ok ? h('span', { style: S.pill }, t(`stage_${header.stage}`)) : null,
              h('span', { style: { ...S.grow, ...S.secondary }, title: project.lastTitle ?? '' }, project.lastTitle ?? ''),
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
      goalLabel: { flex: '0 0 auto', whiteSpace: 'nowrap', color: v('label-tertiary'), font: font('xxs-12') },
      strip: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap', font: font('xxs-12') },
      step: { border: `1px solid ${v('border-l1')}`, borderRadius: '999px', padding: '2px 10px', color: v('label-tertiary'), background: 'none', font: 'inherit' },
      stepDone: { color: v('label-secondary'), cursor: 'pointer' },
      stepNow: { border: `1px solid ${v('border-selected')}`, color: v('label-primary'), font: font('xxs-strong-12') },
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
        const outline = typeof props.useProjection === 'function' ? props.useProjection('turnOutline') : undefined
        const [picked, setPicked] = useState(null)
        const [showDone, setShowDone] = useState(false)
        const byId = sessions?.byId ?? {}
        const context = pipelineContext(sessionId, byId)
        const leadRow = context.leadId ? byId[context.leadId] : null
        const key = leadRow?.cwd ? pathKey(leadRow.cwd) : null
        useEffect(() => {
          if (!key) return
          store.ensure(key, leadRow.cwd, leadRow.id)
          store.ensureGoal(key, leadRow.cwd, leadRow.id)
        }, [key, leadRow, store])
        useSyncExternalStore(store.subscribe, store.version)
        const now = Date.now()
        const open = id => { if (id) crew.ui.openSession(id) }

        if (context.kind === 'plain') {
          const row = byId[sessionId]
          const turns = Array.isArray(outline) ? outline : []
          const first = turns.find(turn => typeof turn?.prompt === 'string' && turn.prompt.trim())?.prompt ?? row?.displayTitle ?? ''
          return h('div', { style: P.wrap },
            h('div', { style: P.goal }, h('span', { style: P.goalLabel }, t('saidFirst')), h('span', null, first)),
            h('div', { style: P.strip },
              turns.length > 0 ? h('span', null, fill(t('turnsCount'), { n: turns.length })) : null,
              turns.length > 0 ? h('span', { style: P.sep }, '·') : null,
              h('span', { title: row?.updatedAt ? new Date(row.updatedAt).toLocaleString() : '' }, `${t('lastActive')} ${relativeTime(row?.updatedAt ?? 0, now, isZh)}`)),
            h('p', { style: { ...P.dt, margin: 0 } }, t('noTeam')),
          )
        }

        const team = context.kind === 'lead' && liveTeam ? liveTeam : leadRow?.projectionValues?.agentTeam
        // Reports are folded on the lead conversation by the Host half (lib/reports.js).
        const reportSource = context.kind === 'lead' && liveReports ? liveReports : leadRow?.projectionValues?.crewReports
        // undefined = DHS has not folded the lead's log with this plugin yet (e.g. right after install or an upgrade).
        const reportsKnown = reportSource !== undefined
        const reports = reportSource ?? {}
        const tasks = Array.isArray(team?.tasks) ? team.tasks : []
        const taskById = new Map(tasks.map(task => [task.id, task]))
        const columns = taskColumns(tasks)
        const mine = new Set(context.kind === 'member' ? tasks.filter(task => task.ownerId === sessionId).map(task => task.id) : [])
        const selectedId = picked ?? (mine.size > 0 ? [...mine][0] : null)
        const selected = selectedId ? taskById.get(selectedId) : null
        const header = key ? store.get(key) : undefined
        const goal = key ? store.goal(key) : null
        const strip = header?.ok ? stageStrip(header.stage) : null
        const waiting = header?.ok ? [...header.waiting].sort((a, b) => WAIT_ORDER.indexOf(a.kind) - WAIT_ORDER.indexOf(b.kind)) : []

        const stripView = strip === null
          ? h('div', { style: P.strip }, h('span', { style: P.step }, t('stageUnknown')))
          : h('div', { style: P.strip, role: 'list' },
            strip.done.length === 0 ? null : showDone
              ? strip.done.map(stage => h('button', { key: stage, type: 'button', role: 'listitem', style: { ...P.step, ...P.stepDone }, onClick: () => setShowDone(false) }, `✓ ${t(`stage_${stage}`)}`))
              : h('button', { type: 'button', role: 'listitem', style: { ...P.step, ...P.stepDone }, onClick: () => setShowDone(true) }, fill(t('doneSteps'), { n: strip.done.length })),
            h('span', { style: P.sep }, '→'),
            h('span', { role: 'listitem', 'aria-current': 'step', style: { ...P.step, ...P.stepNow } }, t(`stage_${strip.current}`)),
            ...strip.upcoming.flatMap(stage => [h('span', { key: `s-${stage}`, style: P.sep }, '→'), h('span', { key: stage, role: 'listitem', style: P.step }, t(`stage_${stage}`))]),
          )

        const nodeView = task => {
          const state = taskState(task, taskById, reports[task.id])
          const owner = ownerInfo(byId, task.ownerId, task.ownerName, context.leadId)
          const isMine = mine.has(task.id)
          return h('button', {
            key: task.id, type: 'button', 'aria-pressed': selectedId === task.id,
            style: { ...P.node, borderLeftColor: STATE_COLOR[state], ...(selectedId === task.id ? P.nodeSelected : null), ...(isMine ? P.nodeMine : null), borderLeftWidth: '3px', borderLeftStyle: 'solid' },
            title: stripTitle(task.subject),
            onClick: () => setPicked(task.id),
          },
          h('span', { style: P.nodeTitle }, stripTitle(task.subject)),
          h('span', { style: P.nodeMeta }, [t(`task_${state}`), owner.isLead ? t('leadName') : owner.name].filter(Boolean).join(' · ')))
        }

        const detailView = selected == null
          ? h('aside', { style: P.detail }, h('span', { style: P.dt }, t('detailHint')))
          : (() => {
            const owner = ownerInfo(byId, selected.ownerId, selected.ownerName, context.leadId)
            const report = reports[selected.id]
            const outputs = report?.output || (selected.writeScopes ?? []).join('；')
            const unverified = report?.unverified && !/^无[。.]?$/.test(report.unverified) ? report.unverified : null
            return h('aside', { style: P.detail, 'aria-label': stripTitle(selected.subject) },
              h('strong', null, stripTitle(selected.subject)),
              mine.has(selected.id) ? h('span', { style: P.dt }, t('yourTask')) : null,
              h('span', { style: P.dt }, t('detailWhat')), h('p', { style: P.dd }, firstParagraph(selected.description) || t('none')),
              h('span', { style: P.dt }, t('detailWho')), h('p', { style: P.dd }, [owner.isLead ? t('leadName') : owner.name, owner.model].filter(Boolean).join(' · ') || t('none')),
              h('span', { style: P.dt }, t('detailOutput')), h('p', { style: P.dd }, outputs || t('none')),
              report ? h('span', { style: P.dt }, t('detailReport')) : null,
              report ? h('p', { style: P.dd }, [report.status, report.summary].filter(Boolean).join(' · ')) : null,
              h('span', { style: P.dt }, t('detailEvidence')), h('p', { style: P.dd }, report?.checks || (report ? t('evidenceNotListed') : reportsKnown ? t('noReport') : t('reportsPending'))),
              !reportsKnown && context.kind === 'member' ? h('div', null, h('button', { type: 'button', style: S.button, onClick: () => open(context.leadId) }, t('openLead'))) : null,
              unverified ? h('span', { style: P.dt }, t('detailUnverified')) : null,
              unverified ? h('p', { style: { ...P.dd, color: v('state-warn-label') } }, unverified) : null,
              report?.leftover && !/^无[。.]?$/.test(report.leftover) ? h('span', { style: P.dt }, t('detailLeftover')) : null,
              report?.leftover && !/^无[。.]?$/.test(report.leftover) ? h('p', { style: P.dd }, report.leftover) : null,
              selected.ownerId ? h('div', null, h('button', { type: 'button', style: S.button, onClick: () => open(selected.ownerId) }, t('openChat'))) : null,
            )
          })()

        return h('div', { style: P.wrap },
          h('div', { style: P.goal }, h('span', { style: P.goalLabel }, t('goalLabel')), h('span', null, goal ?? t('noGoal'))),
          stripView,
          waiting.length === 0 ? null : h('section', { style: S.block },
            h('h2', { style: S.h2 }, t('waitingTitle')),
            h('div', { style: S.card }, waiting.map((item, index) => h('div', { key: index, style: { ...S.row, ...(index === 0 ? S.rowFirst : null) } },
              h('span', { style: S.kind }, t(`kind_${item.kind}`)),
              h('span', { style: S.grow, title: item.text }, item.text),
              context.kind === 'member' ? h('button', { type: 'button', style: S.button, onClick: () => open(context.leadId) }, t('handle')) : null,
            )))),
          h('section', { style: S.block },
            h('h2', { style: S.h2 }, t('tasksTitle')),
            columns.length === 0 ? h('div', { style: S.notice }, t('noTasks')) : h('div', { style: P.body },
              h('div', { style: P.flow }, h('div', { style: P.cols }, columns.flatMap((column, index) => [
                index > 0 ? h('span', { key: `a${index}`, style: P.arrow, 'aria-hidden': true }, '→') : null,
                h('div', { key: `c${index}`, style: P.col(columnCards(column.length)) }, column.map(nodeView)),
              ]))),
              detailView,
            ),
          ),
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

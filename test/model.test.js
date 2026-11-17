/**
 * Offline tests for the pure M1 logic in client.js (returned as `model`):
 * STATE.md header parsing, project grouping, waiting order, recency and the tidy
 * batches with every exclusion from DESIGN.md §3 D.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createPlugin } from './load-client.js'

const m = createPlugin().model
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 16, 12)

const header = [
  '---',
  'stage: design',
  'milestone: M1',
  'updated: 2026-11-16T23:30-08:00',
  'waiting:',
  '  - accept: 看一遍界面规范',
  '  - authorize: 允许第一次存档',
  '  - decide: 选方向',
  '---',
  '# body',
  '',
].join('\n')

test('parses the STATE.md header into stage and typed waiting items', () => {
  const parsed = m.parseStateHeader(header)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.stage, 'design')
  assert.equal(parsed.milestone, 'M1')
  assert.deepEqual(parsed.waiting.map(item => item.kind), ['accept', 'authorize', 'decide'])
  assert.equal(parsed.waiting[0].text, '看一遍界面规范')
})

test('header parsing tolerates CRLF and empty waiting, and rejects bad input', () => {
  assert.equal(m.parseStateHeader(header.replace(/\n/g, '\r\n')).waiting.length, 3)
  assert.deepEqual(m.parseStateHeader('---\nstage: build\nmilestone: M2\nupdated: x\nwaiting: []\n---\n').waiting, [])
  assert.equal(m.parseStateHeader('# no header\n').ok, false)
  assert.equal(m.parseStateHeader('---\nstage: coding\n---\n').ok, false)
  assert.equal(m.parseStateHeader(undefined).ok, false)
  // Unknown kinds are dropped rather than shown with a raw key.
  assert.equal(m.parseStateHeader('---\nstage: plan\nwaiting:\n  - approve: x\n  - act: y\n---\n').waiting.length, 1)
})

test('scratch folders and path keys', () => {
  assert.equal(m.isScratchPath('C:\\Users\\me\\Downloads'), true)
  assert.equal(m.isScratchPath('D:\\2026817'), true)
  assert.equal(m.isScratchPath('D:\\fake\\faker'), true)
  assert.equal(m.isScratchPath('D:\\dsh\\harness'), false)
  assert.equal(m.pathKey('D:\\Dsh\\Harness\\'), m.pathKey('d:/dsh/harness'))
})

const row = (id, extra = {}) => ({ id, displayTitle: id, updatedAt: NOW - DAY, running: false, blank: false, ...extra })
const lead = (id, extra = {}) => row(id, { cwd: 'D:\\dsh\\harness', projectionValues: { agentTeam: { tasks: [{}, {}] } }, ...extra })

test('projects pick the most recent lead and ignore subagents and archived rows', () => {
  const sessions = { byId: {
    oldLead: lead('oldLead', { updatedAt: NOW - 5 * DAY }),
    newLead: lead('newLead', { updatedAt: NOW - 2 * DAY }),
    member: row('member', { origin: 'subagent', parentId: 'newLead', updatedAt: NOW }),
    gone: lead('gone', { updatedAt: NOW }),
    chat: row('chat', { updatedAt: NOW - 3 * DAY }),
  } }
  const workspaces = { items: [{ path: 'D:\\dsh\\harness', title: 'harness', sessionIds: ['oldLead', 'newLead', 'member', 'gone', 'chat'] }], archivedSessionIds: ['gone'] }
  const [project] = m.buildProjects(sessions, workspaces)
  assert.equal(project.leadId, 'newLead')
  assert.equal(project.lastId, 'newLead')
  assert.deepEqual(project.sessionIds, ['oldLead', 'newLead', 'chat'])
})

test('waiting items are ordered by urgency, then project name', () => {
  const projects = [
    { key: 'b', title: 'B', leadId: 'lb' },
    { key: 'a', title: 'A', leadId: 'la' },
    { key: 'c', title: 'C', leadId: null },
  ]
  const headers = new Map([
    ['a', m.parseStateHeader(header)],
    ['b', m.parseStateHeader('---\nstage: build\nwaiting:\n  - authorize: 装插件\n---\n')],
    ['c', m.parseStateHeader(header)], // no lead: ignored
  ])
  const waiting = m.collectWaiting(projects, headers)
  assert.deepEqual(waiting.map(item => `${item.kind}:${item.project}`), ['authorize:A', 'authorize:B', 'accept:A', 'decide:A'])
  assert.equal(waiting[0].leadId, 'la')
})

test('recent projects keep only the last 7 days, newest first', () => {
  const recent = m.recentProjects([
    { key: 'x', lastAt: NOW - 8 * DAY },
    { key: 'y', lastAt: NOW - 1 * DAY },
    { key: 'z', lastAt: NOW - 6 * DAY },
    { key: 'w', lastAt: 0 },
  ], NOW)
  assert.deepEqual(recent.map(p => p.key), ['y', 'z'])
})

test('tidy batches: stale, blank, scratch, and every protected row stays out', () => {
  const sessions = { byId: {
    stale: row('stale', { updatedAt: NOW - 40 * DAY }),
    staleBlank: row('staleBlank', { updatedAt: NOW - 40 * DAY, blank: true }),
    blank: row('blank', { updatedAt: NOW - 10 * DAY, blank: true }),
    recentBlank: row('recentBlank', { updatedAt: NOW - 2 * DAY, blank: true }),
    pinned: row('pinned', { updatedAt: NOW - 90 * DAY }),
    running: row('running', { updatedAt: NOW - 90 * DAY, running: true }),
    waitingLead: lead('waitingLead', { updatedAt: NOW - 90 * DAY }),
    member: row('member', { origin: 'subagent', parentId: 'waitingLead', updatedAt: NOW - 90 * DAY }),
    archived: row('archived', { updatedAt: NOW - 90 * DAY }),
    scratchOnly: row('scratchOnly', { updatedAt: NOW - 12 * DAY }),
    projectChat: row('projectChat', { updatedAt: NOW - 12 * DAY }),
  } }
  const workspaces = {
    items: [
      { path: 'D:\\dsh\\harness', title: 'harness', sessionIds: ['stale', 'staleBlank', 'blank', 'recentBlank', 'pinned', 'running', 'waitingLead', 'member', 'archived', 'projectChat'] },
      { path: 'C:\\Users\\me\\Downloads', title: 'Downloads', sessionIds: ['scratchOnly'] },
    ],
    archivedSessionIds: ['archived'],
    pinnedSessionIds: ['pinned'],
  }
  const batches = m.tidyCandidates({ sessions, workspaces, waitingLeadIds: ['waitingLead'], now: NOW })
  assert.deepEqual(batches.stale.map(e => e.id), ['stale', 'staleBlank'])
  assert.deepEqual(batches.blank.map(e => e.id), ['blank'])
  assert.deepEqual(batches.scratch.map(e => e.id), ['scratchOnly'])
  const all = [...batches.stale, ...batches.blank, ...batches.scratch].map(e => e.id)
  for (const kept of ['recentBlank', 'pinned', 'running', 'waitingLead', 'member', 'archived', 'projectChat']) assert.ok(!all.includes(kept), `${kept} is never suggested`)
  assert.equal(batches.stale[0].folder, 'harness')
})

test('a scratch folder with several conversations is treated as a real folder', () => {
  const sessions = { byId: { a: row('a', { updatedAt: NOW - 12 * DAY }), b: row('b', { updatedAt: NOW - 12 * DAY }) } }
  const workspaces = { items: [{ path: 'D:\\temp', title: 'temp', sessionIds: ['a', 'b'] }] }
  assert.equal(m.tidyCandidates({ sessions, workspaces, now: NOW }).scratch.length, 0)
})

test('conversations outside every folder are tidied too, labelled as ungrouped', () => {
  const sessions = { byId: {
    loose: row('loose', { updatedAt: NOW - 60 * DAY, title: '' }),
    looseRecent: row('looseRecent', { updatedAt: NOW - 1 * DAY }),
    looseArchived: row('looseArchived', { updatedAt: NOW - 60 * DAY }),
    looseMember: row('looseMember', { updatedAt: NOW - 60 * DAY, origin: 'subagent', parentId: 'x' }),
    inFolder: row('inFolder', { updatedAt: NOW - 60 * DAY }),
  } }
  const workspaces = { items: [{ path: 'D:\\p', title: 'p', sessionIds: ['inFolder'] }], archivedSessionIds: ['looseArchived'] }
  const { stale } = m.tidyCandidates({ sessions, workspaces, now: NOW })
  const byId = Object.fromEntries(stale.map(e => [e.id, e.folder]))
  assert.deepEqual(byId, { inFolder: 'p', loose: null })
  assert.equal(stale.find(e => e.id === 'loose').title, '', 'no folder name stands in for a missing title')
})

test('empty folders are those whose conversations are all archived, or that have none', () => {
  const workspaces = {
    items: [
      { workspaceId: 'w1', path: 'D:\\a', title: 'a', sessionIds: ['x', 'y'] },
      { workspaceId: 'w2', path: 'D:\\b', title: 'b', sessionIds: ['x', 'live'] },
      { workspaceId: 'w3', path: 'D:\\c', title: '', sessionIds: [] },
    ],
    archivedSessionIds: ['x', 'y'],
  }
  assert.deepEqual(m.emptyFolders(workspaces), [
    { id: 'w1', title: 'a', path: 'D:\\a', archivedCount: 2 },
    { id: 'w3', title: 'D:\\c', path: 'D:\\c', archivedCount: 0 },
  ])
  assert.deepEqual(m.emptyFolders(undefined), [])
})

test('task titles lose their milestone tags', () => {
  assert.equal(m.stripTitle('[M0] DSH 源码 dev 环境与热更新'), 'DSH 源码 dev 环境与热更新')
  assert.equal(m.stripTitle('[M1][fix]  修活动时间'), '修活动时间')
  assert.equal(m.stripTitle('勘察：竞品'), '勘察：竞品')
  assert.equal(m.stripTitle(undefined), '')
})

test('pipeline context: lead, member of a lead, or plain', () => {
  const byId = {
    L: lead('L'),
    M: row('M', { origin: 'subagent', parentId: 'L' }),
    orphan: row('orphan', { origin: 'subagent', parentId: 'gone' }),
    chat: row('chat'),
  }
  assert.deepEqual(m.pipelineContext('L', byId), { kind: 'lead', leadId: 'L' })
  assert.deepEqual(m.pipelineContext('M', byId), { kind: 'member', leadId: 'L' })
  assert.deepEqual(m.pipelineContext('orphan', byId), { kind: 'plain', leadId: null })
  assert.deepEqual(m.pipelineContext('chat', byId), { kind: 'plain', leadId: null })
  assert.deepEqual(m.pipelineContext('missing', byId), { kind: 'plain', leadId: null })
})

const task = (id, extra = {}) => ({ id, subject: id, description: '', status: 'completed', blockedBy: [], writeScopes: [], ...extra })

test('tasks are laid out in columns by dependency depth', () => {
  const tasks = [
    task('task-12', { blockedBy: ['task-10', 'task-11'] }),
    task('task-2'), task('task-10'), task('task-11', { blockedBy: ['task-2'] }),
    task('task-13', { blockedBy: ['task-12'] }),
    task('task-9', { status: 'deleted' }),
  ]
  const columns = m.taskColumns(tasks).map(column => column.map(t => t.id))
  assert.deepEqual(columns, [['task-2', 'task-10'], ['task-11'], ['task-12'], ['task-13']])
})

test('dependency cycles do not hang the layout', () => {
  const columns = m.taskColumns([task('a', { blockedBy: ['b'] }), task('b', { blockedBy: ['a'] })])
  assert.equal(columns.flat().length, 2)
})

test('task state in plain terms', () => {
  const byId = new Map([['a', task('a', { status: 'in_progress' })], ['b', task('b', { status: 'pending', blockedBy: ['a'] })], ['c', task('c', { status: 'pending' })]])
  assert.equal(m.taskState(task('x'), byId), 'done')
  assert.equal(m.taskState(byId.get('a'), byId), 'doing')
  assert.equal(m.taskState(byId.get('b'), byId), 'blocked')
  assert.equal(m.taskState(byId.get('c'), byId), 'todo')
})

test('a blocked or needs-decision report, or a write-scope warning, marks the task as a problem', () => {
  const byId = new Map()
  assert.equal(m.taskState(task('a', { status: 'in_progress' }), byId, { status: '阻塞' }), 'problem')
  assert.equal(m.taskState(task('a', { status: 'pending' }), byId, { status: '需要决定' }), 'problem')
  assert.equal(m.taskState(task('a', { status: 'completed' }), byId, { status: '阻塞' }), 'done', 'a finished task is not a problem because of an old report')
  assert.equal(m.taskState(task('a', { status: 'in_progress' }), byId, { status: '完成' }), 'doing')
  assert.equal(m.taskState(task('a', { status: 'in_progress', writeScopeWarnings: ['overlaps task-2'] }), byId), 'problem')
})

test('stage strip splits finished, current and upcoming steps', () => {
  const strip = m.stageStrip('build')
  assert.deepEqual(strip.done, ['intake', 'plan', 'design', 'foundation'])
  assert.equal(strip.current, 'build')
  assert.deepEqual(strip.upcoming, ['deliver', 'delivered'])
  assert.deepEqual(m.stageStrip('paused'), { done: [], current: 'paused', upcoming: [] })
  assert.equal(m.stageStrip(undefined).current, null)
})

test('goal is the first sentence under the purpose heading', () => {
  const doc = '# t\n\n> note\n\n## 目的\n\n让用户的 DSH 从“聊天窗口”变成**以项目为中心**的工作台：打开就能看到状态。后面还有。\n\n## 用户\n'
  assert.equal(m.parseGoal(doc), '让用户的 DSH 从“聊天窗口”变成以项目为中心的工作台：打开就能看到状态。')
  assert.equal(m.parseGoal('## 目的\n\n## 下一节\n'), null)
  assert.equal(m.parseGoal('# no goal\n'), null)
})

test('owner info prefers the member label and reads the model', () => {
  const byId = { s: { projectionValues: { subagent: { label: '搭建热更新环境' }, modelSelection: { lastUsed: { model: 'deepseek-flash' } } } } }
  assert.deepEqual(m.ownerInfo(byId, 's', 'builder-env', 'L'), { isLead: false, name: '搭建热更新环境', model: 'deepseek-flash' })
  assert.deepEqual(m.ownerInfo(byId, 'L', 'lead', 'L'), { isLead: true, name: 'lead', model: null })
  assert.equal(m.firstParagraph('第一段\n第二行\n\n第二段'), '第一段\n第二行')
  assert.equal(m.firstParagraph('[M0] 搭建环境。\n\n细节'), '搭建环境。')
})

test('a column with many independent tasks spreads over at most three card widths', () => {
  assert.deepEqual([1, 6, 7, 12, 13, 40].map(m.columnCards), [1, 1, 2, 2, 3, 3])
})

test('relative time in plain words', () => {
  assert.equal(m.relativeTime(NOW - 30 * 1000, NOW), '刚刚')
  assert.equal(m.relativeTime(NOW - 5 * 60000, NOW), '5 分钟前')
  assert.equal(m.relativeTime(NOW - 3 * 3600000, NOW), '3 小时前')
  assert.equal(m.relativeTime(NOW - 3 * DAY, NOW), '3 天前')
  assert.equal(m.relativeTime(0, NOW), '没有记录')
  assert.equal(m.relativeTime(NOW - 3 * DAY, NOW, false), '3 d ago')
})

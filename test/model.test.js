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

test('tidy by purpose: leads a newer lead took over, and delivered projects', () => {
  const sessions = { byId: {
    m1Lead: lead('m1Lead', { updatedAt: NOW - 2 * DAY }),
    m2Lead: lead('m2Lead', { updatedAt: NOW - 3 * 3600000 }),
    m0Lead: lead('m0Lead', { updatedAt: NOW - 3600000 * 12 }),
    chat: row('chat', { updatedAt: NOW - 2 * DAY }),
    doneLead: lead('doneLead', { cwd: 'D:\\done', updatedAt: NOW - 4 * DAY }),
    doneChat: row('doneChat', { updatedAt: NOW - 4 * DAY }),
    doneFresh: row('doneFresh', { updatedAt: NOW - 1 * DAY }),
  } }
  const workspaces = { items: [
    { path: 'D:\\dsh\\harness', title: 'harness', sessionIds: ['m1Lead', 'm2Lead', 'm0Lead', 'chat'] },
    { path: 'D:\\Done\\', title: 'done', sessionIds: ['doneLead', 'doneChat', 'doneFresh'] },
  ] }
  const batches = m.tidyCandidates({ sessions, workspaces, deliveredKeys: new Set(['d:/done']), now: NOW })
  assert.deepEqual(batches.superseded.map(e => e.id), ['m1Lead'], 'only leads older than a day, never the newest one')
  assert.deepEqual(batches.delivered.map(e => e.id), ['doneLead', 'doneChat'], 'quiet for 3 days in a delivered project')
  for (const kept of ['m2Lead', 'm0Lead', 'chat', 'doneFresh']) assert.ok(!Object.values(batches).flat().some(e => e.id === kept), kept)
  const waiting = m.tidyCandidates({ sessions, workspaces, waitingLeadIds: ['m1Lead'], now: NOW })
  assert.equal(waiting.superseded.length, 0, 'a lead with waiting items is never offered')
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

test('decisions the team made on its own: newest first, "无" left out, unknown tasks dropped', () => {
  const tasks = [task('task-1', { subject: '[M1] 记账页' }), task('task-2', { subject: '导出' })]
  const reports = {
    'task-1': { taskId: 'task-1', deviation: '金额按分存整数，不用小数', at: 1 },
    'task-2': { taskId: 'task-2', deviation: '无', at: 3 },
    'task-9': { taskId: 'task-9', deviation: '删掉的任务', at: 4 },
    'task-3': { taskId: 'task-3', at: 5 },
  }
  assert.deepEqual(m.deviations(tasks, reports), [{ taskId: 'task-1', title: '记账页', text: '金额按分存整数，不用小数', plain: true }])
  const many = Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [`task-${n}`, { taskId: `task-${n}`, deviation: `d${n}`, at: n }]))
  const all = [1, 2, 3, 4, 5, 6].map(n => task(`task-${n}`))
  assert.deepEqual(m.deviations(all, many).map(d => d.text), ['d6', 'd5', 'd4', 'd3', 'd2'])
})

test('usage per conversation comes from DHS tokenUsage, biggest first', () => {
  const usage = totals => ({ projectionValues: { tokenUsage: { totals } } })
  const byId = {
    L: { id: 'L', ...usage({ uncachedInputTokens: 100, cacheReadTokens: 1000, outputTokens: 10 }) },
    a: { id: 'a', parentId: 'L', ...usage({ uncachedInputTokens: 200, cacheReadTokens: 50000, outputTokens: 20 }) },
    b: { id: 'b', parentId: 'L' },
    other: { id: 'other', parentId: 'X', ...usage({ cacheReadTokens: 9e9 }) },
  }
  const out = m.teamUsage(byId, 'L', [task('task-1', { ownerId: 'a', ownerName: 'builder-ui' })])
  assert.deepEqual(out, [{ id: 'a', isLead: false, name: 'builder-ui', tokens: 50220 }, { id: 'L', isLead: true, name: null, tokens: 1110 }])
  assert.equal(m.teamUsage({ L: { id: 'L' } }, 'L', []), null, 'no usage sent: the block stays hidden')
  // The session list sends the wire view: the four totals flat, without `totals`.
  assert.equal(m.tokensOf({ projectionValues: { tokenUsage: { uncachedInputTokens: 5, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 0 } } }), 106)
  assert.equal(m.formatTokens(155284096), '1.6 亿')
  assert.equal(m.formatTokens(35000), '3.5 万')
  assert.equal(m.formatTokens(51415000), '5142 万')
  assert.equal(m.formatTokens(512), '512')
  assert.equal(m.formatTokens(12300000, false), '12.3M')
})

test('goal is the first sentence under the purpose heading', () => {
  const doc = '# t\n\n> note\n\n## 目的\n\n让用户的 DSH 从“聊天窗口”变成**以项目为中心**的工作台：打开就能看到状态。后面还有。\n\n## 用户\n'
  assert.equal(m.parseGoal(doc), '让用户的 DSH 从“聊天窗口”变成以项目为中心的工作台：打开就能看到状态。')
  assert.equal(m.parseGoal('## 目的\n\n## 下一节\n'), null)
  assert.equal(m.parseGoal('# no goal\n'), null)
})

test('owner info turns the member name into a role the user can read', () => {
  assert.deepEqual(m.ownerInfo('s', 'builder-env', 'L'), { id: 's', isLead: false, role: 'builder', name: 'builder-env' })
  assert.deepEqual(m.ownerInfo('s', 'reviewer2', 'L'), { id: 's', isLead: false, role: 'reviewer', name: 'reviewer2' })
  assert.deepEqual(m.ownerInfo('s', 'scout-landscape', 'L'), { id: 's', isLead: false, role: 'scout', name: 'scout-landscape' })
  assert.deepEqual(m.ownerInfo('s', 'review-architect', 'L'), { id: 's', isLead: false, role: 'reviewer', name: 'review-architect' })
  assert.deepEqual(m.ownerInfo('s', 'helper', 'L'), { id: 's', isLead: false, role: null, name: 'helper' })
  assert.deepEqual(m.ownerInfo('L', 'lead', 'L'), { id: 'L', isLead: true, role: null, name: 'lead' })
  assert.deepEqual(m.ownerInfo(null, undefined, 'L'), { id: null, isLead: false, role: null, name: null })
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

test('reports are matched to tasks, including one a member sent without the task line', () => {
  const tasks = [
    task('task-1', { ownerName: 'reviewer' }),
    task('task-2', { ownerName: 'docs', status: 'completed', subject: '把 README 改通俗' }),
  ]
  const reports = {
    'task-1': { taskId: 'task-1', deviation: '无', at: 1 },
    '@docs': { taskId: null, deviation: '不再提测试用的环境变量', at: 9 },
  }
  const byTask = m.reportsByTask(tasks, reports)
  assert.deepEqual(Object.keys(byTask).sort(), ['task-1', 'task-2'])
  assert.equal(byTask['task-2'].taskId, 'task-2')
  assert.deepEqual(m.deviations(tasks, byTask), [{ taskId: 'task-2', title: '把 README 改通俗', text: '不再提测试用的环境变量', plain: true }])
  const newer = m.reportsByTask(tasks, { ...reports, 'task-2': { taskId: 'task-2', summary: 'named', at: 20 } })
  assert.equal(newer['task-2'].summary, 'named', 'a newer report that names the task wins')
})

test('a crew folder has a lead even when the lead never created a team task (seen live 11-17)', () => {
  const byId = {
    old: lead('old', { cwd: 'D:/p', updatedAt: NOW - 5 * DAY }),
    solo: row('solo', { cwd: 'D:/P/', updatedAt: NOW - DAY }),
    empty: row('empty', { cwd: 'D:/p', updatedAt: NOW, blank: true }),
    rev: row('rev', { cwd: 'D:/p', origin: 'subagent', parentId: 'solo' }),
    other: row('other', { cwd: 'D:/q', updatedAt: NOW }),
  }
  assert.equal(m.crewLead(byId, 'D:/p', true), 'solo', 'newest non-blank conversation in a folder with a crew header')
  assert.equal(m.crewLead(byId, 'D:/p', false), 'old', 'without a header only a task board makes a lead')
  assert.equal(m.crewLead(byId, 'D:/q', false), null)
  const header = cwd => m.pathKey(cwd) === 'd:/p'
  assert.deepEqual(m.pipelineContext('solo', byId, header), { kind: 'lead', leadId: 'solo' })
  assert.deepEqual(m.pipelineContext('rev', byId, header), { kind: 'member', leadId: 'solo' })
  assert.deepEqual(m.pipelineContext('old', byId, header), { kind: 'lead', leadId: 'old' }, 'an older lead with its own board still shows it')
  assert.deepEqual(m.pipelineContext('solo', byId), { kind: 'plain', leadId: null }, 'no header: unchanged behaviour')
})

test('without a task board, member decisions still show under the member name (seen live 11-17)', () => {
  const reports = {
    'task-1': { taskId: 'task-1', deviation: '版本号冲突时以服务端为准', from: 'critic', at: 2 },
    '@docs': { taskId: null, deviation: 'README 不写端口号的来历', from: 'docs', at: 3 },
  }
  const byTask = m.reportsByTask([], reports)
  assert.deepEqual(m.deviations([], byTask).map(d => [d.title, d.text]), [['docs', 'README 不写端口号的来历'], ['critic', '版本号冲突时以服务端为准']])
})

test('"无" with an explanation is still no decision (seen live 11-17)', () => {
  const tasks = [task('task-1'), task('task-2')]
  const reports = {
    'task-1': { taskId: 'task-1', deviation: '无（只写评审报告，没改代码）', at: 1 },
    'task-2': { taskId: 'task-2', deviation: '无法用拖动时改成上下按钮', at: 2 },
  }
  assert.deepEqual(m.deviations(tasks, reports).map(d => d.taskId), ['task-2'], '"无法…" is a real decision')
})

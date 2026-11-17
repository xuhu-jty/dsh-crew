/**
 * Offline contract checks for the client half: registration id, injected services,
 * the slot contributions from DESIGN.md §2, plain-language copy and DHS-only colors.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createPlugin, loadedCount, registration } from './load-client.js'

const PACKAGE = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
const SOURCE = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8')

function fakeContext() {
  const state = { registrations: [], dictionaries: {} }
  const read = (dictionary, key) => key.split('.').reduce((value, part) => value?.[part], dictionary)
  const ctx = {
    effect: callback => { callback() },
    locale: {
      register: (namespace, dictionaries) => { state.dictionaries[namespace] = dictionaries; return () => {} },
      bind: namespace => key => read(state.dictionaries[namespace]?.zh ?? {}, key) ?? key,
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => { state.registrations.push({ options, component }); return () => {} },
    },
    remote: { workspaceFiles: { read: async () => ({ ok: false }) } },
    get: name => ({
      uiWorkspace: { archiveSession: async () => {}, unarchiveSession: async () => {}, openSession: () => {} },
      workspaces: { delete: async () => {} },
    })[name],
  }
  return { ctx, state }
}

test('registers once under the package name and injects only what it uses', () => {
  assert.equal(loadedCount, 1)
  assert.equal(registration.id, PACKAGE.name)
  const plugin = createPlugin()
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'remote', 'remote.workspaceFiles', 'uiWorkspace', 'workspaces'])
  assert.ok(!plugin.inject.includes('remote.commands'), 'no command channel: nothing is written into sessions')
})

test('apply contributes the page, its sidebar entry, the row dot and the hover line', () => {
  const { ctx, state } = fakeContext()
  createPlugin().apply(ctx)
  const by = name => state.registrations.find(entry => entry.options.name === name)
  assert.equal(by('main').options.key, 'crew-center')
  assert.equal(by('sidebar.panellist').options.id, 'crew-center')
  assert.equal(by('sidebar.panellist').options.label(), '项目')
  assert.equal(by('sidebar.session.row.trailing').options.id, 'crew-center.waiting')
  assert.equal(by('sidebar.session.row.hover').options.id, 'crew-center.waiting')
  const face = by('main').options.inject()
  for (const method of ['archiveSession', 'unarchiveSession', 'openSession']) assert.equal(typeof face.crew.ui[method], 'function')
  assert.equal(typeof face.crew.workspaces.delete, 'function', 'folder removal goes through DHS workspaces.delete')
})

test('the pipeline view sits between DHS chat (0) and trajectory (10)', () => {
  const { ctx, state } = fakeContext()
  createPlugin().apply(ctx)
  const view = state.registrations.find(entry => entry.options.name === 'conversation.view')
  assert.equal(view.options.id, 'crew-center.pipeline')
  assert.equal(view.options.order, 5)
  assert.equal(view.options.label(), '流水线')
  assert.equal(typeof view.component, 'function')
})

test('row dot renders nothing for rows that are not project leads', () => {
  const { ctx, state } = fakeContext()
  createPlugin().apply(ctx)
  const Dot = state.registrations.find(entry => entry.options.name === 'sidebar.session.row.trailing').component
  const props = { sessionId: 's1', useSessions: selector => selector({ byId: { s1: { id: 's1', cwd: 'D:\\x' } } }) }
  assert.equal(Dot(props), null)
})

test('user-facing copy avoids internal terms (DESIGN.md §5)', () => {
  const { ctx, state } = fakeContext()
  createPlugin().apply(ctx)
  const words = JSON.stringify(state.dictionaries.crewCenter.zh).toLowerCase()
  for (const banned of ['session', 'projection', 'host', 'client', 'slot', 'poc', 'task-', 'bundle', 'payload', 'cwd', 'token']) {
    assert.ok(!words.includes(banned), `zh copy has no "${banned}"`)
  }
  assert.ok(state.dictionaries.crewCenter.en.panel, 'English dictionary present')
})

test('dictionaries are flat and cover every stage and waiting kind', () => {
  const { ctx, state } = fakeContext()
  const plugin = createPlugin()
  plugin.apply(ctx)
  for (const lang of ['zh', 'en']) {
    const dict = state.dictionaries.crewCenter[lang]
    for (const value of Object.values(dict)) assert.equal(typeof value, 'string', `${lang} has only flat string entries`)
    for (const stage of plugin.model.STAGES) assert.ok(dict[`stage_${stage}`], `${lang} stage_${stage}`)
    for (const kind of plugin.model.WAIT_ORDER) assert.ok(dict[`kind_${kind}`], `${lang} kind_${kind}`)
  }
})

test('colors come only from DHS variables (DESIGN.md §4)', () => {
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(SOURCE), 'no hex colors')
  assert.ok(!/\brgba?\(|\bhsla?\(/i.test(SOURCE), 'no rgb/hsl colors')
})

'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { RunStore } = require('../workflow/store.cjs')
const { createWorkflowCore } = require('../workflow/core.cjs')
const { extendCore } = require('../workflow/operations.cjs')
const { configuration, runtimePaths } = require('../workflow/runtime.cjs')
const { serve } = require('../workflow/mcp.cjs')
const { tools } = require('../workflow/tools.cjs')
const base = require('../paths.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biohub-core-'))
  const paths = { ...base, engineRoot: () => path.resolve(__dirname, '../../..'), repoRoot: () => root,
    siteCatalogPath: () => path.resolve(__dirname, '../../bioinformatics-hub/public/site-catalog.json'),
    defaultRunsRoot: () => root, resolveRunDir: id => base.resolveRunDir(id, root), resolvePython: () => null }
  const core = createWorkflowCore({ paths, dataDir: root }); extendCore(core)
  t.after(async () => { await core.shutdown(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  return { core, root }
}

test('reading a run never acquires its controller lock or repairs a truncated journal', async t => {
  const { core, root } = fixture(t)
  const store = new RunStore(path.join(root, 'read-test'))
  store.save({ schemaVersion: 2, id: 'read-test', status: 'running', input: {}, nodes: [], workflow: { nodes: [] } }, 'created')
  fs.appendFileSync(store.journal, '{partial')
  const before = fs.readFileSync(store.journal, 'utf8')
  const result = await core.call('load', { id: 'read-test' })
  assert.equal(result.status, 'running')
  assert.equal(fs.readFileSync(store.journal, 'utf8'), before)
  assert.equal(fs.existsSync(path.join(store.dir, '.controller.lock')), false)
})

test('catalog exposes every existing service/tool and the three templates', async t => {
  const { core } = fixture(t)
  const catalog = await core.call('catalog')
  assert.equal(Object.keys(catalog.recipes).length, 28)
  assert.equal(Object.keys(catalog.localTools).length, 8)
  assert.equal(catalog.templates.length, 3)
  assert.deepEqual(catalog.executionOptions.map(option => option.value), ['local', 'web', 'mixed'])
  const names = new Set(tools.map(tool => tool.method))
  for (const method of ['resolve', 'start', 'list', 'load', 'events', 'control', 'answer', 'results', 'openResult', 'archive', 'capture', 'export']) assert.ok(names.has(method))
})

test('starting without a user execution choice does not resolve, schedule or reserve an idempotency key', async t => {
  const { core, root } = fixture(t)
  core.workerRequest = () => { throw new Error('No worker should run before the choice') }
  const args = { identifier: 'P69905', template: 'protein', idempotencyKey: 'choose-first' }
  const missing = await core.call('start', args)
  assert.equal(missing.status, 'needs_choice')
  assert.equal(missing.actionRequired, 'choose_execution')
  assert.equal(missing.id, undefined)
  assert.deepEqual(await core.call('list'), [])
  assert.equal(fs.existsSync(path.join(root, 'requests')), false)
  assert.equal((await core.call('start', { workflow: { nodes: [{ id: 'x', kind: 'local' }] } })).status, 'needs_choice')
  core.workerRequest = () => ({ promise: Promise.resolve({ status: 'ambiguous', actionRequired: 'confirm_identifier' }) })
  const confirmed = await core.call('start', { ...args, executionMode: 'mixed' })
  assert.equal(confirmed.status, 'needs_input')
  assert.equal(confirmed.executionMode, 'mixed')
  assert.equal((await core.call('start', { ...args, executionMode: 'mixed' })).id, confirmed.id)
})

test('execution choices reject incompatible plans without switching tools or silently selecting a template', async t => {
  const { core } = fixture(t)
  core.workerRequest = () => { throw new Error('Incompatible choices must not resolve or launch') }
  assert.equal((await core.call('start', { executionMode: 'local' })).actionRequired, 'choose_workflow')
  await assert.rejects(core.call('start', { executionMode: 'auto', template: 'protein' }), /Unknown executionMode/)
  for (const executionMode of ['local', 'web']) {
    const result = await core.call('start', { executionMode, template: 'protein', identifier: 'P69905' })
    assert.equal(result.status, 'needs_choice')
    assert.equal(result.id, undefined)
    assert.deepEqual(result.conflicts, executionMode === 'local' ? ['interpro'] : ['prepare', 'physchem', 'hydrophobicity'])
  }
  const workflow = { nodes: [{ id: 'custom-website', kind: 'site', custom: true }] }
  assert.deepEqual((await core.call('start', { executionMode: 'local', workflow })).conflicts, ['custom-website'])
  assert.equal(workflow.nodes[0].kind, 'site')
  assert.deepEqual(await core.call('list'), [])
})

test('a matching local or web plan starts with the selected mode in the saved task', async t => {
  const { core } = fixture(t)
  for (const executionMode of ['local', 'web']) {
    const node = { id: 'analysis', kind: executionMode === 'local' ? 'local' : 'site',
      ...(executionMode === 'local' ? { tool: 'physchem' } : { siteId: 'interpro' }),
      input: { source: 'input', key: 'protein' }, dependsOn: [], parameters: {} }
    const result = await core.call('start', { executionMode,
      workflow: { id: 'chosen-plan', name: 'Chosen analysis', version: 1, nodes: [node] },
      inputs: { protein: { kind: 'protein_fasta', value: '>test\nMSTNPKPQRKTK\n' } } })
    assert.ok(result.id)
    assert.equal(result.executionMode, executionMode)
    assert.equal(core.read(result.id).executionMode, executionMode)
    assert.deepEqual(result.workflow.nodes.map(n => n.kind), [node.kind])
  }
})

test('answering an identifier keeps the chosen mode and an older pending task asks before continuing', async t => {
  const { core, root } = fixture(t)
  core.workerRequest = () => ({ promise: Promise.resolve({ status: 'ambiguous', actionRequired: 'confirm_identifier' }) })
  const pending = await core.call('start', { identifier: 'P69905', template: 'protein', executionMode: 'mixed' })
  core.workerRequest = () => ({ promise: Promise.resolve({ status: 'resolved', identifier: 'P69905',
    kind: 'protein_fasta', fasta: '>test\nMSTNPKPQRKTK\n', provenance: { provider: 'uniprot' } }) })
  const answered = await core.call('answer', { id: pending.id, identifier: 'P69905' })
  assert.equal(answered.id, pending.id)
  assert.equal(answered.executionMode, 'mixed')
  assert.deepEqual(answered.workflow, pending.workflow)

  const workflow = (await core.call('catalog')).templates[0]
  const store = new RunStore(path.join(root, 'legacy-pending'))
  store.save({ schemaVersion: 2, id: 'legacy-pending', name: 'Old pending task', status: 'needs_input', input: {}, nodes: [],
    workflow, pendingRequest: { identifier: 'P69905' } }, 'created')
  core.workerRequest = () => { throw new Error('An old task needs a user choice before resolving') }
  assert.equal((await core.call('answer', { id: 'legacy-pending', identifier: 'P69905' })).actionRequired, 'choose_execution')
  assert.equal(core.read('legacy-pending').status, 'needs_input')
  core.workerRequest = () => ({ promise: Promise.resolve({ status: 'ambiguous', actionRequired: 'confirm_identifier' }) })
  const continued = await core.call('answer', { id: 'legacy-pending', executionMode: 'mixed' })
  assert.equal(continued.id, 'legacy-pending')
  assert.equal(continued.executionMode, 'mixed')
})

test('ambiguous sequence creates an idempotent needs_input task without scheduling analysis', async t => {
  const { core, root } = fixture(t)
  core.workerRequest = () => ({ promise: Promise.resolve({ status: 'ambiguous', candidates: [{ identifier: 'CCA0737S0090', provider: 'gigadb' }], actionRequired: 'confirm_identifier' }) })
  const args = { identifier: 'CCA0737S009', template: 'protein', executionMode: 'mixed', idempotencyKey: 'missing-digit' }
  const [a, b] = await Promise.all([core.call('start', args), core.call('start', args)])
  assert.equal(a.id, b.id)
  assert.equal(a.status, 'needs_input')
  assert.equal(a.nodes.length, 0)
  assert.equal(fs.existsSync(path.join(root, a.id, '.controller.lock')), false)
  const again = await core.call('start', args)
  assert.equal(again.id, a.id)
  assert.equal((await core.call('start', { idempotencyKey: 'missing-digit', identifier: 'CCA0737S009', executionMode: 'mixed', template: 'protein' })).id, a.id)
  await assert.rejects(core.call('start', { ...args, identifier: 'other' }), /different arguments/)
})

test('event cursor only returns public metadata and ignores an incomplete tail', async t => {
  const { core, root } = fixture(t)
  const store = new RunStore(path.join(root, 'events-test'))
  const state = { schemaVersion: 2, id: 'events-test', input: {}, nodes: [], workflow: { nodes: [] } }
  store.save(state, 'one'); store.save(state, 'two'); fs.appendFileSync(store.journal, '{')
  const result = await core.call('events', { id: 'events-test', after: 1 })
  assert.equal(result.cursor, 2)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].type, 'two')
  assert.equal('state' in result.events[0], false)
})

test('MCP negotiation, read-only declarations and tool errors preserve protocol stdout', async () => {
  const input = new PassThrough(), output = new PassThrough()
  let buffer = ''; output.on('data', chunk => { buffer += chunk })
  const server = serve({ input, output, invoke: async () => { throw new Error('Missing source') } })
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n')
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'biohub_resolve', arguments: { identifier: 'unknown' } } }) + '\n')
  await new Promise(resolve => setImmediate(resolve))
  server.close(); input.end()
  const replies = buffer.trim().split('\n').map(JSON.parse)
  assert.equal(replies.find(r => r.id === 1).result.serverInfo.name, 'bioinformatics-hub')
  assert.match(replies.find(r => r.id === 1).result.instructions, /ask the user whether to use local tools, web tools or a combination/)
  const catalogue = replies.find(r => r.id === 2).result.tools
  assert.equal(catalogue.find(t => t.name === 'biohub_run_status').annotations.readOnlyHint, true)
  assert.equal(catalogue.find(t => t.name === 'biohub_run_start').annotations.readOnlyHint, false)
  assert.deepEqual(catalogue.find(t => t.name === 'biohub_run_start').inputSchema.properties.executionMode.enum, ['local', 'web', 'mixed'])
  assert.equal(replies.find(r => r.id === 3).result.isError, true)
})

test('separate data directories have separate endpoints and unified explicit run roots', () => {
  const a = configuration({ BIOHUB_HOME: path.join(os.tmpdir(), 'one'), BIOINFORMATICS_HUB_RUNS: path.join(os.tmpdir(), 'runs-one') })
  const b = configuration({ BIOHUB_HOME: path.join(os.tmpdir(), 'two') })
  assert.notEqual(a.endpoint, b.endpoint)
  assert.equal(runtimePaths(a).defaultRunsRoot(), a.runsRoot)
})

test('a pending identifier cannot be resumed as a completed empty workflow', async t => {
  const { core } = fixture(t)
  core.workerRequest = () => ({ promise: Promise.resolve({ status: 'ambiguous', actionRequired: 'confirm_identifier' }) })
  const pending = await core.call('start', { identifier: 'CCA0737S009', template: 'protein', executionMode: 'mixed' })
  await assert.rejects(core.call('control', { id: pending.id, action: 'resume' }), /Confirm the sequence/)
  assert.equal((await core.call('load', { id: pending.id })).status, 'needs_input')
  assert.equal((await core.call('control', { id: pending.id, action: 'cancel' })).status, 'cancelled')
})

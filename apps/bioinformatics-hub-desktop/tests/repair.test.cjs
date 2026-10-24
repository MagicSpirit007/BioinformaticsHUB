'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createWorkflowCore } = require('../workflow/core.cjs')
const { extendCore } = require('../workflow/operations.cjs')
const { RunStore } = require('../workflow/store.cjs')
const { hash } = require('../workflow/model.cjs')
const base = require('../paths.cjs')
const repo = path.resolve(__dirname, '../../..')

test('runtime handshake binds engine bytes, protocol and canonical workspace', t => {
  const { identity, assertCompatible } = require('../workflow/build.cjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biohub-build-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts/workflow'), { recursive: true })
  fs.writeFileSync(path.join(root, 'scripts/workflow/archive.py'), 'full-page patch')
  const config = { repo: root, engine: root, runsRoot: root, dataDir: root, packaged: false }
  const first = identity(config)
  assert.doesNotThrow(() => assertCompatible(first, identity(config)))
  assert.throws(() => assertCompatible(first, { ...first, runsRoot: root + '/other' }), /RUNTIME|mismatch/)
  assert.throws(() => assertCompatible(first, undefined), /mismatch/)
  fs.appendFileSync(path.join(root, 'scripts/workflow/archive.py'), ' changed')
  assert.throws(() => assertCompatible(first, identity(config)), /buildId/)
})

test('imported scientific result is shared by load/results/export and invalidates on bytes or parameters', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biohub-repair-'))
  const core = createWorkflowCore({ dataDir: root, paths: { ...base, engineRoot: () => repo, repoRoot: () => root,
    siteCatalogPath: () => path.join(repo, 'apps/bioinformatics-hub/public/site-catalog.json'),
    defaultRunsRoot: () => root, resolveRunDir: id => base.resolveRunDir(id, root), resolvePython: () => null } })
  extendCore(core)
  t.after(async () => { await core.shutdown(); fs.rmSync(root, { recursive: true, force: true }) })
  const dir = core.runDir('repair-test'); fs.mkdirSync(dir)
  const input = '>query\nMSTK\n'; fs.writeFileSync(path.join(dir, 'input.fa'), input)
  const state = { schemaVersion: 2, id: 'repair-test', name: 'Study', status: 'needs_attention', input: { protein: { path: 'input.fa', kind: 'protein_fasta', sha256: hash(input) } },
    workflow: { nodes: [{ id: 'interpro', kind: 'site', siteId: 'interpro', parameters: {}, dependsOn: [], input: { source: 'input', key: 'protein' } }] },
    recipeSnapshot: {}, nodes: [{ id: 'interpro', status: 'failed', artifacts: [], checkpoint: {}, message: 'Original failure' }] }
  new RunStore(dir).save(state, 'created')
  const original = fs.readFileSync(path.join(dir, 'session.json'), 'utf8')
  const file = path.join(root, 'official.json')
  fs.writeFileSync(file, JSON.stringify({ results: [{ sequence: 'MSTK', md5: require('node:crypto').createHash('md5').update('MSTK').digest('hex'), matches: [] }] }))
  core.workerRequest = request => ({ promise: Promise.resolve(JSON.parse(execFileSync(process.env.BIOHUB_TEST_PYTHON || (process.platform === 'win32' ? path.join(repo, '.venv-local/Scripts/python.exe') : 'python3'), [path.join(repo, 'scripts/workflow_worker.py')], {
    input: JSON.stringify({ requestId: 'test', ...request }) + '\n', encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }).trim()).result) })
  await core.call('resultsRegister', { id: state.id, itemId: 'interpro', name: 'InterPro', kind: 'website', files: [{ path: file, role: 'data' }] })
  const checked = await core.call('resultsValidate', { id: state.id, itemId: 'interpro' })
  assert.equal(checked.results[0].checks.analysis, 'verified', JSON.stringify(checked.results[0].analysisVerification))
  const loaded = await core.call('load', { id: state.id })
  assert.equal(loaded.nodes[0].status, 'succeeded'); assert.equal(loaded.nodes[0].executionStatus, 'failed')
  assert.equal(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'), original)
  const independentlyChecked = await core.call('resultsVerify', { id: state.id })
  assert.equal(independentlyChecked.results.results[0].checks.downloads, 'complete')
  assert.equal(independentlyChecked.results.results[0].checks.archive, 'not_saved')
  const exported = await core.call('export', { id: state.id })
  assert.equal(JSON.parse(fs.readFileSync(path.join(exported.directory, 'acceptance.json'))).results[0].checks.analysis, 'verified')
  state.workflow.nodes[0].parameters = { changed: true }; new RunStore(dir).save(state, 'parameters_changed')
  assert.equal((await core.call('results', { id: state.id })).results[0].checks.analysis, 'unverified')
  assert.equal((await core.call('load', { id: state.id })).nodes[0].status, 'failed')
  state.workflow.nodes[0].parameters = {}; new RunStore(dir).save(state, 'parameters_restored')
  const registered = checked.results[0].artifacts[0]
  fs.appendFileSync(path.join(dir, registered.path), 'corruption')
  assert.equal((await core.call('results', { id: state.id })).results[0].checks.analysis, 'unverified')
  assert.equal((await core.call('resultsValidate', { id: state.id })).results[0].checks.analysis, 'unverified')
  assert.equal(fs.existsSync(path.join(dir, '.controller.lock')), false)
})

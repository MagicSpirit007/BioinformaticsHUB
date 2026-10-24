'use strict'
// Export/delete regression tests. Every fixture lives under the OS temp directory;
// the real user history is never opened or removed.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const base = require('../paths.cjs')
const { RunStore } = require('../workflow/store.cjs')
const { createWorkflowCore } = require('../workflow/core.cjs')
const { extendCore } = require('../workflow/operations.cjs')
const { hash } = require('../workflow/model.cjs')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biohub-export-delete-'))
  const paths = { ...base, engineRoot: () => path.resolve(__dirname, '../../..'), repoRoot: () => root,
    siteCatalogPath: () => path.resolve(__dirname, '../../bioinformatics-hub/public/site-catalog.json'),
    defaultRunsRoot: () => root, resolveRunDir: id => base.resolveRunDir(id, root), resolvePython: () => null }
  const cores = []
  function create() {
    const core = createWorkflowCore({ paths, dataDir: root })
    extendCore(core)
    core.workerRequest = () => ({ promise: Promise.resolve({ status: 'complete', issues: [], pages: [] }) })
    cores.push(core)
    return core
  }
  t.after(async () => {
    for (const core of cores) await core.shutdown().catch(() => {})
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  })
  return { root, paths, core: create(), restart: create }
}
function createTask(core, { id, name = id, status = 'completed', kind = 'local', siteId, files = [] }) {
  const dir = core.runDir(id)
  fs.mkdirSync(dir, { recursive: true })
  const artifacts = files.map(file => {
    const filePath = path.join(dir, file.path)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const data = file.data ?? crypto.randomBytes(file.bytes || 128)
    fs.writeFileSync(filePath, data)
    return { path: file.path, name: path.basename(file.path), kind: file.kind || 'report', sha256: file.sha256 || hash(data),
      bytes: data.length, verified: true, producer: 'n1', role: file.role || 'figure' }
  })
  const definition = kind === 'website'
    ? { id: 'n1', kind: 'site', siteId: siteId || 'hmmer', dependsOn: [], parameters: {} }
    : { id: 'n1', kind: 'local', tool: 'mafft', dependsOn: [], parameters: {} }
  const nodeStatus = status === 'running' ? 'running' : status === 'waiting_remote' ? 'waiting_remote' : 'succeeded'
  const state = { schemaVersion: 2, id, name, status, input: {}, workflow: { id: 'fixture', name: 'Fixture', version: 1, nodes: [definition] },
    recipeSnapshot: kind === 'website' ? { n1: { name: 'Fixture site', entryUrl: 'https://example.org/', allowedHosts: ['example.org'] } } : {},
    nodes: [{ id: 'n1', status: nodeStatus, artifacts, checkpoint: {}, attempts: 1 }] }
  new RunStore(dir).save(state, 'created')
  return { dir, state, artifacts }
}

test('export is asynchronous, deduplicated, and keeps concurrent queries responsive', async t => {
  const { core, root } = fixture(t)
  createTask(core, { id: 'large-task', name: 'Large result', files: [{ path: 'files/large.bin', bytes: 24 * 1024 * 1024 }] })
  await core.call('results', { id: 'large-task' })

  const started = Date.now()
  const exporting = core.call('export', { id: 'large-task' })
  await wait(20)
  await assert.rejects(core.call('export', { id: 'large-task' }), /already being exported/)

  const latencies = []
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const before = Date.now()
    const value = index % 2 === 0
      ? await core.call('results', { id: 'large-task' })
      : await core.call('load', { id: 'large-task' })
    latencies.push(Date.now() - before)
    assert.ok(value.results ? value.results.length === 1 : value.id === 'large-task')
  }))
  const output = await exporting
  assert.ok(Date.now() - started < 30_000)
  assert.ok(Math.max(...latencies) < 5_000, 'queries must not wait for the export: ' + latencies.join(', '))
  assert.deepEqual(output.verification, { status: 'not_run', items: [] })
  assert.ok(fs.existsSync(path.join(output.directory, 'index.html')))
  assert.ok(fs.existsSync(path.join(output.directory, 'acceptance.json')))
  assert.ok(fs.existsSync(path.join(output.directory, 'files', 'files', 'large.bin')))
  assert.equal((await fsp.readdir(path.join(root, 'large-task', 'deliveries'))).filter(name => name.startsWith('.export-')).length, 0)
  assert.equal((await core.call('results', { id: 'large-task' })).results[0].integrityIssues.length, 0)
})

test('export and result mutations of the same task are serialized while other tasks stay readable', async t => {
  const { core } = fixture(t)
  createTask(core, { id: 'serialized', files: [{ path: 'files/big.bin', bytes: 32 * 1024 * 1024 }] })
  createTask(core, { id: 'other-task', files: [{ path: 'files/other.bin', bytes: 1024 }] })
  const source = path.join(os.tmpdir(), `biohub-import-${crypto.randomUUID()}.bin`)
  fs.writeFileSync(source, 'external evidence')
  t.after(() => fs.rmSync(source, { force: true }))
  const exporting = core.call('export', { id: 'serialized' })
  await wait(10)
  const registering = core.call('resultsRegister', { id: 'serialized', itemId: 'external', name: 'External', kind: 'local', files: [{ path: source }] })
  const other = await core.call('results', { id: 'other-task' })
  assert.equal(other.results.length, 1)
  const output = await exporting
  const registered = await registering
  assert.equal(output.items, 1)
  assert.equal(registered.results.some(item => item.id === 'external'), true)
  assert.equal(registered.results.length, 2)
})

test('export failures clean the temporary directory and never publish a success-looking export', async t => {
  const { core, root } = fixture(t)
  createTask(core, { id: 'publish-failure', files: [{ path: 'files/a.bin', bytes: 1024 }] })
  const fsp = require('node:fs/promises')
  const rename = fsp.rename
  fsp.rename = async () => { throw new Error('simulated publish failure') }
  try { await assert.rejects(core.call('export', { id: 'publish-failure' }), /simulated publish failure/) }
  finally { fsp.rename = rename }
  const deliveries = path.join(root, 'publish-failure', 'deliveries')
  const names = fs.existsSync(deliveries) ? await fsp.readdir(deliveries) : []
  assert.deepEqual(names, [])
  assert.equal((await core.call('results', { id: 'publish-failure' })).results.length, 1)
})

test('corrupt and missing artifacts block export without blocking other tasks', async t => {
  const { core } = fixture(t)
  const corrupt = createTask(core, { id: 'corrupt', files: [{ path: 'files/a.bin', bytes: 2048 }, { path: 'files/b.bin', bytes: 2048 }] })
  const missing = createTask(core, { id: 'missing', files: [{ path: 'files/c.bin', bytes: 1024 }] })
  createTask(core, { id: 'healthy', files: [{ path: 'files/d.bin', bytes: 1024 }] })
  fs.appendFileSync(path.join(corrupt.dir, 'files/a.bin'), 'changed')
  fs.unlinkSync(path.join(missing.dir, 'files/c.bin'))
  const corruptResults = await core.call('results', { id: 'corrupt' })
  assert.match(corruptResults.results[0].integrityIssues.join(' '), /changed/)
  assert.match(corruptResults.results[0].gaps.join(' '), /changed/)
  const missingResults = await core.call('results', { id: 'missing' })
  assert.ok(missingResults.results[0].integrityIssues.length > 0)
  await assert.rejects(core.call('export', { id: 'corrupt' }), /changed/)
  await assert.rejects(core.call('export', { id: 'missing' }), /ENOENT|missing|no such file/i)
  const healthy = await core.call('export', { id: 'healthy' })
  assert.ok(fs.existsSync(healthy.directory))
  assert.equal((await core.call('results', { id: 'healthy' })).results[0].integrityIssues.length, 0)
})

test('verification gaps are returned explicitly instead of claiming a complete pass', async t => {
  const { core } = fixture(t)
  createTask(core, { id: 'gap-task', kind: 'website', siteId: 'hmmer', files: [{ path: 'files/result.txt', bytes: 256, role: 'data' }] })
  const output = await core.call('export', { id: 'gap-task' })
  assert.deepEqual(output.verification, { status: 'not_run', items: [] })
  assert.ok(output.gaps.some(gap => /HTML is missing/i.test(gap.message)))
  assert.ok(output.gaps.length > 0)
  const acceptance = JSON.parse(fs.readFileSync(path.join(output.directory, 'acceptance.json'), 'utf8'))
  assert.deepEqual(acceptance.offlineVerification, { status: 'not_run', items: [] })
  assert.deepEqual(acceptance.previousVerification, { scope: 'saved_results', items: [] })
  assert.ok(Array.isArray(acceptance.results[0].gaps))
})

test('multi-page export needs no browser or Python worker and preserves checked files', async t => {
  const { core } = fixture(t)
  const { dir } = createTask(core, { id: 'offline-export', kind: 'website', files: [
    { path: 'pages/one.html', role: 'page', data: '<html><head></head><body>Saved result one</body></html>' },
    { path: 'pages/two.html', role: 'page', data: '<html><head></head><body>Saved result two</body></html>' },
    { path: 'data/results.tsv', role: 'data', data: 'gene\tscore\nA\t1\n' },
  ] })
  let workerCalls = 0
  core.workerRequest = () => { workerCalls++; throw new Error('Browser and Python are unavailable') }
  const registryBefore = fs.existsSync(path.join(dir, 'delivery.json'))
  const output = await core.call('export', { id: 'offline-export' })
  assert.equal(workerCalls, 0, 'export must not launch even a failing verification worker')
  assert.deepEqual(output.verification, { status: 'not_run', items: [] })
  for (const file of ['one.html', 'two.html']) {
    const html = fs.readFileSync(path.join(output.directory, 'files/pages', file), 'utf8')
    assert.match(html, /Content-Security-Policy/)
    assert.match(html, /Saved result/)
  }
  assert.equal(fs.readFileSync(path.join(output.directory, 'files/data/results.tsv'), 'utf8'), 'gene\tscore\nA\t1\n')
  assert.equal(fs.existsSync(path.join(dir, 'delivery.json')), registryBefore, 'export must not create verification records')
})

test('export records matching historical verification separately and excludes stale records', async t => {
  const { core } = fixture(t)
  const { dir } = createTask(core, { id: 'previous-checks', kind: 'website', files: [
    { path: 'files/page.html', role: 'page', data: '<html><head></head><body>Saved result</body></html>' },
    { path: 'files/results.tsv', role: 'data', data: 'A\t1\n' },
  ] })
  const commands = []
  core.workerRequest = request => {
    commands.push(request.command)
    return { promise: Promise.resolve({ status: 'complete', issues: [], pages: [] }) }
  }
  const checked = await core.call('resultsVerify', { id: 'previous-checks' })
  assert.deepEqual(commands, ['delivery_verify', 'verify_downloads'], 'explicit verification still runs both workers')
  const registryFile = path.join(dir, 'delivery.json')
  const before = fs.readFileSync(registryFile, 'utf8')
  commands.length = 0
  const output = await core.call('export', { id: 'previous-checks' })
  const acceptance = JSON.parse(fs.readFileSync(path.join(output.directory, 'acceptance.json'), 'utf8'))
  assert.deepEqual(commands, [])
  assert.equal(fs.readFileSync(registryFile, 'utf8'), before)
  assert.deepEqual(acceptance.previousVerification, { scope: 'saved_results', items: checked.items })
  assert.deepEqual(acceptance.offlineVerification, { status: 'not_run', items: [] })
  assert.ok(acceptance.previousVerification.items[0].verifiedAt)

  const registry = JSON.parse(before)
  registry.verifications.n1.fingerprint = 'stale-fingerprint'
  fs.writeFileSync(registryFile, JSON.stringify(registry))
  const staleOutput = await core.call('export', { id: 'previous-checks' })
  const staleReport = JSON.parse(fs.readFileSync(path.join(staleOutput.directory, 'acceptance.json'), 'utf8'))
  assert.deepEqual(staleReport.previousVerification.items, [])
  assert.deepEqual(commands, [])
})

test('copy failures remove temporary files and publish no export', async t => {
  const { core, root } = fixture(t)
  createTask(core, { id: 'copy-failure', files: [{ path: 'files/result.bin', bytes: 2048 }] })
  const createWriteStream = fs.createWriteStream
  fs.createWriteStream = function (file, ...args) {
    if (String(file).includes('.export-')) throw new Error('simulated copy failure')
    return createWriteStream.call(this, file, ...args)
  }
  try { await assert.rejects(core.call('export', { id: 'copy-failure' }), /simulated copy failure/) }
  finally { fs.createWriteStream = createWriteStream }
  assert.deepEqual(await fsp.readdir(path.join(root, 'copy-failure', 'deliveries')), [])
})

test('delete removes only the owned directory, pointers and restart index state', async t => {
  const { core, root, restart } = fixture(t)
  const a = createTask(core, { id: 'delete-a', files: [{ path: 'files/a.bin', bytes: 512 }] })
  const b = createTask(core, { id: 'delete-b', files: [{ path: 'files/b.bin', bytes: 512 }] })
  const external = path.join(root, 'external-input.fasta')
  const outside = path.join(root, 'already-saved.txt')
  fs.writeFileSync(external, '>input\nMKK\n'); fs.writeFileSync(outside, 'saved elsewhere')
  fs.mkdirSync(path.join(root, 'requests'), { recursive: true })
  const pointer = path.join(root, 'requests', 'idempotency.json')
  fs.writeFileSync(pointer, JSON.stringify({ id: 'delete-a', fingerprint: 'x' }))
  const result = await core.call('delete', { id: 'delete-a' })
  assert.deepEqual(result, { id: 'delete-a' })
  assert.equal(fs.existsSync(a.dir), false)
  assert.ok(fs.existsSync(path.join(b.dir, 'session.json')))
  assert.ok(fs.existsSync(path.join(b.dir, 'files/b.bin')))
  assert.equal(fs.readFileSync(external, 'utf8'), '>input\nMKK\n')
  assert.equal(fs.readFileSync(outside, 'utf8'), 'saved elsewhere')
  assert.equal(fs.existsSync(pointer), false)
  assert.deepEqual((await core.call('list')).map(item => item.id), ['delete-b'])
  await core.shutdown()
  const reopened = restart()
  assert.deepEqual((await reopened.call('list')).map(item => item.id), ['delete-b'])
  await assert.rejects(reopened.call('load', { id: 'delete-a' }), /ENOENT|no such file/i)
})

test('delete refuses running, remote-waiting, active and operation-busy tasks', async t => {
  const { core } = fixture(t)
  createTask(core, { id: 'running-task', status: 'running' })
  createTask(core, { id: 'remote-task', status: 'waiting_remote' })
  createTask(core, { id: 'active-task', status: 'paused' })
  createTask(core, { id: 'busy-task', files: [{ path: 'files/big.bin', bytes: 16 * 1024 * 1024 }] })
  await assert.rejects(core.call('delete', { id: 'running-task' }), /running|stop|wait/i)
  await assert.rejects(core.call('delete', { id: 'remote-task' }), /running|waiting|stop|wait/i)
  const scheduler = core.get('active-task')
  scheduler.active.set('n1', { promise: Promise.resolve(), control() {} })
  await assert.rejects(core.call('delete', { id: 'active-task' }), /running|stop|wait/i)
  scheduler.active.clear()
  const exporting = core.call('export', { id: 'busy-task' })
  await wait(10)
  await assert.rejects(core.call('delete', { id: 'busy-task' }), /busy|export|wait/i)
  await exporting
  assert.deepEqual(await core.call('delete', { id: 'busy-task' }), { id: 'busy-task' })
})

test('delete rejects traversal, foreign and symlinked task directories', async t => {
  const { core, root } = fixture(t)
  createTask(core, { id: 'safe-task', files: [{ path: 'files/a.bin', bytes: 128 }] })
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'biohub-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'session.json'), '{}')
  await assert.rejects(core.call('delete', { id: '../' + path.basename(outside) }), /Invalid workflow ID/)
  const junction = path.join(root, 'linked-task')
  try {
    fs.symlinkSync(outside, junction, 'junction')
    await assert.rejects(core.call('delete', { id: 'linked-task' }), /regular directory|outside the current workspace|Refusing|非法 runId/i)
    assert.ok(fs.existsSync(path.join(outside, 'session.json')))
    assert.ok(fs.existsSync(junction))
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EEXIST'].includes(error.code)) throw error
  }
})

test('file-in-use deletion fails clearly and succeeds after the handle is released', { skip: process.platform !== 'win32' }, async t => {
  const { core } = fixture(t)
  const task = createTask(core, { id: 'locked-task', files: [{ path: 'files/locked.bin', bytes: 4096 }] })
  const file = path.join(task.dir, 'files/locked.bin')
  const marker = path.join(task.dir, 'lock-ready.txt')
  const script = `$f=[IO.File]::Open('${file.replace(/'/g, "''")}','Open','Read','None'); Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value ready; Start-Sleep -Seconds 5; $f.Close()`
  const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' })
  const exited = new Promise(resolve => child.once('exit', resolve))
  try {
    for (let attempt = 0; attempt < 50 && !fs.existsSync(marker); attempt++) await wait(100)
    assert.ok(fs.existsSync(marker), 'the fixture did not acquire the file lock')
    await assert.rejects(core.call('delete', { id: 'locked-task' }), /in use|占用/i)
    assert.ok(fs.existsSync(path.join(task.dir, 'session.json')))
  } finally { await exited }
  assert.deepEqual(await core.call('delete', { id: 'locked-task' }), { id: 'locked-task' })
  assert.equal(fs.existsSync(task.dir), false)
})

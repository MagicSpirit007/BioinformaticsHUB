'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { hash } = require('../workflow/model.cjs')
const { RunStore } = require('../workflow/store.cjs')
const { createWorkflowCore } = require('../workflow/core.cjs')
const { extendCore } = require('../workflow/operations.cjs')
const { roleOf } = require('../workflow/delivery.cjs')
const { windowsPath, convertArgs } = require('../workflow/windows.cjs')
const { tools, validateArguments } = require('../workflow/tools.cjs')
const base = require('../paths.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biohub-delivery-'))
  const paths = { ...base, engineRoot: () => path.resolve(__dirname, '../../..'), repoRoot: () => root,
    siteCatalogPath: () => path.resolve(__dirname, '../../bioinformatics-hub/public/site-catalog.json'),
    defaultRunsRoot: () => root, resolveRunDir: id => base.resolveRunDir(id, root), resolvePython: () => null }
  const core = createWorkflowCore({ paths, dataDir: root }); extendCore(core)
  core.openSystem = async () => ({ accepted: true })
  const dir = core.runDir('delivery-test'); fs.mkdirSync(dir)
  const state = { schemaVersion: 2, id: 'delivery-test', name: 'Original study', status: 'needs_attention',
    input: {}, workflow: { nodes: [{ id: 'analysis', kind: 'site', siteId: 'hmmer' }] },
    recipeSnapshot: {}, nodes: [{ id: 'analysis', status: 'failed', artifacts: [], checkpoint: {}, message: 'Original failure' }] }
  new RunStore(dir).save(state, 'created')
  t.after(async () => { await core.shutdown(); fs.rmSync(root, { force: true, recursive: true }) })
  const file = (name, value) => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, value); return p }
  const register = (args = {}) => core.call('resultsRegister', { id: state.id, itemId: 'analysis', name: 'HMMER', kind: 'website', sourceUrl: 'https://www.ebi.ac.uk/result/job', files: [{ path: file('original.html', '<html><body>Original result 42</body></html>') }], ...args })
  return { core, root, dir, state, file, register }
}
test('external evidence is copied without changing execution history or certifying itself', async t => {
  const { core, dir, register } = fixture(t)
  const before = fs.readFileSync(path.join(dir, 'session.json'), 'utf8')
  const result = await register()
  assert.equal(core.read('delivery-test').nodes[0].status, 'failed')
  assert.equal(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'), before)
  assert.equal(result.results[0].executionStatus, 'failed')
  assert.equal(result.results[0].checks.analysis, 'unverified')
  assert.equal(fs.existsSync(path.join(dir, result.results[0].artifacts[0].path)), true)
  assert.equal(fs.existsSync(path.join(dir, '.controller.lock')), false)
})
test('internal JSON and logs are hidden while resource JSON remains a dependency', async t => {
  const { core, register, file } = fixture(t)
  const result = await register({ files: [
    { path: file('original.html', '<html>Actual result</html>') }, { path: file('result.json', '{}'), role: 'figure' },
    { path: file('assets/data.json', '{"plot":42}'), relativePath: 'assets/data.json', role: 'resource' },
  ] })
  assert.equal(result.results[0].artifacts.length, 1)
  const exported = await core.call('export', { id: result.id })
  assert.ok(exported.path.endsWith('index.html'))
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)])
  const files = walk(path.dirname(exported.path))
  assert.equal(files.filter(p => p.endsWith('.json')).length, 2) // resource plus shared acceptance manifest
  assert.ok(files.some(p => p.endsWith('acceptance.json')))
  assert.ok(files.find(p => p.endsWith(path.join('assets', 'data.json'))))
  assert.ok(!fs.readFileSync(exported.path, 'utf8').includes('result.json'))
})
test('registration rejects path escapes, changed checksums and false source proof', async t => {
  const { register, file } = fixture(t)
  await assert.rejects(register({ files: [{ path: file('a.html', 'result'), relativePath: '../../../../session.json' }] }), /escapes/)
  await assert.rejects(register({ files: [{ path: file('a.html', 'result'), sha256: 'bad' }] }), /checksum/)
  await assert.rejects(register({ inputSha256: '0'.repeat(64) }), /fingerprint/)
  await assert.rejects(register({ sourceTaskId: 'delivery-test', sourceNodeId: 'analysis' }), /verified successful/)
})
test('repeated registration and finalization are idempotent, missing items remain explicit', async t => {
  const { core, register } = fixture(t)
  const a = await register(), b = await register()
  assert.equal(a.revision, b.revision)
  const args = { id: a.id, expected: [{ id: 'analysis' }, { id: 'psipred' }], open: false }
  const first = await core.call('resultsFinalize', args), second = await core.call('resultsFinalize', args)
  assert.equal(first.delivery.version, second.delivery.version)
  assert.equal(second.delivery.expected, 2); assert.equal(second.delivery.recorded, 1)
  assert.equal(second.delivery.status, 'partial')
  assert.ok(second.delivery.gaps.some(g => g.itemId === 'psipred'))
})
test('one corrupt page does not prevent opening other saved pages', async t => {
  const { core, dir, register, file } = fixture(t)
  const first = await register()
  await register({ itemId: 'second', files: [{ path: file('second.html', '<html>Second actual result</html>') }] })
  fs.appendFileSync(path.join(dir, first.results[0].artifacts[0].path), 'changed')
  core.workerRequest = request => ({ promise: Promise.resolve({ opened: request.pages.length, windowId: 9, failed: [], state: { windowId: 9 } }) })
  const opened = await core.call('resultsOpenAll', { id: first.id })
  assert.equal(opened.total, 2); assert.equal(opened.opened, 1); assert.equal(opened.failed.length, 1)
  assert.equal(opened.windowId, undefined); assert.equal(opened.mode, 'system')
})
test('browser failure is returned per page and never starts an analysis', async t => {
  const { core, register } = fixture(t); const result = await register()
  core.workerRequest = () => { throw new Error('Opening must not use Python') }
  core.openSystem = async () => { throw new Error('Default browser unavailable') }
  const opened = await core.call('resultsOpenAll', { id: result.id })
  assert.equal(opened.opened, 0); assert.match(opened.failed[0].message, /Default browser unavailable/)
})
test('source-native artifacts may verify a supplement without resuming the original run', async t => {
  const { core, root, dir, state, file, register } = fixture(t)
  const inputHash = hash('>seq\nMPEPTIDE\n')
  state.input.protein = { sha256: inputHash }; new RunStore(dir).save(state, 'input')
  const sourceDir = core.runDir('source-run'); fs.mkdirSync(sourceDir)
  file('source-run/input.fasta', '>seq\nMPEPTIDE\n')
  const data = 'Original local tree', sourceFile = file('source-run/tree.nwk', data)
  new RunStore(sourceDir).save({ schemaVersion: 2, id: 'source-run', input: { protein: { sha256: inputHash, path: 'input.fasta' } },
    workflow: { nodes: [{ id: 'iqtree', kind: 'local', tool: 'iqtree', input: { source: 'input', key: 'protein' } }] }, nodes: [{ id: 'iqtree', status: 'succeeded', evidence: { verified: true },
      completeness: { downloads: 'complete', visual: 'not_applicable' }, artifacts: [{ path: 'tree.nwk', sha256: hash(data) }] }] }, 'created')
  const result = await register({ itemId: 'iqtree', kind: 'local', sourceTaskId: 'source-run', sourceNodeId: 'iqtree', inputSha256: inputHash, files: [{ path: sourceFile }] })
  assert.equal(result.results.find(r => r.id === 'iqtree').checks.analysis, 'verified')
  assert.equal(core.read(state.id).status, 'needs_attention')
  assert.equal(fs.existsSync(path.join(root, 'source-run', '.controller.lock')), false)
})
test('MCP registration validates array entries and does not accept caller verified flags', () => {
  const schema = tools.find(t => t.method === 'resultsRegister').inputSchema
  assert.throws(() => validateArguments({ id: 'x', itemId: 'a', name: 'A', kind: 'website', files: [{ path: 'a.html', verified: true }] }, schema), /unknown/)
  assert.throws(() => validateArguments({ id: 'x', itemId: 'a', name: 'A', kind: 'website', files: 'a.html' }, schema), /array/)
  assert.equal(roleOf({ path: 'result.json', role: 'figure' }), 'internal')
})
test('WSL boundary converts only filesystem fields and preserves biological input bytes', () => {
  assert.equal(windowsPath('/mnt/d/BioinformaticsHUB/runs'), 'D:\\BioinformaticsHUB\\runs')
  assert.throws(() => windowsPath('/tmp/private'), /Windows-accessible/)
  assert.deepEqual(convertArgs({ files: [{ path: '/mnt/d/result.html' }], inputs: { protein: { value: '>s\nMPEPTIDE\n' } } }),
    { files: [{ path: 'D:\\result.html' }], inputs: { protein: { value: '>s\nMPEPTIDE\n' } } })
})

test('a Windows-saved workspace resolves correctly when read from WSL', () => {
  const { platformPath } = require('../workflow/runtime.cjs')
  if (process.platform === 'linux') assert.equal(platformPath('D:\\BioinformaticsHUB\\runs'), '/mnt/d/BioinformaticsHUB/runs')
})

test('old task records remain readable in the common directory without the legacy builder', async t => {
  const { core, root, file } = fixture(t)
  const source = { id: 'legacy-task', schemaVersion: 1, geneId: 'Legacy gene', status: 'completed', sites: [],
    localTools: [{ id: 'local', status: 'completed', artifacts: [{ path: 'plot.svg' }] }] }
  file('legacy-task/plot.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
  const original = JSON.stringify(source)
  file('legacy-task/session.json', original)
  assert.ok((await core.call('list')).some(t => t.id === 'legacy-task'))
  const legacy = await core.call('load', { id: 'legacy-task' })
  assert.equal(legacy.readOnlyLegacy, true)
  const result = await core.call('results', { id: 'legacy-task' })
  assert.equal(result.results[0].checks.analysis, 'unverified')
  assert.equal(result.results[0].artifacts[0].name, 'plot.svg')
  assert.ok(fs.existsSync((await core.call('export', { id: 'legacy-task' })).path))
  assert.equal(fs.readFileSync(path.join(root, 'legacy-task/session.json'), 'utf8'), original)
})

test('exported original pages block scripts and form resubmission while stored evidence stays unchanged', async t => {
  const { core, dir, file, register } = fixture(t)
  const html = '<html><head></head><body>Original result<script>fetch("/resubmit")</script></body></html>'
  const result = await register({ files: [{ path: file('post-result.html', html) }] })
  const a = result.results[0].artifacts[0]
  const out = await core.call('export', { id: result.id })
  const exported = fs.readFileSync(path.join(out.directory, 'files', a.path), 'utf8')
  assert.ok(exported.includes("script-src 'none'")); assert.ok(exported.includes("form-action 'none'"))
  assert.equal(fs.readFileSync(path.join(dir, a.path), 'utf8'), html)
})

test('cached reads notice new or corrupted journal bytes and never repair history', async t => {
  const { core, dir, state } = fixture(t)
  assert.equal((await core.call('load', { id: state.id })).status, 'needs_attention')
  state.status = 'paused'; new RunStore(dir).save(state, 'paused')
  assert.equal((await core.call('load', { id: state.id })).status, 'paused')
  const journal = path.join(dir, 'events.jsonl')
  fs.appendFileSync(journal, JSON.stringify({ sequence: 999, state: '{}', checksum: 'broken' }) + '\n')
  const before = fs.readFileSync(journal, 'utf8')
  await assert.rejects(core.call('load', { id: state.id }), /checksum/)
  assert.equal(fs.readFileSync(journal, 'utf8'), before)
})

test('offline verification is fingerprint-bound and never certifies analysis', async t => {
  const { core, dir, file, register } = fixture(t)
  const initial = await register({ files: [{ path: file('page.html', '<html>Original result 42</html>') },
    { path: file('archive.json', JSON.stringify({ baseline: { text: 'Original result 42' } })) }] })
  const before = fs.readFileSync(path.join(dir, 'session.json'), 'utf8')
  core.workerRequest = request => {
    assert.equal(request.command, 'delivery_verify')
    assert.equal(request.pages[0].baseline.text, 'Original result 42')
    return { promise: Promise.resolve({ status: 'complete', pages: [{ status: 'complete', issues: [] }] }) }
  }
  const checked = await core.call('resultsVerify', { id: initial.id, itemId: 'analysis' })
  assert.equal(checked.results.results[0].checks.archive, 'complete')
  assert.equal(checked.results.results[0].checks.analysis, 'unverified')
  assert.equal(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'), before)
  const changed = await register({ files: [{ path: file('new.html', '<html>Changed result</html>') }] })
  assert.equal(changed.results[0].checks.archive, 'unverified')
})

test('offline verification retains per-page failures and reports corrupt resources', async t => {
  const { core, dir, file, register } = fixture(t)
  const initial = await register({ files: [{ path: file('page.html', '<html>Result</html>') },
    { path: file('style.css', 'body{}'), relativePath: 'assets/style.css', role: 'resource' }] })
  const registry = JSON.parse(fs.readFileSync(path.join(dir, 'delivery.json')))
  const asset = registry.items[0].artifacts.find(a => a.role === 'resource')
  fs.writeFileSync(path.join(dir, asset.path), 'changed')
  core.workerRequest = () => { throw new Error('Must reject corruption before opening Chrome') }
  const checked = await core.call('resultsVerify', { id: initial.id })
  assert.equal(checked.status, 'partial')
  assert.match(checked.items[0].issues[0], /changed/)
})

test('default-browser opening works without a worker and preserves evidence and relative resources', async t => {
  const {core,dir,file,register}=fixture(t)
  const html='<script>fetch("/submit")</script><html><head><meta http-equiv="refresh" content="0;url=/submit"></head><body><img src="assets/图.png"><form action="/submit"><button>Submit</button></form></body></html>'
  const result=await register({files:[{path:file('原始 页面.html',html),relativePath:'原始 页面.html'},{path:file('图.png','image bytes'),relativePath:'assets/图.png',role:'resource'}]})
  core.workerRequest=()=>{throw new Error('Python must not be used')}
  let accepted
  core.openSystem=async(file,options)=>{assert.equal(options.browser,true);accepted=file;return {accepted:true}}
  const before=fs.readFileSync(path.join(dir,'session.json'))
  const opened=await core.call('openResult',{id:result.id,itemId:'analysis'})
  assert.equal(opened.opened,1);assert.equal(opened.windowId,undefined)
  assert.ok(accepted.includes('views'))
  const copy=fs.readFileSync(accepted,'utf8')
  assert.ok(copy.indexOf('Content-Security-Policy')<copy.indexOf('<script>'))
  assert.match(copy,/form-action 'none'/);assert.doesNotMatch(copy,/http-equiv="refresh"/)
  assert.equal(fs.readFileSync(path.join(path.dirname(accepted),'assets/图.png'),'utf8'),'image bytes')
  assert.equal(fs.readFileSync(path.join(dir,result.results[0].artifacts.find(a=>a.role==='page').path),'utf8'),html)
  assert.deepEqual(fs.readFileSync(path.join(dir,'session.json')),before)
  fs.unlinkSync(path.join(dir,result.results[0].artifacts.find(a=>a.role==='page').path))
  assert.equal((await core.call('openResult',{id:result.id,itemId:'analysis'})).opened,0)
})

test('system opener reports failures and passes filenames as arguments, not shell source', async () => {
  const {openSystem}=require('../workflow/system-open.cjs')
  let call
  await openSystem('/tmp/中文 a & $(whoami).html',{platform:'win32',browser:true,execute:(command,args,options,callback)=>{call={command,args,options};callback(null,'','')}})
  assert.ok(call.args.includes('-Browser')); assert.ok(call.args.includes('-File'))
  assert.ok(call.args.some(a=>a.startsWith('file:')&&a.includes('%20')))
  assert.equal(call.options.shell,undefined)
  await assert.rejects(openSystem('file',{execute:(_command,_args,_options,cb)=>cb(new Error('ENOENT'),'','no opener')}),/no opener/)
})

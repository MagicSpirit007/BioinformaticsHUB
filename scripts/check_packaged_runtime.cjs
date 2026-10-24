'use strict'
// Execute with the candidate Electron executable in Node mode. All task data is
// isolated; this check never contacts a remote analysis or model endpoint.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const net = require('node:net')
const repo = path.resolve(__dirname, '..')
const candidate = path.resolve(process.argv[2])
const archive = path.join(candidate, 'resources/app.asar')
const output = path.join(repo, 'runs', 'packaged-repair-validation-' + Date.now())
fs.mkdirSync(output, { recursive: true })
process.env.BIOHUB_HOME = path.join(output, 'home')
process.env.BIOINFORMATICS_HUB_RUNS = path.join(output, 'tasks')
delete process.env.BIOINFORMATICS_HUB_ENGINE
const { configuration } = require(path.join(archive, 'workflow/runtime.cjs'))
const client = require(path.join(archive, 'workflow/client.cjs'))
async function main() {
  const config = configuration()
  const ping = await client.call('ping')
  assert.equal(ping.runtime.manifestStatus, 'matched')
  assert.equal(ping.runtime.engineRoot.toLowerCase(), path.join(candidate, 'resources/engine').toLowerCase())
  const mismatch = await new Promise((resolve, reject) => {
    const socket = net.createConnection(config.endpoint)
    let buffer = ''
    socket.on('error', reject)
    socket.on('connect', () => socket.write(JSON.stringify({ apiVersion: 1, requestId: 'mismatch-test', method: 'start', runtime: { ...ping.runtime, buildId: 'stale-build' }, args: {} }) + '\n'))
    socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.destroy(); resolve(JSON.parse(buffer)) } })
  })
  assert.equal(mismatch.error.code, 'RUNTIME_MISMATCH')
  await client.call('saveSettings', { localPython: path.join(repo, '.venv-local/Scripts/python.exe'), envFile: '', chromeUrl: '' })
  const spec = JSON.parse(fs.readFileSync(path.join(repo, 'tests/fixtures/protein-workflow.json'), 'utf8'))
  const started = await client.call('start', spec)
  const deadline = Date.now() + 60_000
  let task
  do {
    await new Promise(resolve => setTimeout(resolve, 300))
    task = await client.call('load', { id: started.id })
    if (['needs_attention', 'partial'].includes(task.status)) throw new Error(JSON.stringify(task.nodes.map(n => ({ id: n.id, status: n.status, message: n.message }))))
  } while (task.status !== 'completed' && Date.now() < deadline)
  assert.equal(task.status, 'completed')
  const results = await client.call('results', { id: started.id })
  assert.equal(results.results.length, spec.workflow.nodes.length)
  assert.ok(results.results.every(r => r.checks.analysis === 'verified'))
  const revalidated = await client.call('resultsValidate', { id: started.id })
  assert.ok(revalidated.results.every(r => r.checks.analysis === 'verified'))
  const exported = await client.call('export', { id: started.id })
  const acceptance = JSON.parse(fs.readFileSync(path.join(exported.directory, 'acceptance.json'), 'utf8'))
  assert.deepEqual(acceptance.results.map(r => r.checks.analysis), results.results.map(r => r.checks.analysis))
  const result = { ok: true, candidate, output, runtime: ping.runtime, runId: started.id, checks: [
    'packaged backend/UI/engine match build manifest', 'stale build is rejected before execution',
    'isolated local protein workflow completes in packaged engine', 'load/results/export share analysis status', 'original report remains deferred',
  ] }
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}
main().catch(error => { fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ ok: false, error: error.stack }, null, 2)); console.error(error.stack); process.exitCode = 1 }).finally(() => client.call('stop').catch(() => {}))

'use strict'
// Explicitly invoked study rerun. All new outputs get new task identifiers.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { call } = require('../apps/bioinformatics-hub-desktop/workflow/client.cjs')
const repo = path.resolve(__dirname, '..')
const old = path.join(repo, 'runs/cca0737s0009-26items-20261019')
const root = path.join(repo, 'runs/cca0737s0009-rerun-20261021')
const json = f => JSON.parse(fs.readFileSync(f, 'utf8'))
const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2))
async function main() {
  if (process.platform !== 'win32') throw new Error('Use Windows Node and the shared Windows backend')
  fs.mkdirSync(root, { recursive: true })
  const source = json(path.join(old, 'primary-spec.json'))
  const protein = source.inputs.protein.value, nucleotide = source.inputs.nucleotide.value
  const sequence = fasta => fasta.split(/\r?\n/).filter(l => !l.startsWith('>')).join('').trim()
  if (sequence(protein).length !== 260 || sequence(nucleotide).length !== 783) throw new Error('Unexpected bound input')
  const fingerprint = Object.fromEntries(Object.entries({ protein, nucleotide }).map(([k, v]) => [k, crypto.createHash('sha256').update(v).digest('hex')]))
  save('input-verification.json', { gene: 'CCA0737S0009', species: 'Carya cathayensis', lengths: { cds: 783, protein: 260 }, fingerprint, source: path.join(old, 'primary-spec.json') })
  const config = await call('settings')
  const endpoint = 'http://127.0.0.1:9291'
  let ready = false
  try { ready = (await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(2000) })).ok } catch {}
  if (!ready) {
    const chrome = path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')
    const child = spawn(chrome, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9291', `--user-data-dir=${path.join(root, 'chrome-profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--new-window', 'about:blank'], { detached: true, stdio: 'ignore' })
    child.on('error', e => { throw e }); child.unref()
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) })).ok } catch {}
      if (ready) break
      await new Promise(r => setTimeout(r, 100))
    }
    if (!ready) throw new Error('Visible Chrome did not start')
  }
  await call('saveSettings', { chromeUrl: endpoint })
  const spec = { ...source, name: 'CCA0737S0009 全部26项重跑 · 2026-10-21', idempotencyKey: 'cca0737s0009-full-rerun-20261021-v1',
    workflow: { ...source.workflow, id: 'cca0737s0009-rerun-20261021', nodes: source.workflow.nodes.filter(n => n.id !== 'quickgo') } }
  const limits = { maxActions: 60, maxDecisions: 120, waitHours: 24 }
  spec.workflow.nodes.push({ id: 'interpro', kind: 'site', siteId: 'interpro', input: { source: 'input', key: 'protein' }, dependsOn: [], parameters: {}, limits })
  spec.workflow.nodes.push({ id: 'psi_blast', kind: 'site', siteId: 'psi_blast', input: { source: 'input', key: 'protein' }, dependsOn: [], parameters: { database: 'Non-redundant protein sequences (nr)', iterations: '1', inclusion: '0.005' }, limits })
  // Iterations after the first continue the new RID, never reuse the old job.
  save('primary-spec.json', spec)
  const run = await call('start', spec)
  const expected = json(path.join(old, 'tasks/wf-1792415681013-f2bb07/delivery.json')).expected
  await call('resultsFinalize', { id: run.id, expected, open: false })
  const launched = { id: run.id, root, runDirectory: path.join(config.workspace.runsRoot, run.id), chromeUrl: endpoint, at: new Date().toISOString(), expected }
  save('run.json', launched)
  const executable = path.join(repo, 'apps/bioinformatics-hub-desktop/release/win-unpacked/BioinformaticsHUB.exe')
  const ui = spawn(executable, [], { cwd: repo, detached: true, stdio: 'ignore' }); ui.on('error', e => { throw e }); ui.unref()
  console.log(JSON.stringify({ ...launched, expected: expected.length, initialNodes: spec.workflow.nodes.length, status: run.status, desktop: executable }))
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })

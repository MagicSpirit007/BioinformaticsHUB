'use strict'
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const installation = path.join(root, 'apps/bioinformatics-hub-desktop/release/win-unpacked')
const executable = path.join(installation, 'BioinformaticsHUB.exe')
const entry = path.join(installation, 'resources/app.asar/workflow/entry.cjs')
const output = path.join(root, 'runs', 'packaged-tooling')
fs.mkdirSync(output, { recursive: true })
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', BIOHUB_HOME: path.join(output, 'profile'), BIOINFORMATICS_HUB_RUNS: path.join(output, 'runs') }
function run(args, launcher = false) {
  return new Promise((resolve, reject) => {
    const child = launcher ? spawn('cmd.exe', ['/d', '/c', path.join(installation, 'biohub.cmd'), ...args], { env, windowsHide: true }) : spawn(executable, [entry, ...args], { env, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => { try { if (code) throw new Error(stderr || `exit ${code}`); resolve(JSON.parse(stdout.trim()).result) } catch (error) { reject(error) } })
  })
}
async function main() {
  const checks = []
  try {
    const catalog = await run(['catalog']); assert.equal(Object.keys(catalog.recipes).length, 28)
    checks.push('packaged Electron runs the CLI without opening a GUI or external Node')
    const fromCmd = await run(['catalog'], true); assert.equal(fromCmd.templates.length, 3)
    checks.push('shipped biohub.cmd loads the same capabilities')
    const runtime = await run(['service', 'status']); assert.equal(runtime.dataDir, env.BIOHUB_HOME)
    checks.push('packaged daemon resolves resources and shared data paths correctly')
    const result = { ok: true, checks }
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
  } finally { await run(['service', 'stop']).catch(() => {}) }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })

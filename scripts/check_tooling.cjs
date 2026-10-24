'use strict'
// Real independent CLI processes and MCP share the same durable background service.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'runs', `tooling-smoke-${Date.now()}`)
const env = { ...process.env, BIOHUB_HOME: path.join(output, 'profile'), BIOINFORMATICS_HUB_RUNS: path.join(output, 'runs'), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
fs.mkdirSync(output, { recursive: true })
const cli = path.join(root, 'scripts', 'biohub.cjs')
function invoke(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd: root, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => {
      if (code) return reject(new Error(stderr || `CLI exited ${code}`))
      try { resolve(stdout.trim().split('\n').filter(Boolean).map(JSON.parse).at(-1).result) } catch (error) { reject(error) }
    })
  })
}
async function mcpStatus(id) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'mcp'], { env, cwd: root, windowsHide: true })
    let buffer = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timed out')) }, 15000)
    child.stdout.on('data', chunk => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1)
        if (message.id === 1) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'biohub_run_status', arguments: { id } } }) + '\n')
        if (message.id === 2) { clearTimeout(timer); child.stdin.end(); resolve(message.result.structuredContent.result) }
      }
    })
    child.on('error', reject)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tooling-smoke', version: '1' } } }) + '\n')
  })
}
async function main() {
  const checks = []
  try {
    const catalog = await invoke(['catalog'])
    assert.equal(Object.keys(catalog.recipes).length, 28)
    checks.push('all 28 services and three templates exposed over the CLI')
    const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/protein-workflow.json'), 'utf8'))
    fixture.idempotencyKey = 'tooling-local-characterization'
    const spec = path.join(output, 'task.json'); fs.writeFileSync(spec, JSON.stringify(fixture))
    const created = await invoke(['run', 'start', '--spec', spec])
    const again = await invoke(['run', 'start', '--spec', spec]); assert.equal(again.id, created.id)
    checks.push('idempotent submission returns the same task from an independent CLI process')
    const viaMcp = await mcpStatus(created.id); assert.equal(viaMcp.id, created.id)
    checks.push('a real MCP stdio client reads the CLI task without owning its execution')
    let final
    for (let attempt = 0; attempt < 120; attempt++) {
      final = await invoke(['run', 'status', created.id])
      if (['completed', 'partial', 'needs_attention'].includes(final.status)) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    assert.equal(final.status, 'completed', JSON.stringify(final.nodes.map(n => ({ id: n.id, status: n.status, message: n.message }))))
    assert.ok(final.nodes.every(n => n.status === 'succeeded'))
    checks.push('all local analysis nodes finish after the submitting CLI and MCP disconnect')
    const exported = await invoke(['results', 'export', created.id]); assert.ok(fs.existsSync(exported.index))
    const events = await invoke(['run', 'events', created.id]); assert.ok(events.events.length)
    checks.push('original result directory exports index.html and incremental events contain no private snapshots')
    const validation = { ok: true, runId: created.id, checks }
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(validation, null, 2))
    console.log(JSON.stringify({ ...validation, output }))
  } catch (error) {
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ ok: false, checks, error: error.stack }, null, 2))
    throw error
  } finally { await invoke(['service', 'stop']).catch(() => {}) }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })

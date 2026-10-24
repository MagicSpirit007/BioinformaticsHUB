'use strict'
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { configuration, runtimePaths } = require('./runtime.cjs')
const { createWorkflowCore } = require('./core.cjs')
const { extendCore } = require('./operations.cjs')
const { atomicJson } = require('./store.cjs')
const config = configuration()
const runtime = require('./build.cjs').identity(config)
fs.mkdirSync(config.dataDir, { recursive: true })
const lock = path.join(config.dataDir, 'daemon-' + require('./model.cjs').hash(config.runsRoot).slice(0, 16) + '.lock')
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    const fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); break
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const pid = Number(fs.readFileSync(lock, 'utf8'))
    if (!Number.isInteger(pid) || pid <= 0) process.exit(0) // Another starter may still be writing its PID.
    try { process.kill(pid, 0); process.exit(0) }
    catch (probe) { if (probe.code !== 'ESRCH') process.exit(0) }
    try { fs.unlinkSync(lock) } catch (remove) { if (remove.code !== 'ENOENT') throw remove }
    if (attempt === 1) process.exit(0)
  }
}
if (process.platform !== 'win32') { try { fs.unlinkSync(config.endpoint) } catch (error) { if (error.code !== 'ENOENT') throw error } }
let initialOwned = []
const activeFile = path.join(config.dataDir, 'active-runs-' + require('./model.cjs').hash(config.runsRoot).slice(0, 16) + '.json')
try { initialOwned = JSON.parse(fs.readFileSync(activeFile, 'utf8')) } catch {}
const activeRuns = new Set(initialOwned)
const core = createWorkflowCore({ paths: runtimePaths(config), dataDir: config.dataDir, onChange: session => {
  if (['running', 'waiting_remote'].includes(session.status)) activeRuns.add(session.id)
  else activeRuns.delete(session.id)
  atomicJson(activeFile, [...activeRuns])
}, onDelete: id => {
  // A deleted task must not be recovered from the restart index.
  activeRuns.delete(id)
  try { atomicJson(activeFile, [...activeRuns]) } catch { /* task removal already succeeded */ }
} })
extendCore(core)
let stopping = false
const server = net.createServer(socket => {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('data', chunk => {
    buffer += chunk
    if (buffer.length > 96 * 1024 * 1024) return socket.destroy()
    const index = buffer.indexOf('\n'); if (index < 0) return
    socket.pause()
    let message
    try { message = JSON.parse(buffer.slice(0, index)) } catch { socket.end(JSON.stringify({ error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }) + '\n'); return }
    const send = result => socket.end(JSON.stringify({ apiVersion: 1, requestId: message.requestId, ...result }) + '\n')
    Promise.resolve().then(() => {
      if (message.apiVersion !== 1) throw new Error('Unsupported API version')
      if (message.method === 'ping') return { pid: process.pid, dataDir: config.dataDir, runsRoot: config.runsRoot, backendPath: __filename, engineRoot: config.engine, runtime }
      if (message.method === 'stop') { setTimeout(shutdown, 50); return { stopping: true } }
      if (!['list', 'load', 'events', 'results', 'catalog', 'settings', 'thumbnail'].includes(message.method)) {
        require('./build.cjs').assertCompatible(message.runtime, runtime)
        require('./build.cjs').assertCompatible(runtime, require('./build.cjs').identity(config))
      }
      return core.call(message.method, message.args || {})
    }).then(result => send({ result }), error => send({ error: { code: error.code || 'REQUEST_FAILED', message: error.message } }))
  })
})
server.listen(config.endpoint, async () => {
  if (process.platform !== 'win32') fs.chmodSync(config.endpoint, 0o600)
  // Recovery is owned by the daemon, never by a status/read request.
  for (const id of ['missing', 'mismatch'].includes(runtime.manifestStatus) ? [] : initialOwned) {
    let item
    try { item = core.read(id) } catch { continue }
    if (!['completed', 'partial', 'cancelled', 'needs_input'].includes(item.status)) {
      try { const scheduler = core.get(item.id); if (scheduler.session.nodes.some(n => n.status === 'waiting_remote')) scheduler.resume() }
      catch (error) { console.error(`Recovery ${item.id}: ${error.message}`) }
    }
  }
})
async function shutdown() {
  if (stopping) return; stopping = true
  await core.shutdown()
  server.close()
  try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock) } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
process.on('exit', () => { try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock) } catch {} })

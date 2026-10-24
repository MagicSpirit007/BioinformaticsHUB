'use strict'
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')

function runWorker({ python, script, request, env = process.env, cwd, timeout = 30 * 60_000 }, onEvent = () => ({})) {
  const requestId = crypto.randomUUID()
  const child = spawn(python, ['-u', script], { cwd, env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let result, failure, settled = false, buffer = '', timer
  const send = data => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ ...data, requestId })}\n`) }
  const promise = new Promise((resolve, reject) => {
    const fail = error => { failure = error; terminate() }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 16 * 1024 * 1024) return fail(new Error('Worker event exceeds size limit'))
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        let message
        try { message = JSON.parse(line) } catch { return fail(new Error('Invalid worker JSONL')) }
        if (message.requestId !== requestId) return fail(new Error('Worker request ID mismatch'))
        if (message.type === 'event') {
          try { const control = onEvent(message.event); send({ type: 'ack', eventId: message.eventId, control }) }
          catch (e) { send({ type: 'ack', eventId: message.eventId, error: true }); failure = e }
        } else if (message.type === 'result') result = message.result
        else if (message.type === 'error') failure = new Error(message.message)
        else return fail(new Error('Unknown worker message'))
      }
    })
    // Library diagnostics can contain provider internals. Do not forward stderr.
    child.stderr.resume()
    child.on('error', e => { clearTimeout(timer); settled = true; reject(e) })
    child.on('close', code => {
      clearTimeout(timer); settled = true
      if (failure) reject(failure)
      else if (result === undefined || code !== 0) reject(new Error(`Worker stopped without a valid result (exit ${code})`))
      else resolve(result)
    })
    timer = setTimeout(() => fail(new Error('Worker active-operation timeout; inspect checkpoint before retrying')), timeout)
  })
  function terminate() {
    if (settled || !child.pid) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child.kill())
    } else child.kill('SIGTERM')
  }
  send({ ...request })
  return {
    promise,
    control(action) { send({ type: 'control', action }); if (action === 'cancel') setTimeout(terminate, 3000).unref?.() },
    async stop() {
      send({ type: 'control', action: 'pause' })
      const fallback = setTimeout(terminate, 3000)
      try { await promise } catch { /* scheduler records durable outcome */ } finally { clearTimeout(fallback) }
    },
  }
}
module.exports = { runWorker }

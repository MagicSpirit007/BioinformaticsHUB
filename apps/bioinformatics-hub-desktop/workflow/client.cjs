'use strict'
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { configuration, nodeEnv } = require('./runtime.cjs')

function request(config, method, args = {}, timeout = 180000) {
  const runtime = require('./build.cjs').identity(config)
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.endpoint)
    let buffer = '', done = false
    const finish = (error, value) => { if (done) return; done = true; socket.destroy(); error ? reject(error) : resolve(value) }
    socket.setTimeout(timeout, () => finish(Object.assign(new Error('Background request timed out; the task continues. Query its status before retrying.'), { code: 'BACKGROUND_TIMEOUT' })))
    socket.on('error', error => finish(error))
    socket.on('end', () => { if (!done) finish(new Error('Background service disconnected')) })
    socket.on('connect', () => socket.write(JSON.stringify({ apiVersion: 1, requestId: crypto.randomUUID(), runtime, method, args }) + '\n'))
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 96 * 1024 * 1024) return finish(new Error('Response exceeds limit'))
      const end = buffer.indexOf('\n')
      if (end < 0) return
      try {
        const result = JSON.parse(buffer.slice(0, end))
        if (result.error) { const error = new Error(result.error.message); error.code = result.error.code; finish(error) }
        else finish(null, result.result)
      } catch (error) { finish(error) }
    })
  })
}

let starting
async function ensure(config = configuration()) {
  try { return await request(config, 'ping', {}, 1000) } catch (error) {
    // The daemon is alive but may be busy scanning/exporting a large result
    // directory. A ping timeout must not be reported as a failed request: the
    // real method request below will wait for the daemon's event loop.
    if (error.code === 'BACKGROUND_TIMEOUT') return null
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error
  }
  if (starting) return starting
  starting = (async () => {
    fs.mkdirSync(config.dataDir, { recursive: true })
    const log = fs.openSync(path.join(config.dataDir, 'daemon.log'), 'a')
    try {
      const child = spawn(process.execPath, [path.join(__dirname, 'daemon.cjs')], {
        env: { ...nodeEnv(), BIOHUB_HOME: config.dataDir, BIOINFORMATICS_HUB_RUNS: config.runsRoot },
        cwd: config.dataDir, detached: true, windowsHide: true, stdio: ['ignore', log, log],
      })
      child.on('error', () => {})
      child.unref()
    } finally { fs.closeSync(log) }
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      try { return await request(config, 'ping', {}, 1000) } catch (error) {
        if (error.code === 'BACKGROUND_TIMEOUT') return null
        if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error
      }
    }
    throw new Error('Background service did not start. See daemon.log in the data directory.')
  })().finally(() => { starting = null })
  return starting
}
async function call(method, args = {}, config = configuration()) {
  const windows = require('./windows.cjs')
  if (windows.isWindowsWorkspace()) return windows.requestWindows(config, method, args)
  if (method === 'workspace') return require('./runtime.cjs').selectWorkspace(config, args.runsRoot)
  const readOnly = ['ping', 'list', 'load', 'events', 'results', 'catalog', 'settings', 'thumbnail'].includes(method)
  const remote = await ensure(config)
  if (!readOnly && method !== 'stop' && remote) require('./build.cjs').assertCompatible(require('./build.cjs').identity(config), remote.runtime)
  try { return await request(config, method, args, readOnly ? 15_000 : ['resultsVerify', 'export'].includes(method) ? 30 * 60_000 : 180_000) }
  catch (error) {
    if (!readOnly || !['BACKGROUND_TIMEOUT', 'ECONNRESET', 'EPIPE'].includes(error.code)) throw error
    return request(config, method, args, 15_000)
  }
}
module.exports = { call, request, ensure }

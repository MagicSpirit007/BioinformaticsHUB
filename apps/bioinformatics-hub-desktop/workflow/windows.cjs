'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

function windowsPath(value) {
  if (typeof value !== 'string') return value
  const match = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(value)
  if (match) return match[1].toUpperCase() + ':\\' + (match[2] || '').replace(/\//g, '\\')
  if (value.startsWith('/')) throw new Error('The Windows BioHub service needs a Windows-accessible path: ' + value)
  return value
}
function isWindowsWorkspace() {
  if (process.platform !== 'linux' || process.env.BIOHUB_NATIVE_POSIX === '1' || !/^\/mnt\/[a-z]\//i.test(__dirname)) return false
  try { return /microsoft/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8')) } catch { return false }
}
function convertArgs(value, key) {
  if (Array.isArray(value)) return value.map(v => convertArgs(v))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convertArgs(v, k)]))
  return ['path', 'runsRoot', 'envFile', 'browserPython', 'localPython'].includes(key) ? windowsPath(value) : value
}
function requestWindows(config, method, args) {
  const candidates = [process.env.BIOHUB_WINDOWS_NODE, '/mnt/c/Program Files/nodejs/node.exe', path.resolve(__dirname, '../node_modules/electron/dist/electron.exe')].filter(Boolean)
  const executable = candidates.find(p => fs.existsSync(p))
  if (!executable) return Promise.reject(new Error('Windows Node/Electron is unavailable; configure BIOHUB_WINDOWS_NODE. No second WSL service was started.'))
  let request
  try { request = { home: config.explicitHome ? windowsPath(config.dataDir) : undefined, runs: config.explicitRuns ? windowsPath(config.runsRoot) : undefined, method, args: convertArgs(args) } }
  catch (error) { return Promise.reject(error) }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [windowsPath(path.join(__dirname, 'windows-request.cjs'))], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = '', failure = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows BioHub request timed out; query task status before retrying')) }, 180000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 96 * 1024 * 1024) child.kill() })
    child.stderr.on('data', chunk => { if (failure.length < 2000) failure += chunk })
    child.on('close', code => {
      clearTimeout(timer)
      try {
        if (code !== 0) throw new Error('Windows BioHub bridge failed: ' + failure.slice(0, 500))
        const response = JSON.parse(output)
        if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code })
        resolve(response.result)
      } catch (error) { reject(error) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
module.exports = { windowsPath, convertArgs, isWindowsWorkspace, requestWindows }

'use strict'
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFile } = require('node:child_process')

// Resolve only when the OS opener has accepted the request; this is not proof
// that a browser finished loading. Never swallow spawn/association failures.
function openSystem(target, { browser = false, platform = process.platform, execute = execFile } = {}) {
  const uri = browser && !/^https?:\/\//i.test(target) ? pathToFileURL(target).href : target
  let command, args
  if (platform === 'win32') {
    command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), 'open-browser.ps1'), '-Target', uri]
    if (browser) args.push('-Browser')
  } else {
    command = platform === 'darwin' ? 'open' : 'xdg-open'
    args = [uri]
  }
  return new Promise((resolve, reject) => execute(command, args, { windowsHide: true, timeout: 15000, maxBuffer: 16384 }, (error, _stdout, stderr) => {
    if (error) reject(new Error(`系统无法打开网页或文件 / System opener failed: ${(stderr || error.message).trim().slice(0, 600)}`))
    else resolve({ accepted: true })
  }))
}
module.exports = { openSystem }

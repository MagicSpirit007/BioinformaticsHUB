'use strict'
const path = require('node:path')
const { spawn } = require('node:child_process')
async function main() {
  try { if ((await fetch('http://127.0.0.1:9291/json/version')).ok) return console.log('Existing Chrome is ready') } catch {}
  const chrome = path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')
  const profile = path.resolve(__dirname, '../runs/cca0737s0009-rerun-20261021/chrome-profile')
  const child = spawn(chrome, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9291', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--new-window', 'about:blank'], { detached: true, stdio: 'ignore' })
  child.unref()
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch('http://127.0.0.1:9291/json/version')).ok) return console.log('Study Chrome restarted; recover only existing result URLs') } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  throw Error('Study Chrome did not become ready')
}
main().catch(e => { console.error(e); process.exitCode = 1 })

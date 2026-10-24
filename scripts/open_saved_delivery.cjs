#!/usr/bin/env node
'use strict'
// Windows developer delivery helper. Starts a dedicated headed Chrome only when
// explicitly invoked, then uses the same service/configuration as the desktop.
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { configuration, selectWorkspace } = require('../apps/bioinformatics-hub-desktop/workflow/runtime.cjs')
const { call } = require('../apps/bioinformatics-hub-desktop/workflow/client.cjs')
async function main() {
  if (process.platform !== 'win32') throw new Error('Run this helper with Windows Node')
  const [taskId, directory, endpoint] = process.argv.slice(2)
  if (!taskId || !directory) throw new Error('Usage: node scripts/open_saved_delivery.cjs TASK_ID TASK_STORAGE_DIRECTORY')
  let config = configuration()
  config = selectWorkspace(config, path.resolve(directory))
  const current = await call('settings', {}, config)
  let chromeUrl = endpoint || current.chromeUrl
  if (endpoint) await call('saveSettings', { chromeUrl: endpoint }, config)
  try {
    if (!chromeUrl || !(await fetch(chromeUrl + '/json/version', { signal: AbortSignal.timeout(2000) })).ok) chromeUrl = ''
  } catch { chromeUrl = '' }
  if (!chromeUrl) {
    const server = net.createServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    const chrome = path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe')
    if (!fs.existsSync(chrome)) throw new Error('Configure an existing Chrome endpoint in the desktop settings')
    const child = spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(config.dataDir, 'delivery-chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { detached: true, stdio: 'ignore' })
    let launchError
    child.on('error', error => { launchError = error }); child.unref()
    chromeUrl = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw launchError
      try { ready = (await fetch(chromeUrl + '/json/version', { signal: AbortSignal.timeout(1000) })).ok } catch {}
      if (ready) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Dedicated Chrome did not start')
    await call('saveSettings', { chromeUrl }, config)
  }
  const result = await call('resultsFinalize', { id: taskId }, config)
  console.log(JSON.stringify({ id: taskId, delivery: result.delivery?.status, opened: result.opened, chromeUrl, workspace: config.runsRoot }))
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })

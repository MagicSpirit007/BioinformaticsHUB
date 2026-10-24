'use strict'
// Candidate/source desktop click-through for result export and permanent delete.
// Every fixture and daemon lives in an isolated temp workspace; real history is
// never read, exported or deleted.
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')

const repo = path.resolve(__dirname, '..')
const candidate = process.argv[2] ? path.resolve(process.argv[2]) : null
const appRoot = candidate ? path.join(candidate, 'resources/app.asar') : path.join(repo, 'apps/bioinformatics-hub-desktop')
const uiIndex = candidate ? path.join(candidate, 'resources/ui/index.html') : path.join(repo, 'apps/bioinformatics-hub/dist/index.html')
const output = path.join(repo, 'runs', 'export-delete-desktop-' + Date.now())
const home = path.join(output, 'home'), tasks = path.join(output, 'tasks')
fs.mkdirSync(tasks, { recursive: true })
app.setPath('userData', home)
process.env.BIOHUB_HOME = home
process.env.BIOINFORMATICS_HUB_RUNS = tasks
delete process.env.BIOINFORMATICS_HUB_ENGINE
app.disableHardwareAcceleration()

const client = require(path.join(appRoot, 'workflow/client.cjs'))
const { RunStore } = require(path.join(appRoot, 'workflow/store.cjs'))
const { hash } = require(path.join(appRoot, 'workflow/model.cjs'))
const originalCall = client.call
let holdNextList = false, listHeld = false, failResults = 0
const callLog = []
client.call = async (method, args, config) => {
  const started = Date.now()
  try {
    if (method === 'results' && failResults > 0) {
      failResults--
      throw new Error('simulated refresh timeout')
    }
    const result = await originalCall(method, args, config)
    if (method === 'list' && holdNextList) {
      holdNextList = false
      listHeld = true
      await new Promise(resolve => setTimeout(resolve, 4200))
      listHeld = false
    }
    callLog.push({ method, id: args?.id, ms: Date.now() - started })
    while (callLog.length > 80) callLog.shift()
    return result
  } catch (error) {
    callLog.push({ method, id: args?.id, ms: Date.now() - started, error: error.message })
    while (callLog.length > 80) callLog.shift()
    throw error
  }
}
const openedFolders = []
ipcMain.handle('app:setLocale', () => undefined)
const service = require(path.join(appRoot, 'workflow/service.cjs')).installWorkflow({
  app, ipcMain, dialog: {}, getWindow: () => window, shell: { showItemInFolder: () => {}, openPath: async directory => { openedFolders.push(directory); return '' } },
})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
let window

function task(id, name, status, size, website = false) {
  const dir = path.join(tasks, id), file = path.join(dir, 'files', 'result.bin')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const data = crypto.randomBytes(size)
  fs.writeFileSync(file, data)
  const artifacts = [{ path: 'files/result.bin', name: 'result.bin', kind: 'report', sha256: hash(data), bytes: data.length, verified: true, producer: 'n1', role: 'figure' }]
  if (website) {
    for (const [name, content, role] of [
      ['page-one.html', '<html><head></head><body>Saved page one</body></html>', 'page'],
      ['page-two.html', '<html><head></head><body>Saved page two</body></html>', 'page'],
      ['results.tsv', 'gene\tscore\nA\t1\n', 'data'],
    ]) {
      fs.writeFileSync(path.join(dir, 'files', name), content)
      artifacts.push({ path: 'files/' + name, name, kind: 'report', sha256: hash(content), bytes: Buffer.byteLength(content), verified: true, producer: 'n1', role })
    }
  }
  const nodeStatus = status === 'running' ? 'running' : 'succeeded'
  new RunStore(dir).save({ schemaVersion: 2, id, name, status, input: {},
    workflow: { id: 'fixture', name: 'Fixture', version: 1, nodes: [{ id: 'n1', ...(website ? { kind: 'site', siteId: 'hmmer' } : { kind: 'local', tool: 'mafft' }), dependsOn: [], parameters: {} }] },
    recipeSnapshot: {}, nodes: [{ id: 'n1', status: nodeStatus, attempts: 1, checkpoint: {},
      artifacts }] }, 'created')
  return dir
}

async function until(fn, label, attempts = 240) {
  for (let i = 0; i < attempts; i++) { if (await fn()) return; await delay(100) }
  throw new Error('Timed out waiting for ' + label)
}
function evaluate(source) { return window.webContents.executeJavaScript(source) }
function clickText(text, scope = 'document') {
  return evaluate(`(()=>{const root=${scope};const button=Array.from(root.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('button not found: '+${JSON.stringify(text)});button.click();return true})()`)
}
function clickContains(text, selector = 'button') {
  return evaluate(`(()=>{const button=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(b=>b.textContent.includes(${JSON.stringify(text)}));if(!button)throw new Error('button not found: '+${JSON.stringify(text)});button.click();return true})()`)
}
async function capture(name) {
  // Hidden/offscreen capture can return a stale compositor frame. Flush a real
  // visible frame before requesting the image, then hide the test window again.
  window.showInactive()
  await delay(700)
  window.webContents.invalidate()
  await delay(250)
  const image = await window.webContents.capturePage()
  assert.equal(image.isEmpty(), false, 'empty screenshot: ' + name)
  fs.writeFileSync(path.join(output, name), image.toPNG())
  window.hide()
  await delay(150)
}

app.whenReady().then(async () => {
  try {
    task('wf-running-0001', 'Running task', 'running', 2048)
    task('wf-second-0002', 'Second task', 'completed', 4096)
    const big = task('wf-export-0003', 'Export big task', 'completed', 96 * 1024 * 1024, true)
    await client.call('saveSettings', { browserPython: '', localPython: '', chromeUrl: 'http://127.0.0.1:1', envFile: '' })
    const settings = await client.call('settings')
    assert.equal(settings.browserPython, '')
    assert.equal(settings.localPython, '')
    const windowCreated = new BrowserWindow({ width: 1280, height: 1000, show: false, backgroundThrottling: false,
      webPreferences: { preload: path.join(appRoot, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } })
    window = windowCreated
    await window.loadFile(uiIndex)
    await until(() => evaluate('document.querySelectorAll(".wf-header nav button").length === 5'), 'workbench UI')
    await clickText('成果目录')
    await until(() => evaluate('document.querySelectorAll(".wf-task-directory .wf-history-row").length === 3'), 'three history rows')
    await until(() => evaluate('document.querySelector(".wf-run-title h2")?.textContent === "Export big task"'), 'newest task selected')
    checks.push('history lists tasks and newest task opens in the result directory')
    assert.equal(await evaluate('document.querySelectorAll(".wf-run-title .wf-danger").length'), 0)
    assert.equal(await evaluate('document.querySelectorAll(".wf-task-directory .wf-delete").length'), 3)
    checks.push('delete appears only in task rows, not in the result header')

    // A list response that started before a deletion must not re-add the row.
    checks.push('prepared stale-list verification')

    const exportLatencies = []
    const started = Date.now()
    await clickText('导出成果')
    await until(() => evaluate('Array.from(document.querySelectorAll(".wf-actions button")).some(b => b.textContent === "正在导出…")'), 'exporting label')
    const buttonLabels = await evaluate('Array.from(document.querySelectorAll(".wf-actions button")).map(b=>b.textContent)')
    assert.ok(buttonLabels.includes('正在导出…'))
    let exporting = true
    while (exporting && Date.now() - started < 60_000) {
      const begin = Date.now()
      try {
        const method = exportLatencies.length % 2 === 0 ? 'results' : 'load'
        const result = method === 'results' ? await client.call('results', { id: 'wf-export-0003' }) : await client.call('load', { id: 'wf-export-0003' })
        exportLatencies.push(Date.now() - begin)
        assert.equal(result.id, 'wf-export-0003')
      } catch (error) { exportLatencies.push(Date.now() - begin); throw new Error('result query failed during export: ' + error.message) }
      exporting = await evaluate('Array.from(document.querySelectorAll(".wf-actions button")).some(b=>b.textContent === "正在导出…")')
      if (exporting) await delay(80)
    }
    const exportElapsed = Date.now() - started
    assert.ok(exportElapsed < 60_000)
    assert.ok(exportLatencies.length >= 1)
    assert.ok(Math.max(...exportLatencies) < 5_000, 'results queries were blocked during export: ' + exportLatencies.join(','))
    await until(() => evaluate('Boolean(document.querySelector(".wf-export-result"))'), 'export result panel')
    const exportPanel = await evaluate('document.querySelector(".wf-export-result").innerText')
    assert.match(exportPanel, /Export location|导出位置/)
    assert.match(exportPanel, /本次未重新核验网页显示/)
    assert.doesNotMatch(exportPanel, /离线核验通过|均通过|核验不完整/)
    const exportDirectory = await evaluate('document.querySelector(".wf-export-result code").textContent')
    assert.ok(fs.existsSync(path.join(exportDirectory, 'index.html')))
    assert.ok(fs.existsSync(path.join(exportDirectory, 'acceptance.json')))
    const report = JSON.parse(fs.readFileSync(path.join(exportDirectory, 'acceptance.json'), 'utf8'))
    assert.deepEqual(report.offlineVerification, { status: 'not_run', items: [] })
    for (const name of ['page-one.html', 'page-two.html', 'results.tsv']) assert.ok(fs.existsSync(path.join(exportDirectory, 'files/files', name)))
    checks.push('saved HTML pages and attachments export with browser/Python unavailable')
    assert.ok(exportDirectory.startsWith(path.join(big, 'deliveries')) && path.basename(exportDirectory).startsWith('export-'))
    const exportNames = await fsp.readdir(path.join(big, 'deliveries'))
    assert.equal(exportNames.filter(name => name.startsWith('.export-')).length, 0)
    await capture('export.png')
    await clickText('打开导出目录')
    await until(() => openedFolders.includes(exportDirectory), 'open export folder callback')
    checks.push(`export button shows progress; ${exportLatencies.length} concurrent results/load queries stayed responsive (max ${Math.max(...exportLatencies)} ms); export published ${path.basename(exportDirectory)}`)
    checks.push('export location and open-folder action work; no temporary export directory remains')

    // A transient refresh error must not overwrite the loaded results or the export state.
    failResults = 1
    await until(() => evaluate('document.querySelector(".wf-alert-refresh")?.textContent.includes("simulated refresh timeout")'), 'refresh error banner')
    assert.equal(await evaluate('document.querySelectorAll(".wf-result-card").length'), 1)
    assert.equal(await evaluate('Boolean(document.querySelector(".wf-export-result"))'), true)
    await until(() => evaluate('!document.querySelector(".wf-alert-refresh")'), 'refresh error recovery', 80)
    assert.equal(await evaluate('document.querySelectorAll(".wf-result-card").length'), 1)
    checks.push('a transient refresh failure is reported separately while results and export state stay visible')

    // A real export failure is reported without discarding the loaded results.
    const resultFile = path.join(big, 'files/result.bin'), backup = path.join(output, 'result-backup.bin')
    fs.copyFileSync(resultFile, backup); fs.appendFileSync(resultFile, 'changed')
    await clickText('导出成果')
    await until(() => evaluate('Array.from(document.querySelectorAll(".wf-alert")).some(e=>e.textContent.includes("导出失败"))'), 'export failure alert')
    assert.equal(await evaluate('document.querySelectorAll(".wf-result-card").length'), 1)
    fs.copyFileSync(backup, resultFile)
    await delay(500)
    assert.equal(await evaluate('document.querySelectorAll(".wf-result-card").length'), 1)
    checks.push('a failed export shows its own error and keeps the loaded results')

    // Cancel keeps the task and focuses Cancel by default.
    await evaluate('document.querySelector(".wf-alert[role=alert] button")?.click()')
    await clickText('删除', 'document.querySelector(".wf-task-directory .wf-history-row")')
    await until(() => evaluate('Boolean(document.querySelector(".wf-dialog"))'), 'delete dialog')
    assert.equal(await evaluate('document.activeElement?.textContent?.trim()'), '取消')
    const dialog = await evaluate('document.querySelector(".wf-dialog").innerText')
    assert.match(dialog, /Export big task/); assert.match(dialog, /任务记录|执行历史/); assert.match(dialog, /导出文件/)
    await capture('delete-dialog.png')
    await clickText('取消')
    await until(() => evaluate('!document.querySelector(".wf-dialog")'), 'dialog closed')
    assert.ok(fs.existsSync(path.join(big, 'session.json')))
    checks.push('delete confirmation names the task and scope; default focus is Cancel; cancel keeps all files')

    // English labels mirror the same flow.
    await clickText('EN')
    await until(() => evaluate('document.querySelector(".wf-header nav").innerText.includes("Results")'), 'language switch')
    await clickText('Delete', 'document.querySelector(".wf-task-directory .wf-history-row")')
    await until(() => evaluate('Boolean(document.querySelector(".wf-dialog"))'), 'English delete dialog')
    assert.equal(await evaluate('document.activeElement?.textContent?.trim()'), 'Cancel')
    assert.match(await evaluate('document.querySelector(".wf-dialog").innerText'), /export files/i)
    await clickText('Cancel')
    await clickText('中文')
    checks.push('English and Chinese delete confirmations are both available')

    // Capture a list response now; the delete below must invalidate it.
    holdNextList = true
    await until(() => listHeld || !holdNextList, 'held list response')
    assert.equal(listHeld, true, 'the list response was not held')

    // Delete the selected task: next row is selected and the directory is gone.
    await clickText('删除', 'document.querySelector(".wf-task-directory .wf-history-row")')
    await until(() => evaluate('Boolean(document.querySelector(".wf-dialog"))'), 'delete dialog')
    await clickText('永久删除')
    await until(() => !fs.existsSync(path.join(big, 'session.json')), 'task directory removal')
    await until(() => evaluate('document.querySelector(".wf-run-title h2")?.textContent === "Second task"'), 'next task selected')
    assert.equal(await evaluate('document.querySelectorAll(".wf-task-directory .wf-history-row").length'), 2)
    assert.ok(fs.existsSync(path.join(tasks, 'wf-second-0002', 'session.json')))
    checks.push('deleting the selected task removes its directory, selects the next task and keeps other tasks')

    // The held list response resolves after the deletion and must be ignored.
    await until(() => !listHeld, 'stale list response resolution', 80)
    await delay(1200)
    assert.equal(await evaluate('document.querySelectorAll(".wf-task-directory .wf-history-row").length'), 2)
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".wf-task-directory .wf-history-row strong")).some(e=>e.textContent === "Export big task")'), false)
    checks.push('a list response captured before deletion did not re-add the deleted task')

    // Running task refusal is shown in the dialog and the task survives.
    await clickContains('Running task', '.wf-history')
    await until(() => evaluate('document.querySelector(".wf-run-title h2")?.textContent === "Running task"'), 'running task selected')
    await clickText('删除', 'document.querySelector(".wf-history.selected").closest(".wf-history-row")')
    await until(() => evaluate('Boolean(document.querySelector(".wf-dialog"))'), 'running delete dialog')
    await clickText('永久删除')
    await until(() => evaluate('document.querySelector(".wf-dialog .wf-alert")?.textContent.includes("仍在运行")'), 'running refusal message')
    assert.ok(fs.existsSync(path.join(tasks, 'wf-running-0001', 'session.json')))
    await capture('delete-refused.png')
    await clickText('取消')
    checks.push('a running task is refused with an explanation and is not deleted')

    // Make it idle, then finish the list to cover the empty state.
    const runningDir = path.join(tasks, 'wf-running-0001')
    const state = JSON.parse(fs.readFileSync(path.join(runningDir, 'session.json'), 'utf8'))
    state.status = 'completed'; state.nodes[0].status = 'succeeded'
    new RunStore(runningDir).save(state, 'fixture_completed')
    await delay(1200)
    for (const id of ['wf-second-0002', 'wf-running-0001']) {
      if (!fs.existsSync(path.join(tasks, id))) continue
      await clickContains(id === 'wf-second-0002' ? 'Second task' : 'Running task', '.wf-history')
      await until(() => evaluate(`document.querySelector(".wf-run-title h2")?.textContent === ${JSON.stringify(id === 'wf-second-0002' ? 'Second task' : 'Running task')}`), 'task selected for final delete')
      await clickText('删除', 'document.querySelector(".wf-history.selected").closest(".wf-history-row")')
      await until(() => evaluate('Boolean(document.querySelector(".wf-dialog"))'), 'final delete dialog')
      await clickText('永久删除')
      await until(() => !fs.existsSync(path.join(tasks, id)), 'final task removal')
    }
    await until(() => evaluate('Boolean(document.querySelector(".wf-empty-state"))'), 'empty result state')
    assert.equal(await evaluate('document.querySelectorAll(".wf-task-directory .wf-history-row").length'), 0)
    await clickText('历史记录')
    await until(() => evaluate('document.body.innerText.includes("暂无历史任务")'), 'empty history state')
    await capture('empty.png')
    checks.push('deleting the final task shows the empty state in both result and history tabs')

    // Daemon restart and a fresh renderer must not resurrect any deleted task.
    await originalCall('stop')
    await delay(400)
    assert.deepEqual(await client.call('list'), [])
    window.webContents.reload()
    await until(() => evaluate('document.querySelectorAll(".wf-task-directory .wf-history-row").length === 0'), 'restart empty list')
    checks.push('daemon restart and a fresh renderer show no deleted tasks')

    const validation = { ok: true, candidate: appRoot, output, checks, export: { directory: exportDirectory, elapsedMs: exportElapsed, queryLatencies: exportLatencies }, openedFolders }
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(validation, null, 2))
    console.log(JSON.stringify(validation))
  } catch (error) {
    try {
      const diagnostic = await window?.webContents.executeJavaScript(`({
        selected: Array.from(document.querySelectorAll('.wf-history.selected strong')).map(e => e.textContent),
        rows: Array.from(document.querySelectorAll('.wf-task-directory .wf-history-row strong')).map(e => e.textContent),
        title: document.querySelector('.wf-run-title h2')?.textContent || null,
        loading: document.body.innerText.includes('正在读取成果'),
        refresh: document.querySelector('.wf-alert-refresh')?.textContent || null,
      })`)
      fs.writeFileSync(path.join(output, 'failure.txt'), JSON.stringify({ diagnostic, callLog, body: await window?.webContents.executeJavaScript('document.body.innerText') }, null, 2))
      const image = await window?.webContents.capturePage()
      if (image && !image.isEmpty()) fs.writeFileSync(path.join(output, 'failure.png'), image.toPNG())
    } catch { /* diagnostics are best-effort */ }
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ ok: false, checks, error: error.stack }, null, 2))
    console.error(error.stack)
    process.exitCode = 1
  } finally {
    window?.destroy()
    await service.shutdown().catch(() => {})
    await originalCall('stop').catch(() => {})
    app.exit(process.exitCode || 0)
  }
})

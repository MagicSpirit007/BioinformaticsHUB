'use strict'
// Real renderer and preload, deterministic IPC responses, no user data or network.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const repo = path.resolve(__dirname, '..'), candidate = process.argv[2] ? path.resolve(process.argv[2]) : null
const appRoot = candidate ? path.join(candidate, 'resources/app.asar') : path.join(repo, 'apps/bioinformatics-hub-desktop')
const ui = candidate ? path.join(candidate, 'resources/ui/index.html') : path.join(repo, 'apps/bioinformatics-hub/dist/index.html')
const output = path.join(repo, 'runs', 'workbench-interactions-' + Date.now())
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'home')); app.disableHardwareAcceleration()
let window, workspace = 0, deleted = false, failDetail = false, pendingVerify, pendingExport, pendingList
let holdList = false, holdVerify = false, holdExport = false
const delay = ms => new Promise(r => setTimeout(r, ms))
const evaluate = code => window.webContents.executeJavaScript(code)
async function until(fn, label, timeout = 1800) { const end = Date.now() + timeout; do { if (await fn()) return; await delay(25) } while (Date.now() < end); throw new Error('Timed out: ' + label) }
const settings = () => ({ browserPython: '', localPython: '', chromeUrl: '', envFile: '', workspace: { id: String(workspace), runsRoot: 'fixture-' + workspace } })
const name = id => (workspace ? 'New ' : '') + 'Task ' + id
const list = () => ['A', 'B'].filter(id => !(deleted && !workspace && id === 'A')).map(id => ({ id, name: name(id), status: 'completed', updatedAt: '2026-10-24T04:00:00Z' }))
const session = id => ({ id, name: name(id), status: 'completed', nodes: [], workflow: { nodes: [] } })
const results = id => ({ id, revision: 0, results: [{ id: 'item', name: name(id) + ' result', kind: 'local', artifacts: [], checks: {}, gaps: [] }] })
ipcMain.handle('app:setLocale', () => {})
ipcMain.handle('workflow:catalog', () => ({ recipes: {}, localTools: {}, templates: [] }))
ipcMain.handle('workflow:settings', () => settings())
ipcMain.handle('workflow:list', () => { const value = list(); if (holdList) { holdList = false; return new Promise(r => { pendingList = () => r(value) }) } return value })
ipcMain.handle('workflow:load', (_e, { id }) => session(id))
ipcMain.handle('workflow:results', (_e, { id }) => { if (failDetail) throw new Error('fixture details unavailable'); return results(id) })
ipcMain.handle('workflow:resultsVerify', (_e, { id }) => { const value = { status: 'complete', results: results(id) }; if (holdVerify) return new Promise(r => { pendingVerify = () => r(value) }); return value })
ipcMain.handle('workflow:export', () => { if (holdExport) return new Promise((_r, reject) => { pendingExport = () => reject(new Error('fixture old export failed')) }); throw new Error('Unexpected export') })
ipcMain.handle('workflow:delete', (_e, { id }) => { deleted = true; return { id } })
ipcMain.handle('workflow:selectWorkspace', () => { workspace++; return settings() })
const click = (text, scope = 'document') => evaluate(`(()=>{const b=[...(${scope}).querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw new Error('Missing button '+${JSON.stringify(text)});b.click()})()`)
async function reset() {
  pendingVerify?.(); pendingExport?.(); pendingList?.()
  pendingVerify = pendingExport = pendingList = undefined
  workspace = 0; deleted = failDetail = holdVerify = holdExport = holdList = false
  await window.loadFile(ui)
  await until(() => evaluate('document.querySelectorAll(".wf-header nav button").length === 5'), 'header')
}
async function showResults() { await click('成果目录'); await until(() => evaluate('document.querySelector(".wf-result-card h3")?.textContent === "Task A result"'), 'task A') }
const checks = []
async function check(name, fn) { try { await reset(); await fn(); checks.push({ name, ok: true }) } catch (error) { checks.push({ name, ok: false, error: error.message }) } }
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1120, height: 900, show: false, webPreferences: { preload: path.join(appRoot, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  await check('delete is inside the task border at desktop and narrow widths', async () => {
    await showResults()
    for (const width of [1120, 540]) {
      window.setSize(width, 900); await delay(100)
      const geometry = await evaluate(`(()=>{const row=document.querySelector('.wf-history-row'),b=row.querySelector('.wf-delete'),r=row.getBoundingClientRect(),d=b.getBoundingClientRect();return {border:parseFloat(getComputedStyle(row).borderTopWidth),inside:d.left>r.left&&d.right<r.right&&d.top>r.top&&d.bottom<r.bottom,nested:!!b.closest('.wf-history'),overflow:document.documentElement.scrollWidth>innerWidth+1}})()`)
      assert.ok(geometry.border > 0 && geometry.inside, JSON.stringify(geometry)); assert.equal(geometry.nested, false); assert.equal(geometry.overflow, false)
    }
    window.setSize(1120, 900)
    await evaluate('document.querySelector(".wf-history-row:nth-of-type(2) .wf-delete")?.focus()')
    await click('删除', 'document.querySelectorAll(".wf-history-row")[1]')
    assert.equal(await evaluate('document.querySelector(".wf-history.selected strong").textContent'), 'Task A')
    assert.equal(await evaluate('document.querySelector(".wf-delete-name strong").textContent'), 'Task B')
  })
  await check('detail Retry reloads details immediately', async () => {
    failDetail = true; await click('成果目录')
    await until(() => evaluate('document.querySelector(".wf-alert-refresh")?.textContent.includes("fixture details unavailable")'), 'detail failure')
    failDetail = false; await click('重试', 'document.querySelector(".wf-alert-refresh")')
    await until(() => evaluate('!!document.querySelector(".wf-result-card")'), 'immediate retry', 700)
  })
  await check('late verification cannot replace the newly selected task', async () => {
    await showResults(); holdVerify = true; await click('核验保存结果'); await until(() => pendingVerify, 'held verification')
    await evaluate('document.querySelectorAll(".wf-history")[1].click()')
    await until(() => evaluate('document.querySelector(".wf-result-card h3")?.textContent === "Task B result"'), 'task B')
    pendingVerify(); pendingVerify = undefined; await delay(150)
    assert.equal(await evaluate('document.querySelector(".wf-result-card h3").textContent'), 'Task B result')
  })
  await check('late export failure stays with its original task', async () => {
    await showResults(); holdExport = true; await click('导出成果'); await until(() => pendingExport, 'held export')
    await evaluate('document.querySelectorAll(".wf-history")[1].click()')
    await until(() => evaluate('document.querySelector(".wf-result-card h3")?.textContent === "Task B result"'), 'task B')
    pendingExport(); pendingExport = undefined; await delay(150)
    assert.equal(await evaluate('document.body.innerText.includes("fixture old export failed")'), false)
  })
  await check('workspace switch resets deleted IDs and rejects previous list responses', async () => {
    await showResults(); await click('删除', 'document.querySelector(".wf-history-row")'); await click('永久删除')
    await until(() => evaluate('document.querySelectorAll(".wf-history-row").length === 1'), 'deleted A')
    holdList = true; await until(() => pendingList, 'held old workspace list', 4200)
    await click('系统设置'); await click('选择任务存储目录'); await click('成果目录')
    await until(() => evaluate('document.querySelectorAll(".wf-history-row").length === 2 && document.querySelector(".wf-history strong")?.textContent === "New Task A"'), 'new workspace tasks')
    pendingList(); pendingList = undefined; await delay(100)
    assert.equal(await evaluate('document.querySelector(".wf-history strong").textContent'), 'New Task A')
  })
  await check('delete dialog traps Tab and restores trigger focus on cancel', async () => {
    await showResults(); await evaluate('document.querySelector(".wf-delete").focus()'); await click('删除', 'document.querySelector(".wf-history-row")')
    await until(() => evaluate('document.activeElement?.textContent === "取消"'), 'cancel focused')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] }); await delay(80)
    assert.equal(await evaluate('document.activeElement?.textContent'), '永久删除')
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' }); await delay(80)
    assert.equal(await evaluate('document.activeElement?.textContent'), '取消')
    await click('取消'); await delay(80)
    assert.equal(await evaluate('document.activeElement?.classList.contains("wf-delete")'), true)
  })
  await reset(); await showResults(); window.showInactive(); await delay(300)
  fs.writeFileSync(path.join(output, 'task-card.png'), (await window.webContents.capturePage()).toPNG())
  const result = { ok: checks.every(c => c.ok), checks, output }
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); window.destroy(); app.exit(result.ok ? 0 : 1)
}).catch(error => { console.error(error); app.exit(1) })

'use strict'
// Installed renderer/preload/backend; only isolated settings and drafts.
// Test addresses are never submitted to analysis websites or mail services.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const repo = path.resolve(__dirname, '..'), installed = path.resolve(process.argv[2] || path.join(repo, 'apps'))
const archive = path.join(installed, 'resources/app.asar'), output = path.join(repo, 'runs', 'email-desktop-' + Date.now())
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'home'))
process.env.BIOHUB_HOME = path.join(output, 'home'); process.env.BIOINFORMATICS_HUB_RUNS = path.join(output, 'tasks')
delete process.env.BIOINFORMATICS_HUB_ENGINE
app.disableHardwareAcceleration()
const client = require(path.join(archive, 'workflow/client.cjs'))
let window, service, copied = '', checks = [], saveCount = 0
const delay = ms => new Promise(r => setTimeout(r, ms))
const evaluate = code => window.webContents.executeJavaScript(code)
async function until(fn, name) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(40) } throw new Error('Timed out: ' + name) }
async function click(text) { await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw new Error('Unavailable button: '+${JSON.stringify(text)});b.click()})()`); await delay(80) }
async function choose(name) { await evaluate(`(()=>{const tool=[...document.querySelectorAll('.wf-tool')].find(t=>t.querySelector('strong').textContent.includes(${JSON.stringify(name)}));if(!tool)throw new Error('Missing tool');tool.querySelector('input[type=checkbox]').click()})()`); await delay(80) }
async function mail(choice) { await evaluate(`document.querySelectorAll('input[name=email-choice]')[${choice === 'send' ? 0 : 1}].click()`); await delay(80) }
async function fill(value) { await evaluate(`(()=>{const e=document.querySelector('input[type=email]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`); await delay(80) }
const blocked = () => evaluate(`[...document.querySelectorAll('button')].filter(b=>['复制任务说明','保存 JSON'].includes(b.textContent.trim())).every(b=>b.disabled)`)
async function draft() { copied = ''; await click('复制任务说明'); await until(() => copied, 'copied draft'); return JSON.parse(copied.split('```json\n')[1].split('\n```')[0]) }
async function clear() { await click('清空并开始新配置'); await evaluate('document.querySelector("input[name=execution-mode][value=web]").click()'); await delay(80) }
app.whenReady().then(async () => {
  try {
    ipcMain.handle('app:setLocale', () => {})
    service = require(path.join(archive, 'workflow/service.cjs')).installWorkflow({ app, ipcMain, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(output, 'draft-' + (++saveCount) + '.json') }) }, shell: {}, getWindow: () => window })
    // Keep test instructions out of the user's clipboard, while exercising IPC.
    ipcMain.removeHandler('workflow:copyText'); ipcMain.handle('workflow:copyText', (_event, { text }) => { copied = text })
    window = new BrowserWindow({ width: 1280, height: 950, show: false, webPreferences: { preload: path.join(archive, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    await window.loadFile(path.join(installed, 'resources/ui/index.html'))
    await until(() => evaluate('!!document.querySelector("input[name=execution-mode]")'), 'catalog')
    await clear(); await choose('JPred')
    assert.equal(await evaluate('document.querySelectorAll("input[name=email-choice]:checked").length'), 0)
    assert.ok(await blocked()); checks.push('optional email requires an explicit receive/decline choice')
    await mail('send')
    for (const value of ['', 'bad', 'a@', '@example.org', 'a b@example.org', 'a@example']) { await fill(value); assert.ok(await blocked(), 'Invalid email accepted: ' + value) }
    await fill('fixture+notify@example.org'); assert.equal(await blocked(), false)
    const sent = await draft(); assert.deepEqual(sent.notification, { choice: 'send', email: 'fixture+notify@example.org', siteIds: ['jpred'], consents: {} })
    await click('保存 JSON'); await until(() => fs.existsSync(path.join(output, 'draft-1.json')), 'saved draft')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'draft-1.json'), 'utf8')), sent)
    checks.push('empty and malformed addresses blocked; valid plus-address preserved; copied/saved JSON identical')
    await mail('decline'); assert.equal(await evaluate('!!document.querySelector("input[type=email]")'), false)
    const declined = await draft(); assert.deepEqual(declined.notification, { choice: 'decline' }); assert.equal(copied.includes('fixture+notify@example.org'), false)
    await mail('send'); assert.equal(await evaluate('document.querySelector("input[type=email]").value'), '')
    assert.ok(await blocked()); checks.push('declining removes address from draft and switching back requires re-entry')
    await fill('fixture@example.org'); await choose('eggNOG')
    assert.equal(await evaluate('document.querySelectorAll("input[name=email-choice]:checked").length'), 0); assert.ok(await blocked())
    await mail('decline'); assert.ok(await blocked()); await mail('send'); assert.ok(await blocked()); await fill('fixture@example.org'); assert.ok(await blocked())
    await evaluate('document.querySelector(".wf-fields .wf-confirm input[type=checkbox]").click()'); await delay(80)
    const required = await draft(); assert.deepEqual(new Set(required.notification.siteIds), new Set(['jpred', 'eggnog']))
    assert.equal(required.notification.consents.eggnog, true)
    await choose('eggNOG'); assert.ok(await blocked()); await mail('send')
    const remaining = await draft(); assert.deepEqual(remaining.notification.siteIds, ['jpred']); assert.deepEqual(remaining.notification.consents, {})
    await choose('eggNOG'); await mail('send'); assert.equal(await evaluate('document.querySelector(".wf-fields .wf-confirm input[type=checkbox]").checked'), false)
    assert.ok(await blocked()); checks.push('recipient changes reset choice; required email and per-site storage consent enforced; removed sites and consent do not persist')
    await click('EN'); assert.ok(await evaluate('document.body.innerText.includes("Receive email notifications from the websites?")'))
    await click('中文'); await clear()
    await choose('JPred'); await mail('send'); assert.equal(await evaluate('document.querySelector("input[type=email]").value'), '')
    assert.ok(await blocked()); checks.push('English email controls render and clearing configuration removes address and consent')
    for (const tool of ['AlphaFold DB', 'InterPro']) {
      await clear(); await choose(tool)
      assert.equal(await evaluate('document.querySelectorAll("input[name=email-choice]").length'), 0)
      const noMail = await draft(); assert.equal(noMail.notification, undefined)
    }
    checks.push('sites without confirmed notification support do not receive an email configuration')
    assert.equal((await client.call('list')).length, 0)
    checks.push('zero analysis tasks created; no real email sending or website submission')
    const result = { ok: true, installed, output, checks, clipboard: 'intercepted test IPC; user clipboard unchanged', actualMailDeliveryTested: false }
    fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
  } catch (error) { const body = await evaluate('document.body.innerText').catch(() => ''); fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ ok: false, checks, error: error.stack, body }, null, 2)); console.error(error); process.exitCode = 1 }
  finally { window?.destroy(); await service?.shutdown(); await client.call('stop').catch(() => {}); app.exit(process.exitCode || 0) }
})

'use strict'
// Electron is a client of the same background service used by CLI and MCP.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { call } = require('./client.cjs')
const { configuration } = require('./runtime.cjs')

function installWorkflow({ app, ipcMain, dialog, shell, getWindow }) {
  let config = configuration()
  const oldSettings = path.join(app.getPath('userData'), 'workflow-settings.json')
  const sharedSettings = path.join(config.dataDir, 'workflow-settings.json')
  if (!fs.existsSync(sharedSettings) && fs.existsSync(oldSettings)) {
    fs.mkdirSync(config.dataDir, { recursive: true }); fs.copyFileSync(oldSettings, sharedSettings)
  }
  const methods = ['catalog', 'settings', 'saveSettings', 'probe', 'doctor', 'modelCheck', 'browserCheck', 'validate', 'start', 'list', 'load', 'clone', 'control', 'activate', 'reveal', 'export', 'delete', 'resolve', 'answer', 'events', 'results', 'openResult', 'reopenResult', 'archive', 'capture', 'resultsRegister', 'resultsVerify', 'resultsValidate', 'resultsFinalize', 'resultsOpenAll', 'thumbnail']
  const watched = new Map(), deleted = new Set()
  for (const name of methods) ipcMain.handle(`workflow:${name}`, async (_event, args) => {
    const result = await call(name, args || {}, config)
    if (name === 'delete' && result?.id) { deleted.add(result.id); watched.delete(result.id) }
    if (['start', 'load', 'control', 'answer'].includes(name) && result?.id && !deleted.has(result.id)) watched.set(result.id, `${result.sequence}:${result.deliveryRevision || 0}`)
    return result
  })
  ipcMain.handle('workflow:showExport', async (_event, args) => {
    const id = args?.id, directory = args?.directory
    if (typeof id !== 'string' || typeof directory !== 'string') throw new Error('Invalid export directory request')
    const paths = require('../paths.cjs')
    const { runDir } = paths.resolveRunDir(id, config.runsRoot)
    const deliveries = path.join(runDir, 'deliveries')
    if (!path.basename(directory).startsWith('export-')) throw new Error('Not an export directory')
    if (!paths.isPathInside(deliveries, directory)) throw new Error('Export directory is outside this task')
    const stat = await fsp.stat(directory)
    if (!stat.isDirectory()) throw new Error('Export path is not a directory')
    if (!shell?.openPath) throw new Error('This desktop build cannot open folders')
    const failure = await shell.openPath(directory)
    if (failure) throw new Error(failure)
    return { directory }
  })
  ipcMain.handle('workflow:copyText', (_event, { text }) => {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Invalid task description')
    require('electron').clipboard.writeText(text)
  })
  ipcMain.handle('workflow:saveDraft', async (_event, { draft }) => {
    if (draft?.schemaVersion !== 1 || !['local', 'web', 'mixed'].includes(draft.executionMode) || !Array.isArray(draft.selectedTools)) throw new Error('Invalid analysis draft')
    const data = JSON.stringify(draft, null, 2) + '\n'
    if (data.length > 1024 * 1024) throw new Error('Draft is too large')
    const picked = await dialog.showSaveDialog(getWindow(), { defaultPath: 'biohub-analysis-draft.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (picked.canceled || !picked.filePath) return { cancelled: true }
    fs.writeFileSync(picked.filePath, data, 'utf8')
    return { path: picked.filePath }
  })
  ipcMain.handle('workflow:selectWorkspace', async () => {
    const picked = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'], defaultPath: config.runsRoot })
    if (picked.canceled || !picked.filePaths[0]) return null
    config = require('./runtime.cjs').selectWorkspace(config, picked.filePaths[0])
    watched.clear()
    deleted.clear()
    return call('settings', {}, config)
  })
  ipcMain.handle('workflow:pickInput', async (_event, { kind }) => {
    const extensions = { sequence: ['fasta', 'fa', 'fna', 'faa'], alignment_fasta: ['fasta', 'fa', 'aln'], tree: ['nwk', 'treefile', 'newick'], structure: ['pdb', 'cif'] }[kind]
    if (!extensions) throw new Error('Unsupported input kind')
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), { properties: ['openFile'], filters: [{ name: kind, extensions }] })
    if (canceled || !filePaths[0]) return null
    if (fs.statSync(filePaths[0]).size > 64 * 1024 * 1024) throw new Error('Input exceeds 64 MiB')
    return { name: path.basename(filePaths[0]), value: fs.readFileSync(filePaths[0], 'utf8'), kind }
  })
  let polling = false
  const timer = setInterval(async () => {
    if (polling || !watched.size) return
    polling = true
    try {
      for (const [id, sequence] of watched) {
        const session = await call('load', { id }, config)
        const revision = `${session.sequence}:${session.deliveryRevision || 0}`
        if (revision === sequence) continue
        watched.set(id, revision)
        const window = getWindow()
        if (window && !window.isDestroyed()) window.webContents.send('workflow:update', session)
      }
    } catch { /* individual requests expose background service errors to the UI */ }
    finally { polling = false }
  }, 1000)
  timer.unref?.()
  return { async shutdown() { clearInterval(timer); watched.clear() } }
}
module.exports = { installWorkflow }

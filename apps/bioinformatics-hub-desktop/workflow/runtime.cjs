'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

function platformPath(value) {
  if (process.platform === 'linux' && typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value)) return '/mnt/' + value[0].toLowerCase() + '/' + value.slice(3).replace(/\\/g, '/')
  return value
}

function configuration(env = process.env) {
  const packaged = __dirname.includes('app.asar')
  const repo = path.resolve(__dirname, '../../..')
  const resources = packaged ? path.dirname(path.dirname(__dirname)) : null
  const dataDir = path.resolve(platformPath(env.BIOHUB_HOME) || (process.platform === 'win32'
    ? path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'BioinformaticsHUB')
    : packaged ? path.join(env.APPDATA || path.join(os.homedir(), '.config'), 'BioinformaticsHUB')
    : path.join(repo, 'runs', '.biohub')))
  let workspace = {}
  try { workspace = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const runsRoot = path.resolve(platformPath(env.BIOINFORMATICS_HUB_RUNS) || platformPath(workspace.runsRoot) || (process.platform === 'win32' || packaged ? path.join(dataDir, 'runs') : path.join(repo, 'runs')))
  const key = crypto.createHash('sha256').update(dataDir + '\0' + runsRoot).digest('hex').slice(0, 24)
  return { dataDir, runsRoot, repo, packaged, explicitHome: Boolean(env.BIOHUB_HOME), explicitRuns: Boolean(env.BIOINFORMATICS_HUB_RUNS), engine: env.BIOINFORMATICS_HUB_ENGINE || (packaged ? path.join(resources, 'engine') : repo),
    catalog: packaged ? path.join(resources, 'ui', 'site-catalog.json') : path.join(repo, 'apps/bioinformatics-hub/public/site-catalog.json'),
    endpoint: process.platform === 'win32' ? `\\\\.\\pipe\\biohub-${key}` : path.join(os.tmpdir(), `biohub-${process.getuid?.() || 0}-${key}.sock`) }
}

function runtimePaths(config) {
  const base = require('../paths.cjs')
  return { ...base, isPackaged: () => config.packaged, repoRoot: () => config.repo,
    engineRoot: () => config.engine, siteCatalogPath: () => config.catalog,
    defaultRunsRoot: () => config.runsRoot,
    resolveRunDir: id => base.resolveRunDir(id, config.runsRoot) }
}

function selectWorkspace(config, runsRoot) {
  if (typeof runsRoot !== 'string' || !path.isAbsolute(runsRoot) || !fs.statSync(runsRoot).isDirectory()) throw new Error('Choose an existing task storage directory')
  fs.mkdirSync(config.dataDir, { recursive: true })
  require('./store.cjs').atomicJson(path.join(config.dataDir, 'workspace.json'), { runsRoot: fs.realpathSync(runsRoot) })
  return configuration({ ...process.env, BIOHUB_HOME: config.dataDir, BIOINFORMATICS_HUB_RUNS: undefined })
}

function nodeEnv() { return { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } }
module.exports = { platformPath, configuration, runtimePaths, nodeEnv, selectWorkspace }

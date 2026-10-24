'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const PROTOCOL = 2
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
function canonicalPath(value) {
  let resolved = path.resolve(value)
  try { resolved = fs.realpathSync.native(resolved) } catch {}
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
function tree(root, entries) {
  const files = {}
  function walk(relative) {
    const file = path.join(root, relative)
    if (!fs.existsSync(file)) return
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error('Build input may not redirect through a symlink: ' + file)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) if (!['__pycache__', 'node_modules', '.git'].includes(name)) walk(path.join(relative, name))
    } else if (!/\.(?:pyc|tmp)$/i.test(relative) && !/(?:^|[\\/])\.env/.test(relative)) files[relative.split(path.sep).join('/')] = hash(fs.readFileSync(file))
  }
  entries.forEach(walk)
  return { digest: hash(JSON.stringify(Object.entries(files).sort((a, b) => a[0].localeCompare(b[0])))), files }
}
function components(config) {
  const backendRoot = path.resolve(__dirname, '..')
  const backend = tree(backendRoot, ['workflow', 'main.cjs', 'preload.cjs', 'paths.cjs'])
  // electron-builder removes development metadata from package.json. Bind the
  // stable application identity, not packaging-time dependency bookkeeping.
  const pkg = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8'))
  backend.files['package.identity'] = hash(JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main }))
  backend.digest = hash(JSON.stringify(Object.entries(backend.files).sort((a, b) => a[0].localeCompare(b[0]))))
  const engine = tree(config.engine, ['scripts/workflow', 'scripts/pipeline', 'scripts/browser', 'scripts/vendor', 'scripts/workflow_worker.py', 'scripts/session_runner.py', 'scripts/biohub.cjs'])
  const uiRoot = config.packaged ? path.resolve(config.engine, '../ui') : path.join(config.repo, 'apps/bioinformatics-hub/dist')
  const ui = tree(uiRoot, ['.'])
  return { backend, engine, ui }
}
function identity(config) {
  const parts = components(config)
  const digests = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.digest]))
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(config.engine, 'build-manifest.json'), 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const buildId = hash(JSON.stringify({ protocol: PROTOCOL, ...digests }))
  return { protocol: PROTOCOL, buildId, components: digests, engineRoot: canonicalPath(config.engine),
    runsRoot: canonicalPath(config.runsRoot), dataDir: canonicalPath(config.dataDir),
    manifestStatus: manifest ? manifest.buildId === buildId ? 'matched' : 'mismatch' : config.packaged ? 'missing' : 'development' }
}
function assertCompatible(expected, actual) {
  const keys = ['protocol', 'buildId', 'engineRoot', 'runsRoot', 'dataDir']
  const differences = keys.filter(k => expected?.[k] !== actual?.[k])
  if (actual?.manifestStatus === 'mismatch' || actual?.manifestStatus === 'missing') differences.push('build-manifest')
  if (differences.length) throw Object.assign(new Error('Runtime/workspace mismatch (' + differences.join(', ') + '). Restart with the matching build and workspace. Expected ' + JSON.stringify(expected) + '; backend ' + JSON.stringify(actual)), { code: 'RUNTIME_MISMATCH' })
}
module.exports = { PROTOCOL, canonicalPath, tree, components, identity, assertCompatible }

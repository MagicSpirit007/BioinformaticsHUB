'use strict'
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { loadRecipes, templates } = require('./catalog.cjs')
const { createSession, validateWorkflow, inside, ID, hash, LOCAL } = require('./model.cjs')
const { RunStore, atomicJson } = require('./store.cjs')
const { WorkflowScheduler, Resources } = require('./scheduler.cjs')
const { runWorker } = require('./worker.cjs')
const { executionOptions } = require('./execution.cjs')

function createWorkflowCore({ paths, dataDir, onChange = () => {}, onDelete = () => {} }) {
  const handlers = new Map()
  const recipes = loadRecipes(paths.siteCatalogPath())
  const schedulers = new Map(), readCache = new Map(), resources = new Resources()
  const operations = new Map(), deleting = new Set()
  const settingsPath = () => path.join(dataDir, 'workflow-settings.json')
  const script = () => path.join(paths.engineRoot(), 'scripts', 'workflow_worker.py')
  function settings() {
    let stored = {}
    try { stored = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) } catch { /* first run */ }
    const installed = path.join(os.homedir(), 'jev-ultrafast')
    const browserPython = path.join(installed, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const envFile = path.join(installed, '.env')
    let localPython = paths.resolvePython() || ''
    if (/^py\.exe$/i.test(path.basename(localPython))) {
      const resolved = spawnSync(localPython, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
      if (resolved.status === 0 && fs.existsSync(resolved.stdout.trim())) localPython = resolved.stdout.trim()
    }
    const projectEnv = path.join(paths.repoRoot(), '.venv-local', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    if (!paths.isPackaged() && fs.existsSync(projectEnv)) localPython = projectEnv
    return { localPython, browserPython: fs.existsSync(browserPython) ? browserPython : '', envFile: fs.existsSync(envFile) ? envFile : '', chromeUrl: '', ...stored }
  }
  async function publicSession(session) {
    // Browser capability IDs stay in the main process; UI gets only actionable facts.
    // The delivery projection scans files once per request; never run an extra scan here.
    const projection = handlers.has('results') ? await handlers.get('results')({ id: session.id }) : null
    const items = projection?.results || []
    return { ...session, delivery: projection?.delivery, deliveryRevision: projection?.revision, pendingRequest: undefined, resolution: session.resolution && { ...session.resolution, fasta: undefined }, input: Object.fromEntries(Object.entries(session.input).map(([k, v]) => [k, { ...v, value: undefined }])), nodes: session.nodes.map(n => {
      const result = items.find(i => i.id === n.id)
      return { ...n, executionStatus: n.status, status: result?.checks.analysis === 'verified' ? 'succeeded' : n.status === 'succeeded' && (result?.analysisVerification || result?.integrityIssues?.length) ? 'needs_review' : n.status,
        resultStatus: result?.checks.analysis, analysisVerification: result?.analysisVerification,
        checkpoint: undefined, canActivate: Boolean(n.checkpoint?.targetId), uncertainSubmission: Boolean(n.checkpoint?.effectPending), submitted: Boolean(n.checkpoint?.submitted), submissionPhase: n.checkpoint?.submission?.phase }
    }) }
  }
  function emit(session) {
    // Scheduler progress saves must never block on a result scan. The daemon only
    // tracks lifecycle state here; the UI reads projections through `load`.
    onChange(session)
  }
  function runDir(id) {
    if (!ID.test(id)) throw new Error('Invalid workflow ID')
    return paths.resolveRunDir(id).runDir
  }
  function workerRequest(request, kind = 'site', onEvent, workdir) {
    const config = settings()
    const python = kind === 'local' ? config.localPython : config.browserPython
    if (!python || !fs.existsSync(python)) throw new Error(`${kind} Python is not configured. Open Settings.`)
    if (!fs.existsSync(script())) throw new Error('Workflow worker is missing from the engine installation')
    const env = paths.engineEnv({})
    // An independent venv must never inherit an embedded distribution's PYTHONHOME.
    delete env.PYTHONHOME
    const mafft = paths.resolveMafft(), iqtree = paths.resolveIqtree()
    if (mafft) env.BIOINFORMATICS_HUB_MAFFT = mafft
    if (iqtree) env.BIOINFORMATICS_HUB_IQTREE = iqtree
    return runWorker({ python, script: script(), request: { ...request, settings: config }, env, cwd: workdir || paths.engineRoot(), timeout: ['probe', 'model_check'].includes(request.command) ? 120_000 : 30 * 60_000 }, onEvent)
  }
  function attach(session, store) {
    store.acquire()
    const scheduler = new WorkflowScheduler({ session, store, resources, onChange: emit, launch: (payload, onEvent) => workerRequest({ command: 'run', payload }, payload.node.kind, onEvent, payload.runDir) })
    schedulers.set(session.id, scheduler)
    return scheduler
  }
  function get(id) {
    if (schedulers.has(id)) return schedulers.get(id)
    const store = new RunStore(runDir(id))
    store.acquire()
    let session
    try { session = store.load() } catch (e) { store.release(); throw e }
    const scheduler = attach(session, store)
    if (!['completed', 'cancelled', 'partial'].includes(session.status)) scheduler.recover()
    return scheduler
  }
  function handle(name, handler) { handlers.set(name, handler) }
  function beginOperation(id, reason) {
    const reasons = operations.get(id) || new Set()
    reasons.add(reason); operations.set(id, reasons)
    return () => { reasons.delete(reason); if (!reasons.size) operations.delete(id) }
  }
  function operationReasons(id) { return [...(operations.get(id) || [])] }
  const taskJobs = new Map()
  function withTaskLock(id, reason, fn) {
    // Mutating operations on one task run one at a time. Different tasks keep
    // independent queues, and read-only queries never wait on this lock.
    const end = beginOperation(id, reason)
    const prior = taskJobs.get(id) || Promise.resolve()
    const next = prior.catch(() => {}).then(fn)
    taskJobs.set(id, next)
    return next.finally(() => {
      end()
      if (taskJobs.get(id) === next) taskJobs.delete(id)
    })
  }
  const READ_WHILE_DELETING = new Set(['ping', 'list', 'load', 'events', 'results', 'catalog', 'settings', 'thumbnail'])
  const call = async (name, args = {}) => {
    const handler = handlers.get(name)
    if (!handler) throw new Error('Unknown workflow method: ' + name)
    if (args.id && deleting.has(args.id) && name !== 'delete' && !READ_WHILE_DELETING.has(name)) throw new Error('该任务正在删除，不再接受新操作 / This task is being deleted and no longer accepts new operations')
    return handler(args)
  }
  async function forgetRequestPointers(id) {
    // Idempotency records live outside the task directory; removing only the
    // pointers that name this task avoids resurrecting it via a stale retry.
    const dir = path.join(dataDir, 'requests')
    let names
    try { names = await fsp.readdir(dir) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = path.join(dir, name)
      try {
        const record = JSON.parse(await fsp.readFile(file, 'utf8'))
        if (record?.id === id) await fsp.unlink(file).catch(() => {})
      } catch { /* a malformed or concurrently replaced pointer is not ours to delete */ }
    }
  }
  function lockedError() { return new Error('文件被占用，无法删除该任务。请关闭正在使用其目录的程序后重试 / Files are in use; close programs using this task directory and retry') }
  async function assertDeletable(dir, taskRoot) {
    // Probe every entry with a reversible rename before deleting anything. A
    // locked file aborts the whole delete without leaving a half-removed task.
    const contained = value => {
      const relative = process.platform === 'win32'
        ? path.relative(taskRoot.toLowerCase(), value.toLowerCase())
        : path.relative(taskRoot, value)
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    }
    async function probe(file) {
      const temporary = `${file}.delete-probe-${crypto.randomBytes(4).toString('hex')}`
      try { await fsp.rename(file, temporary) }
      catch (error) {
        if (error.code === 'ENOENT') return
        if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw lockedError()
        throw error
      }
      try { await fsp.rename(temporary, file) }
      catch (error) {
        try { await fsp.rename(temporary, file) } catch { /* report the original failure */ }
        throw error
      }
    }
    async function walk(current, depth = 0) {
      if (depth > 64) throw new Error('Task directory is nested too deeply to delete safely')
      if (!contained(await fsp.realpath(current))) throw new Error('拒绝删除：任务目录包含指向外部的链接 / Refusing to delete: the task contains a link outside its directory')
      const entries = await fsp.readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        const file = path.join(current, entry.name)
        const stat = await fsp.lstat(file)
        await probe(file)
        if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(file, depth + 1)
      }
    }
    await walk(dir)
  }
  async function removeRun(id) {
    if (deleting.has(id)) throw new Error('该任务正在删除 / This task is already being deleted')
    const dir = runDir(id)
    const root = path.resolve(paths.defaultRunsRoot())
    // Block every mutating method for this task before the first await, so a
    // concurrent export/register cannot start while ownership is being checked.
    deleting.add(id)
    try {
      let entry
      try { entry = await fsp.lstat(dir) } catch (error) {
        if (error.code === 'ENOENT') throw new Error('任务不存在或已被删除 / Task does not exist or was already deleted')
        throw error
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('拒绝删除：任务目录不是普通目录 / Refusing to delete: the task path is not a regular directory')
      const [realRoot, realDir] = await Promise.all([fsp.realpath(root), fsp.realpath(dir)])
      const relative = path.relative(realRoot, realDir)
      const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !same(path.basename(realDir), id) || !same(path.dirname(realDir), realRoot)) {
        throw new Error('拒绝删除：任务目录不在当前工作区 / Refusing to delete: the task directory is outside the current workspace')
      }
      let session
      try { session = read(id) } catch (error) { throw new Error('无法读取任务记录，未删除任何文件 / Cannot read the task record; nothing was deleted: ' + error.message) }
      const scheduler = schedulers.get(id)
      if (scheduler?.active?.size) throw new Error('任务仍在执行，请先停止或等待完成 / The task is still running; stop it or wait for it to finish')
      if (['running', 'waiting_remote'].includes(session.status) || session.nodes.some(n => ['running', 'verifying', 'waiting_remote'].includes(n.status))) throw new Error('任务仍在运行或等待远端结果，请先停止或等待完成 / The task is running or waiting for a remote result; stop it or wait before deleting')
      const reasons = operationReasons(id)
      if (reasons.length) throw new Error(`任务正在执行其他操作（${reasons.join(', ')}），请等待完成 / The task is busy (${reasons.join(', ')}); wait for it to finish`)
      if (scheduler) {
        // Shutdown saves a final idle snapshot and releases the controller lock
        // before the directory is removed, so no timer can recreate it.
        await scheduler.shutdown()
        schedulers.delete(id)
        clearTimeout(scheduler.timer)
        scheduler.closed = true
        try { scheduler.store.release() } catch { /* the lock is removed with the directory */ }
      }
      await assertDeletable(dir, realDir)
      try { await fsp.rm(dir, { recursive: true, force: false }) }
      catch (error) {
        if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'ENFILE', 'EMFILE'].includes(error.code)) throw lockedError()
        throw error
      }
      readCache.delete(id)
      deleting.delete(id)
      try { require('./integrity.cjs').clearScanCache(dir) } catch { /* cache only */ }
      try { await forgetRequestPointers(id) } catch { /* best-effort metadata cleanup */ }
      try { onDelete(id) } catch { /* recovery index is best-effort after deletion */ }
      return { id }
    } finally { deleting.delete(id) }
  }
  handle('delete', ({ id }) => removeRun(id))
  function read(id) {
    if (schedulers.has(id)) return schedulers.get(id).session
    const dir = runDir(id)
    const signature = ['session.json', 'events.jsonl'].map(name => {
      try { const s = fs.statSync(path.join(dir, name)); return [s.size, s.mtimeMs, s.ctimeMs].join(':') }
      catch (error) { if (error.code !== 'ENOENT') throw error; return 'missing' }
    }).join('|')
    const previous = readCache.get(id)
    if (previous?.signature === signature) return previous.session
    let session
    try { session = new RunStore(dir).read() } catch (error) {
      if (!/Not a workflow v2 run/.test(error.message)) throw error
      session = require('./legacy-results.cjs').legacySession(dir, JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')), id)
    }
    readCache.set(id, { signature, session })
    return session
  }
  handle('catalog', () => ({ recipes, templates: templates(recipes), localTools: LOCAL, executionOptions }))
  handle('settings', () => ({ ...settings(), workspace: { id: hash(dataDir + '\0' + paths.defaultRunsRoot()).slice(0, 24), dataDir, runsRoot: paths.defaultRunsRoot(), runtime: process.platform } }))
  handle('saveSettings', config => {
    const next = {}
    const previous = settings()
    for (const key of ['localPython', 'browserPython', 'envFile', 'chromeUrl']) {
      const value = String(config[key] ?? previous[key] ?? '').trim()
      if (value.length > 4096) throw new Error('Setting is too long')
      if (key.endsWith('Python') && value && (!path.isAbsolute(value) || !fs.existsSync(value) || !/^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(value)))) throw new Error('Choose an existing Python executable')
      if (key === 'envFile' && value && (!path.isAbsolute(value) || !fs.statSync(value).isFile())) throw new Error('Choose an existing environment file')
      if (key === 'chromeUrl' && value) {
        const url = new URL(value)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Chrome URL must be an HTTP(S) debugging endpoint')
      }
      next[key] = value
    }
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true }); atomicJson(settingsPath(), next)
    return next
  })
  handle('probe', async () => {
    const config = settings()
    const result = { browser: null, local: null, errors: [] }
    for (const [kind, key] of [['site', 'browser'], ['local', 'local']]) {
      try { result[key] = await workerRequest({ command: 'probe' }, kind).promise }
      catch (e) { result.errors.push(`${key}: ${e.message}`) }
    }
    return { ...result, configured: { browserPython: Boolean(config.browserPython), localPython: Boolean(config.localPython), envFile: Boolean(config.envFile) } }
  })
  handle('modelCheck', () => workerRequest({ command: 'model_check' }).promise)
  handle('browserCheck', () => workerRequest({ command: 'browser_check' }).promise)
  handle('validate', ({ workflow, inputs }) => ({ errors: validateWorkflow(workflow, inputs, recipes) }))
  handle('start', async ({ workflow, executionMode, inputs, name, resumeId, resolution, idempotencyKey, requestFingerprint }) => {
    const id = resumeId || `wf-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
    if (Buffer.byteLength(JSON.stringify(inputs || {})) > 64 * 1024 * 1024) throw new Error('Combined input exceeds 64 MiB')
    const session = createSession(id, workflow, inputs, recipes)
    session.executionMode = executionMode
    if (resumeId) {
      const previous = read(resumeId)
      if (previous.status !== 'needs_input') throw new Error('Only a task waiting for sequence input can be answered')
      session.sequence = previous.sequence
      session.createdAt = previous.createdAt
    }
    if (resolution) session.resolution = resolution
    if (idempotencyKey) session.idempotencyKey = idempotencyKey
    if (requestFingerprint) session.requestFingerprint = requestFingerprint
    session.name = String(name || workflow.name || id).slice(0, 200)
    const dir = runDir(id)
    fs.mkdirSync(path.join(dir, '00_input'), { recursive: true })
    const suffix = { sequence: '.fasta', protein_fasta: '.fasta', nucleotide_fasta: '.fasta', alignment_fasta: '.fasta', tree: '.nwk', structure: '.pdb', identifier: '.txt' }
    for (const [key, input] of Object.entries(session.input)) {
      if (!ID.test(key) || !suffix[input.kind]) throw new Error('Invalid input key or kind')
      if (!input.value?.trim()) { delete session.input[key]; continue }
      const relative = `00_input/${key}${suffix[input.kind]}`
      fs.writeFileSync(inside(dir, relative), input.value, 'utf8')
      session.input[key] = { kind: input.kind, path: relative, sha256: hash(input.value), bytes: Buffer.byteLength(input.value), verified: false, ...(input.provenance ? { provenance: input.provenance } : {}) }
    }
    const store = new RunStore(dir)
    store.save(session, 'created')
    attach(session, store).start()
    return await publicSession(session)
  })
  handle('list', () => {
    const root = paths.defaultRunsRoot()
    if (!fs.existsSync(root)) return []
    return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && ID.test(d.name)).flatMap(d => {
      try {
        let session
        try { session = JSON.parse(fs.readFileSync(path.join(root, d.name, 'session.json'), 'utf8')) }
        catch { session = new RunStore(path.join(root, d.name)).read() }
        if (session.schemaVersion !== 2) session = require('./legacy-results.cjs').legacySession(path.join(root, d.name), session, d.name)
        return [{ id: session.id, name: session.name, status: session.status, updatedAt: [session.updatedAt, require('./delivery.cjs').loadRegistry(path.join(root, d.name)).updatedAt].filter(Boolean).sort().at(-1), delivery: require('./delivery.cjs').loadRegistry(path.join(root, d.name)).finalized }]
      } catch { return [] }
    }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  })
  handle('load', async ({ id }) => publicSession(read(id)))
  handle('control', async ({ id, action, nodeId, resultUrl, notSubmitted }) => {
    const scheduler = get(id)
    if (action === 'pause') scheduler.pause()
    else if (action === 'resume') scheduler.resume()
    else if (action === 'cancel') scheduler.cancel()
    else if (action === 'retry') scheduler.retry(nodeId)
    else if (action === 'revalidate') scheduler.revalidate(nodeId)
    else if (action === 'takeover') scheduler.takeover(nodeId)
    else if (action === 'reconcile') scheduler.reconcile(nodeId, { resultUrl, notSubmitted })
    else throw new Error('Unknown workflow action')
    return publicSession(scheduler.session)
  })
  handle('activate', async ({ id, nodeId }) => {
    const scheduler = get(id)
    const run = scheduler.session.nodes.find(n => n.id === nodeId)
    if (scheduler.active.has(nodeId)) {
      if (!run.takeoverRequested) throw new Error('Request takeover before activating a running node')
      await scheduler.active.get(nodeId).promise.catch(() => {})
    }
    if (!run?.checkpoint?.targetId) throw new Error('No owned browser tab is available')
    return workerRequest({ command: 'activate', targetId: run.checkpoint.targetId, browserContextId: run.checkpoint.browserContextId }).promise
  })
  handle('reveal', async ({ id, artifactPath }) => {
    const session = read(id)
    if (!session.nodes.some(n => n.artifacts.some(a => a.path === artifactPath))) throw new Error('Artifact is not registered in this run')
    await require('./results.cjs').openLocal(inside(runDir(id), artifactPath)); return { ok: true }
  })
  handle('export', ({ id }) => {
    const session = read(id)
    const dir = runDir(id), output = path.join(dir, '10_research_handoff')
    fs.mkdirSync(output, { recursive: true })
    const artifactIndex = []
    for (const node of session.nodes) for (const artifact of node.artifacts) {
      const source = inside(dir, artifact.path)
      if (!artifact.verified || hash(fs.readFileSync(source)) !== artifact.sha256) throw new Error(`Cannot export changed artifact: ${artifact.path}`)
      const relative = `artifacts/${artifact.path}`
      const destination = inside(output, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(source, destination)
      artifactIndex.push({ ...artifact, path: relative, nodeId: node.id })
    }
    const inputIndex = {}
    for (const [key, input] of Object.entries(session.input)) {
      const source = inside(dir, input.path)
      if (hash(fs.readFileSync(source)) !== input.sha256) throw new Error(`Cannot export changed input: ${key}`)
      const relative = `inputs/${path.basename(input.path)}`
      const destination = inside(output, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination)
      inputIndex[key] = { ...input, path: relative }
    }
    atomicJson(path.join(output, 'workflow.json'), session.workflow)
    atomicJson(path.join(output, 'site-recipes.json'), session.recipeSnapshot)
    atomicJson(path.join(output, 'artifact-index.json'), artifactIndex)
    atomicJson(path.join(output, 'evidence.json'), { id: session.id, status: session.status, input: inputIndex, nodes: session.nodes.map(n => ({ id: n.id, status: n.status, evidence: n.evidence, resultUrl: n.resultUrl, message: n.message, attempts: n.attempts, remoteMayContinue: n.remoteMayContinue })) })
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => {
      const e = JSON.parse(line); return JSON.stringify({ sequence: e.sequence, at: e.at, type: e.type, detail: e.detail })
    })
    fs.writeFileSync(path.join(output, 'events.jsonl'), events.join('\n') + '\n', 'utf8')
    const escape = value => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')
    const lines = [`# ${session.name}`, '', `Run: ${session.id}`, `Status: ${session.status}`, '', '## Workflow and parameters', '', '```json', JSON.stringify(session.workflow, null, 2), '```', '', '## Verified results', '', '| Step | Status | Official result | Artifacts |', '|---|---|---|---|']
    for (const node of session.nodes) lines.push(`| ${escape(node.id)} | ${escape(node.status)} | ${escape(node.resultUrl || '')} | ${node.artifacts.map(a => escape('artifacts/' + a.path)).join('<br>')} |`)
    lines.push('', '## Evidence and input provenance', '', '```json', JSON.stringify({ input: session.input, nodes: session.nodes.map(n => ({ id: n.id, evidence: n.evidence, artifacts: n.artifacts, message: n.message, remoteMayContinue: n.remoteMayContinue })) }, null, 2), '```', '')
    const file = path.join(output, '研究工作包.md')
    fs.writeFileSync(file, lines.join('\n'), 'utf8')
    return { path: file }
  })
  handle('clone', ({ id }) => {
    const session = read(id), dir = runDir(id)
    return { workflow: session.workflow, inputs: Object.fromEntries(Object.entries(session.input).map(([key, input]) => [key, { kind: input.kind, value: fs.readFileSync(inside(dir, input.path), 'utf8') }])), name: session.name }
  })
  return { call, read, handlers, workerRequest, runDir, get, paths, dataDir, beginOperation, withTaskLock, operationReasons, isActive: id => Boolean(schedulers.get(id)?.active.size), async shutdown() { await Promise.allSettled([...schedulers.values()].map(async s => { try { await s.shutdown() } finally { s.store.release() } })) }, settings }
}
module.exports = { createWorkflowCore }

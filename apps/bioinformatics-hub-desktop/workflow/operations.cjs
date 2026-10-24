'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { RunStore, atomicJson } = require('./store.cjs')
const { inside, hash, ID } = require('./model.cjs')
const { resultRows, openLocal, checkedFile } = require('./results.cjs')
const { executionChoice } = require('./execution.cjs')
const canonical = value => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))

function extendCore(core) {
  const register = (name, fn) => core.handlers.set(name, fn)
  const baseStart = core.handlers.get('start')
  const requests = new Map(), resolving = new Map(), maintenance = new Set()
  const baseControl = core.handlers.get('control')
  register('control', args => {
    const session = core.read(args.id)
    if (session.status !== 'needs_input') return baseControl(args)
    if (args.action !== 'cancel') throw new Error('Confirm the sequence identifier with run answer before execution')
    session.status = 'cancelled'
    new RunStore(core.runDir(args.id)).save(session, 'cancelled')
    return core.call('load', { id: args.id })
  })
  register('resolve', args => {
    const key = hash(JSON.stringify(args))
    if (!resolving.has(key)) resolving.set(key, core.workerRequest({ command: 'resolve', args, cacheDir: path.join(core.dataDir, 'sequence-cache') }, 'local').promise.finally(() => resolving.delete(key)))
    return resolving.get(key)
  })
  register('doctor', () => core.call('probe'))
  register('events', ({ id, after = 0, limit = 200 }) => {
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid event cursor or limit')
    const file = path.join(core.runDir(id), 'events.jsonl')
    const data = fs.readFileSync(file, 'utf8')
    const events = data.slice(0, data.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(e => e.sequence > after).slice(0, limit).map(({ sequence, at, type, detail }) => ({ sequence, at, type, detail }))
    return { events, cursor: events.at(-1)?.sequence || after }
  })
  async function start(args, resumeId) {
    const choice = executionChoice(args.executionMode, args.workflow)
    if (choice) return choice
    const catalog = await core.call('catalog')
    if (!args.workflow && !args.template) return {
      status: 'needs_choice', actionRequired: 'choose_workflow',
      message: '请选择分析模板或提供用户确认的流程，不会默认选择蛋白表征。 / Choose a template or supply a user-confirmed workflow.',
      templates: catalog.templates,
    }
    const workflow = args.workflow || catalog.templates.find(t => t.id === args.template)
    if (!workflow) throw new Error('Unknown workflow template')
    const mismatch = executionChoice(args.executionMode, workflow)
    if (mismatch) return mismatch
    const definition = JSON.parse(JSON.stringify(workflow))
    for (const node of definition.nodes) node.parameters = { ...node.parameters, ...(args.parameters?.[node.id] || {}) }
    const notification = require('./notifications.cjs').notificationChoice(definition, catalog.recipes, args.notification)
    if (notification) return notification
    let inputs = { ...args.inputs }, resolution
    if (args.identifier) {
      resolution = await core.call('resolve', { identifier: args.identifier, provider: args.provider, species: args.species, kind: args.sequenceKind || 'protein_fasta', sourceUrl: args.sourceUrl, sourceSpecies: args.sourceSpecies, sourceVersion: args.sourceVersion })
      if (resolution.status !== 'resolved') {
        const id = resumeId || `wf-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
        const dir = core.runDir(id)
        fs.mkdirSync(dir, { recursive: true })
        const previous = resumeId ? core.read(id) : null
        const session = { schemaVersion: 2, version: '0.7.0', id, sessionId: id, name: args.name || args.identifier,
          createdAt: previous?.createdAt || new Date().toISOString(), sequence: previous?.sequence || 0, status: 'needs_input',
          workflow: definition, executionMode: args.executionMode, recipeSnapshot: {}, input: {}, nodes: [], resolution, pendingRequest: args, idempotencyKey: args.idempotencyKey, requestFingerprint: args.requestFingerprint }
        new RunStore(dir).save(session, 'sequence_input_required', { actionRequired: resolution.actionRequired })
        return { ...session, pendingRequest: undefined }
      }
      const bound = { kind: resolution.kind, value: resolution.fasta, provenance: resolution.provenance }
      inputs = { ...inputs, sequence: bound, [resolution.kind === 'protein_fasta' ? 'protein' : 'nucleotide']: bound }
      // Structure workflows still need a verified UniProt accession, never a similar local gene ID.
      if (resolution.provenance.provider === 'uniprot') inputs.identifier = { kind: 'identifier', value: resolution.identifier }
    }
    return baseStart({ workflow: definition, executionMode: args.executionMode, inputs, name: args.name || args.identifier, resumeId, resolution, idempotencyKey: args.idempotencyKey, requestFingerprint: args.requestFingerprint })
  }
  register('start', args => {
    if (!args.idempotencyKey) return start(args)
    if (typeof args.idempotencyKey !== 'string' || args.idempotencyKey.length > 200) throw new Error('Invalid idempotency key')
    const key = hash(args.idempotencyKey), fingerprint = hash(JSON.stringify(canonical(args)))
    const file = path.join(core.dataDir, 'requests', key + '.json')
    if (fs.existsSync(file)) {
      const prior = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (prior.fingerprint !== fingerprint) throw new Error('Idempotency key was already used with different arguments')
      return core.call('load', { id: prior.id })
    }
    // A recovered run is also a durable idempotency record if the daemon exited before indexing it.
    for (const item of core.handlers.get('list')()) {
      const session = core.read(item.id)
      if (session.idempotencyKey === args.idempotencyKey) {
        if (session.requestFingerprint !== fingerprint) throw new Error('Idempotency key was already used with different arguments')
        return core.call('load', { id: item.id })
      }
    }
    if (requests.has(key)) {
      if (requests.get(key).fingerprint !== fingerprint) throw new Error('Idempotency key has conflicting arguments')
      return requests.get(key).promise
    }
    const promise = start({ ...args, requestFingerprint: fingerprint }).then(session => {
      if (!session.id) return session
      fs.mkdirSync(path.dirname(file), { recursive: true }); atomicJson(file, { id: session.id, fingerprint }); return session
    }).finally(() => requests.delete(key))
    requests.set(key, { fingerprint, promise }); return promise
  })
  register('answer', async ({ id, identifier, species, provider, sourceUrl, sourceSpecies, sourceVersion, executionMode, notification }) => {
    const session = core.read(id)
    if (session.status !== 'needs_input') throw new Error('This task is not waiting for sequence input')
    const patch = Object.fromEntries(Object.entries({ identifier, species, provider, sourceUrl, sourceSpecies, sourceVersion, executionMode, notification }).filter(([, value]) => value != null))
    return start({ ...session.pendingRequest, workflow: session.workflow, executionMode: session.executionMode, ...patch }, id)
  })
  register('results', ({ id }) => ({ id, status: core.read(id).status, results: resultRows(core.read(id)) }))
  register('openResult', async ({ id, nodeId, artifactPath, offline = false }) => {
    const session = core.read(id), run = session.nodes.find(n => n.id === nodeId)
    if (artifactPath) { await openLocal(await checkedFile(core, session, artifactPath)); return { opened: 'file' } }
    if (!run) throw new Error('Result node was not found')
    if (!offline && run.checkpoint?.targetId) {
      try {
        await core.workerRequest({ command: 'activate', targetId: run.checkpoint.targetId, browserContextId: run.checkpoint.browserContextId }).promise
        return { opened: 'original_tab' }
      } catch { /* use the verified recoverable URL or archive */ }
    }
    const recipe = session.recipeSnapshot[nodeId]
    const safeUrl = run.resultUrl && recipe && new URL(run.resultUrl)
    if (!offline && safeUrl && ['https:', 'http:'].includes(safeUrl.protocol) && recipe.allowedHosts.includes(safeUrl.hostname) && !safeUrl.username && !safeUrl.password && (recipe.lookup || recipe.resultReopen === 'url')) {
      await core.workerRequest({ command: 'open_result', url: safeUrl.href, allowedHosts: recipe.allowedHosts }).promise
      return { opened: 'official_url', url: safeUrl.href }
    }
    const file = (run.artifacts || []).find(a => a.path.endsWith('/page.html')) || (run.artifacts || []).find(a => a.path.endsWith('/page.mhtml'))
    if (file) { await openLocal(await checkedFile(core, session, file.path)); return { opened: 'archive', path: file.path } }
    if (safeUrl) return { opened: false, actionRequired: 'confirm_reopen', url: safeUrl.href, message: 'Original browser session is unavailable. This URL may require that session; supply an archive or explicitly reopen it.' }
    return { opened: false, actionRequired: 'result_unavailable', message: 'No recoverable page or archive is available' }
  })
  register('reopenResult', async ({ id, nodeId }) => {
    const session = core.read(id), run = session.nodes.find(n => n.id === nodeId), recipe = session.recipeSnapshot[nodeId]
    const url = new URL(run?.resultUrl)
    if (!recipe?.allowedHosts.includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Result URL is outside the configured service')
    await core.workerRequest({ command: 'open_result', url: url.href, allowedHosts: recipe.allowedHosts }).promise
    return { opened: 'official_url', url: url.href }
  })
  async function archive(args, captureOnly) {
    const key = `${args.id}:${args.nodeId}`
    if (maintenance.has(key)) throw new Error('Result is already being archived')
    const scheduler = core.get(args.id), run = scheduler.session.nodes.find(n => n.id === args.nodeId)
    if (!run || run.status !== 'succeeded' || scheduler.active.has(args.nodeId)) throw new Error('Archive an idle completed result')
    if (!run.checkpoint?.targetId) throw new Error('The original result tab is unavailable')
    maintenance.add(key)
    const reason = captureOnly ? 'capture' : 'archive'
    const work = async () => {
      try {
        const relative = `nodes/${args.nodeId}/archives/${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
        const result = await core.workerRequest({ command: 'archive', runDir: core.runDir(args.id), nodeId: args.nodeId,
          checkpoint: run.checkpoint, recipe: scheduler.session.recipeSnapshot[args.nodeId], output: relative,
          captureOnly, scale: args.scale ?? 2, clip: args.clip }).promise
        run.artifacts.push(...result.artifacts)
        if (!captureOnly) { run.archive = result.archive; run.completeness = { ...run.completeness, visual: result.archive.visual?.status || 'unverified' } }
        scheduler.save(captureOnly ? 'result_captured' : 'result_archived', { nodeId: args.nodeId, status: result.archive.status })
        return result
      } finally { maintenance.delete(key) }
    }
    return core.withTaskLock ? core.withTaskLock(args.id, reason, work) : work()
  }
  register('archive', args => archive(args, false))
  register('capture', args => archive(args, true))
  const baseExport = core.handlers.get('export')
  register('export', async args => {
    const result = await baseExport(args), session = core.read(args.id)
    const output = path.dirname(result.path)
    const escape = text => String(text || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    const rows = resultRows(session).map(row => `<section><h2>${escape(row.name)}</h2><p>${escape(row.status)} · ${escape(row.archive.status)}</p>${row.resultUrl ? `<a href="${escape(row.resultUrl)}">Official result</a>` : ''}<ul>${row.artifacts.map(a => `<li><a href="${escape('artifacts/' + a.path)}">${escape(a.name)}</a></li>`).join('')}</ul></section>`).join('')
    const file = path.join(output, 'index.html')
    fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(session.name)}</title></head><body><h1>${escape(session.name)}</h1>${rows}</body></html>`)
    atomicJson(path.join(output, 'results.json'), { id: session.id, resolution: session.resolution && { ...session.resolution, fasta: undefined }, results: resultRows(session) })
    return { ...result, directory: output, index: file }
  })
  require('./delivery.cjs').installDelivery(core)
}
module.exports = { extendCore }

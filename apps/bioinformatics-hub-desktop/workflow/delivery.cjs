'use strict'
// Delivery is an append-only projection beside the execution journal. Never resume
// a scheduler just to register, view, export or deliver an existing result.
//
// Large result directories are scanned asynchronously. The daemon is single-threaded:
// synchronous reads/hashes of hundreds of megabytes block every other socket request
// (including the liveness ping), which is what used to surface as a `workflow:results`
// timeout while an export was running.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { inside, hash, ID, artifactFor } = require('./model.cjs')
const { atomicJson } = require('./store.cjs')
const { fileDigests, hashFile, verifiedFile, clearScanCache, checked: verifiedChecked, copyVerified } = require('./integrity.cjs')

const INTERNAL = /\.(?:jsonl?|log|ckp|tmp|part|crdownload)$/i

function roleOf(a) {
  if (a.role === 'data') return 'data'
  if (a.role === 'internal') return 'internal'
  if (a.role === 'resource' || /(?:^|\/)assets\//.test(a.path)) return 'resource'
  if (INTERNAL.test(a.path) || /(?:^|\/)(?:official-result\.txt|decisions[^/]*|initial-observation[^/]*|final-observation[^/]*)$/.test(a.path)) return 'internal'
  if (a.role) return a.role
  if (/\.(?:html?|mhtml)$/i.test(a.path)) return 'page'
  if (/\.(?:svg|png|jpe?g|gif|webp)$/i.test(a.path)) return 'figure'
  return 'original_file'
}
function visible(a) { return !['internal', 'resource'].includes(roleOf(a)) }
function itemFingerprint(item) {
  return hash(JSON.stringify(item.artifacts.map(a => [a.path, a.sha256]).sort((a, b) => a[0].localeCompare(b[0]))))
}
const emptyRegistry = () => ({ version: 1, revision: 0, items: [], history: [] })
function loadRegistry(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'delivery.json'), 'utf8')) }
  catch (e) { if (e.code !== 'ENOENT') throw e; return emptyRegistry() }
}
async function readRegistry(root) {
  try { return JSON.parse(await fsp.readFile(path.join(root, 'delivery.json'), 'utf8')) }
  catch (e) { if (e.code !== 'ENOENT') throw e; return emptyRegistry() }
}
async function checked(root, a, cache = fileDigests) {
  return verifiedChecked(root, a, cache)
}

function nativeItems(session) {
  return session.nodes.map(run => {
    const node = session.workflow.nodes.find(n => n.id === run.id)
    const arts = (run.artifacts || []).map(a => ({ ...a, role: roleOf(a) }))
    return { id: run.id, nodeId: run.id, name: session.recipeSnapshot?.[run.id]?.name || node?.tool || run.id,
      kind: node?.kind === 'site' ? 'website' : 'local', executionStatus: run.status, sourceUrl: run.resultUrl,
      artifacts: arts, message: run.message, capturedAt: run.archive?.capturedAt,
      checks: { analysis: run.status === 'succeeded' && run.evidence?.verified ? 'verified' : 'unverified',
        visual: run.completeness?.visual || 'unverified', archive: run.archive?.status || (node?.kind === 'site' ? 'not_saved' : 'not_applicable'),
        downloads: run.completeness?.downloads || 'unverified' }, archive: run.archive || { status: 'not_saved' } }
  })
}
// One scan per request. Every artifact/input digest is cached for the lifetime
// of this scan so verification, projection and export reuse the same proof.
async function resultItems(core, session, options = {}) {
  const root = core.runDir(session.id)
  const registry = await readRegistry(root), items = nativeItems(session), cache = options.cache || fileDigests
  for (const addition of registry.items || []) {
    const at = items.findIndex(item => item.id === addition.id)
    if (at >= 0) items[at] = { ...items[at], ...addition, executionStatus: items[at].executionStatus,
      artifacts: [...items[at].artifacts.filter(a => !addition.artifacts.some(b => b.path === a.path)), ...addition.artifacts] }
    else items.push(addition)
  }
  const artifactChecks = new Map()
  async function checkArtifact(artifact) {
    if (!artifact?.path || !artifact?.sha256) return { ok: false, error: 'Registered file is missing a path or checksum' }
    const key = artifact.path + '\0' + artifact.sha256
    if (artifactChecks.has(key)) return artifactChecks.get(key)
    let result
    try {
      const file = inside(root, artifact.path)
      await verifiedFile(file, artifact.sha256, cache)
      result = { ok: true, file }
    } catch (error) { result = { ok: false, error: error.message } }
    artifactChecks.set(key, result)
    return result
  }
  const checkDigest = (file, expected) => verifiedFile(file, expected, cache)
  for (const item of items) {
    item.integrityIssues = []
    const scientific = registry.analyses?.[item.id]
    for (const artifact of item.artifacts) {
      const check = await checkArtifact(artifact)
      if (!check.ok) item.integrityIssues.push(check.error)
    }
    const definition = session.workflow.nodes.find(n => n.id === item.id), execution = session.nodes.find(n => n.id === item.id)
    if (definition?.input) {
      try {
        const bound = artifactFor(session, definition)
        if (!bound) throw new Error('Bound input is missing')
        const check = await checkArtifact(bound)
        if (!check.ok) throw new Error(check.error)
        const recordedInput = item.proof?.inputSha256 || (!scientific && (execution?.evidence?.inputSha256 || execution?.checkpoint?.inputSha256))
        if (recordedInput && recordedInput !== bound.sha256) throw new Error('Result input binding changed')
        if (!scientific && execution?.evidence?.parametersSha256 && execution.evidence.parametersSha256 !== require('./analysis.cjs').fingerprint(definition.parameters || {})) throw new Error('Result parameters changed')
      } catch (error) { item.integrityIssues.push(error.message) }
    }
    if (scientific) {
      let current = false
      try { current = scientific.fingerprint === (await require('./analysis.cjs').contextFor(core, session, item, { check: checkDigest })).fingerprint } catch {}
      item.analysisVerification = { ...scientific, current: current && !item.integrityIssues.length }
      item.checks.analysis = current && !item.integrityIssues.length && scientific.status === 'verified' ? 'verified' : 'unverified'
    }
    if (item.integrityIssues.length) item.checks = { analysis: 'unverified', visual: 'unverified', archive: 'unverified', downloads: 'unverified' }
    const verification = registry.verifications?.[item.id]
    if (!item.integrityIssues.length && verification?.fingerprint === itemFingerprint(item)) {
      item.verification = verification
      item.checks = { ...item.checks, ...verification.checks }
    }
    item.attachmentInventory = require('./attachments.cjs').inventory(core, session, item)
    if (!['complete', 'not_required'].includes(item.attachmentInventory.status)) item.checks.downloads = item.attachmentInventory.status
  }
  const expected = registry.expected || []
  for (const item of items) item.name = expected.find(e => e.id === item.id)?.name || item.name
  items.sort((a, b) => { const index = id => { const i = expected.findIndex(e => e.id === id); return i < 0 ? expected.length : i }; return index(a.id) - index(b.id) })
  return { root, registry, items, cache, checkArtifact, checkDigest }
}
function gapsFor(item) {
  const gaps = []
  if (item.checks.analysis !== 'verified') gaps.push('分析结果尚未独立核验 / Analysis is unverified')
  if (item.kind === 'website' && !item.artifacts.some(a => roleOf(a) === 'page' && /\.html?$/i.test(a.path))) gaps.push('缺少原站 HTML 存档 / Original HTML is missing')
  for (const [key, label] of [['visual', '图表 / Figures'], ['archive', '网页保存 / Page archive'], ['downloads', '附件下载 / Downloads']]) {
    if (!['complete', 'verified', 'not_applicable', 'not_required'].includes(item.checks[key])) gaps.push(label + ': ' + item.checks[key])
  }
  if (!item.artifacts.some(visible)) gaps.push('尚无可交付文件 / No deliverable files')
  if (item.message) gaps.push(...(item.unavailable ? [item.message] : []))
  if (item.verification?.issues) gaps.push(...item.verification.issues)
  if (item.integrityIssues?.length) gaps.push(...item.integrityIssues)
  if (item.analysisVerification && !item.analysisVerification.current) gaps.push('分析核验已过期 / Scientific verification is stale')
  if (item.analysisVerification?.issues?.length) gaps.push(...item.analysisVerification.issues)
  if (item.attachmentInventory?.issues?.length) gaps.push(...item.attachmentInventory.issues)
  return gaps
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const href = value => value.split('/').map(encodeURIComponent).join('/')

function projection(session, scan) {
  const { registry, items } = scan
  const current = registry.finalized?.fingerprint === hash(JSON.stringify({ expected: registry.expected, items }))
  return { id: session.id, status: session.status, revision: registry.revision,
    delivery: registry.finalized && { ...registry.finalized, ...(current ? {} : { status: 'unverified', stale: true }) },
    results: items.map(item => ({ ...item, ...require('./result-status.cjs').resultStatus(item, session.nodes.find(n => n.id === item.nodeId)), artifacts: item.artifacts.filter(visible), gaps: gapsFor(item) })) }
}
async function projectionFor(core, session) {
  return projection(session, await resultItems(core, session))
}

function installDelivery(core) {
  const exporting = new Set()
  function mutate(id, reason, fn) {
    if (core.withTaskLock) return core.withTaskLock(id, reason, fn)
    const end = core.beginOperation?.(id, reason)
    return Promise.resolve().then(fn).finally(() => end?.())
  }
  function save(root, registry, type, detail) {
    registry.revision++; registry.updatedAt = new Date().toISOString()
    registry.history.push({ at: registry.updatedAt, type, detail })
    atomicJson(path.join(root, 'delivery.json'), registry)
  }
  core.handlers.set('results', async ({ id }) => {
    const session = core.read(id)
    return projection(session, await resultItems(core, session))
  })
  core.handlers.set('resultsValidate', args => mutate(args.id, 'validate', async () => {
    const session = core.read(args.id), root = core.runDir(args.id)
    const scan = await resultItems(core, session), { registry, items } = scan
    if (core.isActive?.(args.id) || session.nodes.some(n => ['running', 'verifying'].includes(n.status))) throw new Error('Pause active execution before importing scientific evidence')
    const selected = items.filter(i => !args.itemId || i.id === args.itemId)
    if (!selected.length) throw new Error('Result item was not found')
    registry.analyses ||= {}
    for (const item of selected) {
      try {
        if (item.integrityIssues.length) throw new Error(item.integrityIssues[0])
        registry.analyses[item.id] = await require('./analysis.cjs').verifyAnalysis(core, session, item, { check: scan.checkDigest })
      } catch (error) {
        registry.analyses[item.id] = { status: 'unverified', issues: [error.message], verifiedAt: new Date().toISOString() }
      }
    }
    registry.finalized = undefined
    save(root, registry, 'analysis_validated', { items: selected.map(i => ({ itemId: i.id, record: registry.analyses[i.id] })) })
    return projection(session, await resultItems(core, core.read(args.id), { cache: scan.cache }))
  }))
  async function verificationPages(root, item, exportedRoot, cache) {
    const candidates = item.artifacts.filter(a => roleOf(a) === 'page' && /\.html?$/i.test(a.path))
    const current = candidates.filter(a => a.path.startsWith('delivery/'))
    const pages = []
    for (const a of current.length ? current : candidates) {
      const metadata = item.artifacts.find(b => b.path === path.posix.join(path.posix.dirname(a.path), 'archive.json'))
      const archive = metadata ? JSON.parse(await fsp.readFile(await checked(root, metadata, cache), 'utf8')) : item.archive
      const file = exportedRoot ? inside(exportedRoot, 'files/' + a.path) : await checked(root, a, cache)
      pages.push({ itemId: item.id, path: file, sha256: exportedRoot ? await hashFile(file) : a.sha256, baseline: archive?.baseline })
    }
    return pages
  }
  async function verifyItems(core, id, itemId, exportedRoot, prepared) {
    const session = core.read(id)
    const scan = prepared || await resultItems(core, session), root = scan.root, { registry, items } = scan
    const selected = items.filter(item => !itemId || item.id === itemId)
    if (itemId && !selected.length) throw new Error('Result item was not found')
    const results = []
    for (const item of selected) {
      const result = { itemId: item.id, fingerprint: itemFingerprint(item), verifiedAt: new Date().toISOString(), checks: {}, pages: [], issues: [] }
      try {
        if (item.integrityIssues.length) throw new Error(item.integrityIssues[0])
        if (item.kind === 'website') {
          try {
            const pages = await verificationPages(root, item, exportedRoot, scan.cache)
            if (!pages.length) {
              result.checks = { archive: 'not_saved', visual: 'unverified' }
              result.issues.push('Original HTML is missing')
            } else {
              const verified = await core.workerRequest({ command: 'delivery_verify', pages }).promise
              result.pages = verified.pages
              const state = verified.status === 'complete' ? 'complete' : verified.pages?.some(p => p.status === 'partial') ? 'partial' : 'unverified'
              result.checks = { archive: state, visual: state }
              result.issues.push(...(verified.pages || []).flatMap(p => p.issues || []))
            }
          } catch (error) {
            result.checks = { archive: 'partial', visual: 'unverified' }
            result.issues.push(error.message)
          }
        }
        const downloads = item.artifacts.filter(a => ['original_file', 'attachment', 'data'].includes(roleOf(a)))
        if (downloads.length) {
          const files = []
          for (const a of downloads) {
            if (exportedRoot) files.push({ path: inside(exportedRoot, 'files/' + a.path), sha256: a.sha256, kind: a.kind })
            else {
              const check = await scan.checkArtifact(a)
              if (!check.ok) throw new Error(check.error)
              files.push({ path: check.file, sha256: a.sha256, kind: a.kind })
            }
          }
          const checkedDownloads = await core.workerRequest({ command: 'verify_downloads', files }, 'local').promise
          result.checks.downloads = checkedDownloads.status
          result.issues.push(...checkedDownloads.issues)
        } else result.checks.downloads = item.attachmentInventory.status === 'not_required' ? 'not_required' : 'unverified'
        if (item.attachmentInventory.issues.length) {
          result.checks.downloads = item.attachmentInventory.status
          result.issues.push(...item.attachmentInventory.issues)
        }
      } catch (error) {
        result.checks = { ...(item.kind === 'website' ? { archive: 'partial', visual: 'unverified' } : {}), downloads: 'unverified' }
        result.issues.push(error.message)
      }
      results.push(result)
    }
    if (!exportedRoot) {
      registry.verifications ||= {}
      for (const result of results) registry.verifications[result.itemId] = result
      registry.finalized = undefined
      save(root, registry, 'verified', { items: results })
    }
    return { status: results.length && results.every(r => !r.issues.length && Object.values(r.checks).every(s => ['complete', 'not_applicable', 'not_required'].includes(s))) ? 'complete' : 'partial', items: results }
  }
  core.handlers.set('resultsVerify', args => mutate(args.id, 'verify', async () => {
    const scan = await resultItems(core, core.read(args.id))
    const outcome = await verifyItems(core, args.id, args.itemId, undefined, scan)
    const session = core.read(args.id)
    return { ...outcome, results: projection(session, await resultItems(core, session, { cache: scan.cache })) }
  }))
  core.handlers.set('resultsRegister', args => mutate(args.id, 'register', async () => {
    const session = core.read(args.id), root = core.runDir(args.id), registry = await readRegistry(root)
    if (!ID.test(args.itemId) || !args.name || !['website', 'local', 'attachment'].includes(args.kind)) throw new Error('Provide itemId, name and kind (website/local/attachment)')
    if (args.sourceUrl) {
      const url = new URL(args.sourceUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid original source URL')
    }
    const allInputs = [...Object.values(session.input || {}), ...session.nodes.flatMap(n => n.artifacts || [])]
    if (args.inputSha256 && !allInputs.some(a => a.sha256 === args.inputSha256) && !args.sourceTaskId) throw new Error('Input fingerprint is not registered in the original task')
    if (!Array.isArray(args.files) || args.files.length > 3000) throw new Error('files must be an array with at most 3000 entries')
    const staged = []
    let totalBytes = 0
    const sources = []
    for (const entry of args.files) {
      if (typeof entry.path !== 'string') throw new Error('Each file requires a path')
      const source = path.isAbsolute(entry.path) ? await fsp.realpath(entry.path) : inside(root, entry.path)
      const stat = await fsp.stat(source)
      totalBytes += stat.size
      if (!stat.isFile() || !stat.size || totalBytes > 256 * 1024 * 1024) throw new Error('Empty, oversized or non-file artifact (256 MiB total limit)')
      const data = await fsp.readFile(source), digest = hash(data)
      if (entry.sha256 && entry.sha256 !== digest) throw new Error('Import checksum mismatch')
      sources.push({ entry, source, data, digest, relative: entry.relativePath || path.basename(source) })
    }
    const batchHash = hash(sources.map(s => s.digest + ':' + s.relative).join('\0'))
    const bucket = `delivery/files/${args.itemId}/${batchHash.slice(0, 16)}`
    const bucketRoot = inside(root, bucket)
    // Validate containment before any file is copied. The bucket is never an
    // execution path; imports cannot replace original session/input evidence.
    await fsp.mkdir(bucketRoot, { recursive: true })
    for (const { entry, source, data, digest, relative } of sources) {
      const destination = inside(bucketRoot, relative)
      const rel = path.relative(root, destination).split(path.sep).join('/')
      const role = roleOf({ path: rel, role: entry.role })
      if (!['page', 'figure', 'data', 'original_file', 'attachment', 'internal', 'resource'].includes(role)) throw new Error('Unknown artifact role')
      staged.push({ source, data, destination, artifact: { path: rel, name: path.basename(relative), role, kind: 'report', sha256: digest, bytes: data.length, verified: true, producer: args.itemId, sourceUrl: args.sourceUrl } })
    }
    if (new Set(staged.map(s => s.destination)).size !== staged.length) throw new Error('Duplicate destination paths')
    let analysis = 'unverified', proof
    if (args.sourceTaskId || args.sourceNodeId) {
      const source = core.read(args.sourceTaskId || args.id), run = source.nodes.find(n => n.id === args.sourceNodeId)
      if (!run || run.status !== 'succeeded' || !run.evidence?.verified) throw new Error('Source task has no verified successful node')
      const sourceDefinition = source.workflow.nodes.find(n => n.id === run.id), targetDefinition = session.workflow.nodes.find(n => n.id === args.itemId)
      if (!sourceDefinition || (args.kind === 'website') !== (sourceDefinition.kind === 'site') || targetDefinition && (targetDefinition.kind !== sourceDefinition.kind || targetDefinition.siteId !== sourceDefinition.siteId || targetDefinition.tool !== sourceDefinition.tool)) throw new Error('Source executor does not match the delivered analysis')
      const bound = artifactFor(source, sourceDefinition)
      if (!bound) throw new Error('Source task bound input is missing')
      await checked(core.runDir(source.id), bound)
      const inputHash = run.evidence.inputSha256 || run.checkpoint?.inputSha256 || bound.sha256
      if (!args.inputSha256 || inputHash !== args.inputSha256) throw new Error('Source task input fingerprint does not match')
      if (targetDefinition?.input) {
        const targetInput = artifactFor(session, targetDefinition)
        if (!targetInput) throw new Error('Target task bound input is missing')
        await checked(root, targetInput)
        if (targetInput.sha256 !== inputHash || require('./analysis.cjs').fingerprint(targetDefinition.parameters || {}) !== require('./analysis.cjs').fingerprint(sourceDefinition.parameters || {})) throw new Error('Source proof differs from target input or parameters')
      }
      if (!staged.length || staged.some(s => !run.artifacts.some(a => a.sha256 === s.artifact.sha256))) throw new Error('Imported files are not the source node artifacts')
      for (const a of run.artifacts) await checked(core.runDir(source.id), a)
      analysis = 'verified'; proof = { taskId: source.id, nodeId: run.id, inputSha256: inputHash }
    }
    for (const s of staged) {
      try {
        const stat = await fsp.stat(s.destination)
        if (stat.isFile() && await hashFile(s.destination) !== s.artifact.sha256) throw new Error('An earlier import owns this path; use another item revision')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    for (const s of staged) {
      await fsp.mkdir(path.dirname(s.destination), { recursive: true })
      try { await fsp.writeFile(s.destination, s.data, { flag: 'wx' }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    // Neither agent assertions nor a file hash certify scientific correctness.
    const item = { id: args.itemId, nodeId: session.nodes.some(n => n.id === args.itemId) ? args.itemId : undefined,
      name: String(args.name).slice(0, 240), kind: args.kind, sourceUrl: args.sourceUrl, inputSha256: args.inputSha256,
      capturedAt: args.capturedAt, registeredAt: new Date().toISOString(), message: String(args.message || '').slice(0, 3000), unavailable: !staged.length,
      artifacts: staged.map(s => s.artifact), proof, checks: { analysis, visual: args.kind === 'website' ? 'unverified' : 'not_applicable',
        archive: args.kind === 'website' ? (staged.some(s => roleOf(s.artifact) === 'page') ? 'unverified' : 'not_saved') : 'not_applicable',
        downloads: staged.length ? 'unverified' : 'not_saved' } }
    if (proof) {
      const source = core.read(proof.taskId), run = source.nodes.find(n => n.id === proof.nodeId)
      item.checks.visual = run.completeness?.visual || (args.kind === 'website' ? 'unverified' : 'not_applicable')
      item.checks.archive = args.kind === 'website' ? run.archive?.status || 'unverified' : 'not_applicable'
      item.checks.downloads = run.completeness?.downloads || 'unverified'
    }
    const prior = registry.items.findIndex(i => i.id === item.id)
    if (prior >= 0 && JSON.stringify({ ...registry.items[prior], registeredAt: undefined }) === JSON.stringify({ ...item, registeredAt: undefined })) return projection(session, await resultItems(core, session))
    if (prior >= 0) registry.items[prior] = item; else registry.items.push(item)
    if (registry.analyses) delete registry.analyses[item.id]
    registry.finalized = undefined
    save(root, registry, 'registered', { itemId: item.id, files: item.artifacts.length, analysis, item })
    return projection(session, await resultItems(core, core.read(args.id)))
  }))
  function pages(items, root, itemId, artifactPath) {
    return items.filter(i => !itemId || i.id === itemId).flatMap(item => {
      const candidates = item.artifacts.filter(a => roleOf(a) === 'page' && (artifactPath ? /\.(?:html?|mhtml)$/i.test(a.path) && a.path === artifactPath : /\.html?$/i.test(a.path)))
      // Prefer the current registered archive; the execution archive remains in history.
      const current = candidates.filter(a => a.path.startsWith('delivery/'))
      return (current.length ? current : candidates).map(a => ({ itemId: item.id, key: a.path, path: inside(root, a.path), sha256: a.sha256 }))
    })
  }
  async function open(args, prepared) {
    const session = core.read(args.id), scan = prepared || await resultItems(core, session), root = scan.root
    const candidates = pages(scan.items, root, args.itemId, args.artifactPath), failed = []
    let opened = 0
    for (const page of candidates) {
      try {
        const item = scan.items.find(i => i.id === page.itemId)
        const artifact = item.artifacts.find(a => a.path === page.key)
        if (!/\.html?$/i.test(artifact.path)) throw new Error('请打开 HTML 存档；MHTML 可另存后手动查看。 / Open the HTML archive instead.')
        await checked(root, artifact, scan.cache)
        const view = await require('./offline-view.cjs').prepareView(root, item, artifact)
        await (core.openSystem || require('./system-open.cjs').openSystem)(view, { browser: true })
        opened++
      } catch (error) { failed.push({ itemId: page.itemId, message: error.message }) }
    }
    return { opened, total: candidates.length, failed, mode: 'system',
      message: candidates.length ? '已交给浏览器打开 / Requests accepted by the system browser' : '没有已保存的 HTML 网页 / No saved HTML pages' }
  }
  core.handlers.set('resultsOpenAll', args => mutate(args.id, 'open', async () => open(args)))
  core.handlers.set('resultsFinalize', args => mutate(args.id, 'finalize', async () => {
    const session = core.read(args.id), scan = await resultItems(core, session), { registry, items } = scan
    const expected = args.expected || registry.expected || items.map(i => ({ id: i.id, name: i.name }))
    if (!Array.isArray(expected) || !expected.length || expected.some(e => !ID.test(e.id)) || new Set(expected.map(e => e.id)).size !== expected.length) throw new Error('expected must contain unique item IDs')
    for (const item of items) item.name = expected.find(e => e.id === item.id)?.name || item.name
    const gaps = expected.flatMap(e => {
      const item = items.find(i => i.id === e.id)
      return (item ? gapsFor(item) : ['缺少交付记录 / Missing delivery record']).map(message => ({ itemId: e.id, name: e.name || item?.name || e.id, message }))
    })
    for (const item of items) if (item.integrityIssues.length) throw new Error(item.integrityIssues[0])
    const fingerprint = hash(JSON.stringify({ expected, items }))
    if (registry.finalized?.fingerprint !== fingerprint) {
      registry.expected = expected
      registry.finalized = { version: (registry.finalized?.version || registry.history.filter(h => h.type === 'finalized').length) + 1,
        at: new Date().toISOString(), fingerprint, status: gaps.length ? 'partial' : 'complete', expected: expected.length,
        recorded: expected.filter(e => items.some(i => i.id === e.id)).length, gaps }
      save(scan.root, registry, 'finalized', registry.finalized)
    }
    const opened = args.open === false ? undefined : await open(args, scan)
    return { ...projection(session, scan), opened }
  }))
  core.handlers.set('thumbnail', async ({ id, artifactPath }) => {
    const session = core.read(id), scan = await resultItems(core, session)
    const a = scan.items.flatMap(i => i.artifacts).find(a => a.path === artifactPath)
    if (!a || !/\.(?:png|jpe?g|webp)$/i.test(a.path) || a.bytes > 12 * 1024 * 1024) throw new Error('Thumbnail is not a registered raster image')
    const data = await fsp.readFile(await checked(scan.root, a, scan.cache)), mime = /\.png$/i.test(a.path) ? 'image/png' : /\.webp$/i.test(a.path) ? 'image/webp' : 'image/jpeg'
    return { url: `data:${mime};base64,${data.toString('base64')}` }
  })
  const originalOpen = core.handlers.get('openResult')
  core.handlers.set('openResult', async args => {
    const session = core.read(args.id), scan = await resultItems(core, session)
    if (args.online) {
      const item = scan.items.find(i => i.id === (args.itemId || args.nodeId))
      if (!item) throw new Error('Result item was not found')
      if (item.nodeId) return originalOpen({ ...args, nodeId: item.nodeId, offline: false })
      if (!item.sourceUrl) throw new Error('No original website URL is registered')
      const url = new URL(item.sourceUrl)
      await core.workerRequest({ command: 'open_result', url: url.href, allowedHosts: [url.hostname] }).promise
      return { opened: 'official_url', url: url.href }
    }
    const a = args.artifactPath && scan.items.flatMap(i => i.artifacts).find(a => a.path === args.artifactPath && visible(a))
    if (args.artifactPath && !a) throw new Error('File is not a registered deliverable')
    if (!args.artifactPath || roleOf(a) === 'page') return mutate(args.id, 'open', () => open({ ...args, itemId: args.itemId || args.nodeId }, scan))
    await require('./results.cjs').openLocal(await checked(scan.root, a, scan.cache)); return { opened: 'file' }
  })
  core.handlers.set('export', async ({ id }) => {
    if (exporting.has(id)) throw new Error('该任务正在导出，请等待完成 / This task is already being exported')
    exporting.add(id)
    try {
      return await mutate(id, 'export', async () => {
        const session = core.read(id), scan = await resultItems(core, session), { registry, items } = scan, root = scan.root
        const deliverable = items.flatMap(i => i.artifacts).filter(a => roleOf(a) !== 'internal')
        for (const a of deliverable) {
          const check = await scan.checkArtifact(a)
          if (!check.ok) throw new Error(check.error)
        }
        const deliveriesRoot = path.join(root, 'deliveries')
        await fsp.mkdir(deliveriesRoot, { recursive: true })
        const output = await fsp.mkdtemp(path.join(deliveriesRoot, '.export-'))
        let published
        try {
          for (const a of deliverable) {
            const source = await checked(root, a, scan.cache)
            const dest = inside(output, 'files/' + a.path)
            await fsp.mkdir(path.dirname(dest), { recursive: true })
            if (/\.html?$/i.test(a.path)) {
              const data = await fsp.readFile(source)
              if (hash(data) !== a.sha256) throw new Error('Saved artifact changed: ' + a.path)
              const original = data.toString('utf8')
              const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; style-src 'self' file: data: 'unsafe-inline'; font-src 'self' file: data:; frame-src 'self' file: data:; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">`
              await fsp.writeFile(dest, /<head(?:\s[^>]*)?>/i.test(original) ? original.replace(/<head(?:\s[^>]*)?>/i, match => match + policy) : policy + original)
            } else await copyVerified(source, dest, a.sha256)
          }
          const sections = items.map(item => `<section><h2>${esc(item.name)}</h2><p>${esc(item.capturedAt || item.registeredAt || '')}</p>${item.sourceUrl ? `<a href="${esc(item.sourceUrl)}">在线原站 / Original website</a>` : ''}<ul>${item.artifacts.filter(visible).map(a => `<li><a href="${href('files/' + a.path)}">${esc(a.name)}</a></li>`).join('')}</ul><p>${esc(item.message)}</p><ul>${gapsFor(item).map(gap => `<li>${esc(gap)}</li>`).join('')}</ul></section>`).join('')
          const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(session.name)}</title><style>body{font:16px/1.7 system-ui;max-width:1000px;margin:40px auto;padding:0 24px;background:#fafaf7;color:#203d36}section{border-top:1px solid #ccc;padding:20px 0}a{color:#176e59}p{overflow-wrap:anywhere}</style><h1>${esc(session.name)}</h1><p>交付状态 / Delivery: ${esc(registry.finalized?.status || 'unverified')} · ${esc(new Date().toISOString())}</p>${sections}</html>`
          const file = path.join(output, 'index.html')
          await fsp.writeFile(file, html)
          // Export only copies and checks saved files. Browser/Python validation
          // remains an explicit action; unavailable runtimes must not delay export.
          const verification = { status: 'not_run', items: [] }
          const previousVerification = { scope: 'saved_results', items: items
            .filter(item => !item.integrityIssues.length && item.verification?.fingerprint === itemFingerprint(item))
            .map(item => ({ ...item.verification, itemId: item.id })) }
          atomicJson(path.join(output, 'acceptance.json'), { ...projection(session, scan), exportedAt: new Date().toISOString(), offlineVerification: verification, previousVerification })
          const directory = path.join(root, 'deliveries', `export-${Date.now()}-${registry.revision}`)
          await fsp.rename(output, directory)
          published = directory
          return { path: path.join(directory, 'index.html'), index: path.join(directory, 'index.html'), directory, items: items.length, verification,
            gaps: items.flatMap(item => gapsFor(item).map(message => ({ itemId: item.id, message }))) }
        } finally {
          if (!published) await fsp.rm(output, { recursive: true, force: true }).catch(() => {})
        }
      })
    } finally { exporting.delete(id) }
  })
  return { projection: async id => projectionFor(core, core.read(id)), pages }
}
module.exports = { installDelivery, roleOf, visible, loadRegistry, resultItems, gapsFor, checked, projection, clearScanCache, verifiedFile }

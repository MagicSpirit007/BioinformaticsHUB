'use strict'
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { hash, inside, artifactFor } = require('./model.cjs')
const { hashFile } = require('./integrity.cjs')

const canonical = value => value == null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
const fingerprint = value => hash(JSON.stringify(canonical(value)))
async function contextFor(core, session, item, options = {}) {
  const check = options.check || (async (file, expected) => {
    const digest = await hashFile(file)
    if (digest !== expected) throw new Error('Bound input or upstream result changed')
    return digest
  })
  const node = session.workflow.nodes.find(n => n.id === (item.nodeId || item.id))
  if (!node) throw new Error('Scientific verification requires an original workflow node')
  const input = artifactFor(session, node)
  if (!input?.path) throw new Error('Bound input is missing')
  const file = inside(core.runDir(session.id), input.path)
  await check(file, input.sha256)
  const executor = node.kind === 'site' ? node.siteId : node.tool
  const validators = []
  for (const name of ['analysis_verifiers.py', 'artifacts.py']) {
    const file = path.join(core.paths.engineRoot(), 'scripts/workflow', name)
    validators.push([name, await hashFile(file)])
  }
  const validatorVersion = fingerprint(validators)
  const recipe = session.recipeSnapshot?.[node.id]
  const ancestors = [], seen = new Set()
  async function lineage(definition) {
    for (const id of definition.dependsOn || []) {
      if (seen.has(id)) continue
      seen.add(id)
      const parent = session.workflow.nodes.find(n => n.id === id)
      if (!parent) throw new Error('Missing upstream definition')
      const run = session.nodes.find(n => n.id === id)
      const bound = artifactFor(session, parent)
      if (!bound?.path) throw new Error('Upstream input is missing')
      await check(inside(core.runDir(session.id), bound.path), bound.sha256)
      const artifacts = []
      for (const a of run?.artifacts || []) {
        await check(inside(core.runDir(session.id), a.path), a.sha256)
        artifacts.push([a.path, a.sha256])
      }
      ancestors.push({ node: parent, inputSha256: bound.sha256, artifacts })
      await lineage(parent)
    }
  }
  await lineage(node)
  return { node, input: { ...input, path: file }, executor, validatorVersion,
    fingerprint: fingerprint({ node, input: { path: input.path, sha256: input.sha256, kind: input.kind }, recipe, ancestors,
      validatorVersion, artifacts: item.artifacts.map(a => [a.path, a.sha256, a.role, a.kind]).sort((a, b) => a[0].localeCompare(b[0])) }) }
}
async function ownedDownloadMatches(root, nodeId, files, run, inputSha256) {
  if (!run?.checkpoint?.inputVerified || run.checkpoint.inputSha256 !== inputSha256) return false
  const nodeRoot = inside(root, 'nodes/' + nodeId)
  if (!fs.existsSync(nodeRoot)) return false
  const wanted = files.filter(a => /\.zip$/i.test(a.path)).map(a => a.sha256)
  if (!wanted.length) return false
  async function walk(dir, depth = 0) {
    if (depth > 4) return false
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (await walk(file, depth + 1)) return true }
      else if (/\.zip$/i.test(entry.name) && wanted.includes(await hashFile(file))) return true
    }
    return false
  }
  return walk(nodeRoot)
}
async function verifyAnalysis(core, session, item, options = {}) {
  const check = options.check || (async (file, expected) => {
    const digest = await hashFile(file)
    if (digest !== expected) throw new Error('Bound input or upstream result changed')
    return digest
  })
  const context = await contextFor(core, session, item, { check })
  const files = item.artifacts.filter(a => ['data', 'original_file', 'attachment'].includes(a.role))
  const run = session.nodes.find(n => n.id === context.node.id)
  const native = context.node.kind === 'local' && run?.status === 'succeeded' && run.evidence?.verified &&
    run.evidence.inputSha256 === context.input.sha256 && run.evidence.parametersSha256 === fingerprint(context.node.parameters || {}) &&
    item.artifacts.length === run.artifacts.length && item.artifacts.every(a => run.artifacts.some(b => b.path === a.path && b.sha256 === a.sha256))
  if (native) return { status: 'verified', validatorId: 'native-local-producer', facts: { method: run.evidence.method }, issues: [],
    fingerprint: context.fingerprint, validatorVersion: context.validatorVersion, inputSha256: context.input.sha256,
    parametersSha256: fingerprint(context.node.parameters || {}), verifiedAt: new Date().toISOString() }
  const owned = await ownedDownloadMatches(core.runDir(session.id), context.node.id, files, run, context.input.sha256)
  const result = await core.workerRequest({ command: 'analysis_verify', executor: context.executor, input: context.input,
    parameters: context.node.parameters || {}, files: files.map(a => ({ ...a, path: inside(core.runDir(session.id), a.path) })),
    context: { inputVerified: run?.checkpoint?.inputVerified && run.checkpoint.inputSha256 === context.input.sha256,
      ownedDownloadMatches: owned } }, 'local').promise
  return { ...result, fingerprint: context.fingerprint, validatorVersion: context.validatorVersion,
    inputSha256: context.input.sha256, parametersSha256: fingerprint(context.node.parameters || {}), verifiedAt: new Date().toISOString() }
}
module.exports = { fingerprint, contextFor, verifyAnalysis }

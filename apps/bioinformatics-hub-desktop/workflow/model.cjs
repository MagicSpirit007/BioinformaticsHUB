'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'blocked'])
const LOCAL = {
  prepare: { input: 'sequence', outputs: ['protein_fasta', 'nucleotide_fasta'] },
  nucleic: { input: 'nucleotide_fasta', outputs: ['report'] },
  physchem: { input: 'protein_fasta', outputs: ['report'] },
  hydrophobicity: { input: 'protein_fasta', outputs: ['report'] },
  mafft: { input: 'alignment_fasta', outputs: ['alignment_fasta', 'report'], parameters: [{ id: 'strategy', label: '比对策略 / Alignment strategy', options: ['auto'], default: 'auto' }] },
  weblogo: { input: 'alignment_fasta', outputs: ['report'] },
  iqtree: { input: 'alignment_fasta', outputs: ['tree', 'report'], parameters: [
    { id: 'model', label: '替换模型 / Substitution model', options: ['MFP', 'LG+G', 'JTT+G', 'WAG+G', 'GTR+G'], default: 'MFP' },
    { id: 'bootstrap', label: 'UFBoot 次数 / Replicates', options: ['1000', '2000', '5000'], default: '1000' },
    { id: 'threads', label: '线程数 / Threads', options: ['1', '2', '4', '8'], default: '2' },
  ] },
  itol: { input: 'tree', outputs: ['report'] },
}
const INPUT_KINDS = new Set(['sequence', 'protein_fasta', 'nucleotide_fasta', 'alignment_fasta', 'tree', 'structure', 'identifier'])
const clone = value => JSON.parse(JSON.stringify(value))
const hash = value => crypto.createHash('sha256').update(value).digest('hex')

function inside(root, name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name)) throw new Error('Invalid artifact path')
  const resolved = path.resolve(root, name)
  const rel = path.relative(path.resolve(root), resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Artifact path escapes run')
  // Existing parents must not redirect through junctions or symlinks.
  let cursor = resolved
  while (!fs.existsSync(cursor)) cursor = path.dirname(cursor)
  const realRoot = fs.realpathSync(root)
  const realParent = fs.realpathSync(cursor)
  const realRel = path.relative(realRoot, realParent)
  if (realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) throw new Error('Artifact symlink escapes run')
  return resolved
}

function httpUrl(raw) {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected HTTP(S) URL without credentials')
  return url
}

function definitionFor(node, recipes) {
  if (node.kind === 'local') return LOCAL[node.tool]
  if (node.kind !== 'site') return null
  if (node.custom) return { input: node.inputKind, outputs: [], parameters: [], allowedHosts: [httpUrl(node.entryUrl).hostname], goal: node.goal, experimental: true }
  return recipes[node.siteId]
}

function validateWorkflow(workflow, inputs, recipes) {
  const errors = []
  if (!workflow || workflow.version !== 1 || !Array.isArray(workflow.nodes) || !workflow.nodes.length || workflow.nodes.length > 80) return ['Workflow must contain 1–80 nodes (version 1)']
  if (!inputs || typeof inputs !== 'object') return ['Inputs are required']
  const nodes = new Map()
  for (const node of workflow.nodes) {
    if (!ID.test(node.id) || nodes.has(node.id)) errors.push(`Invalid or duplicate node: ${node.id}`)
    nodes.set(node.id, node)
  }
  for (const node of workflow.nodes) {
    let def
    try { def = definitionFor(node, recipes) } catch (e) { errors.push(`${node.id}: ${e.message}`) }
    if (!def) { errors.push(`${node.id}: unknown executor`); continue }
    if (node.custom && (!node.goal?.trim() || !INPUT_KINDS.has(node.inputKind))) errors.push(`${node.id}: custom site requires a goal and input type`)
    if (!Array.isArray(node.dependsOn)) { errors.push(`${node.id}: dependsOn must be an array`); continue }
    for (const dep of node.dependsOn) if (!nodes.has(dep) || dep === node.id) errors.push(`${node.id}: invalid dependency ${dep}`)
    const binding = node.input
    if (!binding || !['input', 'node'].includes(binding.source)) { errors.push(`${node.id}: select an input binding`); continue }
    if (binding.source === 'input') {
      const artifact = inputs[binding.key]
      if (!artifact?.value?.trim()) errors.push(`${node.id}: missing input ${binding.key}`)
      else if (artifact.kind !== def.input && !(def.input === 'sequence' && ['protein_fasta', 'nucleotide_fasta'].includes(artifact.kind))) errors.push(`${node.id}: expected ${def.input}, received ${artifact.kind}`)
    } else {
      const upstream = nodes.get(binding.nodeId)
      let producer
      try { producer = upstream && definitionFor(upstream, recipes) } catch { /* reported elsewhere */ }
      if (!producer || !node.dependsOn.includes(binding.nodeId)) errors.push(`${node.id}: input producer must be a dependency`)
      else if (upstream.custom || !producer.outputs.includes(binding.kind) || binding.kind !== def.input) errors.push(`${node.id}: incompatible or unverified upstream output`)
    }
    for (const parameter of def.parameters || []) {
      const value = node.parameters?.[parameter.id]
      if (parameter.required && (value == null || String(value).trim() === '')) errors.push(`${node.id}: required parameter ${parameter.label}`)
      if (value != null && parameter.options && !parameter.options.includes(String(value))) errors.push(`${node.id}: invalid ${parameter.id}`)
    }
    const limits = node.limits || {}
    for (const [key, min, max] of [['maxActions', 1, 600], ['maxDecisions', 1, 1200], ['waitHours', 1, 168]]) {
      if (limits[key] != null && (!Number.isInteger(limits[key]) || limits[key] < min || limits[key] > max)) errors.push(`${node.id}: invalid ${key}`)
    }
  }
  const visiting = new Set(), visited = new Set()
  function visit(id) {
    if (visiting.has(id)) { errors.push('Workflow contains a dependency cycle'); return }
    if (visited.has(id)) return
    visiting.add(id)
    for (const dep of nodes.get(id)?.dependsOn || []) if (nodes.has(dep)) visit(dep)
    visiting.delete(id); visited.add(id)
  }
  for (const id of nodes.keys()) visit(id)
  return [...new Set(errors)]
}

function createSession(id, workflow, inputs, recipes, now = Date.now()) {
  workflow = clone(workflow)
  for (const node of workflow.nodes || []) {
    const def = definitionFor(node, recipes)
    node.parameters = { ...Object.fromEntries((def?.parameters || []).filter(p => p.default != null).map(p => [p.id, p.default])), ...node.parameters }
  }
  const errors = validateWorkflow(workflow, inputs, recipes)
  if (errors.length) throw new Error(errors.join('\n'))
  const recipeSnapshot = {}
  for (const node of workflow.nodes) if (node.kind === 'site') recipeSnapshot[node.id] = clone(definitionFor(node, recipes))
  return { schemaVersion: 2, version: '0.7.0', id, sessionId: id, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), status: 'running', sequence: 0, workflow: clone(workflow), recipeSnapshot, input: clone(inputs), nodes: workflow.nodes.map(n => ({ id: n.id, status: 'ready', attempts: 0, artifacts: [], checkpoint: {}, nextPollAt: 0 })), sites: [], localTools: [] }
}

function artifactFor(session, node) {
  if (node.input.source === 'input') return session.input[node.input.key]
  const upstream = session.nodes.find(n => n.id === node.input.nodeId)
  if (upstream?.status !== 'succeeded') throw new Error('Upstream has not been verified')
  const matches = upstream.artifacts.filter(a => a.kind === node.input.kind && a.verified)
  if (matches.length !== 1) throw new Error('Upstream output is missing or ambiguous; select a unique artifact')
  return matches[0]
}

module.exports = { ID, LOCAL, TERMINAL, INPUT_KINDS, clone, hash, inside, httpUrl, definitionFor, validateWorkflow, createSession, artifactFor }

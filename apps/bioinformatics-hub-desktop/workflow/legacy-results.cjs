'use strict'
// Read-only compatibility projection. The historical file is never migrated or
// certified merely because an old UI called it complete.
const fs = require('node:fs')
const path = require('node:path')
const { inside, hash, ID } = require('./model.cjs')
const { platformPath } = require('./runtime.cjs')
function legacySession(root, raw, id) {
  if (raw.schemaVersion === 2 || !Array.isArray(raw.sites) && !Array.isArray(raw.localTools)) throw new Error('Not a recognized historical task')
  const nodes = [], definitions = [], recipes = {}
  function add(record, kind, index) {
    let key = String(record.id || record.siteId || record.toolId || `legacy-${kind}-${index}`).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)
    if (!ID.test(key) || nodes.some(n => n.id === key)) key = `legacy-${kind}-${index}`
    const artifacts = []
    for (const a of record.artifacts || []) {
      try {
        const candidate = platformPath(a.path)
        const relative = path.isAbsolute(candidate) ? path.relative(root, candidate) : candidate
        const file = inside(root, relative), data = fs.readFileSync(file)
        if (!data.length) continue
        artifacts.push({ path: relative.split(path.sep).join('/'), name: a.name || path.basename(file), kind: 'report', bytes: data.length, sha256: hash(data), verified: true, producer: key })
      } catch { /* A missing or uncontained old file remains absent, never fabricated. */ }
    }
    let resultUrl
    try { const url = new URL(record.resultUrl); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) resultUrl = url.href } catch {}
    if (resultUrl) recipes[key] = { name: record.name || key, entryUrl: record.entryUrl || resultUrl, allowedHosts: [new URL(resultUrl).hostname], lookup: true }
    definitions.push({ id: key, kind, ...(kind === 'site' ? { siteId: record.siteId || key } : { tool: record.toolId || key }), dependsOn: [], input: { source: 'input', key: 'legacy' }, parameters: {} })
    nodes.push({ id: key, status: record.status || 'unverified', message: record.message || record.notes || 'Historical result; independent verification is unavailable', artifacts, resultUrl, checkpoint: {}, attempts: 0 })
  }
  ;(raw.sites || []).forEach((r, i) => add(r, 'site', i))
  ;(raw.localTools || []).forEach((r, i) => add(r, 'local', i))
  return { schemaVersion: 2, readOnlyLegacy: true, id, sessionId: id, name: raw.alias || raw.geneId || raw.input?.geneId || id,
    status: raw.status || 'unverified', sequence: 0, updatedAt: raw.updatedAt || raw.createdAt || fs.statSync(path.join(root, 'session.json')).mtime.toISOString(),
    input: {}, nodes, recipeSnapshot: recipes, workflow: { id: 'legacy-view', version: 1, name: 'Historical task', nodes: definitions } }
}
module.exports = { legacySession }

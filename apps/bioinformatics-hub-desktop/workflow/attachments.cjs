'use strict'
const fs = require('node:fs')
const path = require('node:path')
const manifests = new Map()
function definitions(root) {
  const file = path.join(root, 'scripts/workflow/attachment-manifests.json')
  if (!manifests.has(file)) manifests.set(file, JSON.parse(fs.readFileSync(file, 'utf8')))
  return manifests.get(file)
}
function inventory(core, session, item) {
  const node = session.workflow.nodes.find(n => n.id === (item.nodeId || item.id))
  const expected = node?.kind === 'local' ? [] : definitions(core.paths.engineRoot()).sites[node?.siteId]
  if (!expected) return { status: 'unverified', version: definitions(core.paths.engineRoot()).version, items: [], issues: ['Expected attachment inventory is not declared'] }
  const candidates = item.artifacts.filter(a => ['data', 'attachment', 'original_file', 'figure'].includes(a.role))
  const items = expected.map(def => {
    const matches = candidates.filter(a => new RegExp(def.pattern, 'i').test(a.name || path.basename(a.path)))
    return { id: def.id, required: def.required, state: matches.length ? 'downloaded' : 'missing', files: matches.map(a => a.path) }
  })
  const issues = items.filter(i => i.required && i.state === 'missing').map(i => 'Required attachment missing: ' + i.id)
  return { status: issues.length ? 'partial' : items.length ? 'complete' : 'not_required', version: definitions(core.paths.engineRoot()).version, items, issues }
}
module.exports = { inventory }

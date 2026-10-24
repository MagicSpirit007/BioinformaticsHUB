'use strict'
const fsp = require('node:fs/promises')
const path = require('node:path')
const { inside, hash } = require('./model.cjs')
const POLICY = "default-src 'none'; img-src 'self' file: data:; style-src 'self' file: data: 'unsafe-inline'; font-src 'self' file: data:; frame-src 'self' file:; script-src 'none'; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
function staticHtml(html) {
  // The policy precedes all original content, including scripts before <head>.
  // Remove refresh directives and base URLs from browser-generated snapshots.
  const tags = /<(?:meta|base)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi
  const content = html.replace(tags, tag => /^<base\b/i.test(tag) || /http-equiv/i.test(tag) ? '' : tag)
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}">\n${content}`
}
async function prepareView(root, item, artifact) {
  // Preserve the complete registered relative layout; never copy unregistered
  // neighbours or change evidence. Content-derived buckets can be regenerated.
  const files = item.artifacts.filter(a => a.role !== 'internal')
  const fingerprint = hash(JSON.stringify(files.map(a => [a.path, a.sha256]).sort()) + POLICY + ':2')
  const bucket = inside(root, `delivery/views/${fingerprint}`)
  await fsp.mkdir(bucket, { recursive: true })
  for (const a of files) {
    const source = inside(root, a.path), data = await fsp.readFile(source)
    if (hash(data) !== a.sha256) throw new Error('Saved artifact changed: ' + a.path)
    const dest = inside(bucket, a.path)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.writeFile(dest, /\.html?$/i.test(a.path) ? staticHtml(data.toString('utf8')) : data)
  }
  return inside(bucket, artifact.path)
}
module.exports = { staticHtml, prepareView }

'use strict'
// Byte-level result integrity helpers. The daemon is single-threaded, so every
// read/compare/copy used by result projection and export is asynchronous.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { Transform } = require('node:stream')
const { inside } = require('./model.cjs')

const FILE_CACHE_LIMIT = 8192
const fileDigests = new Map()

function cacheKey(file) { return process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file) }
function statSignature(stat) { return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}` }
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', chunk => digest.update(chunk))
    stream.on('end', () => resolve(digest.digest('hex')))
  })
}
// Stat-keyed digest cache absorbs the UI polling loop without skipping the
// integrity check: any write/rename changes at least one signature component.
async function verifiedFile(file, expected, cache = fileDigests) {
  const stat = await fsp.stat(file)
  if (!stat.isFile()) throw new Error('Saved file is not a regular file: ' + file)
  const key = cacheKey(file), signature = statSignature(stat), prior = cache.get(key)
  if (prior && prior.signature === signature && prior.sha256 === expected) return expected
  const digest = await hashFile(file)
  if (digest !== expected) { cache.delete(key); throw new Error('Saved artifact changed: ' + file) }
  cache.set(key, { signature, sha256: digest })
  while (cache.size > FILE_CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return digest
}
function clearScanCache(root) {
  const prefix = cacheKey(root) + path.sep
  for (const key of fileDigests.keys()) if (key.startsWith(prefix)) fileDigests.delete(key)
}
async function checked(root, artifact, cache = fileDigests) {
  const file = inside(root, artifact.path)
  await verifiedFile(file, artifact.sha256, cache)
  return file
}
async function copyVerified(source, destination, expected) {
  const digest = crypto.createHash('sha256')
  const hasher = new Transform({ transform(chunk, _encoding, callback) { digest.update(chunk); callback(null, chunk) } })
  await pipeline(fs.createReadStream(source), hasher, fs.createWriteStream(destination, { flags: 'wx' }))
  if (digest.digest('hex') !== expected) throw new Error('Saved artifact changed during export: ' + path.basename(source))
}
module.exports = { FILE_CACHE_LIMIT, fileDigests, cacheKey, statSignature, hashFile, verifiedFile, clearScanCache, checked, copyVerified }

'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { hash } = require('./model.cjs')

function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(temp, 'w')
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, file); break }
    catch (error) {
      // Windows scanners/readers can briefly deny replacement. Keep both the
      // previous snapshot and the fsynced journal; never unlink the old file.
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 9) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))
    }
  }
}

class RunStore {
  constructor(dir) { this.dir = dir; this.file = path.join(dir, 'session.json'); this.journal = path.join(dir, 'events.jsonl') }
  acquire() {
    if (this.locked) return
    fs.mkdirSync(this.dir, { recursive: true })
    const file = path.join(this.dir, '.controller.lock')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(file, 'wx')
        try { fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        this.locked = true; return
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const pid = Number(fs.readFileSync(file, 'utf8'))
        let alive = true
        try { if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid controller lock'); process.kill(pid, 0) }
        catch (e) { if (e.code === 'ESRCH') alive = false; else if (e.code !== 'EPERM') throw e }
        if (alive) throw new Error('Another controller owns this run; close it before resuming here')
        fs.unlinkSync(file)
      }
    }
    throw new Error('Could not acquire the run controller lock')
  }
  release() {
    if (!this.locked) return
    const file = path.join(this.dir, '.controller.lock')
    if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file)
    this.locked = false
  }
  save(session, type, detail = {}) {
    fs.mkdirSync(this.dir, { recursive: true })
    session.sequence = (session.sequence || 0) + 1
    session.updatedAt = new Date().toISOString()
    const state = JSON.stringify(session)
    const event = { sequence: session.sequence, at: session.updatedAt, type, detail, checksum: hash(state), state }
    const fd = fs.openSync(this.journal, 'a')
    try { fs.writeFileSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    // Journal is durable before the acknowledgement allows a browser mutation.
    atomicJson(this.file, session)
  }
  load() {
    return this.read(true)
  }
  read(repair = false) {
    let session = null
    try { session = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { /* journal can recover an interrupted snapshot */ }
    if (fs.existsSync(this.journal)) {
      const data = fs.readFileSync(this.journal, 'utf8')
      const complete = data.slice(0, data.lastIndexOf('\n') + 1)
      for (const line of complete.split('\n').filter(Boolean)) {
        const event = JSON.parse(line)
        if (hash(event.state) !== event.checksum) throw new Error('Run journal checksum mismatch')
        if (!session || event.sequence > session.sequence) session = JSON.parse(event.state)
      }
      // A partial final write is not an event; remove only that incomplete tail.
      if (repair && data.length !== complete.length) fs.truncateSync(this.journal, Buffer.byteLength(complete))
    }
    if (!session || session.schemaVersion !== 2) throw new Error('Not a workflow v2 run')
    return session
  }
}
module.exports = { RunStore, atomicJson }

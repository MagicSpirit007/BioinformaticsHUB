#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { components, PROTOCOL } = require('../apps/bioinformatics-hub-desktop/workflow/build.cjs')
const { hash } = require('../apps/bioinformatics-hub-desktop/workflow/model.cjs')
const repo = path.resolve(__dirname, '..')
const engine = path.join(repo, 'packaging/engine')
const parts = components({ repo, engine, packaged: false })
const digests = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.digest]))
const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout?.trim()
const manifest = { version: 1, protocol: PROTOCOL, createdAt: new Date().toISOString(),
  buildId: hash(JSON.stringify({ protocol: PROTOCOL, ...digests })), components: parts,
  source: { commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])),
    engine: components({ repo, engine: repo, packaged: false }).engine.digest } }
if (manifest.source.engine !== parts.engine.digest) throw new Error('Staged engine differs from current source; stage again before building')
fs.writeFileSync(path.join(engine, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
process.stdout.write(JSON.stringify({ buildId: manifest.buildId, source: manifest.source }) + '\n')

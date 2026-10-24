#!/usr/bin/env node
'use strict'
const path = require('node:path')
const fs = require('node:fs')
const development = path.resolve(__dirname, '../apps/bioinformatics-hub-desktop/workflow/cli.cjs')
const packaged = path.resolve(__dirname, '../../app.asar/workflow/cli.cjs')
require(fs.existsSync(development) ? development : packaged).main().catch(error => {
  process.stderr.write(JSON.stringify({ apiVersion: 1, error: { code: error.code || 'REQUEST_FAILED', message: error.message } }) + '\n')
  process.exitCode = 1
})

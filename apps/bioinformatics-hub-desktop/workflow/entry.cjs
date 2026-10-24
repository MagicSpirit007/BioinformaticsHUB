'use strict'
require('./cli.cjs').main().catch(error => {
  process.stderr.write(JSON.stringify({ apiVersion: 1, error: { code: error.code || 'REQUEST_FAILED', message: error.message } }) + '\n')
  process.exitCode = 1
})

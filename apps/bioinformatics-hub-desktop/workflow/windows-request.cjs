'use strict'
// Structured stdin avoids command-shell quoting and converts paths only at the boundary.
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk; if (input.length > 96 * 1024 * 1024) process.exit(1) })
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input)
    if (request.home) process.env.BIOHUB_HOME = request.home; else delete process.env.BIOHUB_HOME
    if (request.runs) process.env.BIOINFORMATICS_HUB_RUNS = request.runs; else delete process.env.BIOINFORMATICS_HUB_RUNS
    const result = await require('./client.cjs').call(request.method, request.args)
    process.stdout.write(JSON.stringify({ result }))
  } catch (error) { process.stdout.write(JSON.stringify({ error: { code: error.code || 'REQUEST_FAILED', message: error.message } })) }
})

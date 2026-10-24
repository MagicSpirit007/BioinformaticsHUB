'use strict'
const fs = require('node:fs')
const { call } = require('./client.cjs')

function parse(argv) {
  const args = {}, words = []
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { words.push(argv[i]); continue }
    const [raw, inline] = argv[i].slice(2).split(/=(.*)/s)
    const key = raw.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())
    const value = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true)
    args[key] = value
  }
  return { args, words }
}
async function main(argv = process.argv.slice(2)) {
  const { args, words } = parse(argv)
  if (args.home) process.env.BIOHUB_HOME = String(args.home)
  if (args.runs) process.env.BIOINFORMATICS_HUB_RUNS = String(args.runs)
  if (words[0] === 'mcp') { require('./mcp.cjs').serve(); return }
  if (!words.length || args.help) {
    process.stdout.write('BioinformaticsHUB 0.7\n\nbiohub catalog|doctor|resolve <identifier> [--species NAME] [--provider auto|ncbi|uniprot|gigadb]\nbiohub run start --execution-mode local|web|mixed (--spec FILE | --identifier ID --template TEMPLATE) [--idempotency-key KEY]\nbiohub run list|status|events|control|answer [ID] [--action resume] [--identifier CONFIRMED_ID]\nbiohub results list|register|validate|verify|finalize|open-all|open|reopen|archive|capture|export ID [--node-id NODE] [--scale 2] [--clip JSON]\nbiohub settings [--spec FILE]\nbiohub service status|stop\nbiohub mcp\n\n--home DIR and --runs DIR select the shared background data/task directories.\n--json JSON or --spec FILE supplies structured arguments. run events --follow emits JSONL.\nAsk the user to choose local, web or mixed tools before starting. No execution mode or template is selected by default.\nA needs_choice response starts no task; supply the user choice and call run start again.\n')
    return
  }
  const json = text => JSON.parse(String(text).replace(/^\uFEFF/, ''))
  let payload = args.spec ? json(fs.readFileSync(String(args.spec), 'utf8')) : args.json ? json(args.json) : {}
  for (const [key, value] of Object.entries(args)) if (!['home', 'runs', 'spec', 'json', 'wait', 'follow', 'quiet'].includes(key)) payload[key] = value
  let method
  if (words[0] === 'run') {
    method = { start: 'start', list: 'list', status: 'load', events: 'events', control: 'control', answer: 'answer' }[words[1]]
    if (words[2]) payload.id = words[2]
  } else if (words[0] === 'results') {
    method = { list: 'results', validate: 'resultsValidate', verify: 'resultsVerify', open: 'openResult', reopen: 'reopenResult', archive: 'archive', capture: 'capture', export: 'export', register: 'resultsRegister', finalize: 'resultsFinalize', 'open-all': 'resultsOpenAll' }[words[1]]
    if (words[2]) payload.id = words[2]
  } else if (words[0] === 'service') method = words[1] === 'stop' ? 'stop' : 'ping'
  else {
    method = { catalog: 'catalog', doctor: 'doctor', resolve: 'resolve', settings: args.spec || args.json ? 'saveSettings' : 'settings', workspace: 'workspace', validate: 'validate' }[words[0]]
    if (words[0] === 'workspace' && words[1]) payload.runsRoot = words[1]
    if (words[0] === 'resolve' && words[1]) payload.identifier = words[1]
  }
  if (!method) throw new Error('Unknown command. Run biohub --help')
  for (const key of ['scale', 'after', 'limit']) if (payload[key] != null) payload[key] = Number(payload[key])
  for (const key of ['clip', 'parameters', 'inputs', 'workflow', 'files', 'expected', 'notification']) if (typeof payload[key] === 'string') payload[key] = JSON.parse(payload[key])
  for (const key of ['offline', 'online', 'open', 'notSubmitted']) if (payload[key] != null) payload[key] = payload[key] === true || payload[key] === 'true'
  const print = result => process.stdout.write(JSON.stringify({ apiVersion: 1, result }) + '\n')
  const result = await call(method, payload); print(result)
  if (args.follow && method === 'events') {
    let cursor = result.cursor
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      const next = await call('events', { id: payload.id, after: cursor })
      if (next.events.length) { print(next); cursor = next.cursor }
      const state = await call('load', { id: payload.id })
      if (['completed', 'partial', 'cancelled', 'needs_input', 'needs_attention', 'paused'].includes(state.status)) break
    }
  }
  if (args.wait && result.id && method !== 'events') {
    let current = result
    while (!['completed', 'partial', 'cancelled', 'needs_input', 'needs_attention', 'paused'].includes(current.status)) {
      await new Promise(resolve => setTimeout(resolve, 1000)); current = await call('load', { id: result.id })
    }
    print(current)
  }
}
module.exports = { main, parse }

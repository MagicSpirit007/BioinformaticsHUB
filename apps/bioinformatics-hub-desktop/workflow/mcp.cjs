'use strict'
const readline = require('node:readline')
const { call } = require('./client.cjs')
const { tools, validateArguments } = require('./tools.cjs')

function serve({ input = process.stdin, output = process.stdout, invoke = call } = {}) {
  const send = data => output.write(JSON.stringify(data) + '\n')
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let initialized = false
  lines.on('line', async line => {
    let message
    try { message = JSON.parse(line) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return }
    if (message.id == null) return // Notifications, including cancellation, never cancel the durable task.
    const reply = result => send({ jsonrpc: '2.0', id: message.id, result })
    const error = (code, text) => send({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })
    try {
      if (message.method === 'initialize') {
        initialized = true
        reply({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'bioinformatics-hub', version: '0.7.0' },
          instructions: 'Use catalog to discover analysis capabilities. Before starting analysis, ask the user whether to use local tools, web tools or a combination unless they already explicitly chose. Pass their choice as executionMode (local/web/mixed); available local tools and template contents are not permission to decide for them. A needs_choice response has not created or scheduled a task: ask the user, then call start again. Do not substitute another execution mode or omit analyses without a user choice. Resolve identifiers before scientific submission. Ask the user when a result reports ambiguity; never invent a sequence or select an unconfirmed candidate. Tasks survive disconnection. Deliver original service pages and archives; interpretation belongs to the calling assistant only when requested. Register all externally obtained pages/files with results_register. Finish with results_finalize using the full expected inventory; this opens all saved pages in one delivery window. Never claim a complete delivery if returned gaps or browser failures remain.' })
      } else if (message.method === 'ping') reply({})
      else if (!initialized) error(-32000, 'Initialize the connection first')
      else if (message.method === 'tools/list') reply({ tools: tools.map(({ method, ...tool }) => tool) })
      else if (message.method === 'tools/call') {
        const tool = tools.find(t => t.name === message.params?.name)
        if (!tool) return error(-32602, 'Unknown tool')
        const args = message.params?.arguments || {}
        try { validateArguments(args, tool.inputSchema) } catch (failure) { return error(-32602, failure.message) }
        try {
          const result = await invoke(tool.method, args)
          reply({ content: [{ type: 'text', text: JSON.stringify({ apiVersion: 1, result }) }], structuredContent: { apiVersion: 1, result }, isError: false })
        } catch (failure) { reply({ content: [{ type: 'text', text: JSON.stringify({ error: { code: failure.code || 'REQUEST_FAILED', message: failure.message } }) }], isError: true }) }
      } else error(-32601, 'Method not found')
    } catch (failure) { error(-32603, failure.message) }
  })
  return lines
}
module.exports = { serve }

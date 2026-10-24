'use strict'
const str = { type: 'string' }
const obj = { type: 'object' }
const task = { id: str }
const node = { ...task, nodeId: str }
const executionMode = { type: 'string', enum: ['local', 'web', 'mixed'], description: 'The user-chosen analysis execution mode. Do not infer it from available tools or a template.' }
const notification = { type: 'object', properties: { choice: { type: 'string', enum: ['send', 'decline'] }, email: str, siteIds: { type: 'array', items: str }, consents: obj }, required: ['choice'], additionalProperties: false }
const resolution = { identifier: str, provider: { type: 'string', enum: ['auto', 'ncbi', 'uniprot', 'gigadb'] }, species: str,
  kind: { type: 'string', enum: ['protein_fasta', 'nucleotide_fasta'] }, sourceUrl: str, sourceSpecies: str, sourceVersion: str }
const entries = [
  ['biohub_catalog', 'catalog', 'List supported analysis services, tools, templates, parameters and execution options. Tool availability and template contents do not authorize choosing local or web analysis for the user.', {}, [], true],
  ['biohub_doctor', 'doctor', 'Inspect local dependencies and configured browser/model capabilities.', {}, [], true],
  ['biohub_resolve', 'resolve', 'Retrieve the exact FASTA from a gene identifier. Ambiguous matches require a user choice; sequence bytes never come from a model.', resolution, ['identifier'], false],
  ['biohub_run_start', 'start', 'Start a durable analysis task using the executionMode explicitly chosen by the user: local, web or mixed. Ask which they want unless their request already specifies it; never choose based on installed tools or templates. If needs_choice, ask the user and call start again with their choice; no task has started. Supply a confirmed template or workflow. Ask whether to receive native website email notifications before submission; if yes, ask for an email and explicitly selected siteIds, plus individual storage consents. Supply notification; never invent an address. Never switch execution modes or omit analyses without the user choosing. Poll status/events; disconnection does not cancel. Use an idempotencyKey for retries. If needs_input, ask about the returned sequence candidates then call answer.', { executionMode, workflow: obj, template: str, inputs: obj, identifier: str, provider: str, species: str, sequenceKind: str, sourceUrl: str, sourceSpecies: str, sourceVersion: str, parameters: obj, notification, name: str, idempotencyKey: str }, [], false],
  ['biohub_run_list', 'list', 'Read the shared task directory.', {}, [], true],
  ['biohub_run_status', 'load', 'Read task state without resuming or changing it.', task, ['id'], true],
  ['biohub_run_events', 'events', 'Read incremental task events using the returned cursor.', { ...task, after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, ['id'], true],
  ['biohub_run_control', 'control', 'Pause/resume/cancel/retry a task or reconcile its original remote receipt. Never retry an uncertain submission without reconciliation.', { ...node, action: { type: 'string', enum: ['pause', 'resume', 'cancel', 'retry', 'revalidate', 'takeover', 'reconcile'] }, resultUrl: str, notSubmitted: { type: 'boolean' } }, ['id', 'action'], false],
  ['biohub_run_answer', 'answer', 'Supply a confirmed identifier/source/species to a task waiting for sequence input. Continues under the same task ID and preserves the chosen execution mode. For an older task without a choice, ask the user and supply executionMode.', { ...task, identifier: str, species: str, provider: str, sourceUrl: str, sourceSpecies: str, sourceVersion: str, executionMode, notification }, ['id'], false],
  ['biohub_results_list', 'results', 'List original service result pages, archives and original downloaded files. No AI scientific interpretation is generated.', task, ['id'], true],
  ['biohub_results_validate', 'resultsValidate', 'Independently parse imported scientific outputs against the original node input and parameters using engine-owned validators. Preserve execution history. Changed files, inputs, parameters or validator versions invalidate the record. This does not submit remote jobs.', { ...task, itemId: str }, ['id'], false],
  ['biohub_results_verify', 'resultsVerify', 'Reopen saved pages in a fresh offline Chrome context with scripts disabled. Validate resource rendering against original captured baselines and parse downloaded files. Store fingerprint-bound checks without certifying scientific analysis or resubmitting it.', { ...task, itemId: str }, ['id'], false],
  ['biohub_results_register', 'resultsRegister', 'Register externally obtained original pages and files in the same task. Files are copied and hashed; scientific verification is not accepted from the caller. Use role=data for official JSON/XML/tabular scientific outputs, then results_validate. Supply sourceTaskId/sourceNodeId and inputSha256 to reuse independently verified native evidence. relativePath preserves HTML resource layout. Empty files records a missing or unsupported analysis.', { ...task, itemId: str, name: str, kind: { type: 'string', enum: ['website', 'local', 'attachment'] }, sourceUrl: str, inputSha256: str, sourceTaskId: str, sourceNodeId: str, capturedAt: str, message: str, files: { type: 'array', items: { type: 'object', properties: { path: str, relativePath: str, sha256: str, role: { type: 'string', enum: ['page', 'figure', 'data', 'original_file', 'attachment', 'internal', 'resource'] } }, required: ['path'], additionalProperties: false } } }, ['id', 'itemId', 'name', 'kind', 'files'], false],
  ['biohub_results_finalize', 'resultsFinalize', 'Check the expected delivery inventory and save a version. Open safe offline copies with the system default browser by default. Partial results retain explicit gaps; this never rewrites execution history or resubmits analyses. Opening does not require Python or a Chrome debugging connection.', { ...task, expected: { type: 'array', items: { type: 'object', properties: { id: str, name: str }, required: ['id'], additionalProperties: false } }, open: { type: 'boolean' } }, ['id'], false],
  ['biohub_results_open_all', 'resultsOpenAll', 'Hand safe offline copies to the system default browser. Return accepted request counts and individual failures, not proof of page loading.', task, ['id'], false],
  ['biohub_results_open', 'openResult', 'Open an offline viewing copy in the system default browser without Python or a debugging connection. online=true activates the original live result instead. Attachments open with their associated application.', { ...node, itemId: str, artifactPath: str, online: { type: 'boolean' }, offline: { type: 'boolean' } }, ['id'], false],
  ['biohub_results_reopen', 'reopenResult', 'Explicitly reopen an official result URL after the original browser session is lost. Does not resubmit analysis.', node, ['id', 'nodeId'], false],
  ['biohub_results_archive', 'archive', 'Retry saving an existing successful result as local HTML/resources, MHTML and high-resolution PNG without resubmitting the analysis.', node, ['id', 'nodeId'], false],
  ['biohub_results_capture', 'capture', 'Save lossless PNGs from an existing result. Default scale is 2. Optional clip uses document coordinates x/y/width/height. Tall pages are tiled, never silently downscaled.', { ...node, scale: { type: 'number', minimum: 1, maximum: 4 }, clip: { type: 'object', properties: { x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } }, required: ['x', 'y', 'width', 'height'], additionalProperties: false } }, ['id', 'nodeId'], false],
  ['biohub_results_export', 'export', 'Export original result pages, archives, original files and input provenance into a portable directory with index.html.', task, ['id'], false],
]
const tools = entries.map(([name, method, description, properties, required, readOnly]) => ({ name, method, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: method === 'control', openWorldHint: !['list', 'load', 'events', 'results'].includes(method) } }))
function validateArguments(value, schema, at = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(at + ' must be an object')
    for (const key of schema.required || []) if (value[key] == null) throw new Error(at + '.' + key + ' is required')
    for (const [key, item] of Object.entries(value)) {
      if (schema.additionalProperties === false && !schema.properties?.[key]) throw new Error(at + '.' + key + ' is unknown')
      if (schema.properties?.[key]) validateArguments(item, schema.properties[key], at + '.' + key)
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(at + ' must be an array')
    if (value.length > 3000) throw new Error(at + ' is too long')
    value.forEach((item, i) => validateArguments(item, schema.items, at + '[' + i + ']'))
  } else if (schema.type === 'string' && typeof value !== 'string') throw new Error(at + ' must be text')
  else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(at + ' must be boolean')
  else if (['number', 'integer'].includes(schema.type) && (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value))) throw new Error(at + ' must be numeric')
  if (schema.enum && !schema.enum.includes(value)) throw new Error(at + ' is not an allowed value')
  if (schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum || schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) throw new Error(at + ' is outside the allowed range')
}
module.exports = { tools, validateArguments }

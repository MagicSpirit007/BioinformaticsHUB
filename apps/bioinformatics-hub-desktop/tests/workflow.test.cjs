const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validateWorkflow, createSession, hash, inside, artifactFor } = require('../workflow/model.cjs')
const { loadRecipes, templates } = require('../workflow/catalog.cjs')
const { RunStore } = require('../workflow/store.cjs')
const { WorkflowScheduler, Resources } = require('../workflow/scheduler.cjs')
const recipes = loadRecipes(path.resolve(__dirname, '../../bioinformatics-hub/public/site-catalog.json'))
const input = { protein: { kind: 'protein_fasta', value: '>test\nMKKLLACDEFGHIKLMNPQRSTVWY\n' } }
const site = (id, siteId = 'plant_mploc', dependsOn = []) => ({ id, kind: 'site', siteId, dependsOn, parameters: {}, input: { source: 'input', key: 'protein' } })
const definition = nodes => ({ id: 'test', name: 'Test', version: 1, nodes })
const flush = () => new Promise(resolve => setImmediate(resolve))
function setup(t, nodes, launch, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biohub-workflow-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = new RunStore(dir)
  const session = createSession('test', definition(nodes), input, recipes)
  const scheduler = new WorkflowScheduler({ session, store, launch, ...options })
  t.after(() => { scheduler.closed = true; clearTimeout(scheduler.timer) })
  return { dir, store, session, scheduler }
}
function success(dir, id) {
  const file = `${id}.txt`; fs.writeFileSync(path.join(dir, file), 'real result')
  return { status: 'succeeded', evidence: { verified: true }, artifacts: [{ path: file, kind: 'report', verified: true, sha256: hash('real result') }] }
}

test('all 28 built-ins have versioned recipes and three templates', () => {
  assert.equal(Object.keys(recipes).length, 28)
  for (const recipe of Object.values(recipes)) {
    assert.ok(recipe.resultPatterns.length >= 2)
    assert.ok(recipe.allowedHosts.includes(new URL(recipe.entryUrl).hostname))
  }
  assert.equal(templates(recipes).length, 3)
})
test('validation catches cycles, missing parameters and incompatible artifacts', () => {
  const a = site('a'), b = site('b'); a.dependsOn = ['b']; b.dependsOn = ['a']
  assert.match(validateWorkflow(definition([a, b]), input, recipes).join(' '), /cycle/)
  assert.match(validateWorkflow(definition([site('d', 'signalp')]), input, recipes).join(' '), /required parameter/)
  const tree = { id: 'tree', kind: 'local', tool: 'iqtree', dependsOn: ['a'], parameters: {}, input: { source: 'node', nodeId: 'a', kind: 'alignment_fasta' } }
  assert.match(validateWorkflow(definition([site('a'), tree]), input, recipes).join(' '), /incompatible/)
})
test('custom outcomes cannot be connected as verified upstream outputs', () => {
  const custom = { ...site('custom'), custom: true, entryUrl: 'https://example.org', inputKind: 'protein_fasta', goal: 'Analyze' }
  const downstream = { ...site('next'), dependsOn: ['custom'], input: { source: 'node', nodeId: 'custom', kind: 'protein_fasta' } }
  assert.match(validateWorkflow(definition([custom, downstream]), input, recipes).join(' '), /unverified/)
})
test('durable checkpoint acknowledgement survives an interrupted snapshot', t => {
  const { session, store, dir } = setup(t, [site('a')], () => {})
  store.save(session, 'created')
  session.nodes[0].checkpoint = { effectPending: true }
  store.save(session, 'intent')
  fs.writeFileSync(path.join(dir, 'session.json'), '{broken')
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{incomplete')
  assert.equal(store.load().nodes[0].checkpoint.effectPending, true)
  store.save(store.load(), 'next')
  assert.equal(store.load().sequence, 3)
})
test('recovery never replays an uncertain submission', t => {
  let calls = 0
  const { scheduler, session } = setup(t, [site('a')], () => { calls++; return { promise: Promise.resolve({ status: 'failed' }) } })
  session.nodes[0].status = 'running'; session.nodes[0].checkpoint.effectPending = true
  scheduler.recover(); scheduler.resume()
  assert.equal(session.nodes[0].status, 'needs_review'); assert.equal(calls, 0)
  assert.throws(() => scheduler.retry('a'), /uncertain/)
})
test('receipt phase protects paused runs even if the legacy flag is absent', t => {
  let calls = 0
  const { scheduler, session, store } = setup(t, [site('a')], () => { calls++; throw new Error('Must not submit') })
  session.nodes[0].status = 'paused'
  session.nodes[0].checkpoint = { submission: { phase: 'submitting', attemptId: 'attempt', inputSha256: 'original' } }
  store.save(session, 'submission_intent')
  scheduler.recover(); scheduler.resume()
  assert.equal(session.nodes[0].status, 'needs_review'); assert.equal(calls, 0)
  assert.equal(store.load().nodes[0].checkpoint.submission.phase, 'needs_reconciliation')
  assert.throws(() => scheduler.retry('a'), /uncertain/)
})
test('remote wait releases browser slot and preserves the submission receipt', async t => {
  const calls = []
  const { scheduler, session } = setup(t, [site('a'), site('b')], payload => {
    calls.push(payload.node.id)
    return { promise: Promise.resolve({ status: 'waiting_remote', checkpoint: { submitted: true, jobId: payload.node.id } }) }
  })
  scheduler.start(); await flush(); await flush()
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(session.nodes[0].checkpoint.jobId, 'a')
  assert.equal(scheduler.resources.browser, 0)
})
test('shared resources enforce global concurrency and per-host exclusion', () => {
  const r = new Resources(), node = { kind: 'site' }
  const a = r.acquire(node, { entryUrl: 'https://a.example/one' })
  assert.equal(r.acquire(node, { entryUrl: 'https://a.example/two' }), null)
  const b = r.acquire(node, { entryUrl: 'https://b.example/' })
  assert.equal(r.acquire(node, { entryUrl: 'https://c.example/' }), null)
  a(); assert.equal(typeof r.acquire(node, { entryUrl: 'https://c.example/' }), 'function'); b()
})
test('DONE without validated artifacts never unlocks dependants', async t => {
  const called = []
  const { scheduler, session } = setup(t, [site('a'), site('b', 'plant_mploc', ['a'])], payload => {
    called.push(payload.node.id)
    return { promise: Promise.resolve({ status: 'succeeded', evidence: { verified: true }, artifacts: [] }) }
  })
  scheduler.start(); await flush()
  assert.deepEqual(called, ['a']); assert.equal(session.nodes[0].status, 'failed'); assert.equal(session.nodes[1].status, 'blocked')
})
test('tampered artifact is rejected; independent branch still completes', async t => {
  let fixture
  fixture = setup(t, [site('a'), site('b', 'interpro')], payload => {
    const result = success(fixture.dir, payload.node.id)
    if (payload.node.id === 'a') fs.writeFileSync(path.join(fixture.dir, 'a.txt'), 'tampered')
    return { promise: Promise.resolve(result) }
  })
  fixture.scheduler.start(); await flush()
  assert.equal(fixture.session.nodes[0].status, 'failed'); assert.equal(fixture.session.nodes[1].status, 'succeeded')
})
test('artifact traversal and ambiguous producer output are rejected', t => {
  const { dir, session } = setup(t, [site('a')], () => {})
  assert.throws(() => inside(dir, '../outside'), /escapes/)
  session.nodes[0].status = 'succeeded'; session.nodes[0].artifacts = [{ kind: 'structure', verified: true }, { kind: 'structure', verified: true }]
  assert.throws(() => artifactFor(session, { input: { source: 'node', nodeId: 'a', kind: 'structure' } }), /ambiguous/)
})
test('pause prevents new nodes and resume dispatches from checkpoint', async t => {
  let calls = 0
  const { scheduler, session } = setup(t, [site('a')], () => { calls++; return { promise: Promise.resolve({ status: 'paused' }) } })
  scheduler.pause(); scheduler.tick(); assert.equal(calls, 0)
  scheduler.resume(); await flush(); assert.equal(calls, 1); assert.equal(session.nodes[0].status, 'paused')
})
test('remote timeout asks for review without resubmission', t => {
  let calls = 0
  const { scheduler, session } = setup(t, [site('a')], () => { calls++ }, { now: () => 90_000_000 })
  Object.assign(session.nodes[0], { status: 'waiting_remote', startedAt: 1, remoteStartedAt: 1, checkpoint: { submitted: true } })
  scheduler.tick(); assert.equal(calls, 0); assert.equal(session.nodes[0].status, 'needs_review')
})
test('controller lock prevents two processes from executing the same run', t => {
  const { store, dir } = setup(t, [site('a')], () => {})
  store.acquire()
  const second = new RunStore(dir)
  assert.throws(() => second.acquire(), /Another controller/)
  store.release(); second.acquire(); second.release()
})
test('shutdown preserves a completed run and cancelled runs cannot retry', async t => {
  const { scheduler, session } = setup(t, [site('a')], () => {})
  session.status = 'completed'; session.nodes[0].status = 'succeeded'
  await scheduler.shutdown(); assert.equal(session.status, 'completed')
  session.status = 'cancelled'; assert.throws(() => scheduler.retry('a'), /terminal/)
})
test('executor result URL is checkpointed for restart without its original tab', async t => {
  const { scheduler, session } = setup(t, [site('a')], () => ({ promise: Promise.resolve({ status:'waiting_remote', checkpoint:{submitted:true}, resultUrl:'http://www.csbio.sjtu.edu.cn/result/job1' }) }))
  scheduler.start(); await flush(); await flush()
  assert.equal(session.nodes[0].checkpoint.resultUrl, 'http://www.csbio.sjtu.edu.cn/result/job1')
})

test('mouse dispatch timeout after persisted submit intent cannot cause a second submission', async t => {
  let calls=0
  const {scheduler,session,store}=setup(t,[site('a')],(_payload,onEvent)=>{
    calls++
    onEvent({type:'checkpoint',checkpoint:{submission:{phase:'submitting',attemptId:'timeout-fixture'}}})
    return {promise:Promise.reject(new Error('_IPCResponseTimeout: Input.dispatchMouseEvent timed out after 5s waiting for the daemon'))}
  })
  scheduler.start();await flush();await flush()
  assert.equal(session.nodes[0].status,'needs_review')
  assert.equal(store.load().nodes[0].checkpoint.submission.phase,'submitting')
  scheduler.recover();scheduler.resume()
  assert.throws(()=>scheduler.retry('a'),/uncertain/)
  assert.equal(calls,1)
})

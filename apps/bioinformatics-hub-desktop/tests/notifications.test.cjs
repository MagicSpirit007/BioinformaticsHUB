'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { notificationChoice } = require('../workflow/notifications.cjs')
const { resultStatus } = require('../workflow/result-status.cjs')
const { createWorkflowCore } = require('../workflow/core.cjs')
const { extendCore } = require('../workflow/operations.cjs')
const paths = require('../paths.cjs')
const recipes = { optional: { name: 'Optional', emailNotification: { support: 'optional', parameter: 'email' } }, required: { name: 'Required', emailNotification: { support: 'required', parameter: 'email', consentParameter: 'emailConsent' } }, unknown: { name: 'Unknown', emailNotification: { support: 'unknown' } } }
const workflow = (...ids) => ({ version: 1, nodes: ids.map(id => ({ id, kind: 'site', siteId: id, parameters: {} })) })
test('notification consent blocks missing choices, invalid email and unsupported recipients', () => {
  for (const notification of [undefined, {choice:'send',email:'bad',siteIds:['optional']}, {choice:'send',email:'a@example.org',siteIds:['unknown']}]) {
    assert.equal(notificationChoice(workflow('optional','unknown'), recipes, notification).status, 'needs_choice')
  }
  const noMail = workflow('optional','unknown')
  assert.equal(notificationChoice(noMail, recipes, {choice:'decline'}), null)
  assert.equal(noMail.nodes[0].parameters.email, '')
  assert.equal(noMail.nodes[1].parameters.email, undefined)
  assert.equal(notificationChoice(workflow('required'), recipes, {choice:'decline'}).actionRequired, 'required_notification_email')
  assert.equal(notificationChoice(workflow('required'), recipes, {choice:'send',email:'a@example.org',siteIds:['required']}).actionRequired, 'confirm_email_terms')
})
test('only explicitly named websites receive an address and terms are site-specific', () => {
  const w = workflow('optional', 'required', 'unknown')
  assert.equal(notificationChoice(w, recipes, {choice:'send',email:'a@example.org',siteIds:['required'],consents:{required:true}}), null)
  assert.equal(w.nodes[0].parameters.email, '')
  assert.deepEqual(w.nodes[1].parameters,{email:'a@example.org',emailConsent:'true'})
  assert.equal(w.nodes[2].parameters.email, undefined)
  const bypass = workflow('optional'); bypass.nodes[0].parameters.email='other@example.org'
  assert.equal(notificationChoice(bypass, recipes, {choice:'decline'}).actionRequired,'confirm_notification_parameters')
})
test('start and answer gate email before sequence lookup, creation or idempotency reservation', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'biohub-notification-'))
  const core=createWorkflowCore({ paths:{...paths,repoRoot:()=>root,defaultRunsRoot:()=>root,resolveRunDir:id=>paths.resolveRunDir(id,root),siteCatalogPath:()=>path.resolve(__dirname,'../../bioinformatics-hub/public/site-catalog.json')},dataDir:root })
  let submitted=0
  core.handlers.set('start', args => { submitted++; return args })
  extendCore(core)
  core.workerRequest=()=>{throw new Error('Preflight must not look up input or launch a worker')}
  t.after(async()=>{await core.shutdown();fs.rmSync(root,{recursive:true,force:true})})
  const spec={executionMode:'web',workflow:workflow('jpred'),identifier:'test-id',idempotencyKey:'email-request'}
  assert.equal((await core.call('start',spec)).actionRequired,'choose_notification')
  assert.equal(submitted,0);assert.equal(fs.existsSync(path.join(root,'requests')),false)
  const accepted=await core.call('start',{...spec,identifier:undefined,idempotencyKey:undefined,notification:{choice:'decline'}})
  assert.equal(submitted,1);assert.equal(accepted.workflow.nodes[0].parameters.email,'')
  const pending={status:'needs_input',pendingRequest:spec,executionMode:'web',workflow:spec.workflow}
  core.read=()=>pending
  assert.equal((await core.call('answer',{id:'pending',identifier:'chosen'})).actionRequired,'choose_notification')
  assert.equal(submitted,1)
})
test('task state distinguishes uncertain submissions, remote work and email activation', () => {
  const item={checks:{analysis:'unverified'},artifacts:[]}
  assert.equal(resultStatus(item,{status:'needs_review',checkpoint:{effectPending:true}}).taskState,'submission_uncertain')
  assert.equal(resultStatus(item,{status:'failed',checkpoint:{submission:{phase:'submitting'}}}).taskState,'submission_uncertain')
  assert.equal(resultStatus({...item,artifacts:[{role:'page'}]},{status:'failed'}).taskState,'result_available')
  assert.equal(resultStatus(item,{status:'waiting_remote',checkpoint:{submitted:true}}).taskState,'waiting_remote')
  assert.equal(resultStatus(item,{status:'waiting_human',checkpoint:{effectPending:true,emailActivationRequired:true}}).taskState,'email_activation')
  assert.equal(resultStatus(item,{status:'failed'}).taskState,'execution_failed')
  assert.equal(resultStatus({...item,checks:{analysis:'verified'}},{status:'failed'}).taskState,'result_available')
})

test('installed catalog email capabilities gate every supported site and isolate recipients', () => {
  const actual = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../bioinformatics-hub/public/workflow-recipes.json'), 'utf8')).recipes
  const supported = Object.entries(actual).filter(([, r]) => ['optional', 'required'].includes(r.emailNotification?.support))
  assert.ok(supported.length > 0)
  for (const [id, recipe] of supported) {
    const capability = recipe.emailNotification
    assert.ok(recipe.parameters.some(p => p.id === (capability.parameter || 'email')), id)
    assert.equal(notificationChoice(workflow(id), actual, undefined).actionRequired, 'choose_notification', id)
    const declined = workflow(id)
    const decision = notificationChoice(declined, actual, { choice: 'decline' })
    if (capability.support === 'required') assert.equal(decision.actionRequired, 'required_notification_email')
    else { assert.equal(decision, null); assert.equal(declined.nodes[0].parameters.email, '') }
    const consent = { choice: 'send', email: 'fixture+notify@example.org', siteIds: [id], consents: {} }
    if (capability.consentParameter) {
      for (const invalid of [undefined, false, 'true', 1]) {
        consent.consents[id] = invalid
        assert.equal(notificationChoice(workflow(id), actual, consent).actionRequired, 'confirm_email_terms')
      }
      consent.consents[id] = true
    }
    const selected = workflow(id)
    assert.equal(notificationChoice(selected, actual, consent), null)
    assert.equal(selected.nodes[0].parameters.email, 'fixture+notify@example.org')
    assert.equal(selected.nodes[0].emailNotification.choice, 'send')
  }
})

test('email rejection leaves workflow unmodified and never reuses another task address', () => {
  const rejected = workflow('optional', 'required')
  const before = JSON.stringify(rejected)
  assert.equal(notificationChoice(rejected, recipes, { choice: 'send', email: 'a@example.org', siteIds: ['optional'] }).actionRequired, 'required_notification_email')
  assert.equal(JSON.stringify(rejected), before)
  for (const email of ['', 'bad', 'a@', '@example.org', 'a b@example.org', 'a@example', 'a'.repeat(255) + '@example.org']) {
    assert.equal(notificationChoice(workflow('optional'), recipes, { choice: 'send', email, siteIds: ['optional'] }).actionRequired, 'provide_notification_email')
  }
  const first = workflow('optional'), second = workflow('optional')
  assert.equal(notificationChoice(first, recipes, { choice: 'send', email: 'first@example.org', siteIds: ['optional'] }), null)
  assert.equal(notificationChoice(second, recipes, { choice: 'decline' }), null)
  assert.equal(first.nodes[0].parameters.email, 'first@example.org')
  assert.equal(second.nodes[0].parameters.email, '')
})

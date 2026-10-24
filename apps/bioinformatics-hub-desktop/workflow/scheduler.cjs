'use strict'
const fs = require('node:fs')
const { artifactFor, inside, hash, TERMINAL } = require('./model.cjs')
const uncertain = checkpoint => Boolean(checkpoint?.effectPending || ['submitting', 'needs_reconciliation'].includes(checkpoint?.submission?.phase))

class Resources {
  constructor() { this.browser = 0; this.local = 0; this.hosts = new Set() }
  acquire(node, recipe) {
    if (node.kind === 'local') { if (this.local >= 1) return null; this.local++; return () => { this.local-- } }
    const host = new URL(recipe.entryUrl || node.entryUrl).hostname
    if (this.browser >= 2 || this.hosts.has(host)) return null
    this.browser++; this.hosts.add(host)
    return () => { this.browser--; this.hosts.delete(host) }
  }
}

class WorkflowScheduler {
  constructor({ session, store, launch, resources = new Resources(), onChange = () => {}, now = Date.now, pollMin = 30_000, pollMax = 300_000 }) {
    Object.assign(this, { session, store, launch, resources, onChange, now, pollMin, pollMax })
    this.active = new Map(); this.timer = null; this.closed = false
  }
  save(type, detail) { this.store.save(this.session, type, detail); this.onChange(this.session) }
  start() { this.closed = false; this.session.status = 'running'; this.session.pauseRequested = false; this.save('started'); this.tick() }
  recover() {
    for (const run of this.session.nodes) {
      if (['running', 'verifying'].includes(run.status) || uncertain(run.checkpoint) && ['ready', 'paused', 'waiting_remote'].includes(run.status)) {
        const c = run.checkpoint || {}
        run.status = uncertain(c) ? 'needs_review' : c.submitted ? 'waiting_remote' : 'ready'
        if (uncertain(c)) { c.effectPending = true; c.submission = { ...c.submission, phase: 'needs_reconciliation' } }
        run.message = c.effectPending ? 'Interrupted browser action: inspect the existing tab/job before resuming.' : 'Recovered from checkpoint.'
      }
    }
    this.session.pauseRequested = true; this.session.status = 'paused'; this.save('recovered')
  }
  schedule() {
    clearTimeout(this.timer)
    if (!this.closed && !this.session.pauseRequested && !['completed', 'cancelled', 'partial'].includes(this.session.status)) {
      this.timer = setTimeout(() => this.tick(), 1000)
      this.timer.unref?.()
    }
  }
  tick() {
    if (this.closed) return
    if (!this.session.pauseRequested && this.session.status !== 'cancelled') {
      for (const node of this.session.workflow.nodes) {
        const run = this.session.nodes.find(r => r.id === node.id)
        if (!['ready', 'waiting_remote'].includes(run.status) || this.active.has(node.id)) continue
        const deps = node.dependsOn.map(id => this.session.nodes.find(r => r.id === id))
        if (deps.some(r => ['failed', 'cancelled', 'blocked'].includes(r.status))) {
          run.status = 'blocked'; run.message = 'An upstream node did not succeed.'; this.save('dependency_blocked', { nodeId: node.id }); continue
        }
        if (deps.some(r => r.status !== 'succeeded')) continue
        if (run.status === 'waiting_remote') {
          const deadline = (run.remoteStartedAt || run.startedAt) + (node.limits?.waitHours || 24) * 3600_000
          if (this.now() >= deadline) { run.status = 'needs_review'; run.message = 'Remote wait limit reached; the remote job may still be running.'; this.save('wait_limit', { nodeId: node.id }); continue }
          if (this.now() < run.nextPollAt) continue
        }
        const release = this.resources.acquire(node, this.session.recipeSnapshot[node.id])
        if (!release) continue
        let input
        try { input = artifactFor(this.session, node) } catch (e) {
          release(); run.status = 'needs_review'; run.message = e.message; this.save('input_unavailable', { nodeId: node.id }); continue
        }
        this.execute(node, run, input, release)
      }
    }
    this.deriveStatus(); this.schedule()
  }
  execute(node, run, input, release) {
    run.status = 'running'; run.attempts++; run.startedAt ||= this.now(); run.message = 'Starting executor'
    this.save('node_started', { nodeId: node.id })
    let handle
    try {
      handle = this.launch({ node, run: JSON.parse(JSON.stringify(run)), input, recipe: this.session.recipeSnapshot[node.id], runDir: this.store.dir, sessionId: this.session.id }, event => this.event(node, run, event))
    } catch (e) { release(); run.status = 'failed'; run.message = e.message; this.save('launch_failed', { nodeId: node.id }); return }
    this.active.set(node.id, handle)
    handle.promise.then(result => {
      if (this.session.status === 'cancelled' || run.cancelRequested) { run.status = 'cancelled'; run.remoteMayContinue = Boolean(run.checkpoint.submitted || run.checkpoint.effectPending); return }
      if (result.checkpoint) run.checkpoint = { ...run.checkpoint, ...result.checkpoint }
      if (result.archive) run.archive = result.archive
      if (result.completeness) run.completeness = result.completeness
      run.failure = result.failure
      if (!['succeeded', 'waiting_remote', 'waiting_human', 'needs_review', 'needs_setup', 'paused', 'failed'].includes(result.status)) throw new Error('Invalid executor outcome')
      if (result.status === 'succeeded') {
        run.status = 'verifying'; this.save('verifying', { nodeId: node.id })
        const customVerifiers = {
          'https://www.bioinformatics.org/sms2/dna_stats.html': 'dna_stats',
          'https://www.bioinformatics.org/sms2/codon_usage.html': 'codon_usage',
          'https://web.expasy.org/protparam/': 'protparam',
          'https://web.expasy.org/protscale/': 'protscale',
          'https://www.ebi.ac.uk/QuickGO/': 'quickgo',
        }
        const configuredVerifier = customVerifiers[node.entryUrl] || (/^https:\/\/www\.ebi\.ac\.uk\/QuickGO\/term\/GO(?::|%3A)\d{7}$/i.test(node.entryUrl || '') ? 'quickgo' : null)
        const customVerified = configuredVerifier && result.evidence?.customVerifier === configuredVerifier && result.evidence?.inputSha256 === input.sha256
        if (!result.evidence?.verified || !result.artifacts?.length || (node.custom && !customVerified)) throw new Error('Unverified outcome cannot succeed')
        for (const artifact of result.artifacts) {
          const file = inside(this.store.dir, artifact.path)
          if (!artifact.verified || !fs.statSync(file).isFile() || fs.statSync(file).size === 0 || hash(fs.readFileSync(file)) !== artifact.sha256) throw new Error('Artifact integrity validation failed')
        }
        run.artifacts = result.artifacts; run.evidence = { ...result.evidence, inputSha256: input.sha256,
          parametersSha256: require('./analysis.cjs').fingerprint(node.parameters || {}) }; run.completedAt = new Date(this.now()).toISOString()
      }
      run.status = result.status; run.message = result.message || ''; run.resultUrl = result.resultUrl || run.resultUrl
      if (result.resultUrl && run.checkpoint.submitted && result.resultUrl !== this.session.recipeSnapshot[node.id]?.entryUrl) run.checkpoint.resultUrl = result.resultUrl
      if (result.status === 'waiting_remote') {
        run.remoteStartedAt ||= this.now(); run.pollCount = (run.pollCount || 0) + 1
        run.nextPollAt = this.now() + Math.min(this.pollMin * 2 ** Math.min(run.pollCount - 1, 10), this.pollMax)
      }
    }).catch(e => {
      if (this.session.status === 'cancelled' || run.cancelRequested) run.status = 'cancelled'
      else run.status = uncertain(run.checkpoint) ? 'needs_review' : 'failed'
      run.message = String(e.message || e).slice(0, 2000)
    }).finally(() => {
      this.active.delete(node.id); release(); this.save('node_finished', { nodeId: node.id, status: run.status }); this.tick()
    })
  }
  event(node, run, event) {
    if (this.closed || run.cancelRequested || this.session.status === 'cancelled') throw new Error('Execution cancelled')
    if (event.type === 'checkpoint') {
      run.checkpoint = { ...run.checkpoint, ...event.checkpoint }
      this.save('checkpoint', { nodeId: node.id })
    } else if (event.type === 'progress') {
      run.message = String(event.message || '').slice(0, 1000)
      run.actions = event.actions || 0; run.decisions = event.decisions || 0
      this.save('progress', { nodeId: node.id })
    }
    return { pause: Boolean(this.session.pauseRequested || run.takeoverRequested), cancel: Boolean(run.cancelRequested) }
  }
  deriveStatus() {
    if (this.session.status === 'cancelled') return
    let next = 'running'
    if (this.session.pauseRequested && !this.active.size) next = 'paused'
    else if (this.session.nodes.every(r => r.status === 'succeeded')) next = 'completed'
    else if (!this.active.size && this.session.nodes.every(r => TERMINAL.has(r.status) || r.status === 'succeeded')) next = 'partial'
    else if (!this.active.size && this.session.nodes.some(r => ['needs_review', 'waiting_human', 'needs_setup', 'paused'].includes(r.status))) next = 'needs_attention'
    else if (!this.active.size && this.session.nodes.some(r => r.status === 'waiting_remote')) next = 'waiting_remote'
    if (next !== this.session.status) { this.session.status = next; this.save('status') }
  }
  pause() {
    if (['completed', 'partial', 'cancelled'].includes(this.session.status)) return
    this.session.pauseRequested = true
    for (const handle of this.active.values()) handle.control?.('pause')
    this.save('pause_requested'); this.tick()
  }
  resume() {
    if (this.session.status === 'completed' || this.session.status === 'cancelled') throw new Error('This run is terminal; clone it to run again')
    this.session.pauseRequested = false
    for (const run of this.session.nodes) if (run.status === 'paused') run.status = uncertain(run.checkpoint) ? 'needs_review' : run.checkpoint.submitted ? 'waiting_remote' : 'ready'
    for (const run of this.session.nodes) if (run.status === 'waiting_remote') run.nextPollAt = 0
    this.session.status = 'running'; this.save('resumed'); this.tick()
  }
  retry(id) {
    if (this.session.status === 'cancelled' || this.session.status === 'completed') throw new Error('This run is terminal; clone it to run again')
    const run = this.session.nodes.find(r => r.id === id)
    if (!run || this.active.has(id)) throw new Error('Node is active or missing')
    if (uncertain(run.checkpoint)) throw new Error('Submission is uncertain. Inspect and reconcile its existing job before retrying.')
    if (!['failed', 'needs_setup', 'blocked', 'waiting_human', 'needs_review', 'paused'].includes(run.status)) throw new Error('Node cannot be retried in its current state')
    run.status = run.checkpoint.submitted ? 'waiting_remote' : 'ready'; run.nextPollAt = 0; run.takeoverRequested = false
    for (const child of this.session.nodes) if (child.status === 'blocked') child.status = 'ready'
    this.session.pauseRequested = false; this.session.status = 'running'; this.save('retry', { nodeId: id }); this.tick()
  }
  revalidate(id) {
    const run = this.session.nodes.find(r => r.id === id)
    if (!run || run.status !== 'succeeded' || this.active.size || this.session.status === 'cancelled') throw new Error('Only an idle verified result can be revalidated')
    if (this.session.workflow.nodes.some(n => n.dependsOn.includes(id) && this.session.nodes.find(r => r.id === n.id).attempts)) throw new Error('Downstream already consumed this result; clone the workflow to revalidate it')
    run.artifacts = []; run.evidence = null; run.completedAt = null; run.status = 'needs_review'
    run.message = 'Previous validation revoked; independent result review is required'
    this.session.status = 'needs_attention'; this.save('revalidation_requested', { nodeId: id })
  }
  takeover(id) {
    const run = this.session.nodes.find(r => r.id === id)
    if (!run) throw new Error('Node missing')
    if (['succeeded', 'cancelled', 'failed', 'blocked'].includes(run.status) || this.session.status === 'cancelled') throw new Error('A terminal node cannot be taken over')
    run.takeoverRequested = true
    const active = this.active.get(id)
    if (active) active.control?.('pause')
    else run.status = 'waiting_human'
    this.save('takeover', { nodeId: id })
  }
  reconcile(id, { resultUrl, notSubmitted = false }) {
    const node = this.session.workflow.nodes.find(n => n.id === id)
    const run = this.session.nodes.find(n => n.id === id)
    if (!run || this.active.has(id) || !['needs_review', 'waiting_human', 'paused'].includes(run.status)) throw new Error('Pause the node before reconciliation')
    if (notSubmitted) {
      run.checkpoint = { ...run.checkpoint, effectPending: false, submitted: false, resultUrl: null, jobId: null,
        submission: { ...run.checkpoint.submission, phase: 'prepared', reconciledAt: new Date(this.now()).toISOString(), notSubmitted: true } }
      run.resultUrl = null
    }
    else {
      const recipe = this.session.recipeSnapshot[id]
      const url = new URL(resultUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !recipe.allowedHosts.includes(url.hostname)) throw new Error('Result URL is outside the site recipe')
      if (url.href === (recipe.entryUrl || node.entryUrl)) throw new Error('Use the actual job/result URL, not the entry page')
      run.checkpoint = { ...run.checkpoint, effectPending: false, submitted: true, resultUrl: url.href, reconciled: true, emailActivationRequired: false,
        submission: { ...run.checkpoint.submission, phase: 'receipt_known', resultUrl: url.href, reconciledAt: new Date(this.now()).toISOString() } }
    }
    this.save('reconciled', { nodeId: id, notSubmitted }); this.retry(id)
  }
  cancel() {
    this.session.status = 'cancelled'; this.session.pauseRequested = true
    for (const run of this.session.nodes) if (run.status !== 'succeeded') {
      run.cancelRequested = true; run.status = 'cancelled'; run.remoteMayContinue = Boolean(run.checkpoint.submitted || run.checkpoint.effectPending)
    }
    this.save('cancelled')
    for (const handle of this.active.values()) handle.control?.('cancel')
    clearTimeout(this.timer)
  }
  async shutdown() {
    if (['completed', 'partial', 'cancelled'].includes(this.session.status) && !this.active.size) { this.closed = true; clearTimeout(this.timer); return }
    this.pause(); clearTimeout(this.timer)
    const handles = [...this.active.values()]
    await Promise.allSettled(handles.map(h => h.stop?.()))
    this.closed = true
    for (const run of this.session.nodes) if (['running', 'verifying'].includes(run.status)) run.status = run.checkpoint.effectPending ? 'needs_review' : 'paused'
    this.session.status = this.session.status === 'cancelled' ? 'cancelled' : 'paused'; this.save('shutdown')
  }
}
module.exports = { WorkflowScheduler, Resources }

'use strict'
function resultStatus(item, run) {
  let state = 'not_started'
  if (item.checks.analysis === 'verified') state = 'result_available'
  else if (run?.checkpoint?.emailActivationRequired || run?.checkpoint?.emailActivationRequired == null && /private start link|human activation/i.test(run?.message || '')) state = 'email_activation'
  else if (run?.checkpoint?.effectPending || ['submitting', 'intent_saved', 'needs_reconciliation'].includes(run?.checkpoint?.submission?.phase)) state = 'submission_uncertain'
  else if (run?.status === 'waiting_remote') state = 'waiting_remote'
  else if (['running', 'verifying'].includes(run?.status)) state = 'running'
  else if (!item.integrityIssues?.length && item.artifacts.some(a => ['page', 'data', 'original_file'].includes(a.role))) state = 'result_available'
  else if (['failed', 'blocked'].includes(run?.status)) state = 'execution_failed'
  else if (['needs_review', 'waiting_human', 'needs_setup', 'paused'].includes(run?.status)) state = 'needs_attention'
  return { taskState: state }
}
module.exports = { resultStatus }

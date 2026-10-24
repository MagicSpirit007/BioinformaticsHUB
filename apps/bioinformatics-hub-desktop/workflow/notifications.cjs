'use strict'
const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
function notificationChoice(workflow, recipes, notification) {
  const sites = workflow.nodes.filter(n => n.kind === 'site').map(n => ({ node: n, recipe: recipes[n.siteId] }))
  const supported = sites.filter(s => ['optional', 'required'].includes(s.recipe?.emailNotification?.support))
  const required = supported.filter(s => s.recipe.emailNotification.support === 'required')
  const ask = (actionRequired, message) => ({ status: 'needs_choice', actionRequired, message,
    sites: supported.map(s => ({ siteId: s.node.siteId, name: s.recipe.name, ...s.recipe.emailNotification })) })
  if (supported.length && !['send', 'decline'].includes(notification?.choice)) return ask('choose_notification', '是否接收网站邮件通知？选择接收后请提供邮箱，并确认接收地址的网站。 / Choose whether to receive website email notifications.')
  if (notification?.choice === 'send') {
    if (!validEmail(notification.email)) return ask('provide_notification_email', '请提供有效的通知邮箱。 / Provide a valid notification email.')
    const allowed = new Set(supported.map(s => s.node.siteId))
    if (!Array.isArray(notification.siteIds) || !notification.siteIds.length || notification.siteIds.some(id => !allowed.has(id))) return ask('choose_notification_sites', '请明确选择支持邮件且已选中的网站。 / Confirm which selected sites receive your email.')
  }
  for (const { node, recipe } of required) {
    if (notification?.choice !== 'send' || !notification.siteIds?.includes(node.siteId)) return ask('required_notification_email', `${recipe.name} 必须提供邮箱；请同意或明确移除此网站。 / Email is required; approve or remove this site.`)
  }
  for (const { node, recipe } of sites) {
    const capability = recipe?.emailNotification
    const send = notification?.choice === 'send' && notification.siteIds?.includes(node.siteId)
    if (send && capability?.consentParameter && notification.consents?.[node.siteId] !== true) return ask('confirm_email_terms', `${recipe.name} 需要单独确认邮箱条款。 / Confirm this site's email storage terms.`)
    // Never allow legacy parameters to bypass the notification choice.
    if (node.parameters?.email && (!send || node.parameters.email !== notification.email.trim())) return ask('confirm_notification_parameters', '邮箱参数与通知选择不一致，请明确确认后继续。 / Email parameters conflict with the notification choice.')
  }
  for (const { node, recipe } of sites) {
    const capability = recipe?.emailNotification
    const send = notification?.choice === 'send' && notification.siteIds?.includes(node.siteId)
    node.emailNotification = { choice: send ? 'send' : 'decline' }
    if (['optional', 'required'].includes(capability?.support)) {
      node.parameters[capability.parameter || 'email'] = send ? notification.email.trim() : ''
      if (capability.consentParameter) node.parameters[capability.consentParameter] = send ? 'true' : 'false'
    }
  }
  return null
}
module.exports = { notificationChoice, validEmail }

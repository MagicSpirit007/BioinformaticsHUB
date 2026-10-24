'use strict'

const executionOptions = [
  { value: 'local', label: '本地分析工具 / Local analysis tools' },
  { value: 'web', label: '网页分析工具 / Web analysis tools' },
  { value: 'mixed', label: '本地与网页组合 / Local and web tools together' },
]

function executionChoice(executionMode, workflow) {
  if (executionMode != null && !executionOptions.some(option => option.value === executionMode)) throw new Error('Unknown executionMode; choose local, web or mixed')
  const conflicts = (workflow?.nodes || []).filter(node => executionMode === 'local' ? node.kind === 'site' : executionMode === 'web' ? node.kind === 'local' : false).map(node => node.id)
  if (executionMode && !conflicts.length) return null
  return {
    status: 'needs_choice', actionRequired: 'choose_execution', options: executionOptions, conflicts,
    message: conflicts.length
      ? '当前流程包含所选执行方式之外的步骤，请按用户选择修改流程；不得自动替换工具或删减分析。 / The workflow conflicts with the selected execution mode. Revise it with the user; do not switch tools or omit analyses automatically.'
      : '这次分析要使用本地工具、网页工具，还是两者组合？请先询问用户，再传入 executionMode；不得根据已安装工具或模板替用户决定。 / Ask the user to choose local, web or mixed tools before supplying executionMode. Installed tools and templates do not imply consent.',
  }
}

module.exports = { executionOptions, executionChoice }

import type { AnalysisDraft, WorkflowCatalog, EmailNotification, ExecutionMode } from './workflow'
export type ToolSelection = { kind: 'site' | 'local'; id: string; parameters: Record<string, string> }
export const localNames: Record<string, string> = { prepare: '序列准备 / Sequence preparation', nucleic: '核酸分析 / Nucleotide analysis', physchem: '理化性质 / Physicochemical properties', hydrophobicity: '疏水性 / Hydrophobicity', mafft: 'MAFFT', weblogo: 'WebLogo', iqtree: 'IQ-TREE', itol: 'iTOL 文件导出 / iTOL export' }
export function buildDraft(catalog: WorkflowCatalog, mode: ExecutionMode, selected: ToolSelection[], researchInput: string, notification?: EmailNotification): AnalysisDraft {
  const selectedTools = selected.map(tool => {
    const def = tool.kind === 'site' ? catalog.recipes[tool.id] : catalog.localTools[tool.id]
    return { ...tool, name: tool.kind === 'site' ? catalog.recipes[tool.id].name : localNames[tool.id] || tool.id, input: def.input }
  })
  const missing = ['提交前由助手核对准确序列、物种、来源、输入类型及必要的上游数据；不得自行替换研究对象或增删分析。']
  if (!researchInput.trim()) missing.unshift('补充研究对象、编号或序列。')
  for (const tool of selectedTools) {
    const def = tool.kind === 'site' ? catalog.recipes[tool.id] : catalog.localTools[tool.id]
    for (const p of def.parameters || []) if (!['email', 'emailConsent'].includes(p.id) && p.required && !tool.parameters[p.id]?.trim()) missing.push(`${tool.name}: 确认 ${p.label}`)
    if (tool.kind === 'site' && catalog.recipes[tool.id].emailNotification?.support === 'unknown') missing.push(`${tool.name}: 邮件能力待核实；发现必填邮箱时先询问用户。`)
  }
  return { schemaVersion: 1, executionMode: mode, researchInput: researchInput.trim(), selectedTools, ...(notification ? { notification } : {}), missingInformation: missing }
}
export function draftText(draft: AnalysisDraft) {
  return `请使用 BioinformaticsHUB 完成以下分析。先核对待补信息，构造并校验流程，再通过已有 CLI/MCP 启动。\n执行方式：${draft.executionMode}\n研究对象：${draft.researchInput || '待补充'}\n所选工具：\n${draft.selectedTools.map(t => `- ${t.name}（${t.kind}:${t.id}），输入：${t.input}；参数：${JSON.stringify(t.parameters)}`).join('\n')}\n邮件：${draft.notification?.choice === 'send' ? `接收网站原生通知；邮箱 ${draft.notification.email}；仅限 ${draft.notification.siteIds?.join('、')}。` : draft.notification?.choice === 'decline' ? '不接收邮件，不代填邮箱。' : '当前没有已确认支持通知的所选网站；发现要求时先询问。'}\n待核对：\n${draft.missingInformation.map(s => '- ' + s).join('\n')}\n提交状态不确定时核对原回执，不重复提交；保存原始结果与附件。\n以下为选择草稿，须转换为 WorkflowDefinition；不要把它直接作为 run start 的参数。\n\n\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\``
}

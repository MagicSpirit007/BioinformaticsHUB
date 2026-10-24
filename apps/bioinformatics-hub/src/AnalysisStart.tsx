import { useEffect, useState } from 'react'
import type { ExecutionMode, WorkflowApi, WorkflowCatalog } from './lib/workflow'
import { buildDraft, draftText, localNames, type ToolSelection } from './lib/analysisDraft'

export default function AnalysisStart({ api, en }: { api?: WorkflowApi; en: boolean }) {
  const inputLabels: Record<string, [string, string]> = { sequence: ['序列（FASTA）', 'Sequence (FASTA)'], protein_fasta: ['蛋白序列（FASTA）', 'Protein sequence (FASTA)'], nucleotide_fasta: ['核酸序列（FASTA）', 'Nucleotide sequence (FASTA)'], alignment_fasta: ['多序列（FASTA）', 'Multiple sequences (FASTA)'], tree: ['系统发育树（Newick）', 'Phylogenetic tree (Newick)'], structure: ['结构文件（PDB / CIF）', 'Structure (PDB / CIF)'], identifier: ['数据库编号', 'Database accession'] }
  const l = (zh: string, english: string) => en ? english : zh
  const [catalog, setCatalog] = useState<WorkflowCatalog | null>(null)
  const [mode, setMode] = useState<ExecutionMode | ''>('')
  const [selected, setSelected] = useState<ToolSelection[]>([])
  const [research, setResearch] = useState(''), [choice, setChoice] = useState(''), [email, setEmail] = useState('')
  const [consents, setConsents] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState(''), [error, setError] = useState('')
  useEffect(() => { let active = true; if (api) void api.catalog().then(c => { if (active) setCatalog(c) }).catch(e => { if (active) setError(String(e)) }); return () => { active = false } }, [api])
  if (!catalog) return <p>{error || l('正在读取工具目录…', 'Loading tool catalog…')}</p>
  const conflicts = selected.filter(t => mode === 'local' && t.kind === 'site' || mode === 'web' && t.kind === 'local')
  const mailSites = selected.filter(t => t.kind === 'site' && ['optional', 'required'].includes(catalog.recipes[t.id].emailNotification?.support || ''))
  const required = mailSites.filter(t => catalog.recipes[t.id].emailNotification?.support === 'required')
  const termSites = mailSites.filter(t => catalog.recipes[t.id].emailNotification?.consentParameter)
  const mailError = mailSites.length && (!choice ? l('请选择是否接收网站邮件通知。', 'Choose whether to receive website email.') : choice === 'send' && (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email.trim()) || email.trim().length > 254) ? l('请输入有效邮箱。', 'Enter a valid email.') : choice === 'decline' && required.length ? l('所选网站需要邮箱，请选择接收或自行取消该网站。', 'A selected site requires email; enable it or deselect that site.') : choice === 'send' && termSites.some(t => !consents[t.id]) ? l('请单独确认网站的邮箱保存条款。', 'Confirm each site’s email terms.') : '')
  const blocked = !mode || !selected.length || conflicts.length > 0 || Boolean(mailError)
  const notification = mailSites.length && choice ? choice === 'send' ? { choice: 'send' as const, email: email.trim(), siteIds: mailSites.map(t => t.id), consents: Object.fromEntries(termSites.map(t => [t.id, Boolean(consents[t.id])])) } : { choice: 'decline' as const } : undefined
  const draft = mode ? buildDraft(catalog, mode, selected, research, notification) : null
  const text = draft ? draftText(draft) : ''
  function toggle(kind: 'site' | 'local', id: string) {
    setMessage('')
    const def = kind === 'site' ? catalog!.recipes[id] : catalog!.localTools[id]
    setSelected(previous => previous.some(t => t.kind === kind && t.id === id) ? previous.filter(t => !(t.kind === kind && t.id === id)) : [...previous, { kind, id, parameters: Object.fromEntries((def.parameters || []).filter(p => p.default != null && !['email', 'emailConsent'].includes(p.id)).map(p => [p.id, p.default!])) }])
    if (kind === 'site' && ['optional', 'required'].includes(catalog!.recipes[id].emailNotification?.support || '')) { setChoice(''); setConsents({}) }
  }
  async function output(save: boolean) {
    if (blocked || !draft || !api) return
    setError(''); setMessage('')
    try {
      if (save) { const result = await api.saveDraft(draft); if (result.path) setMessage(l('配置已保存：', 'Saved configuration: ') + result.path) }
      else { await api.copyText(text); setMessage(l('任务说明已复制，粘贴给助手后由助手核对并启动。', 'Copied. Paste into your assistant to review and start.')) }
    } catch (e) { setError(String(e)) }
  }
  return <section className="wf-start" aria-label={l('选择分析工具', 'Choose analysis tools')}>
    <p>{l('选择工具与参数，复制任务说明交给助手。', 'Choose tools and parameters, then copy the task to your assistant.')}</p>
    <fieldset className="wf-execution-choice"><legend>{l('1 · 选择执行方式', '1 · Execution mode')}</legend><div className="wf-actions">{(['web', 'local', 'mixed'] as const).map((m, i) => <label key={m}><input type="radio" name="execution-mode" value={m} checked={mode === m} onChange={() => { setMode(m); setMessage('') }} />{[l('网页分析', 'Web analyses'), l('本地分析', 'Local analyses'), l('网页与本地组合', 'Web and local')][i]}</label>)}</div></fieldset>
    {conflicts.length > 0 && <div className="wf-alert" role="alert"><div>{l('执行方式与以下已选工具冲突，请调整方式或手动取消：', 'The mode conflicts with these selections; change the mode or remove them: ')}{conflicts.map(t => <button key={`${t.kind}:${t.id}`} onClick={() => toggle(t.kind, t.id)}>{l('取消', 'Remove')} {t.kind === 'site' ? catalog.recipes[t.id].name : localNames[t.id]}</button>)}</div></div>}
    <section className="wf-section"><h2>{l('2 · 选择工具与参数', '2 · Tools and parameters')}</h2>{!mode && <p>{l('先选择执行方式。', 'Choose an execution mode first.')}</p>}
    {mode && (['site', 'local'] as const).filter(kind => mode === 'mixed' || (mode === 'web' ? kind === 'site' : kind === 'local')).map(kind => <div key={kind}><h3>{kind === 'site' ? l('分析网站', 'Analysis websites') : l('本地工具', 'Local tools')}</h3><div className="wf-tool-grid">{Object.entries(kind === 'site' ? catalog.recipes : catalog.localTools).map(([id, def]) => {
      const value = selected.find(t => t.kind === kind && t.id === id), recipe = kind === 'site' ? catalog.recipes[id] : undefined
      return <article className={`wf-tool ${value ? 'selected' : ''}`} key={id}>
        <label className="wf-confirm"><input type="checkbox" checked={Boolean(value)} onChange={() => toggle(kind, id)} /><strong>{recipe?.name || localNames[id] || id}</strong></label>
        <p className="wf-dependency">{l('需要输入', 'Required input')}: {inputLabels[def.input]?.[en ? 1 : 0] || def.input}</p>
        {recipe && <small>{l('邮件通知', 'Email')}: {({ optional: l('可选', 'Optional'), required: l('必需', 'Required'), unsupported: l('不支持', 'Unsupported'), unknown: l('待核实', 'Unconfirmed') })[recipe.emailNotification?.support || 'unknown']}</small>}
        {value && <div className="wf-tool-parameters">{(def.parameters || []).filter(p => !['email', 'emailConsent'].includes(p.id)).map(p => <label key={p.id}>{p.label}{p.required ? ' *' : ''}{p.options ? <select value={value.parameters[p.id] || ''} onChange={e => setSelected(selected.map(t => t === value ? { ...t, parameters: { ...t.parameters, [p.id]: e.target.value } } : t))}><option value="">{l('请确认', 'Confirm')}</option>{p.options.map(v => <option key={v}>{v}</option>)}</select> : <input value={value.parameters[p.id] || ''} onChange={e => setSelected(selected.map(t => t === value ? { ...t, parameters: { ...t.parameters, [p.id]: e.target.value } } : t))} />}</label>)}</div>}
      </article>
    })}</div></div>)}</section>
    <section className="wf-section wf-inputs"><label>{l('3 · 研究对象说明（可由助手补充）', '3 · Research input (the assistant can help complete this)')}<textarea rows={4} value={research} maxLength={100000} onChange={e => setResearch(e.target.value)} placeholder={l('编号、物种、序列或文件位置，以及分析目的', 'Identifier, species, sequence or file location, and analysis goal')} /></label></section>
    {mailSites.length > 0 && <fieldset className="wf-execution-choice"><legend>{l('是否接收网站邮件通知？', 'Receive email notifications from the websites?')}</legend><p>{l('邮箱将提供给：', 'Your address will be provided to: ')}{mailSites.map(t => catalog.recipes[t.id].name).join('、')}</p><div className="wf-actions">{['send', 'decline'].map(c => <label key={c}><input type="radio" name="email-choice" checked={choice === c} onChange={() => { setChoice(c); if (c === 'decline') { setEmail(''); setConsents({}) } }} />{c === 'send' ? l('接收', 'Receive') : l('不接收', 'Do not receive')}</label>)}</div>
      {choice === 'send' && <div className="wf-fields"><label>{l('通知邮箱（仅本次配置）', 'Email (this configuration only)')}<input type="email" autoComplete="off" value={email} maxLength={254} onChange={e => setEmail(e.target.value)} /></label>{termSites.map(t => <label className="wf-confirm" key={t.id}><input type="checkbox" checked={Boolean(consents[t.id])} onChange={e => setConsents({ ...consents, [t.id]: e.target.checked })} />{l('同意该网站保存通知邮箱：', 'Allow this site to store my notification email: ')}<a href={catalog.recipes[t.id].entryUrl} target="_blank" rel="noreferrer">{catalog.recipes[t.id].name}</a></label>)}</div>}
      {mailError && <p className="wf-archive-note">{mailError}</p>}<p>{l('邮件由原网站发送；填写邮箱不代表已发送邮件。部分网站需要点击邮件中的启动链接。', 'The website sends the email; entering an address does not confirm delivery. Some sites require an activation link.')}</p>
    </fieldset>}
    <section className="wf-section"><h2>{l('交给助手', 'Hand off to your assistant')}</h2><p>{l('已选择', 'Selected')}: {selected.length} {l('项。复制与保存只生成配置，不启动分析。', 'tools. Copying and saving only prepare a configuration.')}</p><div className="wf-actions"><button className="wf-primary" disabled={blocked || !api} onClick={() => void output(false)}>{l('复制任务说明', 'Copy task instructions')}</button><button disabled={blocked || !api} onClick={() => void output(true)}>{l('保存 JSON', 'Save JSON')}</button><button onClick={() => { setMode(''); setSelected([]); setResearch(''); setChoice(''); setEmail(''); setConsents({}); setMessage(''); setError('') }}>{l('清空并开始新配置', 'Clear and start a new configuration')}</button></div>
      {message && <p className="wf-notice" role="status">{message}</p>}{error && <p className="wf-alert" role="alert">{error}</p>}
      {draft && <details className="wf-draft-preview"><summary>{l('预览任务说明与配置（包含所填邮箱）', 'Preview instructions and configuration (includes the entered email)')}</summary><pre>{text}</pre></details>}
    </section>
  </section>
}

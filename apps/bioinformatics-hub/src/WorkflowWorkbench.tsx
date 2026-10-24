import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from './i18n'
import type { DeliveryItem, DeliveryResults, ExportResult, OpenPagesResult, WorkflowHistory, WorkflowSession, WorkflowSettings } from './lib/workflow'
import './WorkflowWorkbench.css'
import AnalysisStart from './AnalysisStart'
import ResultActions, { openMessage } from './ResultActions'

type DeleteTarget = { id: string; name: string }
type ExportState = ExportResult & { id: string }
const errorMessage = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error)
  // Electron prefixes rejected invoke() calls with "Error invoking remote method '<channel>':".
  return text.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

function Thumbnail({ id, item }: { id: string; item: DeliveryItem }) {
  const [url, setUrl] = useState('')
  const image = item.artifacts.find(a => /\.(png|jpe?g|webp)$/i.test(a.path) && a.bytes <= 12 * 1024 * 1024)
  useEffect(() => {
    let active = true
    setUrl('')
    if (image && window.workflowHub) void window.workflowHub.thumbnail({ id, artifactPath: image.path }).then(v => { if (active) setUrl(v.url) }).catch(() => {})
    return () => { active = false }
  }, [id, image?.path, image?.sha256])
  return url ? <img className="wf-thumbnail" src={url} alt={item.name} loading="lazy" /> : <div className="wf-thumbnail wf-placeholder" aria-hidden="true">{item.kind === 'website' ? 'HTML' : 'FILE'}</div>
}

function DeleteDialog({ target, en, deleting, error, onCancel, onConfirm }: { target: DeleteTarget; en: boolean; deleting: boolean; error: string; onCancel: () => void; onConfirm: () => void }) {
  const l = (zh: string, english: string) => en ? english : zh
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    return () => { if (trigger?.isConnected) trigger.focus() }
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting) { event.preventDefault(); onCancel() }
      if (event.key === 'Tab') {
        const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
        const first = buttons[0], last = buttons.at(-1)
        if (!first) { event.preventDefault(); dialogRef.current?.focus() }
        else if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [deleting, onCancel])
  return createPortal(
    <div className="wf-scrim" onMouseDown={() => { if (!deleting) onCancel() }}>
      <div ref={dialogRef} tabIndex={-1} className="wf-dialog" role="dialog" aria-modal="true" aria-labelledby="wf-delete-heading" onMouseDown={event => event.stopPropagation()}>
        <h2 id="wf-delete-heading">{l('永久删除这个任务？', 'Permanently delete this task?')}</h2>
        <p className="wf-delete-name"><strong>{target.name}</strong><code>{target.id}</code></p>
        <p>{l('将永久删除以下内容，不能撤销：', 'The following will be permanently deleted, with no undo:')}</p>
        <ul>
          <li>{l('任务记录与执行历史', 'The task record and its execution history')}</li>
          <li>{l('保存的网页、图表和附件', 'Saved pages, figures and attachments')}</li>
          <li>{l('该任务目录内的导出文件', 'Export files inside this task directory')}</li>
        </ul>
        <p className="wf-danger-note">{l('其他任务、外部原始输入以及已另存到该目录外的文件不会被删除。', 'Other tasks, external source inputs and files copied outside this task directory are not deleted.')}</p>
        {error && <div className="wf-alert" role="alert">{error}</div>}
        <div className="wf-dialog-actions">
          <button ref={cancelRef} onClick={onCancel} disabled={deleting}>{l('取消', 'Cancel')}</button>
          <button className="wf-danger" onClick={onConfirm} disabled={deleting}>{deleting ? l('正在删除…', 'Deleting…') : l('永久删除', 'Delete permanently')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default function WorkflowWorkbench() {
  const { locale, setLocale } = useI18n()
  const en = locale === 'en', l = (zh: string, english: string) => en ? english : zh
  const api = window.workflowHub
  const [tab, setTab] = useState<'start' | 'results' | 'history' | 'settings'>('start')
  const refreshing = useRef<number | null>(null)
  const workspaceGeneration = useRef(0)
  const [workspaceRevision, setWorkspaceRevision] = useState(0)
  const retryDetails = useRef<() => Promise<void>>(async () => {})
  const lastDelivery = useRef('')
  const historyLoaded = useRef(false)
  const listGeneration = useRef(0)
  const deletedIds = useRef(new Set<string>())
  const selectedRef = useRef('')
  const [history, setHistory] = useState<WorkflowHistory[]>([])
  const [selected, setSelected] = useState('')
  const [results, setResults] = useState<DeliveryResults | null>(null)
  const [session, setSession] = useState<WorkflowSession | null>(null)
  const [settings, setSettings] = useState<WorkflowSettings | null>(null)
  const [actionError, setActionError] = useState(''), [notice, setNotice] = useState('')
  const [refreshFailure, setRefreshFailure] = useState<{ scope: 'list' | 'detail'; message: string } | null>(null)
  const [busy, setBusy] = useState(false), [exporting, setExporting] = useState(false), [exportInfo, setExportInfo] = useState<ExportState | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null), [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState('')
  const labels: Record<string, string> = {
    submission_uncertain: l('提交状态待核对', 'Submission needs reconciliation'), email_activation: l('需要邮件激活', 'Email activation required'), execution_failed: l('执行失败', 'Execution failed'), result_available: l('已有结果', 'Results available'), not_started: l('尚未取得结果', 'No result yet'),
    verified: l('已核验', 'Verified'), complete: l('完整', 'Complete'), partial: l('部分交付', 'Partial delivery'),
    unverified: l('未核验', 'Unverified'), not_applicable: l('不适用', 'Not applicable'), not_saved: l('未保存', 'Not saved'),
    not_required: l('无需附件', 'No attachments required'),
    failed: l('失败', 'Failed'), succeeded: l('执行成功', 'Execution succeeded'), completed: l('执行完成', 'Execution completed'),
    running: l('执行中', 'Running'), waiting_remote: l('网站计算中', 'Remote computation'), needs_attention: l('等待处理', 'Needs attention'),
    waiting_human: l('需要处理', 'Action required'), needs_review: l('待核验', 'Needs review'), paused: l('已暂停', 'Paused'),
    needs_input: l('等待外层助手确认输入', 'Awaiting input from the calling assistant'), cancelled: l('已取消', 'Cancelled'), blocked: l('受阻', 'Blocked'),
  }
  const status = (value?: string) => labels[value || 'unverified'] || value
  function taskGuard(id: string) {
    const generation = workspaceGeneration.current
    return () => generation === workspaceGeneration.current && selectedRef.current === id && !deletedIds.current.has(id)
  }
  async function act(fn: (isCurrent: () => boolean) => Promise<void>, taskId?: string) {
    const isCurrent = taskId ? taskGuard(taskId) : () => true
    setBusy(true); setActionError(''); setNotice('')
    try { await fn(isCurrent) } catch (error) { if (isCurrent()) setActionError(errorMessage(error)) } finally { setBusy(false) }
  }
  const refresh = useCallback(async () => {
    const generation = listGeneration.current
    if (!api || refreshing.current === generation) return
    refreshing.current = generation
    try {
      const entries = (await api.list()).filter(item => !deletedIds.current.has(item.id))
      if (generation !== listGeneration.current) return
      setHistory(entries)
      const delivered = entries.filter(e => e.delivery?.at).sort((a, b) => b.delivery!.at!.localeCompare(a.delivery!.at!))[0]
      if (delivered?.delivery?.at) {
        if (historyLoaded.current && delivered.delivery.at > lastDelivery.current) setSelected(delivered.id)
        lastDelivery.current = delivered.delivery.at
      }
      historyLoaded.current = true
      setSelected(current => current && entries.some(entry => entry.id === current) ? current : (entries[0]?.id || ''))
      setRefreshFailure(current => current?.scope === 'list' ? null : current)
    } catch (error) {
      if (generation === listGeneration.current) setRefreshFailure({ scope: 'list', message: errorMessage(error) })
    } finally { if (refreshing.current === generation) refreshing.current = null }
  }, [api])
  useEffect(() => {
    let active = true
    if (api) {
      void refresh()
      void api.settings().then(value => { if (active) setSettings(value) }).catch(error => { if (active) setRefreshFailure({ scope: 'list', message: errorMessage(error) }) })
    }
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => { active = false; clearInterval(timer) }
  }, [api, refresh])
  useEffect(() => {
    selectedRef.current = selected
    if (!api || !selected) {
      setResults(null); setSession(null)
      setRefreshFailure(current => current?.scope === 'list' ? current : null)
      return
    }
    let active = true, pending = false
    const generation = workspaceGeneration.current
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const [r, s] = await Promise.all([api.results(selected), api.load(selected)])
        if (active && generation === workspaceGeneration.current && selectedRef.current === selected && !deletedIds.current.has(selected)) {
          setResults(r); setSession(s)
          setRefreshFailure(current => current?.scope === 'detail' ? null : current)
        }
      } catch (error) {
        // A transient refresh failure keeps the last successfully loaded results.
        if (active && generation === workspaceGeneration.current && selectedRef.current === selected) setRefreshFailure({ scope: 'detail', message: errorMessage(error) })
      } finally { pending = false }
    }
    setResults(null); setSession(null)
    setRefreshFailure(current => current?.scope === 'list' ? current : null)
    retryDetails.current = load
    void load()
    const timer = setInterval(() => { void load() }, 3000)
    return () => { active = false; clearInterval(timer); if (retryDetails.current === load) retryDetails.current = async () => {} }
  }, [api, selected, workspaceRevision])
  function selectTask(id: string) {
    if (id === selected) return
    selectedRef.current = id
    setSelected(id); setExportInfo(null); setNotice(''); setActionError('')
  }
  function openedNotice(value: OpenPagesResult) {
    setNotice(openMessage(value, en))
  }
  async function exportResults() {
    if (!api || !selected || exporting) return
    const id = selected
    const isCurrent = taskGuard(id)
    setExporting(true); setActionError(''); setNotice(''); setExportInfo(null)
    try {
      const output = await api.export(id)
      if (!isCurrent()) return
      const gaps = output.gaps || []
      const offlineComplete = output.verification?.status === 'complete'
      setExportInfo({ ...output, id, gaps })
      setNotice(output.verification?.status === 'not_run'
        ? l('成果已导出，本次未重新核验网页显示。', 'Results exported; webpage rendering was not reverified this time.')
        : offlineComplete && !gaps.length
        ? l('导出完成，离线核验与交付检查均通过。', 'Export complete; offline verification and delivery checks passed.')
        : offlineComplete
          ? l(`导出完成；离线核验通过，但交付仍有 ${gaps.length} 项缺口，未宣称全部通过。`, `Export complete; offline verification passed, but ${gaps.length} delivery gaps remain. This is not a complete pass.`)
          : l('导出完成，但离线核验不完整；请在核验报告中查看未通过项。', 'Export complete, but offline verification is incomplete; review the acceptance report for gaps.'))
    } catch (error) {
      if (isCurrent()) setActionError(l('导出失败：', 'Export failed: ') + errorMessage(error))
    } finally { setExporting(false) }
  }
  async function openExportFolder() {
    if (!api || !exportInfo) return
    const isCurrent = taskGuard(exportInfo.id)
    setActionError('')
    try { await api.showExport({ id: exportInfo.id, directory: exportInfo.directory }) }
    catch (error) { if (isCurrent()) setActionError(l('无法打开导出目录：', 'Cannot open the export folder: ') + errorMessage(error)) }
  }
  async function confirmDelete() {
    if (!api || !deleteTarget || deleting) return
    const target = deleteTarget
    setDeleting(true); setDeleteError('')
    try {
      const output = await api.delete(target.id)
      const removed = output?.id || target.id
      deletedIds.current.add(removed)
      listGeneration.current++
      const previous = history, at = previous.findIndex(item => item.id === removed)
      const remaining = previous.filter(item => item.id !== removed)
      setHistory(remaining)
      setDeleteTarget(null)
      if (selectedRef.current === removed || selected === removed) {
        const next = remaining[at]?.id || remaining[at - 1]?.id || remaining[0]?.id || ''
        selectedRef.current = next
        setResults(null); setSession(null); setExportInfo(null); setNotice(''); setActionError('')
        setSelected(next)
      }
      setNotice(l('任务及其保存的网页、附件和导出文件已永久删除。', 'The task, its saved pages, attachments and export files were permanently deleted.'))
      await refresh()
    } catch (error) { setDeleteError(errorMessage(error)) }
    finally { setDeleting(false) }
  }
  function requestDelete(id: string, name: string) {
    setDeleteError(''); setDeleteTarget({ id, name })
  }
  const taskRows = (compact: boolean) => history.map(item => <div className={`wf-history-row ${compact ? 'compact' : ''} ${selected === item.id ? 'selected' : ''}`} role="group" aria-label={item.name} key={item.id}>
    <button className={`wf-history ${selected === item.id ? 'selected' : ''}`} onClick={() => selectTask(item.id)}><strong>{item.name}</strong><span>{status(item.delivery?.status || item.status)}</span><time>{new Date(item.updatedAt).toLocaleString()}</time></button>
    <button className="wf-delete" title={l('删除', 'Delete')} aria-label={`${l('删除任务', 'Delete task')} ${item.name}`} onClick={() => requestDelete(item.id, item.name)}>{l('删除', 'Delete')}</button>
  </div>)
  return <div className="workflow-workbench">
    <header className="wf-header"><button className="wf-brand" onClick={() => setTab('start')}>BioinformaticsHUB <span>ORIGINAL RESULTS</span></button><nav aria-label={l('工作区', 'Workspace')}>
      {(['start', 'results', 'history', 'settings'] as const).map((key, i) => <button key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>{[l('开始', 'Start'), l('成果目录', 'Results'), l('历史记录', 'History'), l('系统设置', 'Settings')][i]}</button>)}
      <button onClick={() => setLocale(en ? 'zh' : 'en')}>{en ? '中文' : 'EN'}</button>
    </nav></header>
    <main>
      <div className="wf-intro wf-intro-compact"><p className="wf-eyebrow">SAVED PAGES · ORIGINAL FILES</p><h1>{tab === 'start' ? l('配置分析任务', 'Prepare an analysis task') : tab === 'settings' ? l('存储与连接', 'Storage and connections') : tab === 'history' ? l('历史研究记录', 'Research history') : l('原始分析成果', 'Original analysis results')}</h1></div>
      {!api && <p className="wf-notice">{l('桌面应用连接后，成果会显示在这里。', 'Results appear here when connected to the desktop application.')}</p>}
      {refreshFailure && <div className="wf-alert wf-alert-refresh" role="status"><span>{refreshFailure.scope === 'list' ? l('成果刷新暂时失败，已保留当前内容：', 'Results refresh failed; the last loaded content is still shown: ') : l('任务详情读取暂时失败，已保留当前内容：', 'Task details could not be refreshed; the last loaded content is still shown: ')}{refreshFailure.message}</span><button onClick={() => { if (refreshFailure.scope === 'detail') void retryDetails.current(); else void refresh() }}>{l('重试', 'Retry')}</button></div>}
      {actionError && <div className="wf-alert" role="alert">{actionError}<button aria-label={l('关闭提示', 'Dismiss')} onClick={() => setActionError('')}>×</button></div>}
      {notice && <p className="wf-notice" role="status">{notice}</p>}
      <div hidden={tab !== 'start'}><AnalysisStart api={api} en={en} /></div>
      {tab === 'results' && <div className="wf-result-layout">
        <aside className="wf-section wf-task-directory"><h2>{l('研究任务', 'Research tasks')}</h2>
          {!history.length && <p>{l('暂无成果。外层助手完成任务后，原始网页与附件会保存在这里。', 'No results yet. Saved pages and files from your assistant appear here.')}</p>}
          {taskRows(true)}
        </aside>
        <section className="wf-section wf-result-directory">{!history.length ? <div className="wf-empty-state"><h2>{l('暂无研究任务', 'No research tasks')}</h2><p>{l('任务被删除后会显示在这里为空。外层助手完成后，保存的网页与附件会出现在此处。', 'Deleted tasks leave this list empty. Saved pages and files appear here after your assistant finishes.')}</p></div> : session && results ? <>
          <div className="wf-run-title"><div><p className="wf-eyebrow">{session.id}</p><h2>{session.name}</h2><p>{l('交付', 'Delivery')}: {status(results.delivery?.status)}{results.delivery ? ` · ${results.delivery.recorded}/${results.delivery.expected}` : ''}</p></div><div className="wf-actions">
            <button className="wf-primary" disabled={busy || exporting} onClick={() => void act(async isCurrent => { const out = await api!.resultsOpenAll({ id: selected }); if (isCurrent()) openedNotice(out) }, selected)}>{busy ? l('正在处理…', 'Working…') : l('打开全部网页', 'Open all pages')}</button>
            <button disabled={busy || exporting} onClick={() => void act(async isCurrent => { const out = await api!.resultsVerify({ id: selected }); if (!isCurrent()) return; setResults(out.results); setNotice(out.status === 'complete' ? l('离线显示及附件核验通过', 'Offline rendering and files verified') : l('核验发现缺口，请查看各项详情', 'Verification found gaps; see item details')) }, selected)}>{l('核验保存结果', 'Verify saved results')}</button>
            <button disabled={busy || exporting} onClick={() => void act(async isCurrent => { const out = await api!.resultsValidate({ id: selected }); if (!isCurrent()) return; setResults(out); setNotice(l('已按原输入重新核验分析数据，请查看各项状态。', 'Scientific outputs checked against original inputs; see item status.')) }, selected)}>{l('核验分析数据', 'Validate analysis data')}</button>
            <button disabled={busy || exporting} onClick={() => void exportResults()}>{exporting ? l('正在导出…', 'Exporting…') : l('导出成果', 'Export results')}</button>
          </div></div>
          {exportInfo && exportInfo.id === selected && <div className="wf-export-result" role="status">
            <p><strong>{l('导出位置', 'Export location')}</strong><code>{exportInfo.directory}</code></p>
            <p>{exportInfo.verification?.status === 'not_run'
              ? l('文件完整性检查已完成；本次未重新核验网页显示。可使用“核验保存结果”检查已保存成果，已有交付缺口见下方及导出报告。', 'File integrity checks completed; webpage rendering was not reverified this time. Use “Verify saved results” to check saved results. Existing delivery gaps are listed below and in the export report.')
              : exportInfo.verification?.status === 'complete'
              ? (exportInfo.gaps?.length ? l('离线核验通过；交付仍有缺口，未宣称全部通过。', 'Offline verification passed; delivery gaps remain, so this is not a complete pass.') : l('离线核验与交付检查均通过。', 'Offline verification and delivery checks passed.'))
              : l('核验不完整：以下项目仍有缺口，未宣称全部通过。', 'Verification incomplete: the items below still have gaps; this is not a complete pass.')}</p>
            {exportInfo.verification?.items?.some(item => item.issues.length > 0) && <ul>{exportInfo.verification.items.filter(item => item.issues.length > 0).map(item => <li key={item.itemId}><strong>{item.itemId}</strong>: {item.issues.join('; ')}</li>)}</ul>}
            {(exportInfo.gaps?.length || 0) > 0 && <details><summary>{l('交付缺口', 'Delivery gaps')} ({exportInfo.gaps!.length})</summary><ul>{exportInfo.gaps!.map((gap, index) => <li key={index}><strong>{gap.itemId}</strong>: {gap.message}</li>)}</ul></details>}
            <button onClick={() => void openExportFolder()}>{l('打开导出目录', 'Open export folder')}</button>
          </div>}
          <div className="wf-result-cards">{results.results.map(item => <article className="wf-result-card" key={item.id}>
            <Thumbnail id={selected} item={item} />
            <div className="wf-card-content"><div className="wf-node-heading"><h3>{item.name}</h3><span className={`wf-status ${item.checks.analysis}`}>{status(item.checks.analysis)}</span></div>
              <dl className="wf-quality">{(['analysis', 'visual', 'archive', 'downloads'] as const).map((key, i) => <div key={key}><dt>{[l('分析结果', 'Analysis'), l('图表', 'Figures'), l('网页保存', 'Page archive'), l('附件下载', 'Downloads')][i]}</dt><dd>{status(item.checks[key])}</dd></div>)}</dl>
              {item.sourceUrl && <p className="wf-result-url">{item.sourceUrl}</p>}
              {item.capturedAt && <p>{l('保存于', 'Saved at')} {new Date(item.capturedAt).toLocaleString()}</p>}
              <p className="wf-task-state"><strong>{status(item.taskState)}</strong>{item.taskState === 'submission_uncertain' && <span> · {l('尚无可靠作业号或结果回执，请核对原任务。', 'No reliable job ID or result receipt; reconcile the original job.')}</span>}</p>
              {api && <ResultActions key={workspaceRevision + ':' + selected + ':' + item.id} api={api} taskId={selected} item={item} node={session.nodes.find(n => n.id === item.nodeId)} en={en} reload={async () => { const isCurrent = taskGuard(selected); const [r, s] = await Promise.all([api.results(selected), api.load(selected)]); if (isCurrent()) { setResults(r); setSession(s) } }} />}
              {(item.message || item.gaps.length > 0) && <details><summary>{l('保存与核验详情', 'Saving and verification details')} ({item.gaps.length})</summary>{item.message && <p className="wf-archive-note">{item.message}</p>}<ul>{item.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></details>}
            </div>
          </article>)}</div>
          <details className="wf-execution-history"><summary>{l('原生执行记录', 'Original execution history')} · {status(session.status)}</summary><ol>{session.nodes.map(node => <li key={node.id}><strong>{node.id}</strong> · {status(node.status)}<p>{node.message}</p>{node.failure && <p>{node.failure.stage} · {node.failure.category}{node.failure.details && <><br />{node.failure.details.field?.label || node.failure.details.field?.node} · {l('期望长度', 'Expected length')} {node.failure.details.expectedSequenceLength} · {l('实际长度', 'Actual length')} {node.failure.details.actualSequenceLength}<br />{l('首个差异位置', 'First difference')}: {node.failure.details.firstDifference}<br /><code>{node.failure.details.expectedExcerpt}</code> → <code>{node.failure.details.actualExcerpt}</code></>}</p>}</li>)}</ol></details>
        </> : <p>{selected ? l('正在读取成果…', 'Loading results…') : l('选择任务查看保存的网页与文件。', 'Select a task to view saved pages and files.')}</p>}</section>
      </div>}
      {tab === 'history' && <section className="wf-section"><h2>{l('历史研究记录', 'Research history')}</h2>{!history.length && <p>{l('暂无历史任务。', 'No research history yet.')}</p>}{taskRows(false)}</section>}
      {tab === 'settings' && settings && <section className="wf-section"><h2>{l('当前工作区', 'Current workspace')}</h2><dl className="wf-storage"><dt>{l('任务存储', 'Task storage')}</dt><dd>{settings.workspace?.runsRoot}</dd><dt>{l('配置位置', 'Configuration')}</dt><dd>{settings.workspace?.dataDir}</dd><dt>{l('连接标识', 'Connection identity')}</dt><dd>{settings.workspace?.id} · {settings.workspace?.runtime}</dd></dl>
        <button disabled={busy || exporting || deleting} onClick={() => void act(async () => { const next = await api!.selectWorkspace(); if (next) { workspaceGeneration.current++; listGeneration.current++; deletedIds.current.clear(); selectedRef.current = ''; lastDelivery.current = ''; historyLoaded.current = false; setWorkspaceRevision(value => value + 1); setHistory([]); setSettings(next); setSelected(''); setResults(null); setSession(null); setExportInfo(null); setDeleteTarget(null); setRefreshFailure(null); setNotice(''); setActionError(''); await refresh() } })}>{l('选择任务存储目录', 'Choose task storage')}</button><h2>{l('执行连接', 'Execution connections')}</h2><div className="wf-fields">{(['chromeUrl', 'browserPython', 'localPython', 'envFile'] as const).map((key, i) => <label key={key}>{[l('Chrome 连接地址', 'Chrome endpoint'), l('浏览器运行环境', 'Browser Python'), l('本地工具运行环境', 'Local Python'), l('已有连接配置文件', 'Existing connection configuration')][i]}<input value={settings[key]} onChange={e => setSettings({ ...settings, [key]: e.target.value })} /></label>)}</div>
        <div className="wf-actions"><button disabled={busy} onClick={() => void act(async () => { await api!.saveSettings(settings); setSettings(await api!.settings()); setNotice(l('连接配置已保存。', 'Connections saved.')) })}>{l('保存连接', 'Save connections')}</button><button disabled={busy} onClick={() => void act(async () => { const probe = await api!.probe(); setNotice(`${l('浏览器环境', 'Browser runtime')}: ${probe.browser?.ready ? l('就绪', 'Ready') : l('需要配置', 'Setup required')}\n${l('本地工具', 'Local tools')}: ${probe.local?.localReady ? l('就绪', 'Ready') : l('需要配置', 'Setup required')}\n${probe.errors.join('\n')}`) })}>{l('检查依赖', 'Check dependencies')}</button><button disabled={busy} onClick={() => void act(async () => setNotice((await api!.browserCheck()).message))}>{l('检查浏览器连接', 'Check browser connection')}</button></div>
      </section>}
    </main><footer className="wf-footer">{l('保存原始页面与文件，保留来源和核验记录。', 'Original pages and files, with sources and verification records.')}</footer>
    {deleteTarget && <DeleteDialog target={deleteTarget} en={en} deleting={deleting} error={deleteError} onCancel={() => { if (!deleting) { setDeleteTarget(null); setDeleteError('') } }} onConfirm={() => void confirmDelete()} />}
  </div>
}

import { useState } from 'react'
import type { DeliveryItem, NodeRun, OpenPagesResult, WorkflowApi } from './lib/workflow'
export function openMessage(value: OpenPagesResult, en: boolean) {
  return `${en ? 'Handed to browser' : '已交给浏览器打开'} ${value.opened}/${value.total ?? value.opened}${value.failed?.length ? '\n' + value.failed.map(f => f.message).join('\n') : ''}${!value.total && value.message ? '\n' + value.message : ''}`
}
export default function ResultActions({ api, taskId, item, node, en, reload }: { api: WorkflowApi; taskId: string; item: DeliveryItem; node?: NodeRun; en: boolean; reload: () => Promise<void> }) {
  const l = (zh: string, english: string) => en ? english : zh
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState(''), [url, setUrl] = useState('')
  const hasHtml = item.artifacts.some(a => a.role === 'page' && /\.html?$/i.test(a.path))
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  async function open(artifactPath?: string) {
    await act(async () => {
      const result = await api.openResult({ id: taskId, itemId: item.id, ...(artifactPath ? { artifactPath } : {}) })
      if (typeof result.opened === 'number') {
        setNotice(openMessage(result as OpenPagesResult, en))
        if ((result as OpenPagesResult).failed?.length || result.opened === 0) setError(l('打开未全部成功，请检查以上原因后重试。', 'Some pages could not be opened; check the reason above and retry.'))
      } else setNotice(result.message || l('已交给系统打开文件。', 'File handed to the system.'))
    })
  }
  const recovery = node && ['needs_review', 'waiting_human', 'paused'].includes(node.status) && item.taskState !== 'result_available'
  return <>
    <div className="wf-actions"><button disabled={busy || !hasHtml} onClick={() => void open()}>{busy ? l('正在处理…', 'Working…') : l('打开保存网页', 'Open saved page')}</button>
      {item.sourceUrl && <button disabled={busy} onClick={() => void act(async () => { const out = await api.openResult({ id: taskId, nodeId: item.nodeId, itemId: item.id, online: true }); setNotice(out.message || l('已请求打开原站。', 'Requested the original website.')); if (out.opened === false) setError(out.message || l('无法打开原站。', 'Unable to open original website.')) })}>{l('在线原站', 'Original website')}</button>}
    </div>
    {notice && <p className="wf-notice" role="status">{notice}</p>}{error && <div className="wf-alert" role="alert"><span>{error}</span>{hasHtml && <button disabled={busy} onClick={() => void open()}>{l('重试打开网页', 'Retry opening page')}</button>}</div>}
    {recovery && <details className="wf-reconcile"><summary>{l('核对原任务／恢复已有结果', 'Reconcile original job / recover existing results')}</summary><p>{l('没有可靠回执时无法确认网站是否收到任务。请核对原标签或邮件中的作业链接；恢复不会重新提交分析。', 'Without a receipt, submission is uncertain. Inspect the original tab or the emailed job link; recovery does not resubmit analysis.')}</p>
      {node.canActivate && <button disabled={busy} onClick={() => void act(async () => { await api.control({ id: taskId, nodeId: node.id, action: 'takeover' }); await api.activate({ id: taskId, nodeId: node.id }); setNotice(l('已请求打开原任务标签。', 'Requested the original job tab.')) })}>{l('核对原任务', 'Inspect original job')}</button>}
      <label>{l('已有作业／结果链接', 'Existing job / result URL')}<input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…" /></label>
      <button disabled={busy || !/^https?:\/\//i.test(url.trim())} onClick={() => void act(async () => { await api.control({ id: taskId, nodeId: node.id, action: 'reconcile', resultUrl: url.trim() }); await reload(); setNotice(l('已接续核对原作业。', 'Continuing the original job.')) })}>{l('核对并从此链接继续', 'Reconcile and continue from this link')}</button>
    </details>}
    <details><summary>{l('已保存文件', 'Saved files')} ({item.artifacts.length})</summary><ul className="wf-artifacts">{item.artifacts.map(a => <li key={a.path}><button disabled={busy} onClick={() => void open(a.path)}>{a.name}</button><small>{Math.ceil(a.bytes / 1024)} KB</small></li>)}</ul></details>
  </>
}

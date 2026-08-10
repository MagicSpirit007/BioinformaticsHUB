import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  ClipboardText,
  ClockCounterClockwise,
  Dna,
  DownloadSimple,
  FileArrowUp,
  FolderOpen,
  Flask,
  GlobeHemisphereEast,
  House,
  LinkBreak,
  LinkSimple,
  ListChecks,
  Play,
  SpinnerGap,
  StopCircle,
  Warning,
  Wrench,
} from '@phosphor-icons/react'
import './App.css'
import { AppFeedback } from './components/AppFeedback'
import { GlassPanel } from './components/GlassPanel'
import {
  LOCAL_TOOLS,
  SITE_GROUPS,
  loadSiteCatalog,
  type LocalToolDefinition,
  type SiteCatalogEntry,
  type SiteInputKind,
} from './analysisCatalog'
import {
  getDesktopApi,
  type InputKind,
  type LocalArtifact,
  type LocalToolTask,
  type SessionListItem,
  type SessionRecord,
  type SessionUpdateEvent,
  type SiteResultMode,
  type SiteTask,
} from './lib/desktop'

type View = 'new' | 'session' | 'history'

const STATUS_LABELS: Record<string, { label: string; tone: 'muted' | 'info' | 'ok' | 'warn' | 'fail' }> = {
  queued: { label: '已排队', tone: 'muted' },
  pending: { label: '等待中', tone: 'muted' },
  opening: { label: '正在打开', tone: 'info' },
  opened_manual: { label: '等待人工操作', tone: 'warn' },
  submitting: { label: '正在自动提交', tone: 'info' },
  result_ready: { label: '结果已就绪', tone: 'ok' },
  completed_manual: { label: '已人工完成', tone: 'ok' },
  running: { label: '本地运行中', tone: 'info' },
  completed: { label: '已完成', tone: 'ok' },
  partial: { label: '部分完成', tone: 'warn' },
  ok: { label: '已完成', tone: 'ok' },
  needs_manual: { label: '需要人工继续', tone: 'warn' },
  needs_setup: { label: '需要安装本地工具', tone: 'warn' },
  skipped: { label: '不适用于当前输入', tone: 'muted' },
  failed: { label: '失败', tone: 'fail' },
  cancelled: { label: '已取消', tone: 'muted' },
}

const TERMINAL_STATUSES = new Set(['result_ready', 'completed_manual', 'completed', 'ok'])

function App() {
  const desktop = useMemo(() => getDesktopApi(), [])
  const [view, setView] = useState<View>('new')
  const [sites, setSites] = useState<SiteCatalogEntry[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [selectedSites, setSelectedSites] = useState<Set<string>>(new Set())
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    new Set(['nucleic', 'physchem', 'hydrophobicity']),
  )
  const [geneId, setGeneId] = useState('')
  const [alias, setAlias] = useState('')
  const [inputKind, setInputKind] = useState<InputKind>('auto')
  const [fastaText, setFastaText] = useState('')
  const [fastaName, setFastaName] = useState('')
  const [alignmentPath, setAlignmentPath] = useState('')
  const [alignmentText, setAlignmentText] = useState('')
  const [activeSession, setActiveSession] = useState<SessionRecord | null>(null)
  const [history, setHistory] = useState<SessionListItem[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [logs, setLogs] = useState<string[]>([])

  const dismissError = useCallback(() => {
    setError('')
    setCatalogError('')
  }, [])
  const dismissNotice = useCallback(() => setNotice(''), [])

  const activeSessionId = getSessionId(activeSession)

  useEffect(() => {
    if (error || catalogError) setNotice('')
  }, [catalogError, error])

  const refreshHistory = useCallback(async () => {
    try {
      const items = await desktop.listSessions()
      setHistory(items)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }, [desktop])

  useEffect(() => {
    let active = true
    loadSiteCatalog()
      .then((catalog) => {
        if (active) setSites(catalog.sites)
      })
      .catch((reason) => {
        if (active) setCatalogError(errorMessage(reason))
      })
    void refreshHistory()
    return () => {
      active = false
    }
  }, [refreshHistory])

  useEffect(() => {
    const mergeEvent = (event: SessionUpdateEvent) => {
      setActiveSession((current) => mergeSessionUpdate(current, event))
    }
    const offUpdate = desktop.onSessionUpdate(mergeEvent)
    const offLog = desktop.onLog((event) => {
      if (typeof event !== 'string' && event.sessionId && activeSessionId && event.sessionId !== activeSessionId) return
      const line = typeof event === 'string' ? event : event.message
      setLogs((current) => [...current.slice(-199), line])
    })
    const offDone = desktop.onSessionDone((event) => {
      const eventSessionId = String(event.sessionId ?? event.session?.sessionId ?? event.session?.id ?? '')
      if (activeSessionId && eventSessionId && eventSessionId !== activeSessionId) {
        void refreshHistory()
        return
      }
      if (event.session) setActiveSession(event.session)
      else if (event.sessionId) {
        void desktop.loadSession(event.sessionId).then(setActiveSession).catch(() => undefined)
      }
      setBusy(false)
      setNotice('研究任务已完成当前可自动执行的部分。')
      void refreshHistory()
    })
    const offCancelled = desktop.onSessionCancelled((event) => {
      if (activeSessionId && event.sessionId && event.sessionId !== activeSessionId) {
        void refreshHistory()
        return
      }
      setActiveSession((current) =>
        !current || (event.sessionId && event.sessionId !== getSessionId(current))
          ? current
          : { ...current, status: 'cancelled' },
      )
      setBusy(false)
      setNotice('已停止打开后续网站。已经打开的浏览器标签会保留。')
      void refreshHistory()
    })
    const offError = desktop.onSessionError((event) => {
      if (activeSessionId && event.sessionId && event.sessionId !== activeSessionId) {
        void refreshHistory()
        return
      }
      setError(event.message)
      setBusy(false)
    })
    return () => {
      offUpdate()
      offLog()
      offDone()
      offCancelled()
      offError()
    }
  }, [activeSessionId, desktop, refreshHistory])

  const chooseFasta = async () => {
    const picked = await desktop.pickFasta()
    if (!picked) return
    setFastaText(picked.text)
    setFastaName(picked.name ?? picked.path)
    if (!geneId) setGeneId(inferFastaId(picked.text) || stripExtension(picked.name ?? ''))
  }

  const chooseAlignment = async () => {
    const picked = await desktop.pickAlignment()
    if (!picked) return
    setAlignmentPath(picked.path)
    setAlignmentText(picked.text)
  }

  const startSession = async () => {
    setError('')
    setNotice('')
    const validation = validateStart({
      geneId,
      fastaText,
      selectedCount: selectedSites.size + selectedTools.size,
      alignmentRequired: LOCAL_TOOLS.some(
        (tool) => tool.requiresAlignment && selectedTools.has(tool.id),
      ),
      alignmentPath,
    })
    if (validation) {
      setError(validation)
      return
    }
    setBusy(true)
    try {
      const started = await desktop.sessionStart({
        fastaText: fastaText.trim(),
        geneId: geneId.trim(),
        alias: alias.trim() || undefined,
        inputKind,
        siteIds: [...selectedSites],
        localToolIds: [...selectedTools],
        alignmentPath: alignmentPath || undefined,
      })
      let session: SessionRecord
      try {
        session = await desktop.loadSession(started.sessionId)
      } catch {
        const now = new Date().toISOString()
        session = {
          sessionId: started.sessionId,
          sessionDir: started.sessionDir,
          status: 'running',
          createdAt: now,
          updatedAt: now,
          input: {
            geneId: geneId.trim(),
            alias: alias.trim(),
            inputKind,
            fastaText: fastaText.trim(),
            normalizedFasta: fastaText.trim(),
            nucleotideFasta: inputKind === 'protein' ? undefined : fastaText.trim(),
            proteinFasta: inputKind === 'protein' ? fastaText.trim() : undefined,
            alignmentPath,
            alignmentFasta: alignmentText,
          },
          sites: [...selectedSites].map((siteId) => ({ siteId, status: 'queued' })),
          localTools: [...selectedTools].map((toolId) => ({ toolId, status: 'queued' })),
        }
      }
      setActiveSession(session)
      setLogs([])
      setView('session')
      setBusy(false)
      void refreshHistory()
    } catch (reason) {
      setError(errorMessage(reason))
      setBusy(false)
    }
  }

  const loadHistorySession = async (item: SessionListItem) => {
    const id = String(item.sessionId ?? item.id ?? '')
    if (!id) return
    setBusy(true)
    setError('')
    try {
      const session = await desktop.loadSession(id)
      setActiveSession({ ...session, legacy: session.legacy ?? item.legacy })
      setView('session')
    } catch (reason) {
      setError(`无法载入记录：${errorMessage(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const reloadActiveSession = useCallback(async () => {
    if (!activeSessionId) return
    try {
      setActiveSession(await desktop.loadSession(activeSessionId))
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }, [activeSessionId, desktop])

  const cancelSession = async () => {
    if (!activeSessionId) return
    await desktop.sessionCancel(activeSessionId)
    setActiveSession((current) => (current ? { ...current, status: 'cancelled' } : current))
    setBusy(false)
  }

  const exportBundle = async () => {
    if (!activeSessionId) return
    setError('')
    try {
      const result = await desktop.exportResearchBundle(activeSessionId)
      setNotice(`研究工作包已导出：${result.path}`)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const openSite = async (site: SiteCatalogEntry) => {
    if (!activeSessionId) return
    setError('')
    try {
      await desktop.openSite({ sessionId: activeSessionId, siteId: site.id, entryUrl: site.entryUrl })
      await reloadActiveSession()
    } catch (reason) {
      setError(`${site.name} 打开失败：${errorMessage(reason)}`)
    }
  }

  const saveSiteResult = async (site: SiteCatalogEntry, resultMode: SiteResultMode, resultUrl: string, notes: string) => {
    if (!activeSessionId) return
    try {
      let normalized: string | undefined
      if (resultMode === 'result_url') {
        normalized = normalizeHttpUrl(resultUrl) ?? undefined
        if (!normalized) throw new Error('结果链接必须是完整的 http:// 或 https:// 地址')
        assertResultUrlForSite(site, normalized)
      }
      const response = await desktop.saveSiteResult({
        sessionId: activeSessionId,
        siteId: site.id,
        resultMode,
        resultUrl: normalized,
        notes: notes.trim() || undefined,
      })
      if (response && 'session' in response && response.session) setActiveSession(response.session)
      else await reloadActiveSession()
      setNotice(resultMode === 'result_url'
        ? `${site.name} 的结果链接已保存。`
        : `${site.name} 已标记完成：无可复开链接。`)
    } catch (reason) {
      setError(errorMessage(reason))
      throw reason
    }
  }

  const copyForSite = async (site: SiteCatalogEntry) => {
    try {
      const value = sourceForSite(activeSession, site.inputKind)
      if (!value) throw new Error(sourceUnavailableMessage(site.inputKind))
      await navigator.clipboard.writeText(value)
      setNotice(`${site.name} 所需${copyLabel(site.inputKind)}已复制。`)
    } catch (reason) {
      setError(errorMessage(reason))
      throw reason
    }
  }

  const revealArtifact = async (path: string) => {
    if (!activeSessionId) return
    setError('')
    try {
      await desktop.revealArtifact({ sessionId: activeSessionId, path })
    } catch (reason) {
      setError(`无法显示本地产物：${errorMessage(reason)}`)
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setView('new')} aria-label="返回新建任务">
          <span className="brand-mark"><Dna size={23} weight="duotone" /></span>
          <span><strong>BioinformaticsHUB</strong><small>研究网站整合平台 · 0.3</small></span>
        </button>
        <nav className="nav" aria-label="主导航">
          <NavButton active={view === 'new'} icon={<House />} onClick={() => setView('new')}>新建</NavButton>
          <NavButton active={view === 'session'} icon={<ListChecks />} onClick={() => setView('session')} disabled={!activeSession}>任务</NavButton>
          <NavButton active={view === 'history'} icon={<ClockCounterClockwise />} onClick={() => { setView('history'); void refreshHistory() }}>历史</NavButton>
        </nav>
        <span className={`connection-pill ${desktop.isDesktop ? 'connected' : ''}`}>
          <span aria-hidden="true" />{desktop.isDesktop ? '桌面引擎' : '浏览器预览'}
        </span>
      </header>

      <AppFeedback error={error || catalogError} notice={notice} onDismissError={dismissError} onDismissNotice={dismissNotice} />

      <main className="main-content" id="main-content" tabIndex={-1}>
        {view === 'new' && (
          <NewSessionView
            sites={sites}
            selectedSites={selectedSites}
            setSelectedSites={setSelectedSites}
            selectedTools={selectedTools}
            setSelectedTools={setSelectedTools}
            geneId={geneId}
            setGeneId={setGeneId}
            alias={alias}
            setAlias={setAlias}
            inputKind={inputKind}
            setInputKind={setInputKind}
            fastaText={fastaText}
            setFastaText={setFastaText}
            fastaName={fastaName}
            alignmentPath={alignmentPath}
            chooseFasta={chooseFasta}
            chooseAlignment={chooseAlignment}
            startSession={startSession}
            busy={busy}
          />
        )}

        {view === 'session' && activeSession && (
          <SessionDashboard
            session={activeSession}
            sites={sites}
            busy={busy}
            logs={logs}
            openSite={openSite}
            copyForSite={copyForSite}
            saveSiteResult={saveSiteResult}
            cancelSession={cancelSession}
            exportBundle={exportBundle}
            reloadSession={reloadActiveSession}
            revealArtifact={revealArtifact}
          />
        )}

        {view === 'session' && !activeSession && (
          <EmptyState icon={<ListChecks />} title="尚无当前任务" text="先创建研究任务，再在这里跟踪各网站与本地工具。" action="新建任务" onAction={() => setView('new')} />
        )}

        {view === 'history' && (
          <HistoryView history={history} busy={busy} onOpen={loadHistorySession} onRefresh={refreshHistory} />
        )}
      </main>

      <footer className="app-colophon">BioinformaticsHUB 0.3 只组织输入、网站任务、来源明确的本地产物与研究链接；不替代研究者选择模型，也不生成综合科学结论。</footer>
    </div>
  )
}

type NewSessionProps = {
  sites: SiteCatalogEntry[]
  selectedSites: Set<string>
  setSelectedSites: (value: Set<string>) => void
  selectedTools: Set<string>
  setSelectedTools: (value: Set<string>) => void
  geneId: string
  setGeneId: (value: string) => void
  alias: string
  setAlias: (value: string) => void
  inputKind: InputKind
  setInputKind: (value: InputKind) => void
  fastaText: string
  setFastaText: (value: string) => void
  fastaName: string
  alignmentPath: string
  chooseFasta: () => Promise<void>
  chooseAlignment: () => Promise<void>
  startSession: () => Promise<void>
  busy: boolean
}

function NewSessionView(props: NewSessionProps) {
  const alignmentNeeded = LOCAL_TOOLS.some((tool) => tool.requiresAlignment && props.selectedTools.has(tool.id))
  const toggleSite = (id: string) => props.setSelectedSites(toggleSet(props.selectedSites, id))
  const toggleTool = (id: string) => {
    const next = new Set(props.selectedTools)
    if (next.has(id)) {
      next.delete(id)
      if (id === 'iqtree') next.delete('itol')
    } else {
      next.add(id)
      const tool = LOCAL_TOOLS.find((candidate) => candidate.id === id)
      for (const dependency of tool?.dependsOn ?? []) next.add(dependency)
    }
    props.setSelectedTools(next)
  }

  return (
    <div className="new-layout enter">
      <section className="intro-block">
        <p className="eyebrow">SITE-FIRST RESEARCH</p>
        <h1>多分析网站整合</h1>
        <p>整理输入、分批打开网站并保存结果链接</p>
      </section>

      <div className="new-grid">
        <GlassPanel className="input-panel" padding="clamp(18px, 3vw, 28px)" cornerRadius={26} solid>
          <SectionTitle icon={<Dna />} eyebrow="01 · INPUT" title="研究输入" />
          <div className="two-fields">
            <label className="field"><span>基因 ID <b aria-hidden="true">*</b><span className="sr-only">（必填）</span></span><input value={props.geneId} onChange={(e) => props.setGeneId(e.target.value)} placeholder="例如 CCA0859S0013" autoComplete="off" required aria-required="true" /></label>
            <label className="field"><span>别名</span><input value={props.alias} onChange={(e) => props.setAlias(e.target.value)} placeholder="例如 CcAZF2" autoComplete="off" /></label>
          </div>
          <fieldset className="segmented-field">
            <legend>输入类型</legend>
            <div className="segmented" role="group">
              {([['auto', '自动识别'], ['cds', 'CDS'], ['protein', '蛋白']] as Array<[InputKind, string]>).map(([value, label]) => (
                <button type="button" key={value} className={props.inputKind === value ? 'active' : ''} aria-pressed={props.inputKind === value} onClick={() => props.setInputKind(value)}>{label}</button>
              ))}
            </div>
          </fieldset>
          <label className="field fasta-field">
            <span>FASTA 序列 <b aria-hidden="true">*</b><span className="sr-only">（必填）</span></span>
            <textarea value={props.fastaText} onChange={(e) => props.setFastaText(e.target.value)} spellCheck={false} placeholder={'>gene_id\nATGGCC… 或 >protein_id\nMAV…'} required aria-required="true" />
          </label>
          <div className="file-row">
            <button className="btn ghost" type="button" onClick={() => void props.chooseFasta()}><FileArrowUp />选择 FASTA</button>
            <span>{props.fastaName || '也可直接粘贴完整 FASTA'}</span>
          </div>
          <p className="scope-note">CDS 默认使用标准遗传密码、正向第一阅读框翻译；内部终止或不完整 CDS 会明确警告，不会静默修正。</p>
        </GlassPanel>

        <GlassPanel className="selection-summary" padding="24px" cornerRadius={26} solid>
          <p className="eyebrow">CURRENT SELECTION</p>
          <div className="selection-number">{String(props.selectedSites.size).padStart(2, '0')}</div>
          <p>个研究网站</p>
          <div className="selection-number small">{String(props.selectedTools.size).padStart(2, '0')}</div>
          <p>个本地工具</p>
          <div className="summary-rule" />
          <p className="muted">参数型网站每批打开 5 个；自动提交白名单共 1 个。</p>
        </GlassPanel>
      </div>

      <section className="catalog-section" aria-labelledby="website-heading">
        <div className="catalog-heading">
          <SectionTitle icon={<GlobeHemisphereEast />} eyebrow="02 · WEBSITES" title="研究网站" id="website-heading" />
          <div className="compact-actions"><button className="btn ghost" type="button" onClick={() => props.setSelectedSites(new Set(props.sites.map((site) => site.id)))}>全选网站</button><button className="btn ghost" type="button" onClick={() => props.setSelectedSites(new Set())}>清空</button></div>
        </div>
        <p className="section-lead">“仅打开”：用户决定参数与模型；“自动提交”只需在本应用中输入序列即可</p>
        {SITE_GROUPS.map((group) => {
          const groupSites = props.sites.filter((site) => site.group === group.id)
          if (!groupSites.length) return null
          const allSelected = groupSites.every((site) => props.selectedSites.has(site.id))
          return (
            <div className="site-group" key={group.id}>
              <div className="group-heading"><h3>{group.label}</h3><button type="button" className="text-button" onClick={() => props.setSelectedSites(setGroup(props.selectedSites, groupSites.map((site) => site.id), !allSelected))}>{allSelected ? '取消本组' : '选择本组'}</button></div>
              <div className="site-select-grid">
                {groupSites.map((site) => (
                  <label className={`site-select-card ${props.selectedSites.has(site.id) ? 'selected' : ''}`} key={site.id}>
                    <input type="checkbox" checked={props.selectedSites.has(site.id)} onChange={() => toggleSite(site.id)} />
                    <span className="custom-check" aria-hidden="true"><CheckCircle weight="fill" /></span>
                    <span className="site-select-main"><span className="site-title-line"><strong>{site.name}</strong><ModeBadge mode={site.execution} /></span><small>{site.provider}</small><span>{site.description}</span>{site.risk && <em><Warning weight="fill" />{site.risk}</em>}</span>
                  </label>
                ))}
              </div>
            </div>
          )
        })}
      </section>

      <section className="catalog-section local-selection" aria-labelledby="local-heading">
        <div className="catalog-heading"><SectionTitle icon={<Wrench />} eyebrow="03 · LOCAL" title="本地工具" id="local-heading" /><span className="source-pill">产物逐卡展示来源</span></div>
        <div className="local-select-grid">
          {LOCAL_TOOLS.map((tool) => (
            <label className={`local-select-card ${props.selectedTools.has(tool.id) ? 'selected' : ''}`} key={tool.id}>
              <input type="checkbox" checked={props.selectedTools.has(tool.id)} onChange={() => toggleTool(tool.id)} />
              <span className="tool-index">{String(LOCAL_TOOLS.indexOf(tool) + 1).padStart(2, '0')}</span>
              <span><strong>{tool.name}</strong><small>{tool.description}</small><em>{tool.provenance}</em></span>
            </label>
          ))}
        </div>
        {alignmentNeeded && (
          <div className="alignment-picker">
            <div><strong>多序列 FASTA</strong><span>IQ-TREE 需要等长比对；未比对序列请同时勾选 MAFFT。iTOL 使用本次 IQ-TREE 生成的树。</span></div>
            <button className="btn ghost" type="button" onClick={() => void props.chooseAlignment()}><FileArrowUp />选择文件</button>
            <code>{props.alignmentPath || '尚未选择'}</code>
          </div>
        )}
      </section>

      <div className="launch-bar">
        <div><strong>{props.selectedSites.size + props.selectedTools.size} 项已选择</strong><span>开始后，人工网站会按批次打开；随时可停止后续批次。</span></div>
        <button className="btn primary launch" type="button" onClick={() => void props.startSession()} disabled={props.busy || !props.sites.length}>{props.busy ? <SpinnerGap className="spin" /> : <Play weight="fill" />}建立研究任务</button>
      </div>
    </div>
  )
}

type SessionDashboardProps = {
  session: SessionRecord
  sites: SiteCatalogEntry[]
  busy: boolean
  logs: string[]
  openSite: (site: SiteCatalogEntry) => Promise<void>
  copyForSite: (site: SiteCatalogEntry) => Promise<void>
  saveSiteResult: (site: SiteCatalogEntry, resultMode: SiteResultMode, resultUrl: string, notes: string) => Promise<void>
  cancelSession: () => Promise<void>
  exportBundle: () => Promise<void>
  reloadSession: () => Promise<void>
  revealArtifact: (path: string) => Promise<void>
}

function SessionDashboard(props: SessionDashboardProps) {
  const siteTaskMap = taskMap(props.session.sites, 'siteId')
  const toolTaskMap = taskMap(props.session.localTools, 'toolId')
  const selectedSites = props.sites.filter((site) => siteTaskMap.has(site.id))
  const selectedTools = LOCAL_TOOLS.filter((tool) => toolTaskMap.has(tool.id))
  const doneSites = selectedSites.filter((site) => TERMINAL_STATUSES.has(String(siteTaskMap.get(site.id)?.status))).length
  const openSites = selectedSites.filter((site) => ['opened_manual', 'needs_manual'].includes(String(siteTaskMap.get(site.id)?.status))).length
  const running = ['running', 'opening', 'submitting', 'queued', 'pending'].includes(String(props.session.status ?? ''))

  return (
    <div className="dashboard enter">
      <GlassPanel className="session-hero" padding="clamp(20px, 3vw, 30px)" cornerRadius={28} solid>
        <div className="session-hero-main">
          <p className="eyebrow">RESEARCH SESSION · {props.session.legacy ? 'LEGACY' : '0.3'}</p>
          <h1>{sessionTitle(props.session)}</h1>
          <div className="session-meta"><span>{getSessionId(props.session)}</span><StatusBadge status={String(props.session.status ?? 'running')} />{props.session.legacy && <span className="legacy-badge">旧版记录 · 只读兼容</span>}</div>
        </div>
        <div className="dashboard-actions">
          <button className="btn ghost" type="button" onClick={() => void props.reloadSession()}><ArrowClockwise />刷新</button>
          <button className="btn ghost" type="button" onClick={() => void props.exportBundle()}><DownloadSimple />导出研究工作包</button>
          {running && <button className="btn danger" type="button" onClick={() => void props.cancelSession()}><StopCircle />停止后续任务</button>}
        </div>
        <div className="session-stats">
          <Stat value={`${doneSites}/${selectedSites.length}`} label="网站完成" />
          <Stat value={String(openSites)} label="等待人工" />
          <Stat value={String(selectedTools.length)} label="本地工具" />
          <Stat value={inputKindLabel(String(props.session.input?.inputKind ?? 'auto'))} label="输入识别" />
        </div>
        {props.session.input?.warnings && props.session.input.warnings.length > 0 && (
          <div className="input-warnings"><Warning weight="fill" /><div><strong>输入检查提醒</strong>{props.session.input.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div></div>
        )}
      </GlassPanel>

      <section className="dashboard-section" aria-labelledby="site-task-heading">
        <div className="catalog-heading"><SectionTitle icon={<GlobeHemisphereEast />} eyebrow="WEBSITE TASKS" title="网站任务" id="site-task-heading" /><span className="muted">每张卡保留原网站入口与结果链接</span></div>
        {selectedSites.length ? (
          <div className="task-grid">
            {selectedSites.map((site) => (
              <SiteTaskCard
                key={site.id}
                site={site}
                task={siteTaskMap.get(site.id) as SiteTask | undefined}
                copyAvailable={Boolean(sourceForSite(props.session, site.inputKind))}
                onOpen={() => props.openSite(site)}
                onCopy={() => props.copyForSite(site)}
                onSave={(resultMode, url, notes) => props.saveSiteResult(site, resultMode, url, notes)}
              />
            ))}
          </div>
        ) : <p className="empty-inline">此任务没有网站项目。</p>}
      </section>

      <section className="dashboard-section" aria-labelledby="local-task-heading">
        <div className="catalog-heading"><SectionTitle icon={<Flask />} eyebrow="LOCAL TOOLS" title="本地工具产物" id="local-task-heading" /><span className="source-pill">不汇总为结论或统一图廊</span></div>
        {selectedTools.length ? (
          <div className="local-task-stack">
            {selectedTools.map((tool) => <LocalToolCard key={tool.id} definition={tool} task={toolTaskMap.get(tool.id) as LocalToolTask | undefined} onReveal={props.revealArtifact} />)}
          </div>
        ) : <p className="empty-inline">此任务没有选择本地工具。</p>}
      </section>

      {props.logs.length > 0 && (
        <details className="activity-log"><summary>运行日志 <span>{props.logs.length}</span></summary><pre>{props.logs.join('\n')}</pre></details>
      )}
    </div>
  )
}

function SiteTaskCard({ site, task, copyAvailable, onOpen, onCopy, onSave }: { site: SiteCatalogEntry; task?: SiteTask; copyAvailable: boolean; onOpen: () => Promise<void>; onCopy: () => Promise<void>; onSave: (resultMode: SiteResultMode, url: string, notes: string) => Promise<void> }) {
  const [url, setUrl] = useState(task?.resultUrl ?? '')
  const [notes, setNotes] = useState(task?.notes ?? '')
  const [savingMode, setSavingMode] = useState<SiteResultMode | null>(null)
  const resultHelpId = useId()
  useEffect(() => { setUrl(task?.resultUrl ?? ''); setNotes(task?.notes ?? '') }, [task?.resultUrl, task?.notes])
  const status = String(task?.status ?? 'queued')
  const completedWithoutLink = status === 'completed_manual' && !task?.resultUrl

  const doCopy = async () => {
    try { await onCopy() } catch { /* Global feedback reports the failure. */ }
  }
  const doSave = async (resultMode: SiteResultMode) => {
    setSavingMode(resultMode)
    try { await onSave(resultMode, url, notes) } catch { /* Global feedback reports the failure. */ } finally { setSavingMode(null) }
  }

  return (
    <article className="task-card" data-mode={site.execution}>
      <div className="task-card-head"><div><span className="provider">{site.provider}</span><h3>{site.name}</h3></div><StatusBadge status={status} /></div>
      <div className="task-mode-row"><ModeBadge mode={site.execution} /><span>{inputKindName(site.inputKind)}</span></div>
      <p>{site.description}</p>
      {site.automationNote && <div className="automation-note"><span>固定脚本</span>{site.automationNote}</div>}
      {site.risk && <div className="risk-note"><Warning weight="fill" />{site.risk}</div>}
      {task?.message && <p className="task-message">{task.message}</p>}
      <div className="task-actions">
        <button className="btn primary" type="button" onClick={() => void onOpen()}><ArrowSquareOut />{task?.resultUrl ? '打开结果页' : site.execution === 'auto_submit' ? '打开输入页' : '打开网站'}</button>
        <button className="btn ghost" type="button" onClick={() => void doCopy()} disabled={!copyAvailable}><ClipboardText />{copyLabel(site.inputKind)}</button>
      </div>
      <div className="entry-link"><span>入口</span><a href={site.entryUrl} target="_blank" rel="noreferrer">{shortUrl(site.entryUrl)}<ArrowSquareOut /></a></div>
      <details className="result-capture" open={Boolean(task?.resultUrl) || completedWithoutLink}>
        <summary><LinkSimple />记录结果</summary>
        {completedWithoutLink && <p className="no-result-record"><LinkBreak weight="bold" />已记录：此网站没有可复开的结果链接。</p>}
        <label><span>可复开的结果页 URL（可选）</span><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-describedby={resultHelpId} /></label>
        <p className="result-help" id={resultHelpId}>请粘贴提交后地址栏中的结果页；若地址仍是入口，请选择无链接完成。</p>
        <label><span>研究备注（可选）</span><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="记录所选模型、阈值或需要复核之处" /></label>
        <div className="result-actions">
          <button className="btn primary block" type="button" disabled={Boolean(savingMode) || !url.trim()} onClick={() => void doSave('result_url')}>{savingMode === 'result_url' ? <SpinnerGap className="spin" /> : <LinkSimple />}保存结果链接并完成</button>
          <button className="btn ghost block" type="button" disabled={Boolean(savingMode)} onClick={() => void doSave('no_persistent_url')}>{savingMode === 'no_persistent_url' ? <SpinnerGap className="spin" /> : <LinkBreak />}无可复开链接，标记完成</button>
        </div>
      </details>
    </article>
  )
}

function LocalToolCard({ definition, task, onReveal }: { definition: LocalToolDefinition; task?: LocalToolTask; onReveal: (path: string) => Promise<void> }) {
  const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : []
  return (
    <article className="local-task-card">
      <div className="local-task-head"><div><span className="local-stamp"><Flask weight="fill" />本地生成</span><h3>{definition.name}</h3></div><StatusBadge status={String(task?.status ?? 'queued')} /></div>
      <p>{task?.message || definition.description}</p>
      <dl className="provenance-list">
        <div><dt>来源</dt><dd>{formatProvenance(task?.provenance, definition.provenance)}</dd></div>
        {task?.source && <div><dt>实现来源</dt><dd><code>{task.source}</code></dd></div>}
        {task?.version && <div><dt>版本</dt><dd>{task.version}</dd></div>}
        {task?.parameters && <div><dt>参数</dt><dd><code>{formatParameters(task.parameters)}</code></dd></div>}
      </dl>
      {artifacts.length > 0 ? (
        <div className="artifact-grid">
          {artifacts.map((artifact, index) => <ArtifactView key={`${artifact.path}-${index}`} artifact={artifact} onReveal={onReveal} />)}
        </div>
      ) : <p className="artifact-empty">尚无产物。若状态为“需要安装”，请安装对应本地程序后重试。</p>}
    </article>
  )
}

function ArtifactView({ artifact, onReveal }: { artifact: LocalArtifact; onReveal: (path: string) => Promise<void> }) {
  const image = artifact.kind === 'image' || /\.(png|jpe?g|gif|svg|webp)$/i.test(artifact.path)
  const label = artifact.name || artifact.path.split(/[\\/]/).pop() || '本地产物'
  return (
    <figure className={`artifact ${image ? 'image-artifact' : ''}`}>
      {image && artifact.url ? <img src={artifact.url} alt={`${label}，本地生成`} /> : <div className="artifact-icon">{image ? <Flask /> : <FileArrowUp />}</div>}
      <figcaption><strong>{label}</strong>{artifact.description && <span>{artifact.description}</span>}<code>{artifact.path}</code><button className="artifact-reveal" type="button" onClick={() => void onReveal(artifact.path)}><FolderOpen />在文件夹中显示</button></figcaption>
    </figure>
  )
}

function HistoryView({ history, busy, onOpen, onRefresh }: { history: SessionListItem[]; busy: boolean; onOpen: (item: SessionListItem) => Promise<void>; onRefresh: () => Promise<void> }) {
  return (
    <div className="history-page enter">
      <div className="catalog-heading"><div><p className="eyebrow">ARCHIVE</p><h1>研究记录</h1><p className="section-lead">0.3 会话按网站任务与本地工具展示；旧版流水线记录保留为只读历史。</p></div><button className="btn ghost" type="button" onClick={() => void onRefresh()}><ArrowClockwise />刷新</button></div>
      {history.length ? (
        <div className="history-grid">
          {history.map((item, index) => {
            const id = String(item.sessionId ?? item.id ?? `record-${index}`)
            const legacy = Boolean(item.legacy || (item.version && !String(item.version).startsWith('0.3')))
            return (
              <article className="history-card" key={id}>
                <div><span className="history-date">{formatDate(item.updatedAt ?? item.createdAt)}</span>{legacy && <span className="legacy-badge">旧版记录</span>}</div>
                <h2>{item.alias || item.geneId || id}</h2>
                <code>{id}</code>
                {item.path && <p>{item.path}</p>}
                <div className="history-foot"><StatusBadge status={String(item.status ?? item.overall ?? 'pending')} /><button className="btn ghost" type="button" disabled={busy} onClick={() => void onOpen(item)}>载入记录<ArrowSquareOut /></button></div>
              </article>
            )
          })}
        </div>
      ) : <EmptyState icon={<ClockCounterClockwise />} title="还没有研究记录" text="创建第一个研究任务后，它会出现在这里。" />}
    </div>
  )
}

function NavButton({ active, icon, children, onClick, disabled = false }: { active: boolean; icon: React.ReactNode; children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} onClick={onClick} disabled={disabled}>{icon}<span>{children}</span></button>
}

function SectionTitle({ icon, eyebrow, title, id }: { icon: React.ReactNode; eyebrow: string; title: string; id?: string }) {
  return <div className="section-title"><span className="section-icon">{icon}</span><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div></div>
}

function ModeBadge({ mode }: { mode: SiteCatalogEntry['execution'] }) {
  return <span className={`mode-badge ${mode}`}><span aria-hidden="true" />{mode === 'auto_submit' ? '自动提交' : '仅打开'}</span>
}

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_LABELS[status] ?? { label: status || '未知', tone: 'muted' as const }
  return <span className={`status-badge tone-${meta.tone}`}><span aria-hidden="true" />{meta.label}</span>
}

function Stat({ value, label }: { value: string; label: string }) {
  return <div className="session-stat"><strong>{value}</strong><span>{label}</span></div>
}

function EmptyState({ icon, title, text, action, onAction }: { icon: React.ReactNode; title: string; text: string; action?: string; onAction?: () => void }) {
  return <div className="empty-state"><span>{icon}</span><h1>{title}</h1><p>{text}</p>{action && onAction && <button className="btn primary" type="button" onClick={onAction}>{action}</button>}</div>
}

function toggleSet(current: Set<string>, id: string): Set<string> {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

function setGroup(current: Set<string>, ids: string[], selected: boolean): Set<string> {
  const next = new Set(current)
  ids.forEach((id) => selected ? next.add(id) : next.delete(id))
  return next
}

function taskMap<T extends { id?: string; siteId?: string; toolId?: string }>(tasks: T[] | undefined, primary: 'siteId' | 'toolId'): Map<string, T> {
  return new Map((Array.isArray(tasks) ? tasks : []).map((task) => [String(task[primary] ?? task.id ?? ''), task]))
}

function getSessionId(session: SessionRecord | null): string {
  return String(session?.sessionId ?? session?.id ?? '')
}

function mergeSessionUpdate(current: SessionRecord | null, update: SessionUpdateEvent): SessionRecord | null {
  const recordUpdate = update as SessionRecord
  if (Array.isArray(recordUpdate.sites) || Array.isArray(recordUpdate.localTools) || recordUpdate.input) {
    const updateId = getSessionId(recordUpdate)
    if (current && updateId && updateId !== getSessionId(current)) return current
    return {
      ...(current ?? {}),
      ...recordUpdate,
      input: recordUpdate.input ? { ...(current?.input ?? {}), ...recordUpdate.input } : current?.input,
    }
  }
  if (!current) return null
  const patchUpdate = update as {
    sessionId?: string
    status?: string
    message?: string
    site?: SiteTask
    localTool?: LocalToolTask
  }
  if (patchUpdate.sessionId && patchUpdate.sessionId !== getSessionId(current)) return current
  let sites = current.sites
  let localTools = current.localTools
  if (patchUpdate.site) sites = upsertTask<SiteTask>(sites ?? [], patchUpdate.site, 'siteId')
  if (patchUpdate.localTool) localTools = upsertTask<LocalToolTask>(localTools ?? [], patchUpdate.localTool, 'toolId')
  return { ...current, status: patchUpdate.status ?? current.status, sites, localTools }
}

function upsertTask<T extends { id?: string; siteId?: string; toolId?: string }>(tasks: T[], update: T, key: 'siteId' | 'toolId'): T[] {
  const id = String(update[key] ?? update.id ?? '')
  const index = tasks.findIndex((task) => String(task[key] ?? task.id ?? '') === id)
  if (index < 0) return [...tasks, update]
  return tasks.map((task, taskIndex) => taskIndex === index ? { ...task, ...update } : task)
}

function sourceForSite(session: SessionRecord | null, inputKind: SiteInputKind): string {
  if (!session) return ''
  const input = session.input ?? {}
  const original = String(input.fastaText ?? input.normalizedFasta ?? session.fastaText ?? '')
  if (inputKind === 'nucleotide_fasta') return String(input.nucleotideFasta ?? input.cdsFasta ?? session.nucleotideFasta ?? session.cdsFasta ?? (input.inputKind === 'protein' ? '' : original))
  if (inputKind === 'protein_fasta') return String(input.proteinFasta ?? session.proteinFasta ?? (input.inputKind === 'protein' ? original : ''))
  if (inputKind === 'alignment_fasta') return String(input.alignmentFasta ?? '')
  if (inputKind === 'identifier') return String(input.alias ?? input.geneId ?? session.alias ?? session.geneId ?? '')
  return ''
}

function sourceUnavailableMessage(kind: SiteInputKind): string {
  if (kind === 'protein_fasta') return '蛋白 FASTA 尚未生成；请等待 CDS 翻译完成或直接提供蛋白 FASTA。'
  if (kind === 'alignment_fasta') return '尚未提供多序列 FASTA。'
  if (kind === 'tree') return '该网站需要 Newick 树文件，请从本地 iTOL 数据包中取得。'
  if (kind === 'structure') return '该网站需要三维结构文件，不能用 FASTA 代替。'
  return '当前任务没有该网站所需的输入。'
}

function copyLabel(kind: SiteInputKind): string {
  if (kind === 'identifier') return '复制标识'
  if (kind === 'alignment_fasta') return '复制多序列 FASTA'
  if (kind === 'tree') return '需要树文件'
  if (kind === 'structure') return '需要结构文件'
  return kind === 'nucleotide_fasta' ? '复制核酸 FASTA' : '复制蛋白 FASTA'
}

function inputKindName(kind: SiteInputKind): string {
  return ({ nucleotide_fasta: '核酸 FASTA', protein_fasta: '蛋白 FASTA', alignment_fasta: '多序列 FASTA', tree: 'Newick 树', identifier: '基因 / 蛋白标识', structure: '结构文件' } as Record<SiteInputKind, string>)[kind]
}

function inputKindLabel(kind: string): string {
  return kind === 'cds' ? 'CDS' : kind === 'protein' ? '蛋白' : '自动'
}

function validateStart(values: { geneId: string; fastaText: string; selectedCount: number; alignmentRequired: boolean; alignmentPath: string }): string {
  if (!values.geneId.trim()) return '请填写基因 ID。'
  const fasta = values.fastaText.trim()
  if (!fasta.startsWith('>') || fasta.split(/\r?\n/).length < 2) return '请提供带有 “>” 标题行的完整 FASTA。'
  if (!values.selectedCount) return '请至少选择一个研究网站或本地工具。'
  if (values.alignmentRequired && !values.alignmentPath) return '所选本地比对/建树工具需要独立的多序列 FASTA；iTOL 使用本次 IQ-TREE 生成的树。'
  return ''
}

function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.toString()
  } catch { return null }
}

function assertResultUrlForSite(site: SiteCatalogEntry, resultUrl: string): void {
  const result = new URL(resultUrl)
  const entry = new URL(site.entryUrl)
  const allowedOrigins = new Set([`http://${entry.host}`, `https://${entry.host}`])
  for (const configured of site.resultOrigins ?? []) {
    try {
      const parsed = new URL(configured)
      allowedOrigins.add(parsed.origin)
    } catch {
      const host = configured.trim().toLowerCase()
      if (/^[a-z0-9.-]+$/.test(host)) {
        allowedOrigins.add(`http://${host}`)
        allowedOrigins.add(`https://${host}`)
      }
    }
  }
  if (!allowedOrigins.has(result.origin)) {
    throw new Error(`结果 URL 来源不属于 ${site.name} 的官方允许范围：${result.origin}`)
  }
  if (isEntryEquivalentResultUrl(site.entryUrl, resultUrl)) {
    throw new Error(
      `这仍是 ${site.name} 的入口页，不能作为可复开的结果链接。` +
        '若网站提交后地址未变化，请选择“无可复开链接，标记完成”。',
    )
  }
}

function isEntryEquivalentResultUrl(entryUrl: string, resultUrl: string): boolean {
  const comparable = (rawUrl: string): string => {
    const parsed = new URL(rawUrl)
    parsed.hash = ''
    parsed.protocol = 'https:'
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    parsed.searchParams.sort()
    return `${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`
  }
  return comparable(entryUrl) === comparable(resultUrl)
}

function inferFastaId(text: string): string {
  return text.match(/^>([^\s|]+)/m)?.[1] ?? ''
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

function sessionTitle(session: SessionRecord): string {
  const alias = String(session.input?.alias ?? session.alias ?? '').trim()
  const id = String(session.input?.geneId ?? session.geneId ?? getSessionId(session)).trim()
  return alias ? `${alias} · ${id}` : id
}

function shortUrl(value: string): string {
  try { const url = new URL(value); return `${url.host}${url.pathname === '/' ? '' : url.pathname}` } catch { return value }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function formatParameters(value: LocalToolTask['parameters']): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.join(' · ')
  return Object.entries(value ?? {}).map(([key, item]) => `${key}=${String(item)}`).join(' · ')
}

function formatProvenance(value: LocalToolTask['provenance'], fallback: string): string {
  if (!value) return fallback
  if (typeof value === 'string') return value
  return Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`).join(' · ')
}

function formatDate(value?: string): string {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export default App

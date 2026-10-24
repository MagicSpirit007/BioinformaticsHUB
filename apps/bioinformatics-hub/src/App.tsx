import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
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
  PencilSimple,
  Play,
  Plus,
  SpinnerGap,
  StopCircle,
  Trash,
  Warning,
  Wrench,
  X,
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
  type SiteExecution,
  type SiteGroupId,
  type SiteInputKind,
} from './analysisCatalog'
import {
  getDesktopApi,
  type EngineStatus,
  type InputKind,
  type LocalArtifact,
  type LocalToolTask,
  type SessionListItem,
  type SessionRecord,
  type SessionUpdateEvent,
  type SiteResultMode,
  type SiteTask,
} from './lib/desktop'
import { useI18n, type Translate } from './i18n'
import {
  loadCustomCatalog,
  newCustomId,
  normalizeCustomUrl,
  type CustomCatalog,
  type CustomGroup,
  type CustomSite,
} from './customCatalog'

type View = 'new' | 'session' | 'history'

const STATUS_TONES: Record<string, 'muted' | 'info' | 'ok' | 'warn' | 'fail'> = {
  queued: 'muted',
  pending: 'muted',
  opening: 'info',
  opened_manual: 'warn',
  submitting: 'info',
  result_ready: 'ok',
  completed_manual: 'ok',
  running: 'info',
  completed: 'ok',
  partial: 'warn',
  ok: 'ok',
  needs_manual: 'warn',
  needs_setup: 'warn',
  skipped: 'muted',
  failed: 'fail',
  cancelled: 'muted',
}

const TERMINAL_STATUSES = new Set(['result_ready', 'completed_manual', 'completed', 'ok'])

function App({ archiveOnly = false, onNew }: { archiveOnly?: boolean; onNew?: () => void }) {
  const { locale, setLocale, t } = useI18n()
  const desktop = useMemo(() => getDesktopApi(), [])
  const [view, setView] = useState<View>(archiveOnly ? 'history' : 'new')
  const [sites, setSites] = useState<SiteCatalogEntry[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [selectedSites, setSelectedSites] = useState<Set<string>>(new Set())
  const [selectedTools, setSelectedTools] = useState<Set<string>>(
    new Set(['nucleic', 'physchem', 'hydrophobicity']),
  )
  const [customCatalog, setCustomCatalog] = useState<CustomCatalog>(() => loadCustomCatalog())
  const [customManagerOpen, setCustomManagerOpen] = useState(false)
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null)
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
    void desktop.engineStatus().then(setEngineStatus).catch(() => setEngineStatus(null))
    return () => {
      active = false
    }
  }, [refreshHistory, desktop])

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
      setNotice(t('msg.sessionDone'))
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
      setNotice(t('msg.sessionCancelled'))
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
  }, [activeSessionId, desktop, refreshHistory, t])

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
    const validation = validateStart(t, {
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
    const selectedCustomSites = customCatalog.sites.filter((site) => selectedSites.has(site.id))
    try {
      const started = await desktop.sessionStart({
        fastaText: fastaText.trim(),
        geneId: geneId.trim(),
        alias: alias.trim() || undefined,
        inputKind,
        siteIds: [...selectedSites],
        localToolIds: [...selectedTools],
        alignmentPath: alignmentPath || undefined,
        customSites: selectedCustomSites.map((site) => ({
          id: site.id,
          name: site.name,
          entryUrl: site.entryUrl,
          note: site.note,
        })),
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
          sites: [...selectedSites].map((siteId) => {
            const custom = selectedCustomSites.find((site) => site.id === siteId)
            if (custom) {
              return {
                siteId,
                id: siteId,
                name: custom.name,
                execution: 'open_only',
                custom: true,
                entryUrl: custom.entryUrl,
                status: 'queued',
              }
            }
            return { siteId, status: 'queued' }
          }),
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
      setError(t('msg.loadFailed', { reason: errorMessage(reason) }))
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
      setNotice(t('msg.exported', { path: result.path }))
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
      setError(t('msg.openFailed', { name: site.name, reason: errorMessage(reason) }))
    }
  }

  const saveSiteResult = async (site: SiteCatalogEntry, resultMode: SiteResultMode, resultUrl: string, notes: string) => {
    if (!activeSessionId) return
    try {
      let normalized: string | undefined
      if (resultMode === 'result_url') {
        normalized = normalizeHttpUrl(resultUrl) ?? undefined
        if (!normalized) throw new Error(t('result.httpOnly'))
        assertResultUrlForSite(t, site, normalized)
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
        ? t('msg.resultSaved', { name: site.name })
        : t('msg.resultNoLink', { name: site.name }))
    } catch (reason) {
      setError(errorMessage(reason))
      throw reason
    }
  }

  const copyForSite = async (site: SiteCatalogEntry) => {
    try {
      const value = sourceForSite(activeSession, site.inputKind)
      if (!value) throw new Error(sourceUnavailableMessage(t, site.inputKind))
      await navigator.clipboard.writeText(value)
      setNotice(t('msg.copied', { name: site.name, kind: copyLabel(t, site.inputKind) }))
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
      setError(t('msg.revealFailed', { reason: errorMessage(reason) }))
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t('skip.link')}</a>
      <header className="topbar">
        <button className="brand" type="button" onClick={() => archiveOnly ? onNew?.() : setView('new')} aria-label={t('brand.aria')}>
          <span className="brand-mark"><Dna size={23} weight="duotone" /></span>
          <span><strong>BioinformaticsHUB</strong><small>{t('brand.subtitle')}</small></span>
        </button>
        <nav className="nav" aria-label={t('nav.aria')}>
          <NavButton active={view === 'new'} icon={<House />} onClick={() => archiveOnly ? onNew?.() : setView('new')}>{t('nav.new')}</NavButton>
          <NavButton active={view === 'session'} icon={<ListChecks />} onClick={() => setView('session')} disabled={!activeSession}>{t('nav.session')}</NavButton>
          <NavButton active={view === 'history'} icon={<ClockCounterClockwise />} onClick={() => { setView('history'); void refreshHistory() }}>{t('nav.history')}</NavButton>
        </nav>
        <div className="lang-switch" role="group" aria-label={t('lang.aria')}>
          <button type="button" className={locale === 'zh' ? 'active' : ''} aria-pressed={locale === 'zh'} onClick={() => setLocale('zh')}>中</button>
          <button type="button" className={locale === 'en' ? 'active' : ''} aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button>
        </div>
        <span className={`connection-pill ${desktop.isDesktop ? 'connected' : ''}`}>
          <span aria-hidden="true" />{desktop.isDesktop ? t('conn.desktop') : t('conn.browser')}
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
            customCatalog={customCatalog}
            setCustomCatalog={setCustomCatalog}
            customManagerOpen={customManagerOpen}
            setCustomManagerOpen={setCustomManagerOpen}
            engineStatus={engineStatus}
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
            archiveOnly={archiveOnly}
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
          <EmptyState icon={<ListChecks />} title={t('empty.session.title')} text={t('empty.session.text')} action={t('empty.session.action')} onAction={() => setView('new')} />
        )}

        {view === 'history' && (
          <HistoryView history={history} busy={busy} onOpen={loadHistorySession} onRefresh={refreshHistory} />
        )}
      </main>

      <footer className="app-colophon">{t('footer.colophon')}</footer>
    </div>
  )
}

type NewSessionProps = {
  sites: SiteCatalogEntry[]
  selectedSites: Set<string>
  setSelectedSites: (value: Set<string>) => void
  selectedTools: Set<string>
  setSelectedTools: (value: Set<string>) => void
  customCatalog: CustomCatalog
  setCustomCatalog: (value: CustomCatalog) => void
  customManagerOpen: boolean
  setCustomManagerOpen: (value: boolean) => void
  engineStatus: EngineStatus | null
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
  const { locale, t } = useI18n()
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
        <p className="eyebrow">{t('new.eyebrow')}</p>
        <h1>{t('new.title')}</h1>
        <p>{t('new.lead')}</p>
      </section>

      <div className="new-grid">
        <GlassPanel className="input-panel" padding="clamp(18px, 3vw, 28px)" cornerRadius={26} solid>
          <SectionTitle icon={<Dna />} eyebrow={t('new.input.eyebrow')} title={t('new.input.title')} />
          <div className="two-fields">
            <label className="field"><span>{t('new.field.geneId')} <b aria-hidden="true">*</b><span className="sr-only">{t('new.field.required')}</span></span><input value={props.geneId} onChange={(e) => props.setGeneId(e.target.value)} placeholder={t('new.field.geneId.placeholder')} autoComplete="off" required aria-required="true" /></label>
            <label className="field"><span>{t('new.field.alias')}</span><input value={props.alias} onChange={(e) => props.setAlias(e.target.value)} placeholder={t('new.field.alias.placeholder')} autoComplete="off" /></label>
          </div>
          <fieldset className="segmented-field">
            <legend>{t('new.field.inputKind')}</legend>
            <div className="segmented" role="group">
              {([['auto', t('new.inputKind.auto')], ['cds', t('new.inputKind.cds')], ['protein', t('new.inputKind.protein')]] as Array<[InputKind, string]>).map(([value, label]) => (
                <button type="button" key={value} className={props.inputKind === value ? 'active' : ''} aria-pressed={props.inputKind === value} onClick={() => props.setInputKind(value)}>{label}</button>
              ))}
            </div>
          </fieldset>
          <label className="field fasta-field">
            <span>{t('new.field.fasta')} <b aria-hidden="true">*</b><span className="sr-only">{t('new.field.required')}</span></span>
            <textarea value={props.fastaText} onChange={(e) => props.setFastaText(e.target.value)} spellCheck={false} placeholder={'>gene_id\nATGGCC… 或 >protein_id\nMAV…'} required aria-required="true" />
          </label>
          <div className="file-row">
            <button className="btn ghost" type="button" onClick={() => void props.chooseFasta()}><FileArrowUp />{t('new.file.choose')}</button>
            <span>{props.fastaName || t('new.file.orPaste')}</span>
          </div>
          <p className="scope-note">{t('new.scopeNote')}</p>
        </GlassPanel>

        <GlassPanel className="selection-summary" padding="24px" cornerRadius={26} solid>
          <p className="eyebrow">{t('new.summary.eyebrow')}</p>
          <div className="selection-number">{String(props.selectedSites.size).padStart(2, '0')}</div>
          <p>{t('new.summary.sites')}</p>
          <div className="selection-number small">{String(props.selectedTools.size).padStart(2, '0')}</div>
          <p>{t('new.summary.tools')}</p>
          <div className="summary-rule" />
          <p className="muted">{t('new.summary.note')}</p>
        </GlassPanel>
      </div>

      <section className="catalog-section" aria-labelledby="website-heading">
        <div className="catalog-heading">
          <SectionTitle icon={<GlobeHemisphereEast />} eyebrow={t('new.websites.eyebrow')} title={t('new.websites.title')} id="website-heading" />
          <div className="compact-actions"><button className="btn ghost" type="button" onClick={() => props.setSelectedSites(new Set(props.sites.map((site) => site.id)))}>{t('new.websites.selectAll')}</button><button className="btn ghost" type="button" onClick={() => props.setSelectedSites(new Set())}>{t('new.websites.clear')}</button></div>
        </div>
        <p className="section-lead">{t('new.websites.lead')}</p>
        {SITE_GROUPS.map((group) => {
          const groupSites = props.sites.filter((site) => site.group === group.id)
          if (!groupSites.length) return null
          const allSelected = groupSites.every((site) => props.selectedSites.has(site.id))
          return (
            <div className="site-group" key={group.id}>
              <div className="group-heading"><h3>{locale === 'en' ? group.labelEn : group.label}</h3><button type="button" className="text-button" onClick={() => props.setSelectedSites(setGroup(props.selectedSites, groupSites.map((site) => site.id), !allSelected))}>{allSelected ? t('new.websites.clearGroup') : t('new.websites.selectGroup')}</button></div>
              <div className="site-select-grid">
                {groupSites.map((site) => (
                  <SiteSelectCard key={site.id} site={site} checked={props.selectedSites.has(site.id)} onToggle={() => toggleSite(site.id)} />
                ))}
              </div>
            </div>
          )
        })}
      </section>

      <CustomSitesSection
        customCatalog={props.customCatalog}
        selectedSites={props.selectedSites}
        onToggleSite={toggleSite}
        onOpenManager={() => props.setCustomManagerOpen(true)}
        onSelectGroup={(ids, select) => props.setSelectedSites(setGroup(props.selectedSites, ids, select))}
      />

      <section className="catalog-section local-selection" aria-labelledby="local-heading">
        <div className="catalog-heading"><SectionTitle icon={<Wrench />} eyebrow={t('new.local.eyebrow')} title={t('new.local.title')} id="local-heading" /><span className="source-pill">{t('new.local.pill')}</span></div>
        <EngineStatusBar status={props.engineStatus} />
        <div className="local-select-grid">
          {LOCAL_TOOLS.map((tool) => (
            <label className={`local-select-card ${props.selectedTools.has(tool.id) ? 'selected' : ''}`} key={tool.id}>
              <input type="checkbox" checked={props.selectedTools.has(tool.id)} onChange={() => toggleTool(tool.id)} />
              <span className="tool-index">{String(LOCAL_TOOLS.indexOf(tool) + 1).padStart(2, '0')}</span>
              <span><strong>{locale === 'en' ? tool.nameEn : tool.name}</strong><small>{locale === 'en' ? tool.descriptionEn : tool.description}</small><em>{locale === 'en' ? tool.provenanceEn : tool.provenance}</em></span>
            </label>
          ))}
        </div>
        {alignmentNeeded && (
          <div className="alignment-picker">
            <div><strong>{t('new.alignment.title')}</strong><span>{t('new.alignment.hint')}</span></div>
            <button className="btn ghost" type="button" onClick={() => void props.chooseAlignment()}><FileArrowUp />{t('new.alignment.choose')}</button>
            <code>{props.alignmentPath || t('new.alignment.none')}</code>
          </div>
        )}
      </section>

      <div className="launch-bar">
        <div><strong>{t('new.launch.count', { count: props.selectedSites.size + props.selectedTools.size })}</strong><span>{t('new.launch.hint')}</span></div>
        <button className="btn primary launch" type="button" onClick={() => void props.startSession()} disabled={props.busy || !props.sites.length}>{props.busy ? <SpinnerGap className="spin" /> : <Play weight="fill" />}{t('new.launch.cta')}</button>
      </div>

      {props.customManagerOpen && (
        <CustomCatalogManager
          catalog={props.customCatalog}
          onChange={props.setCustomCatalog}
          onClose={() => props.setCustomManagerOpen(false)}
        />
      )}
    </div>
  )
}

function SiteSelectCard({ site, checked, onToggle }: { site: SiteCatalogEntry; checked: boolean; onToggle: () => void }) {
  const { locale } = useI18n()
  const description = locale === 'en' ? (site.descriptionEn ?? site.description) : site.description
  const risk = locale === 'en' ? (site.riskEn ?? site.risk) : site.risk
  return (
    <label className={`site-select-card ${checked ? 'selected' : ''}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="custom-check" aria-hidden="true"><CheckCircle weight="fill" /></span>
      <span className="site-select-main"><span className="site-title-line"><strong>{site.name}</strong><ModeBadge mode={site.execution} /></span><small>{site.provider}</small><span>{description}</span>{risk && <em><Warning weight="fill" />{risk}</em>}</span>
    </label>
  )
}

function CustomSitesSection({ customCatalog, selectedSites, onToggleSite, onOpenManager, onSelectGroup }: { customCatalog: CustomCatalog; selectedSites: Set<string>; onToggleSite: (id: string) => void; onOpenManager: () => void; onSelectGroup: (ids: string[], select: boolean) => void }) {
  const { t } = useI18n()
  return (
    <section className="catalog-section custom-selection" aria-labelledby="custom-heading">
      <div className="catalog-heading">
        <SectionTitle icon={<LinkSimple />} eyebrow={t('new.custom.eyebrow')} title={t('new.custom.title')} id="custom-heading" />
        <div className="compact-actions"><button className="btn ghost" type="button" onClick={onOpenManager}><PencilSimple />{t('new.custom.manage')}</button></div>
      </div>
      {!customCatalog.sites.length ? (
        <p className="section-lead">{t('new.custom.empty')}</p>
      ) : (
        customCatalog.groups.map((group) => {
          const groupSites = customCatalog.sites.filter((site) => site.groupId === group.id)
          if (!groupSites.length) return null
          const allSelected = groupSites.every((site) => selectedSites.has(site.id))
          return (
            <div className="site-group" key={group.id}>
              <div className="group-heading"><h3>{group.name}</h3><button type="button" className="text-button" onClick={() => onSelectGroup(groupSites.map((site) => site.id), !allSelected)}>{allSelected ? t('new.custom.clearGroup') : t('new.custom.selectGroup')}</button></div>
              <div className="site-select-grid">
                {groupSites.map((site) => (
                  <SiteSelectCard key={site.id} site={customSiteToEntry(site)} checked={selectedSites.has(site.id)} onToggle={() => onToggleSite(site.id)} />
                ))}
              </div>
            </div>
          )
        })
      )}
    </section>
  )
}

function CustomCatalogManager({ catalog, onChange, onClose }: { catalog: CustomCatalog; onChange: (value: CustomCatalog) => void; onClose: () => void }) {
  const { t } = useI18n()
  const groups = catalog.groups
  const [selectedGroupId, setSelectedGroupId] = useState<string>(groups[0]?.id ?? '')
  const [siteGroupId, setSiteGroupId] = useState<string>(groups[0]?.id ?? '')
  const [newGroupName, setNewGroupName] = useState('')
  const [siteName, setSiteName] = useState('')
  const [siteUrl, setSiteUrl] = useState('')
  const [siteNote, setSiteNote] = useState('')
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null)
  const [formError, setFormError] = useState('')

  const activeGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0]
  const activeSites = catalog.sites.filter((site) => site.groupId === activeGroup?.id)

  const addGroup = () => {
    const name = newGroupName.trim()
    if (!name) {
      setFormError(t('custom.err.groupNameRequired'))
      return
    }
    setFormError('')
    const group: CustomGroup = { id: newCustomId('group'), name }
    onChange({ groups: [...groups, group], sites: catalog.sites })
    setNewGroupName('')
    setSelectedGroupId(group.id)
    setSiteGroupId(group.id)
  }

  const deleteGroup = (group: CustomGroup) => {
    if (!window.confirm(t('custom.group.removeConfirm', { name: group.name }))) return
    const nextGroups = groups.filter((candidate) => candidate.id !== group.id)
    const nextSites = catalog.sites.filter((site) => site.groupId !== group.id)
    onChange({ groups: nextGroups, sites: nextSites })
    if (selectedGroupId === group.id) setSelectedGroupId(nextGroups[0]?.id ?? '')
    if (siteGroupId === group.id) setSiteGroupId(nextGroups[0]?.id ?? '')
  }

  const submitSite = () => {
    const name = siteName.trim()
    const url = normalizeCustomUrl(siteUrl)
    if (!name) {
      setFormError(t('custom.err.nameRequired'))
      return
    }
    if (!url) {
      setFormError(t('custom.err.urlInvalid'))
      return
    }
    const targetGroupId = siteGroupId || groups[0]?.id
    if (!targetGroupId) return
    setFormError('')
    const note = siteNote.trim() || undefined
    if (editingSiteId) {
      onChange({
        groups,
        sites: catalog.sites.map((site) =>
          site.id === editingSiteId ? { ...site, name, entryUrl: url, note, groupId: targetGroupId } : site,
        ),
      })
    } else {
      const site: CustomSite = { id: newCustomId('site'), groupId: targetGroupId, name, entryUrl: url, note }
      onChange({ groups, sites: [...catalog.sites, site] })
    }
    setSiteName('')
    setSiteUrl('')
    setSiteNote('')
    setEditingSiteId(null)
    setSelectedGroupId(targetGroupId)
  }

  const startEditSite = (site: CustomSite) => {
    setEditingSiteId(site.id)
    setSiteGroupId(site.groupId)
    setSiteName(site.name)
    setSiteUrl(site.entryUrl)
    setSiteNote(site.note ?? '')
    setFormError('')
  }

  const deleteSite = (site: CustomSite) => {
    onChange({ groups, sites: catalog.sites.filter((candidate) => candidate.id !== site.id) })
    if (editingSiteId === site.id) {
      setEditingSiteId(null)
      setSiteName('')
      setSiteUrl('')
      setSiteNote('')
    }
  }

  return createPortal(
    <div className="custom-scrim">
      <div className="custom-dialog-shell" role="dialog" aria-modal="true" aria-label={t('custom.modal.title')}>
        <GlassPanel nativeMaterial className="custom-dialog" padding="clamp(20px, 4vw, 26px)" cornerRadius={26} elasticity={0}>
          <div className="custom-dialog-head">
            <div><p className="eyebrow">CUSTOM</p><h2>{t('custom.modal.title')}</h2></div>
            <button className="btn ghost custom-close" type="button" onClick={onClose} aria-label={t('custom.modal.close')}><X /></button>
          </div>

          <div className="custom-block">
            <div className="custom-block-head"><h3>{t('custom.groups.label')}</h3></div>
            {groups.length ? (
              <div className="custom-group-list">
                {groups.map((group) => (
                  <div className={`custom-group-item ${activeGroup?.id === group.id ? 'active' : ''}`} key={group.id}>
                    <button type="button" className="custom-group-select" onClick={() => { setSelectedGroupId(group.id); setSiteGroupId(group.id) }}>{group.name}<span>{catalog.sites.filter((site) => site.groupId === group.id).length}</span></button>
                    <button type="button" className="custom-icon-button" onClick={() => deleteGroup(group)} aria-label={t('custom.group.remove')}><Trash /></button>
                  </div>
                ))}
              </div>
            ) : <p className="custom-empty">{t('custom.groups.empty')}</p>}
            <div className="custom-add-row">
              <label className="field"><span className="sr-only">{t('custom.group.name')}</span><input value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGroup() } }} placeholder={t('custom.group.name')} /></label>
              <button className="btn ghost" type="button" onClick={addGroup}><Plus />{t('custom.group.add')}</button>
            </div>
          </div>

          <div className="custom-block">
            <div className="custom-block-head"><h3>{t('custom.sites.label')}{activeGroup ? ` · ${activeGroup.name}` : ''}</h3></div>
            {activeSites.length ? (
              <div className="custom-site-list">
                {activeSites.map((site) => (
                  <div className="custom-site-item" key={site.id}>
                    <div className="custom-site-info"><strong>{site.name}</strong><code>{site.entryUrl}</code>{site.note && <span>{site.note}</span>}</div>
                    <div className="custom-site-actions">
                      <button type="button" className="custom-icon-button" onClick={() => startEditSite(site)} aria-label={t('custom.site.save')}><PencilSimple /></button>
                      <button type="button" className="custom-icon-button" onClick={() => deleteSite(site)} aria-label={t('custom.site.remove')}><Trash /></button>
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="custom-empty">{t('custom.sites.empty')}</p>}
            {groups.length ? (
              <div className="custom-form">
                <div className="custom-form-title">{editingSiteId ? t('custom.site.save') : t('custom.site.add')}</div>
                <label className="field"><span>{t('custom.groups.label')}</span>
                  <select value={siteGroupId || groups[0]?.id} onChange={(e) => setSiteGroupId(e.target.value)}>
                    {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                  </select>
                </label>
                <label className="field"><span>{t('custom.site.name')}</span><input value={siteName} onChange={(e) => setSiteName(e.target.value)} /></label>
                <label className="field"><span>{t('custom.site.url')}</span><input type="url" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://…" /></label>
                <label className="field"><span>{t('custom.site.note')}</span><input value={siteNote} onChange={(e) => setSiteNote(e.target.value)} /></label>
                {formError && <p className="custom-form-error" role="alert">{formError}</p>}
                <div className="custom-form-actions">
                  <button className="btn primary block" type="button" onClick={submitSite}>{editingSiteId ? <CheckCircle /> : <Plus />}{editingSiteId ? t('custom.site.save') : t('custom.site.addCta')}</button>
                  {editingSiteId && <button className="btn ghost block" type="button" onClick={() => { setEditingSiteId(null); setSiteName(''); setSiteUrl(''); setSiteNote(''); setFormError('') }}>{t('custom.site.cancel')}</button>}
                </div>
              </div>
            ) : null}
          </div>
        </GlassPanel>
      </div>
    </div>,
    document.body,
  )
}

type SessionDashboardProps = {
  archiveOnly?: boolean
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
  const { locale, t } = useI18n()
  const siteTaskMap = taskMap(props.session.sites, 'siteId')
  const toolTaskMap = taskMap(props.session.localTools, 'toolId')
  const selectedSites = sessionSiteEntries(props.session, props.sites).filter((site) => siteTaskMap.has(site.id))
  const selectedTools = LOCAL_TOOLS.filter((tool) => toolTaskMap.has(tool.id))
  const doneSites = selectedSites.filter((site) => TERMINAL_STATUSES.has(String(siteTaskMap.get(site.id)?.status))).length
  const openSites = selectedSites.filter((site) => ['opened_manual', 'needs_manual'].includes(String(siteTaskMap.get(site.id)?.status))).length
  const running = ['running', 'opening', 'submitting', 'queued', 'pending'].includes(String(props.session.status ?? ''))

  return (
    <div className="dashboard enter">
      <GlassPanel className="session-hero" padding="clamp(20px, 3vw, 30px)" cornerRadius={28} solid>
        <div className="session-hero-main">
          <p className="eyebrow">{t('dash.eyebrow', { version: props.session.legacy ? 'LEGACY' : '0.5' })}</p>
          <h1>{sessionTitle(props.session)}</h1>
          <div className="session-meta"><span>{getSessionId(props.session)}</span><StatusBadge status={String(props.session.status ?? 'running')} />{props.session.legacy && <span className="legacy-badge">{t('dash.legacyBadge')}</span>}</div>
        </div>
        <div className="dashboard-actions">
          <button className="btn ghost" type="button" onClick={() => void props.reloadSession()}><ArrowClockwise />{t('dash.refresh')}</button>
          <button className="btn ghost" type="button" onClick={() => void props.exportBundle()}><DownloadSimple />{t('dash.export')}</button>
          {running && !props.archiveOnly && <button className="btn danger" type="button" onClick={() => void props.cancelSession()}><StopCircle />{t('dash.cancel')}</button>}
        </div>
        <div className="session-stats">
          <Stat value={`${doneSites}/${selectedSites.length}`} label={t('dash.stat.sites')} />
          <Stat value={String(openSites)} label={t('dash.stat.manual')} />
          <Stat value={String(selectedTools.length)} label={t('dash.stat.tools')} />
          <Stat value={inputKindLabel(locale, String(props.session.input?.inputKind ?? 'auto'))} label={t('dash.stat.input')} />
        </div>
        {props.session.input?.warnings && props.session.input.warnings.length > 0 && (
          <div className="input-warnings"><Warning weight="fill" /><div><strong>{t('dash.warnings')}</strong>{props.session.input.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div></div>
        )}
      </GlassPanel>

      <section className="dashboard-section" aria-labelledby="site-task-heading">
        <div className="catalog-heading"><SectionTitle icon={<GlobeHemisphereEast />} eyebrow={t('dash.sites.eyebrow')} title={t('dash.sites.title')} id="site-task-heading" /><span className="muted">{t('dash.sites.hint')}</span></div>
        {selectedSites.length ? (
          <div className="task-grid">
            {selectedSites.map((site) => (
              <div key={site.id}>
              {props.archiveOnly ? <article className="task-card"><h3>{site.name}</h3><StatusBadge status={String(siteTaskMap.get(site.id)?.status || 'unknown')} /><p>{String(siteTaskMap.get(site.id)?.resultUrl || '')}</p><p>{String(siteTaskMap.get(site.id)?.notes || '')}</p></article> : <SiteTaskCard
                key={site.id}
                site={site}
                task={siteTaskMap.get(site.id) as SiteTask | undefined}
                copyAvailable={Boolean(sourceForSite(props.session, site.inputKind))}
                onOpen={() => props.openSite(site)}
                onCopy={() => props.copyForSite(site)}
                onSave={(resultMode, url, notes) => props.saveSiteResult(site, resultMode, url, notes)}
              />}
              </div>
            ))}
          </div>
        ) : <p className="empty-inline">{t('dash.sites.empty')}</p>}
      </section>

      <section className="dashboard-section" aria-labelledby="local-task-heading">
        <div className="catalog-heading"><SectionTitle icon={<Flask />} eyebrow={t('dash.local.eyebrow')} title={t('dash.local.title')} id="local-task-heading" /><span className="source-pill">{t('dash.local.pill')}</span></div>
        {selectedTools.length ? (
          <div className="local-task-stack">
            {selectedTools.map((tool) => <LocalToolCard key={tool.id} definition={tool} task={toolTaskMap.get(tool.id) as LocalToolTask | undefined} onReveal={props.revealArtifact} />)}
          </div>
        ) : <p className="empty-inline">{t('dash.local.empty')}</p>}
      </section>

      {props.logs.length > 0 && (
        <details className="activity-log"><summary>{t('dash.log')} <span>{props.logs.length}</span></summary><pre>{props.logs.join('\n')}</pre></details>
      )}
    </div>
  )
}

function SiteTaskCard({ site, task, copyAvailable, onOpen, onCopy, onSave }: { site: SiteCatalogEntry; task?: SiteTask; copyAvailable: boolean; onOpen: () => Promise<void>; onCopy: () => Promise<void>; onSave: (resultMode: SiteResultMode, url: string, notes: string) => Promise<void> }) {
  const { locale, t } = useI18n()
  const [url, setUrl] = useState(task?.resultUrl ?? '')
  const [notes, setNotes] = useState(task?.notes ?? '')
  const [savingMode, setSavingMode] = useState<SiteResultMode | null>(null)
  const resultHelpId = useId()
  useEffect(() => { setUrl(task?.resultUrl ?? ''); setNotes(task?.notes ?? '') }, [task?.resultUrl, task?.notes])
  const status = String(task?.status ?? 'queued')
  const completedWithoutLink = status === 'completed_manual' && !task?.resultUrl
  const description = locale === 'en' ? (site.descriptionEn ?? site.description) : site.description
  const risk = locale === 'en' ? (site.riskEn ?? site.risk) : site.risk

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
      <div className="task-mode-row"><ModeBadge mode={site.execution} /><span>{inputKindName(locale, site.inputKind)}</span></div>
      <p>{description}</p>
      {site.automationNote && <div className="automation-note"><span>{t('task.automation')}</span>{site.automationNote}</div>}
      {risk && <div className="risk-note"><Warning weight="fill" />{risk}</div>}
      {task?.message && <p className="task-message">{task.message}</p>}
      <div className="task-actions">
        <button className="btn primary" type="button" onClick={() => void onOpen()}><ArrowSquareOut />{task?.resultUrl ? t('task.open.result') : site.execution === 'auto_submit' ? t('task.open.entry') : t('task.open.site')}</button>
        <button className="btn ghost" type="button" onClick={() => void doCopy()} disabled={!copyAvailable}><ClipboardText />{copyLabel(t, site.inputKind)}</button>
      </div>
      <div className="entry-link"><span>{t('task.entry')}</span><a href={site.entryUrl} target="_blank" rel="noreferrer">{shortUrl(site.entryUrl)}<ArrowSquareOut /></a></div>
      <details className="result-capture" open={Boolean(task?.resultUrl) || completedWithoutLink}>
        <summary><LinkSimple />{t('task.record')}</summary>
        {completedWithoutLink && <p className="no-result-record"><LinkBreak weight="bold" />{t('task.noResultRecord')}</p>}
        <label><span>{t('task.resultUrl')}</span><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-describedby={resultHelpId} /></label>
        <p className="result-help" id={resultHelpId}>{t('task.resultHelp')}</p>
        <label><span>{t('task.notes')}</span><textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('task.notes.placeholder')} /></label>
        <div className="result-actions">
          <button className="btn primary block" type="button" disabled={Boolean(savingMode) || !url.trim()} onClick={() => void doSave('result_url')}>{savingMode === 'result_url' ? <SpinnerGap className="spin" /> : <LinkSimple />}{t('task.saveResult')}</button>
          <button className="btn ghost block" type="button" disabled={Boolean(savingMode)} onClick={() => void doSave('no_persistent_url')}>{savingMode === 'no_persistent_url' ? <SpinnerGap className="spin" /> : <LinkBreak />}{t('task.saveNoLink')}</button>
        </div>
      </details>
    </article>
  )
}

function LocalToolCard({ definition, task, onReveal }: { definition: LocalToolDefinition; task?: LocalToolTask; onReveal: (path: string) => Promise<void> }) {
  const { locale, t } = useI18n()
  const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : []
  return (
    <article className="local-task-card">
      <div className="local-task-head"><div><span className="local-stamp"><Flask weight="fill" />{t('local.stamp')}</span><h3>{locale === 'en' ? definition.nameEn : definition.name}</h3></div><StatusBadge status={String(task?.status ?? 'queued')} /></div>
      <p>{task?.message || (locale === 'en' ? definition.descriptionEn : definition.description)}</p>
      <dl className="provenance-list">
        <div><dt>{t('local.provenance')}</dt><dd>{formatProvenance(task?.provenance, locale === 'en' ? definition.provenanceEn : definition.provenance)}</dd></div>
        {task?.source && <div><dt>{t('local.source')}</dt><dd><code>{task.source}</code></dd></div>}
        {task?.version && <div><dt>{t('local.version')}</dt><dd>{task.version}</dd></div>}
        {task?.parameters && <div><dt>{t('local.parameters')}</dt><dd><code>{formatParameters(task.parameters)}</code></dd></div>}
      </dl>
      {artifacts.length > 0 ? (
        <div className="artifact-grid">
          {artifacts.map((artifact, index) => <ArtifactView key={`${artifact.path}-${index}`} artifact={artifact} onReveal={onReveal} />)}
        </div>
      ) : <p className="artifact-empty">{t('local.artifactEmpty')}</p>}
    </article>
  )
}

function ArtifactView({ artifact, onReveal }: { artifact: LocalArtifact; onReveal: (path: string) => Promise<void> }) {
  const { t } = useI18n()
  const image = artifact.kind === 'image' || /\.(png|jpe?g|gif|svg|webp)$/i.test(artifact.path)
  const label = artifact.name || artifact.path.split(/[\\/]/).pop() || t('local.artifactFallback')
  return (
    <figure className={`artifact ${image ? 'image-artifact' : ''}`}>
      {image && artifact.url ? <img src={artifact.url} alt={`${label}，本地生成`} /> : <div className="artifact-icon">{image ? <Flask /> : <FileArrowUp />}</div>}
      <figcaption><strong>{label}</strong>{artifact.description && <span>{artifact.description}</span>}<code>{artifact.path}</code><button className="artifact-reveal" type="button" onClick={() => void onReveal(artifact.path)}><FolderOpen />{t('local.reveal')}</button></figcaption>
    </figure>
  )
}

function HistoryView({ history, busy, onOpen, onRefresh }: { history: SessionListItem[]; busy: boolean; onOpen: (item: SessionListItem) => Promise<void>; onRefresh: () => Promise<void> }) {
  const { locale, t } = useI18n()
  return (
    <div className="history-page enter">
      <div className="catalog-heading"><div><p className="eyebrow">{t('history.eyebrow')}</p><h1>{t('history.title')}</h1><p className="section-lead">{t('history.lead')}</p></div><button className="btn ghost" type="button" onClick={() => void onRefresh()}><ArrowClockwise />{t('history.refresh')}</button></div>
      {history.length ? (
        <div className="history-grid">
          {history.map((item, index) => {
            const id = String(item.sessionId ?? item.id ?? `record-${index}`)
            const legacy = Boolean(item.legacy || (item.version && !String(item.version).startsWith('0.5')))
            return (
              <article className="history-card" key={id}>
                <div><span className="history-date">{formatDate(locale, item.updatedAt ?? item.createdAt)}</span>{legacy && <span className="legacy-badge">{t('history.legacy')}</span>}</div>
                <h2>{item.alias || item.geneId || id}</h2>
                <code>{id}</code>
                {item.path && <p>{item.path}</p>}
                <div className="history-foot"><StatusBadge status={String(item.status ?? item.overall ?? 'pending')} /><button className="btn ghost" type="button" disabled={busy} onClick={() => void onOpen(item)}>{t('history.open')}<ArrowSquareOut /></button></div>
              </article>
            )
          })}
        </div>
      ) : <EmptyState icon={<ClockCounterClockwise />} title={t('history.empty.title')} text={t('history.empty.text')} />}
    </div>
  )
}

function NavButton({ active, icon, children, onClick, disabled = false }: { active: boolean; icon: React.ReactNode; children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} onClick={onClick} disabled={disabled}>{icon}<span>{children}</span></button>
}

function SectionTitle({ icon, eyebrow, title, id }: { icon: React.ReactNode; eyebrow: string; title: string; id?: string }) {
  return <div className="section-title"><span className="section-icon">{icon}</span><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div></div>
}

function EngineStatusBar({ status }: { status: EngineStatus | null }) {
  const { t } = useI18n()
  if (!status) return null
  const items = [
    { label: 'Python', ok: status.coreReady },
    { label: 'MAFFT', ok: status.mafft },
    { label: 'IQ-TREE', ok: status.iqtree },
    { label: t('engine.status.auto'), ok: status.autoSubmitReady },
  ]
  return (
    <div className="engine-status-bar" role="status" aria-label={t('engine.status.title')}>
      <span className="engine-status-title">{t('engine.status.title')}</span>
      <div className="engine-status-items">
        {items.map((item) => (
          <span key={item.label} className={`engine-status-item ${item.ok ? 'ok' : ''}`}>
            <span className="engine-status-dot" aria-hidden="true" />
            {item.label}
          </span>
        ))}
      </div>
      {!status.coreReady && <p className="engine-status-hint">{t('engine.status.hint')}</p>}
    </div>
  )
}

function ModeBadge({ mode }: { mode: SiteExecution }) {
  const { t } = useI18n()
  return <span className={`mode-badge ${mode}`}><span aria-hidden="true" />{t(mode === 'auto_submit' ? 'mode.auto_submit' : 'mode.open_only')}</span>
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n()
  const label = t(`status.${status}`) === `status.${status}` ? (status || t('status.unknown')) : t(`status.${status}`)
  const tone = STATUS_TONES[status] ?? 'muted'
  return <span className={`status-badge tone-${tone}`}><span aria-hidden="true" />{label}</span>
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

function sessionSiteEntries(session: SessionRecord, catalogSites: SiteCatalogEntry[]): SiteCatalogEntry[] {
  const catalogMap = new Map(catalogSites.map((site) => [site.id, site]))
  const entries: SiteCatalogEntry[] = []
  for (const record of session.sites ?? []) {
    const id = String(record.siteId ?? record.id ?? '')
    if (!id) continue
    const catalogEntry = catalogMap.get(id)
    if (catalogEntry) {
      entries.push(catalogEntry)
      continue
    }
    if (record.custom || id.startsWith('custom_') || record.entryUrl) {
      entries.push(customSiteToEntry({
        id,
        groupId: '',
        name: String(record.name ?? id),
        entryUrl: String(record.entryUrl ?? ''),
        note: typeof record.description === 'string' ? record.description : undefined,
      }))
    }
  }
  return entries
}

function customSiteToEntry(site: CustomSite): SiteCatalogEntry {
  return {
    id: site.id,
    name: site.name,
    nameEn: site.name,
    group: 'sequence' as SiteGroupId,
    provider: hostOf(site.entryUrl),
    description: site.note || site.entryUrl,
    descriptionEn: site.note || site.entryUrl,
    entryUrl: site.entryUrl,
    execution: 'open_only',
    inputKind: 'identifier',
    custom: true,
  }
}

function hostOf(value: string): string {
  try { return new URL(value).host } catch { return value }
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

function sourceUnavailableMessage(t: Translate, kind: SiteInputKind): string {
  if (kind === 'protein_fasta') return t('source.protein_fasta')
  if (kind === 'alignment_fasta') return t('source.alignment_fasta')
  if (kind === 'tree') return t('source.tree')
  if (kind === 'structure') return t('source.structure')
  return t('source.default')
}

function copyLabel(t: Translate, kind: SiteInputKind): string {
  if (kind === 'identifier') return t('copyLabel.identifier')
  if (kind === 'alignment_fasta') return t('copyLabel.alignment_fasta')
  if (kind === 'tree') return t('copyLabel.tree')
  if (kind === 'structure') return t('copyLabel.structure')
  return kind === 'nucleotide_fasta' ? t('copyLabel.nucleotide_fasta') : t('copyLabel.protein_fasta')
}

function inputKindName(locale: 'zh' | 'en', kind: SiteInputKind): string {
  const map: Record<SiteInputKind, [string, string]> = {
    nucleotide_fasta: ['核酸 FASTA', 'Nucleotide FASTA'],
    protein_fasta: ['蛋白 FASTA', 'Protein FASTA'],
    alignment_fasta: ['多序列 FASTA', 'Multiple sequence FASTA'],
    tree: ['Newick 树', 'Newick tree'],
    identifier: ['基因 / 蛋白标识', 'Gene / protein ID'],
    structure: ['结构文件', 'Structure file'],
  }
  const entry = map[kind] ?? map.identifier
  return locale === 'en' ? entry[1] : entry[0]
}

function inputKindLabel(locale: 'zh' | 'en', kind: string): string {
  if (kind === 'cds') return 'CDS'
  if (kind === 'protein') return locale === 'en' ? 'Protein' : '蛋白'
  return locale === 'en' ? 'Auto' : '自动'
}

function validateStart(t: Translate, values: { geneId: string; fastaText: string; selectedCount: number; alignmentRequired: boolean; alignmentPath: string }): string {
  if (!values.geneId.trim()) return t('validate.geneIdRequired')
  const fasta = values.fastaText.trim()
  if (!fasta.startsWith('>') || fasta.split(/\r?\n/).length < 2) return t('validate.fastaInvalid')
  if (!values.selectedCount) return t('validate.selectAtLeastOne')
  if (values.alignmentRequired && !values.alignmentPath) return t('validate.alignmentRequired')
  return ''
}

function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.toString()
  } catch { return null }
}

function assertResultUrlForSite(t: Translate, site: SiteCatalogEntry, resultUrl: string): void {
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
    throw new Error(t('result.originInvalid', { name: site.name, origin: result.origin }))
  }
  if (isEntryEquivalentResultUrl(site.entryUrl, resultUrl)) {
    throw new Error(t('result.stillEntry', { name: site.name }))
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

function formatDate(locale: 'zh' | 'en', value?: string): string {
  if (!value) return locale === 'en' ? 'Unknown time' : '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export default App

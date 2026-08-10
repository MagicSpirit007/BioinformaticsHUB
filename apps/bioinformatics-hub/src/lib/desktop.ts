/** Electron preload bridge for BioinformaticsHUB 0.3 website aggregation sessions. */

export type InputKind = 'auto' | 'cds' | 'protein'

export type TaskStatus =
  | 'queued'
  | 'opening'
  | 'opened_manual'
  | 'submitting'
  | 'result_ready'
  | 'completed_manual'
  | 'needs_manual'
  | 'needs_setup'
  | 'skipped'
  | 'failed'
  | 'cancelled'
  | 'running'
  | 'completed'
  | 'partial'
  | 'ok'
  | 'pending'

export type SessionStartArgs = {
  fastaText: string
  geneId: string
  alias?: string
  inputKind: InputKind
  siteIds: string[]
  localToolIds: string[]
  alignmentPath?: string
}

export type SessionInput = {
  geneId?: string
  alias?: string
  inputKind?: InputKind | string
  fastaText?: string
  normalizedFasta?: string
  nucleotideFasta?: string
  cdsFasta?: string
  proteinFasta?: string
  alignmentFasta?: string
  normalizedFastaPath?: string
  alignmentPath?: string
  translationRule?: string
  warnings?: string[]
  [key: string]: unknown
}

export type SiteTask = {
  id?: string
  siteId?: string
  status?: TaskStatus | string
  entryUrl?: string
  resultUrl?: string
  message?: string
  notes?: string
  openedAt?: string
  completedAt?: string
  [key: string]: unknown
}

export type LocalArtifact = {
  path: string
  name?: string
  kind?: 'image' | 'table' | 'text' | 'tree' | 'alignment' | string
  url?: string
  description?: string
  [key: string]: unknown
}

export type LocalToolTask = {
  id?: string
  toolId?: string
  status?: TaskStatus | string
  message?: string
  provenance?: string | Record<string, unknown>
  version?: string
  source?: string
  parameters?: Record<string, unknown> | string[] | string
  artifacts?: LocalArtifact[]
  [key: string]: unknown
}

export type SessionRecord = {
  id?: string
  sessionId?: string
  sessionDir?: string
  path?: string
  schemaVersion?: number
  version?: string
  legacy?: boolean
  status?: string
  createdAt?: string
  updatedAt?: string
  geneId?: string
  alias?: string
  fastaText?: string
  nucleotideFasta?: string
  cdsFasta?: string
  proteinFasta?: string
  input?: SessionInput
  sites?: SiteTask[]
  localTools?: LocalToolTask[]
  [key: string]: unknown
}

export type SessionListItem = {
  id?: string
  sessionId?: string
  path?: string
  status?: string
  overall?: string
  updatedAt?: string
  createdAt?: string
  geneId?: string
  alias?: string
  legacy?: boolean
  version?: string
  [key: string]: unknown
}

export type SessionUpdateEvent =
  | SessionRecord
  | {
      sessionId?: string
      status?: string
      message?: string
      site?: SiteTask
      localTool?: LocalToolTask
    }

export type SessionDoneEvent = {
  sessionId?: string
  sessionDir?: string
  status?: string
  session?: SessionRecord
}

export type SessionErrorEvent = { message: string; sessionId?: string }

export type OpenSiteArgs = {
  sessionId: string
  siteId: string
  /** Browser-preview fallback only; Electron may ignore it. */
  entryUrl?: string
}

export type SiteResultMode = 'result_url' | 'no_persistent_url'

export type SaveSiteResultArgs = {
  sessionId: string
  siteId: string
  /** Omitted by legacy callers; a supplied resultUrl then implies result_url. */
  resultMode?: SiteResultMode
  resultUrl?: string
  notes?: string
}

export type RevealArtifactArgs = {
  sessionId: string
  path: string
}

export type PickedTextFile = { path: string; name?: string; text: string }

export type DesktopApi = {
  isDesktop: boolean
  sessionStart: (args: SessionStartArgs) => Promise<{ sessionId: string; sessionDir?: string }>
  sessionCancel: (sessionId: string) => Promise<void | { ok: boolean }>
  loadSession: (sessionId: string) => Promise<SessionRecord>
  listSessions: () => Promise<SessionListItem[]>
  openSite: (args: OpenSiteArgs) => Promise<void | { ok: boolean; resultUrl?: string; status?: string }>
  saveSiteResult: (args: SaveSiteResultArgs) => Promise<void | { ok: boolean; session?: SessionRecord }>
  revealArtifact: (args: RevealArtifactArgs) => Promise<void | { ok: boolean }>
  exportResearchBundle: (sessionId: string) => Promise<{ path: string }>
  pickFasta: () => Promise<PickedTextFile | null>
  pickAlignment: () => Promise<PickedTextFile | null>
  onSessionUpdate: (cb: (event: SessionUpdateEvent) => void) => () => void
  onLog: (cb: (event: string | { sessionId?: string; message: string }) => void) => () => void
  onSessionDone: (cb: (event: SessionDoneEvent) => void) => () => void
  onSessionCancelled: (cb: (event: { sessionId?: string }) => void) => () => void
  onSessionError: (cb: (event: SessionErrorEvent) => void) => () => void
}

declare global {
  interface Window {
    bioinformaticsHub?: Partial<DesktopApi>
  }
}

const browserSessions = new Map<string, SessionRecord>()

function sessionIdOf(record: SessionRecord | SessionListItem): string {
  return String(record.sessionId ?? record.id ?? '')
}

export function getDesktopApi(): DesktopApi {
  const bridge = typeof window !== 'undefined' ? window.bioinformaticsHub : undefined
  const isDesktop = Boolean(bridge?.isDesktop)

  return {
    isDesktop,
    sessionStart: async (args) => {
      if (bridge?.sessionStart) return bridge.sessionStart(args)
      const sessionId = `${safeId(args.geneId)}-${new Date().toISOString().replace(/[:.]/g, '-')}`
      const now = new Date().toISOString()
      browserSessions.set(sessionId, {
        sessionId,
        schemaVersion: 1,
        version: '0.3.0-preview',
        status: 'running',
        createdAt: now,
        updatedAt: now,
        input: {
          geneId: args.geneId,
          alias: args.alias,
          inputKind: args.inputKind,
          fastaText: args.fastaText,
          normalizedFasta: args.fastaText,
          nucleotideFasta: args.inputKind === 'protein' ? undefined : args.fastaText,
          proteinFasta: args.inputKind === 'protein' ? args.fastaText : undefined,
          alignmentPath: args.alignmentPath,
        },
        sites: args.siteIds.map((siteId) => ({ siteId, status: 'queued' })),
        localTools: args.localToolIds.map((toolId) => ({
          toolId,
          status: 'needs_setup',
          message: '浏览器预览不运行本地引擎',
        })),
      })
      return { sessionId }
    },
    sessionCancel: async (sessionId) => {
      if (bridge?.sessionCancel) return bridge.sessionCancel(sessionId)
      const session = browserSessions.get(sessionId)
      if (session) browserSessions.set(sessionId, { ...session, status: 'cancelled' })
      return { ok: true }
    },
    loadSession: async (sessionId) => {
      if (bridge?.loadSession) return bridge.loadSession(sessionId)
      const session = browserSessions.get(sessionId)
      if (!session) throw new Error('浏览器预览中没有该研究任务')
      return session
    },
    listSessions: async () => {
      if (bridge?.listSessions) return bridge.listSessions()
      return Array.from(browserSessions.values()).map((session) => ({
        sessionId: sessionIdOf(session),
        status: session.status,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        geneId: session.input?.geneId,
        alias: session.input?.alias,
        version: session.version,
      }))
    },
    openSite: async (args) => {
      if (bridge?.openSite) return bridge.openSite(args)
      if (args.entryUrl) window.open(args.entryUrl, '_blank', 'noopener,noreferrer')
      const session = browserSessions.get(args.sessionId)
      if (session) {
        browserSessions.set(args.sessionId, {
          ...session,
          sites: session.sites?.map((site) =>
            String(site.siteId ?? site.id) === args.siteId
              ? { ...site, status: 'opened_manual', openedAt: new Date().toISOString() }
              : site,
          ),
        })
      }
      return { ok: true, status: 'opened_manual' }
    },
    saveSiteResult: async (args) => {
      if (bridge?.saveSiteResult) return bridge.saveSiteResult(args)
      const session = browserSessions.get(args.sessionId)
      if (!session) throw new Error('浏览器预览中没有该研究任务')
      const resultMode = args.resultMode ?? (args.resultUrl ? 'result_url' : undefined)
      if (!resultMode) throw new Error('必须明确保存结果链接，或选择无可复开链接完成')
      if (resultMode === 'result_url' && !args.resultUrl) throw new Error('缺少结果 URL')
      if (resultMode === 'no_persistent_url' && args.resultUrl) {
        throw new Error('无可复开链接模式不能同时保存结果 URL')
      }
      const next: SessionRecord = {
        ...session,
        updatedAt: new Date().toISOString(),
        sites: session.sites?.map((site) =>
          String(site.siteId ?? site.id) === args.siteId
            ? {
                ...site,
                status: 'completed_manual',
                resultUrl: resultMode === 'result_url' ? args.resultUrl : undefined,
                notes: args.notes,
                completedAt: new Date().toISOString(),
              }
            : site,
        ),
      }
      browserSessions.set(args.sessionId, next)
      return { ok: true, session: next }
    },
    revealArtifact: async (args) => {
      if (bridge?.revealArtifact) return bridge.revealArtifact(args)
      throw new Error(`浏览器预览无法显示本地文件：${args.path}`)
    },
    exportResearchBundle: async (sessionId) => {
      if (bridge?.exportResearchBundle) return bridge.exportResearchBundle(sessionId)
      const session = browserSessions.get(sessionId)
      if (!session) throw new Error('浏览器预览中没有该研究任务')
      const filename = `${safeId(sessionId)}-研究工作包.md`
      const blob = new Blob([previewBundle(session)], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      URL.revokeObjectURL(url)
      return { path: filename }
    },
    pickFasta: async () => {
      if (bridge?.pickFasta) return bridge.pickFasta()
      return pickTextFile('.fa,.fasta,.fna,.faa,.txt')
    },
    pickAlignment: async () => {
      if (bridge?.pickAlignment) return bridge.pickAlignment()
      return pickTextFile('.fa,.fasta,.faa,.aln,.afa,.txt')
    },
    onSessionUpdate: (cb) => bridge?.onSessionUpdate?.(cb) ?? (() => undefined),
    onLog: (cb) => bridge?.onLog?.(cb) ?? (() => undefined),
    onSessionDone: (cb) => bridge?.onSessionDone?.(cb) ?? (() => undefined),
    onSessionCancelled: (cb) => bridge?.onSessionCancelled?.(cb) ?? (() => undefined),
    onSessionError: (cb) => bridge?.onSessionError?.(cb) ?? (() => undefined),
  }
}

function safeId(value: string): string {
  return value.trim().replace(/[^\p{L}\p{N}_.-]+/gu, '_') || 'sequence'
}

async function pickTextFile(accept: string): Promise<PickedTextFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      resolve({ path: file.name, name: file.name, text: await file.text() })
    }
    input.click()
  })
}

function previewBundle(session: SessionRecord): string {
  const sites = (session.sites ?? [])
    .map((site) => {
      const result = site.resultUrl
        ? ` — ${site.resultUrl}`
        : String(site.status ?? '').toLowerCase() === 'completed_manual'
          ? ' — 无可复开链接'
          : ''
      return `- ${site.siteId ?? site.id}: ${site.status ?? 'queued'}${result}`
    })
    .join('\n')
  const tools = (session.localTools ?? [])
    .map((tool) => `- ${tool.toolId ?? tool.id}: ${tool.status ?? 'queued'}${tool.provenance ? ` — ${tool.provenance}` : ''}`)
    .join('\n')
  return `# 研究工作包\n\n> BioinformaticsHUB 浏览器预览导出；不包含科学结论。\n\n## 输入\n\n- ID: ${session.input?.geneId ?? ''}\n- 别名: ${session.input?.alias ?? ''}\n\n## 网站任务\n\n${sites || '- 无'}\n\n## 本地工具\n\n${tools || '- 无'}\n`
}

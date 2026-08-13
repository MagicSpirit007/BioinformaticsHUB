/**
 * BioinformaticsHUB Electron main process (Windows-first).
 *
 * The desktop shell owns session.json and the browser-opening lifecycle. Python
 * performs sequence preprocessing/local tools plus explicitly allow-listed
 * auto-submit sites and reports newline-delimited JSON events back here.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn, spawnSync } = require('child_process')
const os = require('os')
const { StringDecoder } = require('string_decoder')
const {
  isPackaged,
  engineRoot,
  resolvePython,
  resolveMafft,
  resolveIqtree,
  sessionRunnerScript,
  siteCatalogPath,
  uiIndexHtml,
  fallbackHtml,
  defaultRunsRoot,
  engineEnv,
  safeRunId,
  isPathInside,
  resolveDeclaredArtifact,
  copyAlignmentIntoRun,
  assertAlignmentFileExtension,
  canFinalizeSession,
  deriveSessionFinalStatus,
  resolveRunDir,
  resolveRunDirFromArg,
  getDevOrigins,
  isAllowedNavigation,
  assertFastaByteLimit,
  assertHttpUrl,
  isEntryEquivalentResultUrl,
  MAX_FASTA_BYTES,
  MAX_ALIGNMENT_BYTES,
  ALIGNMENT_EXTENSIONS,
  CANCEL_GRACE_MS,
  TASKKILL_TIMEOUT_MS,
} = require('./paths.cjs')

const SESSION_VERSION = 1
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
// input_ready may describe a 10 MiB nucleotide FASTA plus its translated form.
const MAX_EVENT_LINE = 48 * 1024 * 1024
const MAX_STDERR_BUFFER = 1024 * 1024
const MANUAL_BATCH_SIZE = 5
const MANUAL_TAB_DELAY_MS = 750
const MANUAL_BATCH_DELAY_MS = 4_000
const SITE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const CUSTOM_SITE_ID_RE = /^custom_[A-Za-z0-9_.-]{1,63}$/
const LOCAL_TOOL_IDS = new Set([
  'nucleic',
  'physchem',
  'hydrophobicity',
  'mafft',
  'weblogo',
  'iqtree',
  'itol',
])

let mainWindow = null

// UI language for main-process messages (errors, dialogs, research bundle).
// The renderer pushes its selection via app:setLocale; defaults to the OS locale.
let uiLocale = /^zh/i.test(String(typeof app.getLocale === 'function' ? app.getLocale() : 'en')) ? 'zh' : 'en'

const MESSAGES = {
  zh: {
    'catalog.missing': (p) => `找不到网站目录: ${p}`,
    'catalog.invalid': (p) => `网站目录无法解析: ${p}`,
    'catalog.badSiteId': (p) => `网站目录含非法 siteId: ${p}`,
    'catalog.dupSiteId': (p) => `网站目录含重复 siteId: ${p}`,
    'catalog.badExecution': (s, e) => `网站 ${s} 的 execution 无效: ${e || '(empty)'}`,
    'site.invalidId': 'siteId 无效',
    'site.notInCatalog': (p) => `网站不在目录中: ${p}`,
    'site.resultUrlLabel': (p) => `${p} 结果 URL`,
    'site.originNotAllowed': (p) => `结果 URL 来源不属于网站目录允许范围: ${p}`,
    'site.stillEntry': (p) =>
      `这仍是 ${p} 的入口页，不能作为可复开的结果链接。` +
      '若网站提交后地址未变化，请选择“无可复开链接，标记完成”。',
    'site.urlLabel': (p) => `站点 ${p} URL`,
    'site.missingUrl': (p) => `站点 ${p} 缺少入口 URL`,
    'list.badId': (l, i) => `${l} 含非法 ID: ${i}`,
    'list.tooMany': (l) => `${l} 数量过多`,
    'session.allocFail': '无法分配新的会话目录',
    'session.pathEscape': 'session.json 路径越界',
    'session.dirMissing': (p) => `会话目录不存在: ${p}`,
    'session.invalidJson': (p) => `session.json 无法解析: ${p}`,
    'session.invalidStructure': 'session.json 结构无效',
    'session.missingFasta': '缺少 FASTA 序列',
    'session.missingRunner': (p) => `找不到会话引擎: ${p}`,
    'session.alreadyRunning': (p) => `会话已在运行: ${p}`,
    'session.unknownTool': (p) => `未知本地工具: ${p}`,
    'session.missingSite': (p) => `网站未包含在本次会话中: ${p}`,
    'session.openUrlNotOwned': '打开 URL 不属于该会话的网站记录',
    'session.resultModeRequired': '必须明确保存结果链接，或选择无可复开链接完成',
    'session.noLinkWithUrl': '无可复开链接模式不能同时保存结果 URL',
    'legacy.noArtifacts': '旧版记录不包含已声明的本地产物',
    'legacy.noSites': '旧版记录不包含网站任务',
    'legacy.noBundle': '旧版记录没有 0.3 研究工作包',
    'legacy.noSaveResult': '旧版记录不支持保存网站结果',
    'artifact.notFile': '产物不是普通文件',
    'alignment.importRequired': '比对文件必须通过“选择比对文件”导入',
    'alignment.notFile': '所选比对路径不是文件',
    'alignment.tooLarge': '比对文件超过 25 MiB 上限',
    'pick.notFile': '所选路径不是文件',
    'pick.tooLarge': (p) => `文件超过 ${p} MiB 上限`,
    'pick.contentTooLarge': '文件内容超过大小上限',
    'dialog.exportTitle': '导出研究工作包',
    'dialog.exportDefault': (p) => `研究工作包_${p}.md`,
    'dialog.pickFasta': '选择 FASTA',
    'dialog.pickAlignment': '选择多序列比对文件',
    'dialog.pickAlignmentFilter': '多序列 FASTA',
    'log.eventTooLarge': 'Python 事件行超过大小上限，已丢弃该行',
    'log.runnerExitedNoDone': 'session_runner.py 已退出，但未发送 done 事件',
    'log.runnerExit': (p) => `session_runner.py exit ${p}`,
    'session.runFailed': '会话运行失败',
    'result.autoOpenFailed': (p) => `结果已生成，但无法自动打开：${p}`,
    'result.manualOpenFailed': (p) => `需要人工处理，且官方入口打开失败：${p}`,
    'custom.badId': (p) => `自定义网站含非法 id: ${p}`,
    'custom.badUrl': (p) => `自定义网站 ${p} 的网址无效`,
    'custom.missingName': (p) => `自定义网站 ${p} 缺少名称`,
    'tool.needsSetup':
      '未检测到本地引擎；请运行安装目录中的 install_tools.ps1 安装 Python 依赖与 MAFFT / IQ-TREE。',
  },
  en: {
    'catalog.missing': (p) => `Site catalog not found: ${p}`,
    'catalog.invalid': (p) => `Site catalog could not be parsed: ${p}`,
    'catalog.badSiteId': (p) => `Site catalog has an invalid siteId: ${p}`,
    'catalog.dupSiteId': (p) => `Site catalog has a duplicate siteId: ${p}`,
    'catalog.badExecution': (s, e) => `Site ${s} has an invalid execution: ${e || '(empty)'}`,
    'site.invalidId': 'Invalid siteId',
    'site.notInCatalog': (p) => `Site is not in the catalog: ${p}`,
    'site.resultUrlLabel': (p) => `${p} result URL`,
    'site.originNotAllowed': (p) => `The result URL origin is outside the allowed catalog range: ${p}`,
    'site.stillEntry': (p) =>
      `This is still the entry page of ${p}, so it cannot be reused as a result link. ` +
      'If the address does not change after submission, choose “no link, mark complete”.',
    'site.urlLabel': (p) => `Site ${p} URL`,
    'site.missingUrl': (p) => `Site ${p} is missing an entry URL`,
    'list.badId': (l, i) => `${l} contains an invalid ID: ${i}`,
    'list.tooMany': (l) => `Too many entries in ${l}`,
    'session.allocFail': 'Could not allocate a new session directory',
    'session.pathEscape': 'session.json path escapes its directory',
    'session.dirMissing': (p) => `Session directory does not exist: ${p}`,
    'session.invalidJson': (p) => `session.json could not be parsed: ${p}`,
    'session.invalidStructure': 'session.json has an invalid structure',
    'session.missingFasta': 'Missing FASTA sequence',
    'session.missingRunner': (p) => `Session engine not found: ${p}`,
    'session.alreadyRunning': (p) => `Session already running: ${p}`,
    'session.unknownTool': (p) => `Unknown local tool: ${p}`,
    'session.missingSite': (p) => `Site is not part of this session: ${p}`,
    'session.openUrlNotOwned': 'The URL to open does not belong to this session’s site record',
    'session.resultModeRequired': 'Save a result link explicitly, or choose “no link, mark complete”',
    'session.noLinkWithUrl': 'The “no link” mode cannot also save a result URL',
    'legacy.noArtifacts': 'Legacy records do not contain declared local artifacts',
    'legacy.noSites': 'Legacy records do not contain website tasks',
    'legacy.noBundle': 'Legacy records have no 0.3 research bundle',
    'legacy.noSaveResult': 'Legacy records do not support saving site results',
    'artifact.notFile': 'Artifact is not a regular file',
    'alignment.importRequired': 'The alignment file must be imported via “choose alignment file”',
    'alignment.notFile': 'The selected alignment path is not a file',
    'alignment.tooLarge': 'Alignment file exceeds the 25 MiB limit',
    'pick.notFile': 'The selected path is not a file',
    'pick.tooLarge': (p) => `File exceeds the ${p} MiB limit`,
    'pick.contentTooLarge': 'File content exceeds the size limit',
    'dialog.exportTitle': 'Export research bundle',
    'dialog.exportDefault': (p) => `research_bundle_${p}.md`,
    'dialog.pickFasta': 'Choose FASTA',
    'dialog.pickAlignment': 'Choose alignment file',
    'dialog.pickAlignmentFilter': 'Multiple sequence FASTA',
    'log.eventTooLarge': 'Python event line exceeded the size limit and was dropped',
    'log.runnerExitedNoDone': 'session_runner.py exited without sending a done event',
    'log.runnerExit': (p) => `session_runner.py exit ${p}`,
    'session.runFailed': 'Session run failed',
    'result.autoOpenFailed': (p) => `Result generated but could not be opened automatically: ${p}`,
    'result.manualOpenFailed': (p) => `Manual handling required, and the official entry failed to open: ${p}`,
    'custom.badId': (p) => `Custom site has an invalid id: ${p}`,
    'custom.badUrl': (p) => `Custom site ${p} has an invalid URL`,
    'custom.missingName': (p) => `Custom site ${p} is missing a name`,
    'tool.needsSetup':
      'Local engine not detected; run install_tools.ps1 from the install directory to set up Python dependencies and MAFFT / IQ-TREE.',
  },
}

function msg(key, ...args) {
  const dict = MESSAGES[uiLocale] || MESSAGES.en
  const entry = dict[key]
  if (entry == null) return key
  return typeof entry === 'function' ? entry(...args) : entry
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bioinformatics-hub-artifact',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

/**
 * @type {Map<string, {
 *   sessionId: string,
 *   runDir: string,
 *   child: import('child_process').ChildProcess,
 *   tempDir: string | null,
 *   tempFasta: string | null,
 *   cancelled: boolean,
 *   disposed: boolean,
 *   childClosed: boolean,
 *   runnerDone: boolean,
 *   runnerOverall: string | null,
 *   outcomeEmitted: boolean,
 *   stdoutBuffer: string,
 *   stderrBuffer: string,
 *   stdoutDecoder: StringDecoder,
 *   stderrDecoder: StringDecoder,
 *   manualTimers: Set<ReturnType<typeof setTimeout>>,
 *   manualSiteIds: string[],
 *   manualSitesScheduled: boolean,
 *   manualInFlight: number,
 *   openingResultSites: Set<string>,
 *   fallbackSiteOpenAttempts: Set<string>,
 *   session: Record<string, unknown>,
 * }>} */
const activeSessions = new Map()

/** Files whose absolute paths came from the alignment picker. */
const selectedAlignmentPaths = new Set()

let catalogCache = null
let catalogCachePath = null
let catalogCacheMtime = -1

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function nowIso() {
  return new Date().toISOString()
}

/**
 * Best-effort removal of a freshly created run directory that never received a
 * persisted session.json (session start failed mid-setup). Keeps allocateSessionId
 * names reusable; only removes the directory when it is empty or only contains
 * the initial alignment copy, and never touches anything outside the runs root.
 */
function removeEmptyRunDir(runDir) {
  if (!runDir) return
  try {
    const stat = fs.statSync(runDir)
    if (!stat.isDirectory()) return
    const allowed = new Set(['00_input'])
    for (const entry of fs.readdirSync(runDir)) {
      if (!allowed.has(entry)) return
    }
    const inputDir = path.join(runDir, '00_input')
    if (fs.existsSync(inputDir)) {
      fs.rmSync(inputDir, { recursive: true, force: true })
    }
    fs.rmdirSync(runDir)
  } catch {
    /* best-effort only */
  }
}

const PY_PROBE_SNIPPET = [
  'import json',
  'import os',
  'pkgs = {}',
  "for name, key in [('Bio','biopython'),('numpy','numpy'),('matplotlib','matplotlib'),('logomaker','logomaker'),('PIL','pillow'),('playwright','playwright')]:",
  '    try:',
  '        __import__(name)',
  '        pkgs[key] = True',
  '    except Exception:',
  '        pkgs[key] = False',
  'chromium = False',
  "if pkgs.get('playwright'):",
  '    try:',
  '        from playwright.sync_api import sync_playwright',
  '        with sync_playwright() as p:',
  '            exe = p.chromium.executable_path',
  '            chromium = bool(exe) and os.path.isfile(exe)',
  '    except Exception:',
  '        chromium = False',
  "print(json.dumps({'packages': pkgs, 'chromium': chromium}))",
].join('\n')

/**
 * Probe the user's machine for the external tools that power local analysis and
 * the auto-submit site. The packaged app no longer ships Python/Chromium/MAFFT,
 * so this drives the UI status and the session:start engine-vs-degraded split.
 */
function probeEngine() {
  const python = resolvePython()
  const mafft = resolveMafft()
  const iqtree = resolveIqtree()
  const status = {
    python: Boolean(python),
    pythonPath: python || null,
    mafft: Boolean(mafft),
    mafftPath: mafft || null,
    iqtree: Boolean(iqtree),
    iqtreePath: iqtree || null,
    packages: {
      biopython: false,
      numpy: false,
      matplotlib: false,
      logomaker: false,
      pillow: false,
      playwright: false,
    },
    chromium: false,
    coreReady: false,
    autoSubmitReady: false,
  }
  if (python) {
    const probe = spawnSync(python, ['-c', PY_PROBE_SNIPPET], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    })
    if (!probe.error && probe.status === 0) {
      try {
        const parsed = JSON.parse(String(probe.stdout || '').trim() || '{}')
        if (parsed.packages && typeof parsed.packages === 'object') {
          status.packages = { ...status.packages, ...parsed.packages }
        }
        status.chromium = Boolean(parsed.chromium)
      } catch {
        /* probe output is not authoritative; leave everything as unavailable */
      }
    }
  }
  status.coreReady = Boolean(
    python &&
      status.packages.biopython &&
      status.packages.numpy &&
      status.packages.matplotlib &&
      status.packages.logomaker &&
      status.packages.pillow,
  )
  status.autoSubmitReady = Boolean(python && status.packages.playwright && status.chromium)
  return status
}

function textValue(value, maxLength = 4_000) {
  return String(value == null ? '' : value).replace(/\0/g, '').slice(0, maxLength)
}

function unlinkQuiet(filePath) {
  if (!filePath) return
  try {
    fs.unlinkSync(filePath)
  } catch {
    /* already absent or locked */
  }
}

function cleanupTemp(entry) {
  if (!entry) return
  unlinkQuiet(entry.tempFasta)
  entry.tempFasta = null
  if (entry.tempDir) {
    try {
      fs.rmdirSync(entry.tempDir)
    } catch {
      /* only remove an empty, main-owned temp directory */
    }
    entry.tempDir = null
  }
}

function writeTempFasta(sessionId, fastaText) {
  assertFastaByteLimit(fastaText)
  const root = path.join(os.tmpdir(), 'bioinformatics-hub-session-')
  const tempDir = fs.mkdtempSync(root)
  const tempFasta = path.join(tempDir, `${safeRunId(sessionId)}.fasta`)
  fs.writeFileSync(tempFasta, fastaText, 'utf8')
  return { tempDir, tempFasta }
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child) return resolve('no_child')
    if (child.exitCode != null || child.signalCode != null) return resolve('already_exited')
    let settled = false
    const finish = (reason) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('close', onClose)
      resolve(reason)
    }
    const onClose = () => finish('closed')
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    child.once('close', onClose)
  })
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    let taskkill
    try {
      taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch (error) {
      finish({ ok: false, error: error.message || String(error) })
      return
    }
    timer = setTimeout(() => {
      try {
        taskkill.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: 'taskkill_timeout' })
    }, TASKKILL_TIMEOUT_MS)
    taskkill.once('close', (code) => finish({ ok: code === 0, code }))
    taskkill.once('error', (error) =>
      finish({ ok: false, error: error.message || String(error) }),
    )
  })
}

async function killProcessTree(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return
  if (process.platform === 'win32' && child.pid) {
    await runTaskkill(child.pid)
    const reason = await waitForChildExit(child, CANCEL_GRACE_MS)
    if (reason === 'timeout' && child.exitCode == null && child.signalCode == null) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      await waitForChildExit(child, 2_000)
    }
    return
  }
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  await waitForChildExit(child, CANCEL_GRACE_MS)
}

function allowedUiFilePaths() {
  const list = []
  const ui = uiIndexHtml()
  if (ui) list.push(ui)
  list.push(fallbackHtml())
  return list
}

function attachNavigationGuards(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const safeUrl = assertHttpUrl(url)
      const allowed = [...loadSiteCatalog().sites.values()].some(
        (site) => site.entryUrl === safeUrl,
      )
      if (allowed) shell.openExternal(safeUrl)
    } catch {
      /* deny invalid/non-web popup */
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (
      !isAllowedNavigation(url, {
        allowedFilePaths: allowedUiFilePaths(),
        devOrigins: getDevOrigins(),
      })
    ) {
      event.preventDefault()
    }
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#020617',
    title: 'BioinformaticsHUB',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  attachNavigationGuards(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow.show())

  const devUrl = process.env.BIOINFORMATICS_HUB_DEV_URL || 'http://127.0.0.1:5173'
  if (!isPackaged() && process.env.BIOINFORMATICS_HUB_USE_DIST !== '1') {
    mainWindow.loadURL(devUrl).catch(() => {
      const dist = uiIndexHtml()
      if (dist) mainWindow.loadFile(dist)
      else mainWindow.loadFile(fallbackHtml())
    })
    if (process.env.BIOINFORMATICS_HUB_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    const indexHtml = uiIndexHtml()
    mainWindow.loadFile(indexHtml && fs.existsSync(indexHtml) ? indexHtml : fallbackHtml())
  }
}

function catalogRows(raw) {
  const rows = Array.isArray(raw) ? raw : raw?.sites || raw?.catalog || []
  if (Array.isArray(rows)) return rows
  if (rows && typeof rows === 'object') {
    return Object.entries(rows).map(([id, value]) => ({ id, ...(value || {}) }))
  }
  return []
}

function firstSiteUrl(row) {
  const candidates = [
    row?.entryUrl,
    row?.entry_url,
    row?.url,
    row?.homeUrl,
    row?.home_url,
    row?.submitUrl,
    row?.submit_url,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    return assertHttpUrl(candidate, msg('site.urlLabel', row?.id || row?.siteId || ''))
  }
  throw new Error(msg('site.missingUrl', row?.id || row?.siteId || '(unknown)'))
}

function normalizeExecution(value) {
  const raw = String(value || '').toLowerCase()
  if (['auto_submit', 'auto-submit', 'auto'].includes(raw)) return 'auto_submit'
  if (['open_only', 'open-only', 'manual', 'browser'].includes(raw)) return 'open_only'
  if (raw === 'local') return 'local'
  return raw
}

function additionalSiteOrigins(row) {
  const values = []
  for (const key of [
    'resultOrigins',
    'result_origins',
    'allowedOrigins',
    'allowed_origins',
    'allowedResultOrigins',
    'allowed_result_origins',
  ]) {
    const value = row?.[key]
    if (Array.isArray(value)) values.push(...value)
    else if (value) values.push(value)
  }
  const origins = new Set()
  for (const value of values) {
    try {
      origins.add(new URL(assertHttpUrl(value, 'Site result origin')).origin)
    } catch {
      const host = String(value || '').trim().toLowerCase()
      if (/^[a-z0-9.-]+$/.test(host)) {
        origins.add(`https://${host}`)
        origins.add(`http://${host}`)
      }
    }
  }
  return origins
}

function loadSiteCatalog() {
  const filePath = siteCatalogPath()
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    throw new Error(msg('catalog.missing', filePath))
  }
  if (catalogCache && catalogCachePath === filePath && catalogCacheMtime === stat.mtimeMs) {
    return catalogCache
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(msg('catalog.invalid', error.message || error))
  }
  const sites = new Map()
  for (const row of catalogRows(raw)) {
    const siteId = String(row?.siteId || row?.id || '').trim()
    if (!SITE_ID_RE.test(siteId)) throw new Error(msg('catalog.badSiteId', siteId))
    if (sites.has(siteId)) throw new Error(msg('catalog.dupSiteId', siteId))
    const execution = normalizeExecution(row?.execution || row?.mode || row?.kind)
    if (!['open_only', 'auto_submit', 'local'].includes(execution)) {
      throw new Error(msg('catalog.badExecution', siteId, execution || '(empty)'))
    }
    if (execution === 'local') continue
    const entryUrl = firstSiteUrl(row)
    const allowedOrigins = additionalSiteOrigins(row)
    const entryParsed = new URL(entryUrl)
    allowedOrigins.add(entryParsed.origin)
    // Permit an official host to upgrade/downgrade between its catalogued HTTP
    // and HTTPS endpoint without permitting a different host.
    allowedOrigins.add(`http://${entryParsed.host}`)
    allowedOrigins.add(`https://${entryParsed.host}`)
    sites.set(siteId, {
      siteId,
      name: textValue(row?.name || row?.label || siteId, 200),
      execution,
      entryUrl,
      allowedOrigins,
      warning: textValue(row?.warning || row?.risk || '', 1_000),
    })
  }
  catalogCache = { version: raw?.version || 1, path: filePath, sites }
  catalogCachePath = filePath
  catalogCacheMtime = stat.mtimeMs
  return catalogCache
}

function getCatalogSite(siteIdRaw) {
  const siteId = String(siteIdRaw || '').trim()
  if (!SITE_ID_RE.test(siteId)) throw new Error(msg('site.invalidId'))
  const site = loadSiteCatalog().sites.get(siteId)
  if (!site) throw new Error(msg('site.notInCatalog', siteId))
  return site
}

/**
 * Resolve a site record for a session, preferring the built-in catalog but
 * falling back to custom sites persisted in the session record.
 */
function resolveSessionSite(session, siteIdRaw) {
  const siteId = String(siteIdRaw || '').trim()
  if (!SITE_ID_RE.test(siteId)) throw new Error(msg('site.invalidId'))
  const catalogSite = loadSiteCatalog().sites.get(siteId)
  if (catalogSite) return catalogSite
  const record = findSiteRecord(session, siteId)
  if (!record || !record.custom || !record.entryUrl) {
    throw new Error(msg('site.notInCatalog', siteId))
  }
  const entryUrl = assertHttpUrl(record.entryUrl, msg('site.urlLabel', siteId))
  const entryParsed = new URL(entryUrl)
  return {
    siteId,
    name: textValue(record.name || siteId, 200),
    execution: 'open_only',
    entryUrl,
    custom: true,
    allowedOrigins: new Set([
      entryParsed.origin,
      `http://${entryParsed.host}`,
      `https://${entryParsed.host}`,
    ]),
    warning: textValue(record.warning || '', 1_000),
  }
}

/**
 * Validate and normalize renderer-supplied custom sites for session:start.
 * @returns {Array<{ id: string, name: string, entryUrl: string, note?: string }>}
 */
function parseCustomSites(rawSites) {
  if (rawSites == null) return []
  if (!Array.isArray(rawSites)) throw new Error(msg('list.badId', '自定义网站列表', '(not a list)'))
  const seen = new Set()
  const result = []
  for (const row of rawSites.slice(0, 128)) {
    const id = String(row?.id ?? row?.siteId ?? '').trim()
    if (!CUSTOM_SITE_ID_RE.test(id)) throw new Error(msg('custom.badId', id || '(empty)'))
    if (seen.has(id)) continue
    const name = String(row?.name ?? '').trim()
    if (!name) throw new Error(msg('custom.missingName', id))
    const entryUrl = assertHttpUrl(row?.entryUrl, msg('site.urlLabel', name))
    seen.add(id)
    result.push({
      id,
      name: textValue(name, 200),
      entryUrl,
      note: textValue(row?.note, 1_000) || undefined,
    })
  }
  return result
}

function assertResultUrlForSite(site, rawUrl) {
  const canonical = assertHttpUrl(rawUrl, msg('site.resultUrlLabel', site.name || site.siteId))
  const origin = new URL(canonical).origin
  if (!site.allowedOrigins.has(origin)) {
    throw new Error(msg('site.originNotAllowed', origin))
  }
  return canonical
}

function assertPersistableResultUrlForSite(site, rawUrl) {
  const canonical = assertResultUrlForSite(site, rawUrl)
  if (isEntryEquivalentResultUrl(site.entryUrl, canonical)) {
    throw new Error(msg('site.stillEntry', site.name || site.siteId))
  }
  return canonical
}

function isValidSiteResultRecord(record) {
  try {
    const siteId = String(record?.siteId || record?.id || '')
    if (!record?.resultUrl) return false
    let site
    try {
      site = getCatalogSite(siteId)
    } catch {
      // Custom sites carry their own entry URL in the session record.
      if (!record.entryUrl) return false
      const entryUrl = assertHttpUrl(record.entryUrl, msg('site.urlLabel', siteId))
      const entryParsed = new URL(entryUrl)
      site = {
        siteId,
        name: textValue(record.name || siteId, 200),
        execution: 'open_only',
        entryUrl,
        allowedOrigins: new Set([
          entryParsed.origin,
          `http://${entryParsed.host}`,
          `https://${entryParsed.host}`,
        ]),
      }
    }
    return Boolean(assertResultUrlForSite(site, record.resultUrl))
  } catch {
    return false
  }
}

function normalizeIdList(value, label) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? value.split(',')
      : []
  const ids = []
  const seen = new Set()
  for (const item of raw) {
    const id = String(item || '').trim()
    if (!SITE_ID_RE.test(id)) throw new Error(msg('list.badId', label, id))
    if (!seen.has(id)) {
      ids.push(id)
      seen.add(id)
    }
  }
  if (ids.length > 128) throw new Error(msg('list.tooMany', label))
  return ids
}

function allocateSessionId(geneIdRaw) {
  const base = safeRunId(geneIdRaw || 'gene')
  const baseDir = resolveRunDir(base).runDir
  if (!fs.existsSync(baseDir)) return base
  const stamp = nowIso().replace(/[-:TZ.]/g, '').slice(0, 14)
  for (let index = 0; index < 1_000; index += 1) {
    const suffix = index ? `-${stamp}-${index + 1}` : `-${stamp}`
    const candidate = safeRunId(`${base}${suffix}`)
    if (!fs.existsSync(resolveRunDir(candidate).runDir)) return candidate
  }
  throw new Error(msg('session.allocFail'))
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  )
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, filePath)
  } finally {
    unlinkQuiet(tmp)
  }
}

function sessionPath(runDir) {
  const resolved = path.resolve(runDir, 'session.json')
  if (!isPathInside(runDir, resolved)) throw new Error(msg('session.pathEscape'))
  return resolved
}

function persistSession(runDir, session, { touch = true } = {}) {
  if (touch) session.updatedAt = nowIso()
  atomicWriteJson(sessionPath(runDir), session)
}

function normalizedArtifactPath(rawPath) {
  return String(rawPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/')
}

function artifactUrl(sessionId, relativePath) {
  const encodedPath = normalizedArtifactPath(relativePath)
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  return `bioinformatics-hub-artifact://file/${encodeURIComponent(sessionId)}/${encodedPath}`
}

function artifactMime(filePath) {
  return new Map([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
  ]).get(path.extname(String(filePath || '')).toLowerCase())
}

function declaredArtifactPaths(session) {
  return (Array.isArray(session?.localTools) ? session.localTools : []).flatMap((tool) =>
    (Array.isArray(tool?.artifacts) ? tool.artifacts : [])
      .map((artifact) => artifact?.path)
      .filter(Boolean),
  )
}

function readDeclaredInputText(runDir, relativePath, maxBytes) {
  if (!relativePath) return undefined
  const candidate = path.resolve(runDir, String(relativePath))
  if (!isPathInside(runDir, candidate)) return undefined
  try {
    const stat = fs.statSync(candidate)
    if (!stat.isFile() || stat.size > maxBytes) return undefined
    return fs.readFileSync(candidate, 'utf8')
  } catch {
    return undefined
  }
}

function safeSessionInputPath(runDir, rawPath) {
  if (!rawPath) return null
  const raw = String(rawPath).replace(/\\/g, '/')
  if (
    raw.includes('\0') ||
    path.isAbsolute(String(rawPath)) ||
    path.posix.isAbsolute(raw) ||
    raw.split('/').includes('..')
  ) {
    return null
  }
  const normalized = path.posix.normalize(raw)
  if (!normalized || normalized === '.') return null
  const candidate = path.resolve(runDir, ...normalized.split('/'))
  if (!isPathInside(runDir, candidate)) return null
  return path.relative(runDir, candidate).replace(/\\/g, '/')
}

function publicSession(session, runDir, { includeInputText = false } = {}) {
  const input = { ...(session.input || {}) }
  const inputFiles = [
    ['normalizedFastaPath', 'normalizedFasta', MAX_FASTA_BYTES],
    ['cdsFastaPath', 'cdsFasta', MAX_FASTA_BYTES],
    ['proteinFastaPath', 'proteinFasta', MAX_FASTA_BYTES],
    ['alignmentFastaPath', 'alignmentFasta', MAX_ALIGNMENT_BYTES],
  ]
  for (const textKey of [
    'fastaText',
    'sequenceText',
    'normalizedFasta',
    'nucleotideFasta',
    'cdsFasta',
    'proteinFasta',
    'alignmentFasta',
  ]) {
    delete input[textKey]
  }
  for (const [pathKey, textKey, limit] of inputFiles) {
    const safePath = safeSessionInputPath(runDir, input[pathKey])
    if (!safePath) {
      delete input[pathKey]
      continue
    }
    input[pathKey] = safePath
    if (includeInputText) {
      const text = readDeclaredInputText(runDir, safePath, limit)
      if (text !== undefined) input[textKey] = text
    }
  }
  if (includeInputText && !input.nucleotideFasta && input.cdsFasta) {
    input.nucleotideFasta = input.cdsFasta
  }
  if (!input.translationRule && input.translation?.rule) {
    input.translationRule = textValue(input.translation.rule, 1_000)
  }

  const localTools = (Array.isArray(session.localTools) ? session.localTools : []).map((tool) => ({
    ...tool,
    artifacts: (Array.isArray(tool?.artifacts) ? tool.artifacts : []).map((artifact) => {
      const item = { ...artifact }
      if (artifactMime(artifact.path)) {
        item.url = artifactUrl(session.sessionId || session.id, artifact.path)
      } else {
        delete item.url
      }
      return item
    }),
  }))
  const result = { ...session, input, localTools, sessionDir: runDir, runDir }
  for (const key of ['fastaText', 'sequenceText', 'cdsFasta', 'proteinFasta', 'alignmentFasta']) {
    delete result[key]
  }
  return result
}

async function handleArtifactRequest(request) {
  try {
    const url = new URL(request.url)
    if (url.hostname !== 'file') return new Response('Not found', { status: 404 })
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
    const sessionId = parts.shift()
    if (!sessionId || safeRunId(sessionId) !== sessionId || !parts.length) {
      return new Response('Bad request', { status: 400 })
    }
    const loaded = readSession(sessionId)
    if (loaded.legacy) return new Response('Not found', { status: 404 })
    const declaredPaths = declaredArtifactPaths(loaded.session)
    const target = resolveDeclaredArtifact(loaded.runDir, declaredPaths, parts.join('/'))
    const mime = artifactMime(target)
    if (!mime) return new Response('Unsupported media type', { status: 415 })
    const stat = await fs.promises.stat(target)
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
      return new Response('Not found', { status: 404 })
    }
    const body = await fs.promises.readFile(target)
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(stat.size),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

function readSession(sessionIdRaw) {
  const { runId: sessionId, runDir } = resolveRunDir(sessionIdRaw)
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    throw new Error(msg('session.dirMissing', sessionId))
  }
  const filePath = sessionPath(runDir)
  if (!fs.existsSync(filePath)) return legacySessionPayload(sessionId, runDir)
  let session
  try {
    session = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(msg('session.invalidJson', error.message || error))
  }
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error(msg('session.invalidStructure'))
  }
  if (!Array.isArray(session.sites)) session.sites = []
  if (!Array.isArray(session.localTools)) session.localTools = []
  // The containing directory is authoritative; never trust IDs persisted in data.
  session.id = sessionId
  session.sessionId = sessionId
  return { session, sessionId, runDir, legacy: false }
}

function legacySessionPayload(sessionId, runDir) {
  const stat = fs.statSync(runDir)
  const indexPath = path.join(runDir, 'index.html')
  return {
    legacy: true,
    sessionId,
    runDir,
    session: {
      id: sessionId,
      sessionId,
      status: 'legacy',
      legacy: true,
      createdAt: stat.birthtime?.toISOString?.() || stat.mtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      input: null,
      sites: [],
      localTools: [],
      openFolderPath: runDir,
      indexPath: fs.existsSync(indexPath) ? indexPath : null,
    },
  }
}

function loadSessionPayload(sessionIdRaw) {
  const loaded = readSession(sessionIdRaw)
  return publicSession(loaded.session, loaded.runDir, { includeInputText: true })
}

function findSiteRecord(session, siteId) {
  return session.sites.find((row) => String(row?.siteId || row?.id) === siteId)
}

function findToolRecord(session, toolId) {
  return session.localTools.find((row) => String(row?.toolId || row?.id) === toolId)
}

function sanitizeArtifact(raw, runDir) {
  if (!raw) return null
  const source = typeof raw === 'string' ? { path: raw } : raw
  if (typeof source !== 'object') return null
  const pathValue = source.path || source.file || source.relativePath
  if (!pathValue) return null
  const candidate = path.isAbsolute(String(pathValue))
    ? path.resolve(String(pathValue))
    : path.resolve(runDir, String(pathValue))
  if (!isPathInside(runDir, candidate)) return null
  const relativePath = path.relative(runDir, candidate).replace(/\\/g, '/')
  const result = {
    path: relativePath,
    name: textValue(source.name || path.basename(candidate), 240),
    kind: textValue(source.kind || source.type || 'file', 80),
  }
  if (source.description) result.description = textValue(source.description, 1_000)
  if (source.url) {
    try {
      result.url = assertHttpUrl(source.url, 'Artifact URL')
    } catch {
      /* local artifacts need no renderer-loadable URL */
    }
  }
  return result
}

function mergeSitePatch(entry, patch) {
  if (!patch || typeof patch !== 'object') return false
  const siteId = String(patch.siteId || patch.id || '').trim()
  if (!siteId) return false
  const record = findSiteRecord(entry.session, siteId)
  if (!record) return false
  const catalogSite = resolveSessionSite(entry.session, siteId)
  if (patch.status || patch.state) record.status = textValue(patch.status || patch.state, 64)
  if (patch.message != null) record.message = textValue(patch.message, 4_000)
  if (patch.note != null || patch.notes != null) {
    record.notes = textValue(patch.notes ?? patch.note, 4_000)
  }
  for (const key of ['openedAt', 'startedAt', 'completedAt']) {
    if (patch[key]) record[key] = textValue(patch[key], 80)
  }
  if (patch.resultUrl || patch.result_url) {
    const rawUrl = patch.resultUrl || patch.result_url
    try {
      record.resultUrl = assertResultUrlForSite(catalogSite, rawUrl)
    } catch (error) {
      record.resultUrl = null
      record.status = 'needs_manual'
      record.message = textValue(error.message, 4_000)
    }
  }
  if (record.status === 'result_ready') {
    try {
      if (!record.resultUrl) throw new Error(`${catalogSite.name} returned no result URL`)
      record.resultUrl = assertResultUrlForSite(catalogSite, record.resultUrl)
    } catch (error) {
      record.resultUrl = null
      record.status = 'needs_manual'
      record.message = textValue(error.message || error, 4_000)
    }
  }
  record.updatedAt = nowIso()
  return true
}

function maybeOpenAutomaticResult(entry, siteId) {
  const record = findSiteRecord(entry.session, siteId)
  if (
    !record ||
    record.execution !== 'auto_submit' ||
    !record.resultUrl ||
    record.resultOpenedAt ||
    entry.openingResultSites.has(siteId) ||
    entry.cancelled ||
    entry.disposed
  ) {
    return
  }
  const catalogSite = getCatalogSite(siteId)
  let resultUrl
  try {
    resultUrl = assertResultUrlForSite(catalogSite, record.resultUrl)
  } catch (error) {
    record.resultUrl = null
    record.status = 'needs_manual'
    record.message = textValue(error.message || error, 4_000)
    emitSessionUpdate(entry)
    maybeOpenAutomaticFallback(entry, siteId)
    return
  }
  entry.openingResultSites.add(siteId)
  entry.manualInFlight += 1
  shell
    .openExternal(resultUrl)
    .then(() => {
      if (!entry.cancelled && !entry.disposed) {
        record.resultOpenedAt = nowIso()
        record.updatedAt = record.resultOpenedAt
        emitSessionUpdate(entry)
      }
    })
    .catch((error) => {
      if (!entry.cancelled && !entry.disposed) {
        record.status = 'needs_manual'
        record.message = msg('result.autoOpenFailed', textValue(error.message || error, 3_900))
        emitSessionUpdate(entry)
      }
    })
    .finally(() => {
      entry.openingResultSites.delete(siteId)
      entry.manualInFlight -= 1
      maybeDisposeEntry(entry)
    })
}

function maybeOpenAutomaticFallback(entry, siteId) {
  const record = findSiteRecord(entry.session, siteId)
  if (
    !record ||
    record.execution !== 'auto_submit' ||
    record.status !== 'needs_manual' ||
    record.resultUrl ||
    record.fallbackOpenAttemptedAt ||
    entry.fallbackSiteOpenAttempts.has(siteId) ||
    entry.openingResultSites.has(siteId) ||
    entry.cancelled ||
    entry.disposed
  ) {
    return
  }
  const catalogSite = getCatalogSite(siteId)
  entry.fallbackSiteOpenAttempts.add(siteId)
  entry.openingResultSites.add(siteId)
  entry.manualInFlight += 1
  record.fallbackOpenAttemptedAt = nowIso()
  record.updatedAt = record.fallbackOpenAttemptedAt
  emitSessionUpdate(entry)
  shell
    .openExternal(catalogSite.entryUrl)
    .then(() => {
      if (!entry.cancelled && !entry.disposed) {
        record.openedAt = nowIso()
        record.updatedAt = record.openedAt
        emitSessionUpdate(entry)
      }
    })
    .catch((error) => {
      if (!entry.cancelled && !entry.disposed) {
        record.message = msg('result.manualOpenFailed', textValue(error.message || error, 3_850))
        emitSessionUpdate(entry)
      }
    })
    .finally(() => {
      entry.openingResultSites.delete(siteId)
      entry.manualInFlight -= 1
      maybeDisposeEntry(entry)
    })
}

const AUDIT_LEAF = Symbol('bioinformaticsHubAuditLeaf')

function looksLikeAbsolutePath(value) {
  const raw = String(value || '').trim()
  return path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)
}

function portableBasename(value) {
  const raw = String(value || '')
  return raw.includes('\\') ? path.win32.basename(raw) : path.posix.basename(raw)
}

function sanitizeAbsoluteAuditPath(rawPath, runDir) {
  const absolute = path.resolve(String(rawPath))
  if (isPathInside(runDir, absolute)) {
    return {
      [AUDIT_LEAF]: true,
      value: path.relative(runDir, absolute).replace(/\\/g, '/'),
      location: 'session',
    }
  }
  const engine = engineRoot()
  if (isPathInside(engine, absolute)) {
    const relative = path.relative(engine, absolute).replace(/\\/g, '/')
    return { [AUDIT_LEAF]: true, value: `engine/${relative}`, location: 'engine' }
  }
  return {
    [AUDIT_LEAF]: true,
    value: textValue(portableBasename(rawPath), 512),
    location: 'external',
  }
}

function sanitizeAuditValue(value, runDir, depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    if (looksLikeAbsolutePath(value)) return sanitizeAbsoluteAuditPath(value, runDir)
    return { [AUDIT_LEAF]: true, value: textValue(value, 4_000), location: null }
  }
  if (depth >= 8) return null
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((item) => {
      const sanitized = sanitizeAuditValue(item, runDir, depth + 1)
      return sanitized && typeof sanitized === 'object' && sanitized[AUDIT_LEAF]
        ? sanitized.value
        : sanitized
    })
  }
  if (typeof value !== 'object') return null
  const result = {}
  let hasExternalPath = false
  for (const [rawKey, item] of Object.entries(value).slice(0, 128)) {
    const key = textValue(rawKey, 128)
    if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) continue
    const sanitized = sanitizeAuditValue(item, runDir, depth + 1)
    if (sanitized && typeof sanitized === 'object' && sanitized[AUDIT_LEAF]) {
      result[key] = sanitized.value
      if (sanitized.location === 'external') hasExternalPath = true
    } else {
      result[key] = sanitized
    }
  }
  if (hasExternalPath) result.location = 'external'
  return result
}

function sanitizeProvenance(value, runDir) {
  const sanitized = sanitizeAuditValue(value, runDir)
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {}
}

function sanitizeSourceText(value, runDir) {
  const raw = textValue(value, 1_000)
  if (!looksLikeAbsolutePath(raw)) return { value: raw, location: null }
  return sanitizeAbsoluteAuditPath(raw, runDir)
}

function mergeToolPatch(entry, patch) {
  if (!patch || typeof patch !== 'object') return false
  const toolId = String(patch.toolId || patch.id || '').trim()
  if (!toolId) return false
  const record = findToolRecord(entry.session, toolId)
  if (!record) return false
  if (patch.status || patch.state) record.status = textValue(patch.status || patch.state, 64)
  if (patch.message != null) record.message = textValue(patch.message, 4_000)
  if (patch.provenance && typeof patch.provenance === 'object') {
    record.provenance = sanitizeProvenance(patch.provenance, entry.runDir)
  }
  if (patch.parameters && typeof patch.parameters === 'object') {
    record.parameters = patch.parameters
  }
  if (patch.version != null) record.version = textValue(patch.version, 128)
  if (patch.source != null) {
    const source = sanitizeSourceText(patch.source, entry.runDir)
    if (source.value) record.source = source.value
    if (source.location === 'external') {
      record.provenance = { ...(record.provenance || {}), location: 'external' }
    }
  }
  if (Array.isArray(patch.artifacts)) {
    record.artifacts = patch.artifacts
      .slice(0, 256)
      .map((artifact) => sanitizeArtifact(artifact, entry.runDir))
      .filter(Boolean)
  }
  for (const key of ['startedAt', 'completedAt']) {
    if (patch[key]) record[key] = textValue(patch[key], 80)
  }
  record.updatedAt = nowIso()
  return true
}

function mergeInputPatch(entry, patch) {
  if (!patch || typeof patch !== 'object') return false
  const input = entry.session.input || {}
  const primitiveKeys = [
    'id',
    'alias',
    'kind',
    'inputKind',
    'detectedKind',
    'sequenceType',
    'length',
    'lengthBp',
    'lengthAa',
    'cdsLengthBp',
    'proteinLengthAa',
    'hasCds',
    'hasProtein',
    'geneticCode',
    'translationFrame',
  ]
  for (const key of primitiveKeys) {
    if (['string', 'number', 'boolean'].includes(typeof patch[key])) input[key] = patch[key]
  }
  if (Array.isArray(patch.warnings)) {
    input.warnings = patch.warnings.slice(0, 100).map((item) => textValue(item, 1_000))
  }
  if (patch.translation && typeof patch.translation === 'object') {
    input.translation = patch.translation
  }
  for (const key of ['normalizedFastaPath', 'cdsFastaPath', 'proteinFastaPath']) {
    if (!patch[key]) continue
    const candidate = path.isAbsolute(String(patch[key]))
      ? path.resolve(String(patch[key]))
      : path.resolve(entry.runDir, String(patch[key]))
    if (isPathInside(entry.runDir, candidate)) {
      input[key] = path.relative(entry.runDir, candidate).replace(/\\/g, '/')
    }
  }
  // The alignment location is fixed by Electron at session:start. A runner
  // event may echo that path, but must never replace it with another path.
  if (input.alignmentFastaPath && patch.alignmentFastaPath) {
    const expected = path.resolve(entry.runDir, String(input.alignmentFastaPath))
    const candidate = path.isAbsolute(String(patch.alignmentFastaPath))
      ? path.resolve(String(patch.alignmentFastaPath))
      : path.resolve(entry.runDir, String(patch.alignmentFastaPath))
    if (isPathInside(entry.runDir, expected) && candidate === expected) {
      input.alignmentFastaPath = path.relative(entry.runDir, expected).replace(/\\/g, '/')
    }
  }
  entry.session.input = input
  return true
}

function mergeSessionPatch(entry, patch) {
  if (!patch || typeof patch !== 'object') return false
  let changed = false
  if (patch.status) {
    entry.session.status = textValue(patch.status, 64)
    changed = true
  }
  if (patch.message != null) {
    entry.session.message = textValue(patch.message, 4_000)
    changed = true
  }
  if (patch.input) changed = mergeInputPatch(entry, patch.input) || changed
  if (Array.isArray(patch.sites)) {
    for (const sitePatch of patch.sites) changed = mergeSitePatch(entry, sitePatch) || changed
  }
  if (Array.isArray(patch.localTools)) {
    for (const toolPatch of patch.localTools) changed = mergeToolPatch(entry, toolPatch) || changed
  }
  return changed
}

function emitSessionUpdate(entry) {
  persistSession(entry.runDir, entry.session)
  send('session:update', publicSession(entry.session, entry.runDir))
}

function emitLog(entry, message, level = 'info') {
  send('session:log', {
    sessionId: entry?.sessionId,
    message: textValue(message, 16_000),
    level: textValue(level, 32),
  })
}

function emitOutcomeOnce(entry, channel, payload) {
  if (!entry || entry.outcomeEmitted) return false
  entry.outcomeEmitted = true
  send(channel, payload)
  return true
}

function eventType(event) {
  return String(event?.type || event?.event || event?.kind || '').toLowerCase()
}

function handleRunnerEvent(entry, event) {
  if (!event || typeof event !== 'object' || entry.disposed) return
  const type = eventType(event)
  const data = event.data && typeof event.data === 'object' ? event.data : event

  if (type === 'log' || type.endsWith(':log')) {
    emitLog(entry, event.message ?? data.message ?? '', event.level || data.level || 'info')
    return
  }

  let changed = false
  if (event.session && typeof event.session === 'object') {
    changed = mergeSessionPatch(entry, event.session) || changed
  }
  if (type.includes('site') || event.site || data.siteId) {
    const sitePatch = event.site || data.site || data
    changed = mergeSitePatch(entry, sitePatch) || changed
    const siteId = String(sitePatch?.siteId || sitePatch?.id || '').trim()
    if (siteId) {
      maybeOpenAutomaticResult(entry, siteId)
      maybeOpenAutomaticFallback(entry, siteId)
    }
  }
  if (type.includes('local') || type.includes('tool') || event.localTool || data.toolId) {
    changed = mergeToolPatch(entry, event.localTool || data.localTool || data.tool || data) || changed
  }
  if (type.includes('input') || event.input) {
    changed = mergeInputPatch(entry, event.input || data.input || data) || changed
  }
  if (type === 'input_ready') scheduleManualSitesOnce(entry)
  if ((type === 'update' || type === 'session:update' || type === 'status') && event.status) {
    entry.session.status = textValue(event.status, 64)
    if (event.message != null) entry.session.message = textValue(event.message, 4_000)
    changed = true
  }

  if (type === 'error' || type === 'session:error') {
    entry.runnerDone = true
    entry.runnerOverall = 'partial'
    entry.session.runner = { status: 'failed', overall: 'partial' }
    clearManualTimers(entry)
    entry.session.status = 'failed'
    entry.session.message = textValue(event.message || data.message || msg('session.runFailed'), 4_000)
    changed = true
  } else if (type === 'cancelled' || type === 'session:cancelled') {
    entry.cancelled = true
    entry.runnerDone = true
    entry.runnerOverall = 'partial'
    entry.session.runner = { status: 'cancelled', overall: 'partial' }
    clearManualTimers(entry)
    entry.session.status = 'cancelled'
    changed = true
  } else if (type === 'done' || type === 'session:done') {
    const terminalStatus = event.status || event.overall || data.status || data.overall
    entry.runnerDone = true
    entry.runnerOverall = String(terminalStatus || 'ok').toLowerCase()
    entry.session.runner = { status: 'done', overall: entry.runnerOverall }
    // Electron still owns pending manual tab opens, so the top-level session
    // remains running until the child and every open operation have settled.
    if (!['failed', 'cancelled'].includes(entry.session.status)) entry.session.status = 'running'
    changed = true
  }

  if (changed) emitSessionUpdate(entry)

  if (type === 'error' || type === 'session:error') {
    emitOutcomeOnce(entry, 'session:error', {
      sessionId: entry.sessionId,
      message: entry.session.message,
    })
  } else if (type === 'cancelled' || type === 'session:cancelled') {
    emitOutcomeOnce(entry, 'session:cancelled', { sessionId: entry.sessionId })
  }
  maybeDisposeEntry(entry)
}

function handleStdoutChunk(entry, chunk) {
  entry.stdoutBuffer += entry.stdoutDecoder.write(chunk)
  if (entry.stdoutBuffer.length > MAX_EVENT_LINE) {
    emitLog(entry, msg('log.eventTooLarge'), 'error')
    entry.stdoutBuffer = ''
    return
  }
  const lines = entry.stdoutBuffer.split(/\r?\n/)
  entry.stdoutBuffer = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      handleRunnerEvent(entry, JSON.parse(line))
    } catch {
      emitLog(entry, line)
    }
  }
}

function handleStderrChunk(entry, chunk) {
  entry.stderrBuffer += entry.stderrDecoder.write(chunk)
  if (entry.stderrBuffer.length > MAX_STDERR_BUFFER) {
    emitLog(entry, entry.stderrBuffer.slice(0, MAX_STDERR_BUFFER), 'error')
    entry.stderrBuffer = ''
    return
  }
  const lines = entry.stderrBuffer.split(/\r?\n/)
  entry.stderrBuffer = lines.pop() || ''
  for (const line of lines) if (line.trim()) emitLog(entry, line, 'error')
}

function clearManualTimers(entry) {
  for (const timer of entry.manualTimers) clearTimeout(timer)
  entry.manualTimers.clear()
}

function maybeFinalizeSession(entry) {
  if (
    !canFinalizeSession({
      childClosed: entry.childClosed,
      runnerDone: entry.runnerDone,
      pendingManualCount: entry.manualTimers.size,
      manualInFlight: entry.manualInFlight,
      cancelled: entry.cancelled,
      outcomeEmitted: entry.outcomeEmitted,
    })
  ) {
    return false
  }
  entry.session.status = deriveSessionFinalStatus(
    entry.runnerOverall,
    entry.session.sites,
    entry.session.localTools,
    { isValidSiteResult: isValidSiteResultRecord },
  )
  entry.session.completedAt = nowIso()
  emitSessionUpdate(entry)
  emitOutcomeOnce(entry, 'session:done', {
    sessionId: entry.sessionId,
    sessionDir: entry.runDir,
    status: entry.session.status,
  })
  return true
}

function maybeDisposeEntry(entry) {
  if (entry.disposed) return
  if (!entry.childClosed || entry.manualTimers.size > 0 || entry.manualInFlight > 0) return
  if (!entry.cancelled && !entry.outcomeEmitted && !maybeFinalizeSession(entry)) return
  if (!entry.outcomeEmitted) return
  entry.disposed = true
  cleanupTemp(entry)
  if (activeSessions.get(entry.sessionId) === entry) activeSessions.delete(entry.sessionId)
}

async function openScheduledSite(entry, siteId) {
  if (entry.cancelled || entry.disposed) return
  const catalogSite = resolveSessionSite(entry.session, siteId)
  const record = findSiteRecord(entry.session, siteId)
  // A user may have opened/completed the card before its batch timer fired.
  if (!record || record.status !== 'queued' || record.resultUrl) return
  entry.manualInFlight += 1
  record.status = 'opening'
  record.updatedAt = nowIso()
  emitSessionUpdate(entry)
  try {
    await shell.openExternal(catalogSite.entryUrl)
    if (!entry.cancelled) {
      record.status = 'opened_manual'
      record.openedAt = nowIso()
      record.message = ''
      emitSessionUpdate(entry)
    }
  } catch (error) {
    if (!entry.cancelled) {
      record.status = 'failed'
      record.message = textValue(error.message || error, 4_000)
      emitSessionUpdate(entry)
    }
  } finally {
    entry.manualInFlight -= 1
    maybeDisposeEntry(entry)
  }
}

function scheduleManualSites(entry, siteIds) {
  let offset = 0
  for (let start = 0; start < siteIds.length; start += MANUAL_BATCH_SIZE) {
    const batch = siteIds.slice(start, start + MANUAL_BATCH_SIZE)
    batch.forEach((siteId, index) => {
      let timer
      timer = setTimeout(() => {
        entry.manualTimers.delete(timer)
        if (!entry.cancelled && !entry.disposed) {
          openScheduledSite(entry, siteId)
            .catch((error) => emitLog(entry, error.message || error, 'error'))
            .finally(() => maybeDisposeEntry(entry))
        } else {
          maybeDisposeEntry(entry)
        }
      }, offset + index * MANUAL_TAB_DELAY_MS)
      entry.manualTimers.add(timer)
    })
    offset += Math.max(0, batch.length - 1) * MANUAL_TAB_DELAY_MS
    if (start + MANUAL_BATCH_SIZE < siteIds.length) offset += MANUAL_BATCH_DELAY_MS
  }
}

function scheduleManualSitesOnce(entry) {
  if (entry.manualSitesScheduled || entry.cancelled || entry.disposed) return
  entry.manualSitesScheduled = true
  scheduleManualSites(entry, entry.manualSiteIds)
}

function finishChild(entry, code) {
  if (entry.disposed) return
  entry.stdoutBuffer += entry.stdoutDecoder.end()
  entry.stderrBuffer += entry.stderrDecoder.end()
  if (entry.stdoutBuffer.trim()) {
    try {
      handleRunnerEvent(entry, JSON.parse(entry.stdoutBuffer))
    } catch {
      emitLog(entry, entry.stdoutBuffer)
    }
  }
  if (entry.stderrBuffer.trim()) emitLog(entry, entry.stderrBuffer, 'error')
  entry.stdoutBuffer = ''
  entry.stderrBuffer = ''
  entry.childClosed = true
  cleanupTemp(entry)

  if (!entry.cancelled) {
    if (code === 0) {
      if (!entry.runnerDone) {
        entry.runnerDone = true
        entry.runnerOverall = 'partial'
        entry.session.runner = { status: 'done_without_event', overall: 'partial', exitCode: 0 }
        entry.session.message = msg('log.runnerExitedNoDone')
        emitLog(entry, entry.session.message, 'error')
        emitSessionUpdate(entry)
      }
    } else if (!entry.outcomeEmitted) {
      entry.runnerDone = true
      entry.runnerOverall = 'partial'
      entry.session.runner = { status: 'failed', overall: 'partial', exitCode: code }
      clearManualTimers(entry)
      entry.session.status = 'failed'
      entry.session.message = msg('log.runnerExit', code)
      for (const site of entry.session.sites) {
        if (['queued', 'opening', 'submitting'].includes(site.status)) site.status = 'failed'
      }
      for (const tool of entry.session.localTools) {
        if (['queued', 'running'].includes(tool.status)) tool.status = 'failed'
      }
      emitSessionUpdate(entry)
      emitOutcomeOnce(entry, 'session:error', {
        sessionId: entry.sessionId,
        message: entry.session.message,
      })
    }
  }
  maybeDisposeEntry(entry)
}

function spawnSessionRunner(pyArgs) {
  const extra = {}
  const mafft = resolveMafft()
  const iqtree = resolveIqtree()
  if (mafft) extra.BIOINFORMATICS_HUB_MAFFT = mafft
  if (iqtree) extra.BIOINFORMATICS_HUB_IQTREE = iqtree
  return spawn(resolvePython(), pyArgs, {
    cwd: engineRoot(),
    env: engineEnv(extra),
    windowsHide: true,
  })
}

function validateAlignmentPath(rawPath) {
  if (!rawPath) return null
  const absolute = path.resolve(String(rawPath))
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  if (!selectedAlignmentPaths.has(key)) {
    throw new Error(msg('alignment.importRequired'))
  }
  // Picker grants are single-use: a stale path from another session cannot be
  // silently reused later.
  selectedAlignmentPaths.delete(key)
  assertAlignmentFileExtension(absolute)
  const stat = fs.statSync(absolute)
  if (!stat.isFile()) throw new Error(msg('alignment.notFile'))
  if (stat.size > MAX_ALIGNMENT_BYTES) throw new Error(msg('alignment.tooLarge'))
  return { path: absolute }
}

function markdownCell(value) {
  return textValue(value, 8_000).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|') || '—'
}

function markdownJson(value) {
  if (!value || typeof value !== 'object' || !Object.keys(value).length) return '—'
  return `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}

function markdownWebLink(value) {
  if (!value) return '—'
  try {
    const safeUrl = assertHttpUrl(value, 'Research bundle URL')
      .replace(/\|/g, '%7C')
      .replace(/>/g, '%3E')
    return `<${safeUrl}>`
  } catch {
    return '—'
  }
}

function buildResearchBundle(session) {
  const input = session.input || {}
  const en = uiLocale === 'en'
  const title = en ? 'Research bundle' : '研究工作包'
  const lines = [
    `# BioinformaticsHUB ${title}：${markdownCell(input.geneId || session.sessionId)}`,
    '',
    en
      ? '> This file records input, session state, local tool provenance and website result links; it contains no scientific conclusions.'
      : '> 本文件只记录输入、会话状态、本地工具来源与网站结果链接；不包含科学结论。',
    '',
    en ? '## Session & input' : '## 会话与输入',
    '',
    en ? '| Field | Value |' : '| 字段 | 值 |',
    '|---|---|',
    `${en ? '| Session ID' : '| 会话 ID'} | ${markdownCell(session.sessionId)} |`,
    `${en ? '| Gene ID' : '| 基因 ID'} | ${markdownCell(input.geneId)} |`,
    `${en ? '| Alias' : '| 别名'} | ${markdownCell(input.alias)} |`,
    `${en ? '| Input type' : '| 输入类型'} | ${markdownCell(input.detectedKind || input.inputKind)} |`,
    `${en ? '| FASTA bytes' : '| FASTA 字节数'} | ${markdownCell(input.fastaBytes)} |`,
    `${en ? '| Normalized FASTA path' : '| 规范化 FASTA 路径'} | ${markdownCell(input.normalizedFastaPath)} |`,
    `${en ? '| Alignment path' : '| 多序列比对路径'} | ${markdownCell(input.alignmentFastaPath)} |`,
    `${en ? '| Created at' : '| 创建时间'} | ${markdownCell(session.createdAt)} |`,
    `${en ? '| Updated at' : '| 更新时间'} | ${markdownCell(session.updatedAt)} |`,
  ]
  if (Array.isArray(input.warnings) && input.warnings.length) {
    lines.push('', en ? 'Input warnings:' : '输入警告：', '', ...input.warnings.map((warning) => `- ${markdownCell(warning)}`))
  }

  lines.push('', en ? '## Local tools & artifacts' : '## 本地工具与产物', '')
  if (!session.localTools.length) lines.push(en ? 'No local tools selected.' : '未选择本地工具。')
  for (const tool of session.localTools) {
    lines.push(
      `### ${markdownCell(tool.toolId || tool.id)}`,
      '',
      `${en ? '- Status' : '- 状态'}：${markdownCell(tool.status)}`,
      `${en ? '- Implementation' : '- 实现来源'}：${markdownCell(tool.source)}`,
      `${en ? '- Version' : '- 版本'}：${markdownCell(tool.version)}`,
      `- Provenance：${markdownJson(tool.provenance)}`,
      `${en ? '- Parameters' : '- 参数'}：${markdownJson(tool.parameters)}`,
    )
    const artifacts = Array.isArray(tool.artifacts) ? tool.artifacts : []
    if (artifacts.length) {
      lines.push('', en ? 'Artifacts:' : '产物：', '')
      for (const artifact of artifacts) {
        lines.push(`- ${markdownCell(artifact.name || artifact.path)} — \`${markdownCell(artifact.path)}\``)
      }
    }
    lines.push('')
  }

  lines.push(
    en ? '## Website tasks & result links' : '## 网站任务与结果链接',
    '',
    en
      ? '| Site | Mode | Status | Official entry | Result link | Note |'
      : '| 网站 | 模式 | 状态 | 官方入口 | 结果链接 | 用户备注 |',
    '|---|---|---|---|---|---|',
  )
  for (const site of session.sites) {
    const entryUrl = markdownWebLink(site.entryUrl)
    const result = site.resultUrl
      ? markdownWebLink(site.resultUrl)
      : String(site.status || '').toLowerCase() === 'completed_manual'
        ? (en ? 'No reopenable link' : '无可复开链接')
        : ''
    lines.push(
      `| ${markdownCell(site.name || site.siteId)} | ${markdownCell(site.execution)} | ${markdownCell(site.status)} | ${entryUrl} | ${result} | ${markdownCell(site.notes)} |`,
    )
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

function writeResearchBundle(runDir, session) {
  const handoffDir = path.resolve(runDir, '10_research_handoff')
  if (!isPathInside(runDir, handoffDir)) {
    throw new Error(uiLocale === 'en' ? 'Research bundle path escapes its directory' : '研究工作包路径越界')
  }
  fs.mkdirSync(handoffDir, { recursive: true })
  // The fixed directory filename is part of the documented session layout and
  // stays language-neutral; only the exported copy gets a localized name.
  const target = path.join(handoffDir, '研究工作包.md')
  const tmp = path.join(handoffDir, `.研究工作包.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmp, buildResearchBundle(session), 'utf8')
    fs.renameSync(tmp, target)
  } finally {
    unlinkQuiet(tmp)
  }
  return target
}

ipcMain.handle('session:start', async (_event, args) => {
  const fastaText = String(args?.fastaText ?? args?.sequenceText ?? args?.cdsText ?? '').trim()
  if (!fastaText) throw new Error(msg('session.missingFasta'))
  assertFastaByteLimit(fastaText)

  const geneId = safeRunId(args?.geneId || args?.id || 'gene')
  const sessionId = allocateSessionId(geneId)
  if (activeSessions.has(sessionId)) throw new Error(msg('session.alreadyRunning', sessionId))
  const alias = textValue(args?.alias, 256)
  const inputKind = ['auto', 'cds', 'protein'].includes(String(args?.inputKind))
    ? String(args.inputKind)
    : 'auto'
  const requestedSiteIds = normalizeIdList(args?.siteIds ?? args?.sites, 'Website list')
  const localToolIds = normalizeIdList(
    args?.localToolIds ?? args?.localTools,
    'Local tool list',
  )
  for (const toolId of localToolIds) {
    if (!LOCAL_TOOL_IDS.has(toolId)) throw new Error(msg('session.unknownTool', toolId))
  }
  const customSites = parseCustomSites(args?.customSites)
  const customSiteMap = new Map(customSites.map((site) => [site.id, site]))

  // Split requested site ids into built-in catalog sites and custom sites.
  const builtinIds = []
  const customSiteIds = []
  for (const siteId of requestedSiteIds) {
    if (customSiteMap.has(siteId)) customSiteIds.push(siteId)
    else builtinIds.push(siteId)
  }
  const catalogSites = builtinIds.map((siteId) => getCatalogSite(siteId))

  // Engine availability decides whether auto-submit runs and whether the Python
  // session engine can be spawned at all (external tools are no longer bundled).
  // probeEngine() already resolved the interpreter, so reuse it instead of
  // re-scanning PATH/spawning a second probe.
  const engine = probeEngine()
  const python = engine.pythonPath || null
  const canRunEngine = Boolean(python && engine.coreReady)
  const canAutoSubmit = engine.autoSubmitReady
  const downgradedAutoIds = canAutoSubmit
    ? []
    : catalogSites.filter((site) => site.execution === 'auto_submit').map((site) => site.siteId)
  const downgradedAutoSet = new Set(downgradedAutoIds)
  const autoSiteIds = catalogSites
    .filter((site) => site.execution === 'auto_submit' && !downgradedAutoSet.has(site.siteId))
    .map((site) => site.siteId)
  const manualSiteIds = [
    ...catalogSites.filter((site) => site.execution === 'open_only').map((site) => site.siteId),
    ...downgradedAutoIds,
    ...customSiteIds,
  ]
  const alignmentSelection = validateAlignmentPath(args?.alignmentPath)

  fs.mkdirSync(defaultRunsRoot(), { recursive: true })
  const { runDir } = resolveRunDir(sessionId)
  fs.mkdirSync(runDir, { recursive: false })
  let tempDir = null
  let tempFasta = null
  let alignmentCopy = null
  try {
    if (alignmentSelection) {
      alignmentCopy = copyAlignmentIntoRun(alignmentSelection.path, runDir)
    }
    const tempFiles = writeTempFasta(sessionId, fastaText)
    tempDir = tempFiles.tempDir
    tempFasta = tempFiles.tempFasta
  } catch (error) {
    cleanupTemp({ tempDir, tempFasta })
    removeEmptyRunDir(runDir)
    throw error
  }
  const createdAt = nowIso()
  const downgradeWarning = uiLocale === 'en'
    ? 'Auto-submit unavailable (Playwright/Chromium not found); opened manually'
    : '自动提交不可用（未检测到 Playwright/Chromium），已改为手动打开'
  const session = {
    schemaVersion: SESSION_VERSION,
    version: '0.5.2',
    id: sessionId,
    sessionId,
    status: 'running',
    runner: { status: canRunEngine ? 'running' : 'unavailable', overall: null },
    createdAt,
    updatedAt: createdAt,
    input: {
      geneId,
      alias,
      inputKind,
      fastaBytes: Buffer.byteLength(fastaText, 'utf8'),
      alignmentFastaPath: alignmentCopy?.relativePath || null,
    },
    sites: [
      ...catalogSites.map((site) => {
        const downgraded = downgradedAutoSet.has(site.siteId)
        return {
          id: site.siteId,
          siteId: site.siteId,
          name: site.name,
          execution: downgraded ? 'open_only' : site.execution,
          entryUrl: site.entryUrl,
          status: 'queued',
          resultUrl: null,
          notes: '',
          warning: downgraded ? downgradeWarning : site.warning || '',
          updatedAt: createdAt,
        }
      }),
      ...customSiteIds.map((siteId) => {
        const custom = customSiteMap.get(siteId)
        return {
          id: siteId,
          siteId,
          name: custom.name,
          execution: 'open_only',
          custom: true,
          entryUrl: custom.entryUrl,
          status: 'queued',
          resultUrl: null,
          description: custom.note || '',
          notes: '',
          updatedAt: createdAt,
        }
      }),
    ],
    localTools: localToolIds.map((toolId) => ({
      id: toolId,
      toolId,
      status: canRunEngine ? 'queued' : 'needs_setup',
      message: canRunEngine ? '' : msg('tool.needsSetup'),
      provenance: {},
      parameters: {},
      artifacts: [],
      updatedAt: createdAt,
    })),
  }
  try {
    persistSession(runDir, session, { touch: false })
  } catch (error) {
    cleanupTemp({ tempDir, tempFasta })
    removeEmptyRunDir(runDir)
    throw error
  }

  // Fully degraded: no spawnable Python engine. Open every requested site as a
  // manual tab in batches, mark local tools needs_setup, and finish as partial.
  if (!canRunEngine) {
    const entry = {
      sessionId,
      runDir,
      child: null,
      tempDir,
      tempFasta,
      cancelled: false,
      disposed: false,
      childClosed: true,
      runnerDone: true,
      runnerOverall: 'partial',
      outcomeEmitted: false,
      stdoutBuffer: '',
      stderrBuffer: '',
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      manualTimers: new Set(),
      manualSiteIds,
      manualSitesScheduled: false,
      manualInFlight: 0,
      openingResultSites: new Set(),
      fallbackSiteOpenAttempts: new Set(),
      session,
    }
    activeSessions.set(sessionId, entry)
    send('session:update', publicSession(session, runDir, { includeInputText: true }))
    if (manualSiteIds.length) {
      scheduleManualSites(entry, manualSiteIds)
    } else {
      // No runner and no manual tabs: finalize immediately so the session does
      // not stay stuck in "running" (which also leaks temp files and the entry).
      maybeFinalizeSession(entry)
    }
    return { sessionId, sessionDir: runDir, runId: sessionId, runDir }
  }

  const runner = sessionRunnerScript()
  if (!fs.existsSync(runner)) {
    cleanupTemp({ tempDir, tempFasta })
    removeEmptyRunDir(runDir)
    throw new Error(msg('session.missingRunner', runner))
  }

  const pyArgs = [
    runner,
    '--fasta',
    tempFasta,
    '--id',
    sessionId,
    '--run-dir',
    runDir,
    '--alias',
    alias,
    '--input-kind',
    inputKind,
    '--local-tools',
    localToolIds.join(','),
    '--auto-sites',
    autoSiteIds.join(','),
  ]
  if (alignmentCopy) pyArgs.push('--alignment', alignmentCopy.path)

  let child
  try {
    child = spawnSessionRunner(pyArgs)
  } catch (error) {
    cleanupTemp({ tempDir, tempFasta })
    session.status = 'failed'
    session.message = textValue(error.message || error, 4_000)
    persistSession(runDir, session)
    throw error
  }

  const entry = {
    sessionId,
    runDir,
    child,
    tempDir,
    tempFasta,
    cancelled: false,
    disposed: false,
    childClosed: false,
    runnerDone: false,
    runnerOverall: null,
    outcomeEmitted: false,
    stdoutBuffer: '',
    stderrBuffer: '',
    stdoutDecoder: new StringDecoder('utf8'),
    stderrDecoder: new StringDecoder('utf8'),
    manualTimers: new Set(),
    manualSiteIds,
    manualSitesScheduled: false,
    manualInFlight: 0,
    openingResultSites: new Set(),
    fallbackSiteOpenAttempts: new Set(),
    session,
  }
  activeSessions.set(sessionId, entry)
  child.stdout.on('data', (chunk) => handleStdoutChunk(entry, chunk))
  child.stderr.on('data', (chunk) => handleStderrChunk(entry, chunk))
  child.once('close', (code) => finishChild(entry, code))
  child.once('error', (error) => {
    if (entry.disposed || entry.cancelled) return
    entry.runnerDone = true
    entry.runnerOverall = 'partial'
    entry.session.runner = { status: 'failed', overall: 'partial' }
    clearManualTimers(entry)
    entry.session.status = 'failed'
    entry.session.message = textValue(error.message || error, 4_000)
    for (const site of entry.session.sites) {
      if (['queued', 'opening', 'submitting'].includes(site.status)) site.status = 'failed'
    }
    for (const tool of entry.session.localTools) {
      if (['queued', 'running'].includes(tool.status)) tool.status = 'failed'
    }
    emitSessionUpdate(entry)
    emitOutcomeOnce(entry, 'session:error', {
      sessionId,
      message: entry.session.message,
    })
  })

  send('session:update', publicSession(session, runDir, { includeInputText: true }))
  return { sessionId, sessionDir: runDir, runId: sessionId, runDir }
})

ipcMain.handle('session:cancel', async (_event, sessionIdRaw) => {
  const sessionId = safeRunId(sessionIdRaw)
  const entry = activeSessions.get(sessionId)
  if (!entry) return { ok: false, reason: 'not_running' }
  entry.cancelled = true
  clearManualTimers(entry)
  for (const site of entry.session.sites) {
    if (['queued', 'opening', 'submitting'].includes(site.status)) {
      site.status = 'cancelled'
      site.updatedAt = nowIso()
    }
  }
  for (const tool of entry.session.localTools) {
    if (['queued', 'running'].includes(tool.status)) {
      tool.status = 'cancelled'
      tool.updatedAt = nowIso()
    }
  }
  entry.session.status = 'cancelled'
  entry.session.runner = {
    ...(entry.session.runner || {}),
    status: 'cancelled',
    overall: 'partial',
  }
  emitSessionUpdate(entry)
  try {
    await killProcessTree(entry.child)
  } catch {
    /* session state still becomes cancelled */
  }
  entry.childClosed = true
  cleanupTemp(entry)
  emitOutcomeOnce(entry, 'session:cancelled', { sessionId })
  entry.disposed = true
  activeSessions.delete(sessionId)
  return { ok: true }
})

ipcMain.handle('session:load', async (_event, sessionId) => loadSessionPayload(sessionId))

ipcMain.handle('session:list', async () => {
  const root = defaultRunsRoot()
  if (!fs.existsSync(root)) return []
  const items = []
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.')) continue
    if (safeRunId(name) !== name) continue
    const runDir = path.join(root, name)
    let stat
    try {
      stat = fs.statSync(runDir)
      if (!stat.isDirectory()) continue
    } catch {
      continue
    }
    const filePath = sessionPath(runDir)
    if (!fs.existsSync(filePath)) {
      const legacy = legacySessionPayload(name, runDir).session
      items.push({ ...publicSession(legacy, runDir), geneId: name, alias: '' })
      continue
    }
    try {
      const session = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      const input = session.input && typeof session.input === 'object' ? session.input : {}
      const publicInput = publicSession(session, runDir).input
      items.push({
        id: name,
        sessionId: name,
        geneId: textValue(input.geneId || input.id || name, 256),
        alias: textValue(input.alias, 256),
        status: textValue(session.status || 'unknown', 64),
        createdAt: session.createdAt || stat.birthtime.toISOString(),
        updatedAt: session.updatedAt || stat.mtime.toISOString(),
        input: publicInput,
        version: String(session.version || '0.5.2'),
        legacy: false,
        sessionDir: runDir,
        runDir,
      })
    } catch (error) {
      items.push({
        id: name,
        sessionId: name,
        geneId: name,
        alias: '',
        status: 'invalid',
        message: `${uiLocale === 'en' ? 'session.json could not be parsed' : 'session.json 无法解析'}: ${textValue(error.message || error, 500)}`,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
        input: null,
        legacy: false,
        sessionDir: runDir,
        runDir,
      })
    }
  }
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return items
})

ipcMain.handle('artifact:reveal', async (_event, payload) => {
  const sessionId = payload?.sessionId || payload?.runId
  const loaded = readSession(sessionId)
  if (loaded.legacy) throw new Error(msg('legacy.noArtifacts'))
  const target = resolveDeclaredArtifact(
    loaded.runDir,
    declaredArtifactPaths(loaded.session),
    payload?.path,
  )
  const stat = fs.statSync(target)
  if (!stat.isFile()) throw new Error(msg('artifact.notFile'))
  shell.showItemInFolder(target)
  return { ok: true }
})

ipcMain.handle('site:open', async (_event, payload) => {
  const sessionId = payload?.sessionId || payload?.runId
  const loaded = readSession(sessionId)
  if (loaded.legacy) throw new Error(msg('legacy.noSites'))
  const activeEntry = activeSessions.get(loaded.sessionId)
  const session = activeEntry && !activeEntry.disposed ? activeEntry.session : loaded.session
  const site = resolveSessionSite(session, payload?.siteId)
  const record = findSiteRecord(session, site.siteId)
  if (!record) throw new Error(msg('session.missingSite', site.siteId))

  let target = record.resultUrl
    ? assertResultUrlForSite(site, record.resultUrl)
    : site.entryUrl
  if (payload?.url) {
    const supplied = assertHttpUrl(payload.url, 'Open URL')
    const allowed = new Set([site.entryUrl, record.resultUrl].filter(Boolean))
    if (!allowed.has(supplied)) throw new Error(msg('session.openUrlNotOwned'))
    target = supplied
  }
  await shell.openExternal(target)
  if (!record.resultUrl) {
    record.status = record.execution === 'auto_submit' ? 'needs_manual' : 'opened_manual'
    record.openedAt = nowIso()
    record.updatedAt = record.openedAt
    persistSession(loaded.runDir, session)
    send('session:update', publicSession(session, loaded.runDir))
    if (activeEntry) maybeDisposeEntry(activeEntry)
  }
  return { ok: true, resultUrl: record.resultUrl || undefined, status: record.status }
})

ipcMain.handle('site:saveResult', async (_event, payload) => {
  const sessionId = payload?.sessionId || payload?.runId
  const loaded = readSession(sessionId)
  if (loaded.legacy) throw new Error(msg('legacy.noSaveResult'))
  const activeEntry = activeSessions.get(loaded.sessionId)
  const sessionRecord = activeEntry && !activeEntry.disposed ? activeEntry.session : loaded.session
  const catalogSite = resolveSessionSite(sessionRecord, payload?.siteId)
  const record = findSiteRecord(sessionRecord, catalogSite.siteId)
  if (!record) throw new Error(msg('session.missingSite', catalogSite.siteId))
  const resultMode = String(payload?.resultMode || (payload?.resultUrl ? 'result_url' : '')).trim()
  if (!['result_url', 'no_persistent_url'].includes(resultMode)) {
    throw new Error(msg('session.resultModeRequired'))
  }
  if (resultMode === 'result_url') {
    record.resultUrl = assertPersistableResultUrlForSite(catalogSite, payload?.resultUrl)
  } else {
    if (payload?.resultUrl) throw new Error(msg('session.noLinkWithUrl'))
    record.resultUrl = null
  }
  record.notes = textValue(payload?.notes ?? payload?.note, 4_000)
  const completed = resultMode === 'no_persistent_url' || payload?.completed !== false
  record.status = completed ? 'completed_manual' : 'result_ready'
  record.completedAt = completed ? nowIso() : null
  record.updatedAt = nowIso()
  if (!activeEntry && sessionRecord.status !== 'cancelled') {
    const runnerOverall = sessionRecord.runner?.overall ||
      (sessionRecord.status === 'failed' ? 'partial' : 'ok')
    sessionRecord.status = deriveSessionFinalStatus(
      runnerOverall,
      sessionRecord.sites,
      sessionRecord.localTools,
      { isValidSiteResult: isValidSiteResultRecord },
    )
  }
  persistSession(loaded.runDir, sessionRecord)
  if (activeEntry) maybeDisposeEntry(activeEntry)
  const session = publicSession(sessionRecord, loaded.runDir)
  send('session:update', session)
  return { ok: true, session }
})

ipcMain.handle('fs:exportResearchBundle', async (_event, runIdOrDir) => {
  const { runId: sessionId, runDir } = resolveRunDirFromArg(runIdOrDir)
  const loaded = readSession(sessionId)
  if (loaded.legacy) throw new Error(msg('legacy.noBundle'))
  const primary = writeResearchBundle(runDir, loaded.session)
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: msg('dialog.exportTitle'),
    defaultPath: msg('dialog.exportDefault', sessionId),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  if (!filePath) return { path: primary }
  const destination = path.resolve(filePath)
  if (destination !== path.resolve(primary)) fs.copyFileSync(primary, destination)
  return { path: destination }
})

async function pickTextFile({ title, filters, maxBytes, rememberAlignment = false }) {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title,
    filters,
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return null
  const filePath = path.resolve(filePaths[0])
  if (rememberAlignment) assertAlignmentFileExtension(filePath)
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(msg('pick.notFile'))
  if (stat.size > maxBytes) {
    throw new Error(msg('pick.tooLarge', Math.floor(maxBytes / 1024 / 1024)))
  }
  const text = fs.readFileSync(filePath, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(msg('pick.contentTooLarge'))
  if (rememberAlignment) {
    const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath
    selectedAlignmentPaths.add(key)
    while (selectedAlignmentPaths.size > 128) {
      selectedAlignmentPaths.delete(selectedAlignmentPaths.values().next().value)
    }
  }
  return { path: filePath, name: path.basename(filePath), text }
}

ipcMain.handle('fs:pickFasta', async () =>
  pickTextFile({
    title: msg('dialog.pickFasta'),
    filters: [
      { name: 'FASTA', extensions: ['fa', 'fasta', 'fna', 'faa', 'txt'] },
      { name: 'All', extensions: ['*'] },
    ],
    maxBytes: MAX_FASTA_BYTES,
  }),
)

ipcMain.handle('fs:pickAlignment', async () =>
  pickTextFile({
    title: msg('dialog.pickAlignment'),
    filters: [
      {
        name: msg('dialog.pickAlignmentFilter'),
        extensions: ALIGNMENT_EXTENSIONS.map((extension) => extension.slice(1)),
      },
    ],
    maxBytes: MAX_ALIGNMENT_BYTES,
    rememberAlignment: true,
  }),
)

ipcMain.handle('app:setLocale', (_event, locale) => {
  if (locale === 'zh' || locale === 'en') uiLocale = locale
  return { ok: true, locale: uiLocale }
})

ipcMain.handle('engine:status', async () => probeEngine())

function stopAllSessions() {
  for (const entry of activeSessions.values()) {
    entry.cancelled = true
    clearManualTimers(entry)
    entry.session.status = 'cancelled'
    entry.session.runner = {
      ...(entry.session.runner || {}),
      status: 'cancelled',
      overall: 'partial',
    }
    for (const site of entry.session.sites) {
      if (['queued', 'opening', 'submitting'].includes(site.status)) site.status = 'cancelled'
    }
    for (const tool of entry.session.localTools) {
      if (['queued', 'running'].includes(tool.status)) tool.status = 'cancelled'
    }
    try {
      persistSession(entry.runDir, entry.session)
    } catch {
      /* quitting must continue even if storage became unavailable */
    }
    entry.disposed = true
    killProcessTree(entry.child).catch(() => {})
    cleanupTemp(entry)
  }
  activeSessions.clear()
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  protocol.handle('bioinformatics-hub-artifact', handleArtifactRequest)
  createWindow()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
  stopAllSessions()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', stopAllSessions)

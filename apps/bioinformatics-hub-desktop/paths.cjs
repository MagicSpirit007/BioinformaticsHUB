/**
 * Resolve engine / UI / site catalog / runs paths for dev vs packaged Electron.
 * Pure helpers (safeRunId, isPathInside, navigation, FASTA limits) work under plain Node for tests.
 */
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')
const { pathToFileURL, fileURLToPath } = require('url')

/** Documented maximum size for pasted/selected FASTA (bytes). */
const MAX_FASTA_BYTES = 10 * 1024 * 1024

/** Maximum size for an alignment copied into a session (bytes). */
const MAX_ALIGNMENT_BYTES = 25 * 1024 * 1024

/** Fixed, session-relative location for an imported alignment. */
const SESSION_ALIGNMENT_PATH = '00_input/alignment.fasta'

/** Extensions accepted by the engine's FASTA parser for an imported MSA. */
const ALIGNMENT_EXTENSIONS = Object.freeze(['.fa', '.fasta', '.faa', '.fna', '.afa', '.aln', '.txt'])

/** Doctor process wall-clock timeout (ms). */
const DOCTOR_TIMEOUT_MS = 30_000

/** Cap doctor stdout/stderr retained in memory (bytes, UTF-16 code units approx via string length). */
const DOCTOR_MAX_CAPTURE = 1 * 1024 * 1024

/** Grace period after taskkill / SIGTERM before hard fallback (ms). */
const CANCEL_GRACE_MS = 5_000

/** Max wait for taskkill process itself (ms). */
const TASKKILL_TIMEOUT_MS = 8_000

/** Windows device / reserved base names (CON, PRN, AUX, NUL, COM1–9, LPT1–9). */
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Obtain Electron app when running inside Electron; null under plain Node tests.
 * @returns {import('electron').App | null}
 */
function getApp() {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const electron = require('electron')
    if (electron && typeof electron === 'object' && electron.app) {
      return electron.app
    }
  } catch {
    /* plain Node / tests */
  }
  return null
}

function repoRoot() {
  // apps/bioinformatics-hub-desktop → repository root
  return path.resolve(__dirname, '..', '..')
}

function isPackaged() {
  const a = getApp()
  return !!(a && a.isPackaged)
}

/**
 * Mini-repo root that contains scripts/ + tools/ + python/.
 * Packaged: resources/engine
 * Dev: packaging/engine if bootstrapped, else live repo root
 */
function engineRoot() {
  if (process.env.BIOINFORMATICS_HUB_ENGINE && fs.existsSync(process.env.BIOINFORMATICS_HUB_ENGINE)) {
    return path.resolve(process.env.BIOINFORMATICS_HUB_ENGINE)
  }
  if (isPackaged()) {
    const a = getApp()
    return path.join(a.resourcesPath || process.resourcesPath, 'engine')
  }
  const staged = path.join(repoRoot(), 'packaging', 'engine')
  if (fs.existsSync(path.join(staged, 'scripts', 'session_runner.py'))) {
    return staged
  }
  return repoRoot()
}

function resolvePython() {
  if (process.env.BIOINFORMATICS_HUB_PYTHON && fs.existsSync(process.env.BIOINFORMATICS_HUB_PYTHON)) {
    return process.env.BIOINFORMATICS_HUB_PYTHON
  }
  const eng = engineRoot()
  const bundled = path.join(eng, 'python', 'python.exe')
  if (fs.existsSync(bundled)) return bundled

  const candidates = process.platform === 'win32'
    ? [findOnPath('py'), findOnPath('python'), findOnPath('python3')]
    : [findOnPath('python3'), findOnPath('python')]
  for (const candidate of candidates) {
    if (!candidate) continue
    const probe = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    })
    if (!probe.error && probe.status === 0) return candidate
  }
  return null
}

/**
 * Find an executable on PATH (Windows PATHEXT-aware). Returns an absolute path
 * or null. `name` may already be an existing path or include an extension.
 */
function findOnPath(name) {
  if (!name) return null
  const raw = String(name).trim()
  if (!raw) return null
  if ((raw.includes('/') || raw.includes('\\')) && fs.existsSync(raw)) {
    return path.resolve(raw)
  }
  const isWin = process.platform === 'win32'
  // PATHEXT on Windows carries the preferred executable extensions; never split
  // PATH on ':' there, because drive letters (C:\...) contain colons.
  const extensions = isWin
    ? ['', ...new Set([...String(process.env.PATHEXT || '').split(';').filter(Boolean), '.EXE', '.CMD', '.BAT', '.COM'])]
    : ['']
  const pathVar = process.env.PATH || process.env.Path || ''
  const dirs = pathVar.split(isWin ? ';' : ':').filter(Boolean)
  const lower = raw.toLowerCase()
  for (const dir of dirs) {
    const base = path.resolve(dir, raw)
    const candidates = extensions.map((ext) => (lower.endsWith(ext) ? base : `${base}${ext}`))
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

/**
 * Locate MAFFT (env override → PATH → bundled full-engine tools directory).
 */
function resolveMafft() {
  if (process.env.BIOINFORMATICS_HUB_MAFFT && fs.existsSync(process.env.BIOINFORMATICS_HUB_MAFFT)) {
    return path.resolve(process.env.BIOINFORMATICS_HUB_MAFFT)
  }
  const onPath = findOnPath('mafft') || findOnPath('mafft.bat')
  if (onPath) return onPath
  return firstGlobFile(path.join(engineRoot(), 'tools'), 'mafft.bat')
}

/**
 * Locate IQ-TREE (env override → PATH → bundled full-engine tools directory).
 */
function resolveIqtree() {
  if (process.env.BIOINFORMATICS_HUB_IQTREE && fs.existsSync(process.env.BIOINFORMATICS_HUB_IQTREE)) {
    return path.resolve(process.env.BIOINFORMATICS_HUB_IQTREE)
  }
  const onPath = findOnPath('iqtree2') || findOnPath('iqtree')
  if (onPath) return onPath
  return (
    firstGlobFile(path.join(engineRoot(), 'tools'), 'iqtree2.exe') ||
    firstGlobFile(path.join(engineRoot(), 'tools'), 'iqtree2')
  )
}

/** First file matching `leaf` anywhere under `root`, sorted by path depth. */
function firstGlobFile(root, leaf) {
  let result = null
  let resultDepth = Infinity
  const visit = (dir, depth) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth + 1 < resultDepth) visit(full, depth + 1)
      } else if (entry.name.toLowerCase() === leaf.toLowerCase()) {
        if (depth < resultDepth) {
          result = full
          resultDepth = depth
        }
      }
    }
  }
  visit(root, 0)
  return result
}

function sessionRunnerScript() {
  return path.join(engineRoot(), 'scripts', 'session_runner.py')
}

function doctorScript() {
  const eng = engineRoot()
  const a = path.join(eng, 'doctor.py')
  if (fs.existsSync(a)) return a
  return path.join(repoRoot(), 'packaging', 'scripts', 'doctor.py')
}

function uiIndexHtml() {
  if (isPackaged()) {
    const a = getApp()
    return path.join(a.resourcesPath || process.resourcesPath, 'ui', 'index.html')
  }
  const dist = path.join(repoRoot(), 'apps', 'bioinformatics-hub', 'dist', 'index.html')
  if (fs.existsSync(dist)) return dist
  return null
}

/**
 * Authoritative website catalog.
 * Packaged builds copy public/site-catalog.json into resources/ui/.
 * Development reads the source file first so a stale dist cannot silently win.
 */
function resolveSiteCatalogPath({ packaged, resourcesPath, repo } = {}) {
  const root = path.resolve(repo || repoRoot())
  if (packaged) {
    return path.join(resourcesPath, 'ui', 'site-catalog.json')
  }
  const source = path.join(root, 'apps', 'bioinformatics-hub', 'public', 'site-catalog.json')
  if (fs.existsSync(source)) return source
  return path.join(root, 'apps', 'bioinformatics-hub', 'dist', 'site-catalog.json')
}

function siteCatalogPath() {
  const packaged = isPackaged()
  const a = getApp()
  const resourcesPath =
    packaged && a ? a.resourcesPath || process.resourcesPath : process.resourcesPath
  return resolveSiteCatalogPath({ packaged, resourcesPath, repo: repoRoot() })
}

function fallbackHtml() {
  return path.join(__dirname, 'fallback.html')
}

function resolveDefaultRunsRoot({ override, packaged, userData, repo } = {}) {
  if (override && String(override).trim()) {
    return path.resolve(String(override))
  }
  if (!packaged) {
    return path.join(repo, 'runs')
  }
  if (userData) {
    return path.join(userData, 'runs')
  }
  return path.join(repo, 'runs')
}

function defaultRunsRoot() {
  const packaged = isPackaged()
  const a = getApp()
  const userData = packaged && a && typeof a.getPath === 'function' ? a.getPath('userData') : null
  return resolveDefaultRunsRoot({
    override: process.env.BIOINFORMATICS_HUB_RUNS,
    packaged,
    userData,
    repo: repoRoot(),
  })
}

/**
 * Sanitize gene / run id for filesystem use.
 * Strips traversal-ish characters, leading dots, trailing dots/spaces,
 * and prefixes Windows reserved device names.
 */
function safeRunId(raw) {
  // Trim first so trailing spaces are not turned into "_" by the charset pass.
  let s = String(raw == null ? 'gene' : raw)
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 128)
  // Windows FS ignores trailing dots (and we already trimmed spaces)
  s = s.replace(/\.+$/g, '')
  if (!s) s = 'gene'
  if (WIN_RESERVED_RE.test(s)) {
    s = `_${s}`
  }
  // basename equality guards against oddities like ".." after sanitize
  if (s === '.' || s === '..') s = 'gene'
  return s
}

/**
 * Lexical containment: resolved target is under resolved root (or equal).
 * Case-insensitive on Windows.
 */
function isPathInsideLexical(root, target) {
  let rootAbs = path.resolve(root)
  let targetAbs = path.resolve(target)
  if (process.platform === 'win32') {
    rootAbs = rootAbs.replace(/\//g, '\\')
    targetAbs = targetAbs.replace(/\//g, '\\')
    const rl = rootAbs.toLowerCase()
    const tl = targetAbs.toLowerCase()
    if (tl === rl) return true
    const prefix = rl.endsWith(path.sep) ? rl : rl + path.sep
    return tl.startsWith(prefix)
  }
  if (targetAbs === rootAbs) return true
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep
  return targetAbs.startsWith(prefix)
}

function tryRealpath(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/**
 * True if path is under root (or equal).
 * - Existing targets: containment after realpath (junction/reparse safe).
 * - Non-existing targets: safe lexical containment only.
 */
function isPathInside(root, target) {
  const rootAbs = path.resolve(root)
  const targetAbs = path.resolve(target)

  const targetReal = tryRealpath(targetAbs)
  if (targetReal) {
    const rootReal = tryRealpath(rootAbs) || rootAbs
    return isPathInsideLexical(rootReal, targetReal)
  }
  // Target does not exist yet — lexical only (output path planning).
  return isPathInsideLexical(rootAbs, targetAbs)
}

/**
 * Resolve a renderer-requested artifact only when its canonical relative path
 * was declared by session.json. Existing symlinks/junctions are checked by
 * isPathInside after realpath resolution.
 */
function resolveDeclaredArtifact(runDir, declaredPaths, requestedRelativePath) {
  const root = path.resolve(runDir)
  const requestedRaw = String(requestedRelativePath || '').replace(/\\/g, '/')
  if (
    !requestedRaw ||
    requestedRaw.includes('\0') ||
    path.posix.isAbsolute(requestedRaw) ||
    path.win32.isAbsolute(requestedRaw)
  ) {
    throw new Error('产物路径无效')
  }
  if (requestedRaw.split('/').includes('..')) throw new Error('产物路径越界')
  const requestedNormalized = path.posix.normalize(requestedRaw)
  if (
    requestedNormalized === '..' ||
    requestedNormalized.startsWith('../') ||
    requestedNormalized === '.'
  ) {
    throw new Error('产物路径越界')
  }
  const declared = new Set(
    (Array.isArray(declaredPaths) ? declaredPaths : [])
      .map((value) => String(value || '').replace(/\\/g, '/'))
      .filter(
        (value) =>
          value &&
          !value.includes('\0') &&
          !path.posix.isAbsolute(value) &&
          !path.win32.isAbsolute(value) &&
          !value.split('/').includes('..'),
      )
      .map((value) => path.posix.normalize(value))
      .filter((value) => value && value !== '.' && value !== '..' && !value.startsWith('../')),
  )
  if (!declared.has(requestedNormalized)) throw new Error('产物未在会话中声明')
  const target = path.resolve(root, ...requestedNormalized.split('/'))
  if (!isPathInside(root, target)) throw new Error('产物路径越界')
  return target
}

/**
 * Copy a picker-approved alignment into the new session directory. The Python
 * runner receives only this copy, so session.json never needs to retain an
 * external absolute path.
 */
function copyAlignmentIntoRun(sourcePath, runDir, maxBytes = MAX_ALIGNMENT_BYTES) {
  const source = path.resolve(String(sourcePath || ''))
  const root = path.resolve(runDir)
  const sourceStat = fs.statSync(source)
  if (!sourceStat.isFile()) throw new Error('所选比对路径不是文件')
  if (sourceStat.size > maxBytes) throw new Error('比对文件超过 25 MiB 上限')

  const rootStat = fs.statSync(root)
  if (!rootStat.isDirectory()) throw new Error('会话目录无效')
  const inputDir = path.resolve(root, '00_input')
  if (!isPathInside(root, inputDir)) throw new Error('比对文件目标路径越界')
  fs.mkdirSync(inputDir, { recursive: true })
  // Re-check after mkdir so a pre-existing junction cannot redirect the copy.
  if (!isPathInside(root, inputDir)) throw new Error('比对文件目标路径越界')

  const target = path.resolve(root, ...SESSION_ALIGNMENT_PATH.split('/'))
  if (!isPathInside(root, target)) throw new Error('比对文件目标路径越界')
  if (fs.existsSync(target)) throw new Error('会话比对文件已存在')
  let copyCreated = false
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
    copyCreated = true
    const copiedStat = fs.statSync(target)
    if (!copiedStat.isFile() || copiedStat.size > maxBytes || !isPathInside(root, target)) {
      throw new Error('会话比对文件副本无效')
    }
  } catch (error) {
    if (copyCreated) {
      try {
        fs.unlinkSync(target)
      } catch {
        /* no partial copy to clean */
      }
    }
    throw error
  }
  return { path: target, relativePath: SESSION_ALIGNMENT_PATH }
}

function assertAlignmentFileExtension(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase()
  if (!ALIGNMENT_EXTENSIONS.includes(extension)) {
    throw new Error(
      `比对文件必须是多序列 FASTA（${ALIGNMENT_EXTENSIONS.join('/')}）`,
    )
  }
  return extension
}

/** True only after both the runner and every Electron-owned open have settled. */
function canFinalizeSession(state = {}) {
  return Boolean(
    state.childClosed &&
      state.runnerDone &&
      Number(state.pendingManualCount || 0) === 0 &&
      Number(state.manualInFlight || 0) === 0 &&
      !state.cancelled &&
      !state.outcomeEmitted,
  )
}

/** Derive the successful terminal state from runner and per-task evidence. */
function deriveSessionFinalStatus(runnerOverall, sites = [], localTools = [], options = {}) {
  if (String(runnerOverall || '').toLowerCase() === 'partial') return 'partial'
  const siteSuccess = new Set(['result_ready', 'completed_manual'])
  for (const site of Array.isArray(sites) ? sites : []) {
    const status = String(site?.status || site?.state || '').toLowerCase()
    if (!siteSuccess.has(status)) return 'partial'
    if (status === 'result_ready') {
      try {
        assertHttpUrl(site?.resultUrl, '网站结果 URL')
      } catch {
        return 'partial'
      }
      if (typeof options.isValidSiteResult === 'function' && !options.isValidSiteResult(site)) {
        return 'partial'
      }
    }
  }
  const localSuccess = new Set(['completed', 'skipped'])
  for (const tool of Array.isArray(localTools) ? localTools : []) {
    if (!localSuccess.has(String(tool?.status || tool?.state || '').toLowerCase())) {
      return 'partial'
    }
  }
  return 'completed'
}

/**
 * Resolve runDir under runs root from runId only.
 * @throws if id invalid or escapes root
 */
function resolveRunDir(runId, runsRootOpt) {
  const id = safeRunId(runId)
  const root = path.resolve(runsRootOpt != null ? runsRootOpt : defaultRunsRoot())
  const runDir = path.resolve(path.join(root, id))
  if (!isPathInside(root, runDir) || path.basename(runDir) !== id) {
    throw new Error(`非法 runId: ${runId}`)
  }
  return { runId: id, runDir, runsRoot: root }
}

/**
 * Accept runId, or a runDir that already lives under runs root.
 * Prefer runId from renderer.
 */
function resolveRunDirFromArg(arg, runsRootOpt) {
  if (arg == null || arg === '') {
    throw new Error('缺少 runId 或 runDir')
  }
  const s = String(arg)
  // If looks like a path with separators, treat as path under runs root
  if (s.includes('/') || s.includes('\\') || path.isAbsolute(s)) {
    const root = path.resolve(runsRootOpt != null ? runsRootOpt : defaultRunsRoot())
    const runDir = path.resolve(s)
    if (!isPathInside(root, runDir)) {
      throw new Error('路径不在 runs 目录内')
    }
    const id = path.basename(runDir)
    return { runId: safeRunId(id), runDir, runsRoot: root }
  }
  return resolveRunDir(s, runsRootOpt)
}

/**
 * Convert absolute filesystem path to file:// URL string.
 */
function toFileUrl(filePath) {
  return pathToFileURL(path.resolve(filePath)).href
}

/**
 * Normalize file URL / path for equality checks (Windows-aware).
 */
function normalizeFsPathFromUrlOrPath(urlOrPath) {
  if (!urlOrPath) return ''
  const s = String(urlOrPath)
  let p
  if (s.startsWith('file:')) {
    try {
      p = fileURLToPath(s)
    } catch {
      return ''
    }
  } else {
    p = s
  }
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Development origins allowed for will-navigate (configured BIOINFORMATICS_HUB_DEV_URL only).
 * @returns {Set<string>}
 */
function getDevOrigins() {
  const raw = process.env.BIOINFORMATICS_HUB_DEV_URL || 'http://127.0.0.1:5173'
  const set = new Set()
  try {
    set.add(new URL(raw).origin)
  } catch {
    set.add('http://127.0.0.1:5173')
  }
  return set
}

/**
 * Navigation allow-list: only the packaged/dev UI file URL(s) and the configured dev origin.
 * Never blanket-allows arbitrary file:// pages.
 *
 * @param {string} url
 * @param {{ allowedFilePaths?: string[], devOrigins?: Set<string> }} [opts]
 * @returns {boolean}
 */
function isAllowedNavigation(url, opts = {}) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }

  if (u.protocol === 'http:' || u.protocol === 'https:') {
    const origins = opts.devOrigins || getDevOrigins()
    return origins.has(u.origin)
  }

  if (u.protocol === 'file:') {
    const allowed = opts.allowedFilePaths || []
    const target = normalizeFsPathFromUrlOrPath(u.href)
    if (!target) return false
    for (const fp of allowed) {
      if (!fp) continue
      const a = normalizeFsPathFromUrlOrPath(fp)
      if (a && a === target) return true
    }
    return false
  }

  return false
}

/**
 * Byte length of text as UTF-8; throw if over MAX_FASTA_BYTES.
 * @param {string} text
 */
function assertFastaByteLimit(text) {
  const n = Buffer.byteLength(String(text ?? ''), 'utf8')
  if (n > MAX_FASTA_BYTES) {
    throw new Error(
      `FASTA 超过 10 MiB 上限（${n} bytes > ${MAX_FASTA_BYTES} bytes）`,
    )
  }
  return n
}

/**
 * Parse and canonicalize a URL while allowing only normal web navigation.
 * Credentials are rejected so renderer data cannot smuggle secrets to a host.
 */
function assertHttpUrl(raw, label = 'URL') {
  let parsed
  try {
    parsed = new URL(String(raw || '').trim())
  } catch {
    throw new Error(`${label} 无效`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} 仅允许 http/https`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} 不允许包含用户名或密码`)
  }
  return parsed.href
}

/**
 * Compare a candidate result URL with a catalog entry while ignoring details
 * that do not make the address reusable as a distinct result resource.
 */
function isEntryEquivalentResultUrl(entryUrl, resultUrl) {
  const comparable = (rawUrl, label) => {
    const parsed = new URL(assertHttpUrl(rawUrl, label))
    parsed.hash = ''
    parsed.protocol = 'https:'
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    parsed.searchParams.sort()
    return `${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`
  }
  return comparable(entryUrl, '网站入口 URL') === comparable(resultUrl, '网站结果 URL')
}

/**
 * Append chunk to string buffer without exceeding maxLen characters.
 */
function appendBounded(buf, chunk, maxLen) {
  if (buf.length >= maxLen) return buf
  const s = String(chunk)
  const room = maxLen - buf.length
  if (s.length <= room) return buf + s
  return buf + s.slice(0, room)
}

function engineEnv(extra = {}) {
  const eng = engineRoot()
  const env = {
    ...process.env,
    ...extra,
    MPLBACKEND: 'Agg',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    // Prefer bundled tools discovery via the engine root.
    BIOINFORMATICS_HUB_ENGINE: eng,
  }
  // Only pin the browser path when a full engine actually ships one; otherwise
  // leave it unset so Playwright uses the user's default registry location.
  const bundledBrowsers = path.join(eng, 'playwright-browsers')
  if (fs.existsSync(bundledBrowsers)) {
    env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers
  }
  // Ensure embeddable python finds its DLLs (full-engine builds only)
  const pyHome = path.join(eng, 'python')
  if (fs.existsSync(pyHome)) {
    env.PYTHONHOME = pyHome
    const scripts = path.join(pyHome, 'Scripts')
    env.PATH = [pyHome, scripts, env.PATH || ''].join(path.delimiter)
  }
  return env
}

module.exports = {
  repoRoot,
  isPackaged,
  engineRoot,
  resolvePython,
  findOnPath,
  resolveMafft,
  resolveIqtree,
  sessionRunnerScript,
  doctorScript,
  uiIndexHtml,
  siteCatalogPath,
  resolveSiteCatalogPath,
  fallbackHtml,
  defaultRunsRoot,
  resolveDefaultRunsRoot,
  engineEnv,
  safeRunId,
  isPathInside,
  isPathInsideLexical,
  resolveDeclaredArtifact,
  copyAlignmentIntoRun,
  assertAlignmentFileExtension,
  canFinalizeSession,
  deriveSessionFinalStatus,
  resolveRunDir,
  resolveRunDirFromArg,
  toFileUrl,
  normalizeFsPathFromUrlOrPath,
  getDevOrigins,
  isAllowedNavigation,
  assertFastaByteLimit,
  assertHttpUrl,
  isEntryEquivalentResultUrl,
  appendBounded,
  MAX_FASTA_BYTES,
  MAX_ALIGNMENT_BYTES,
  SESSION_ALIGNMENT_PATH,
  ALIGNMENT_EXTENSIONS,
  DOCTOR_TIMEOUT_MS,
  DOCTOR_MAX_CAPTURE,
  CANCEL_GRACE_MS,
  TASKKILL_TIMEOUT_MS,
  WIN_RESERVED_RE,
}

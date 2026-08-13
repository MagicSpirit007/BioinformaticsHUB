/**
 * Pure Node tests for paths.cjs helpers (no Electron GUI).
 * Run: node --test tests/paths.helpers.test.cjs
 */
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { EventEmitter } = require('events')
const { pathToFileURL } = require('url')

const {
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
  isAllowedNavigation,
  getDevOrigins,
  assertFastaByteLimit,
  appendBounded,
  MAX_FASTA_BYTES,
  MAX_ALIGNMENT_BYTES,
  SESSION_ALIGNMENT_PATH,
  ALIGNMENT_EXTENSIONS,
  normalizeFsPathFromUrlOrPath,
  toFileUrl,
  resolveDefaultRunsRoot,
  resolveSiteCatalogPath,
  assertHttpUrl,
  isEntryEquivalentResultUrl,
  resolvePython,
  findOnPath,
  resolveMafft,
  resolveIqtree,
} = require('../paths.cjs')

// A "engine fully available" probe result for the session:start tests that
// expect the Python runner to be spawned (local tools + auto-submit usable).
const ENGINE_READY_STDOUT = JSON.stringify({
  packages: {
    biopython: true,
    numpy: true,
    matplotlib: true,
    logomaker: true,
    pillow: true,
    playwright: true,
  },
  chromium: true,
})

function engineReadySpawnSync() {
  return { error: null, status: 0, stdout: ENGINE_READY_STDOUT }
}

describe('resolveDefaultRunsRoot', () => {
  const repo = path.join(os.tmpdir(), 'bioinformatics-hub-repo')
  const userData = path.join(os.tmpdir(), 'bioinformatics-hub-user-data')

  it('keeps an explicit BIOINFORMATICS_HUB_RUNS-style override at highest priority', () => {
    const override = path.join(os.tmpdir(), 'custom-bioinformatics-hub-runs')
    assert.equal(
      resolveDefaultRunsRoot({ override, packaged: true, userData, repo }),
      path.resolve(override),
    )
  })

  it('uses the repository runs directory in development', () => {
    assert.equal(
      resolveDefaultRunsRoot({ packaged: false, userData, repo }),
      path.join(repo, 'runs'),
    )
  })

  it('uses the Electron userData directory when packaged', () => {
    const resolved = resolveDefaultRunsRoot({ packaged: true, userData, repo })
    assert.equal(resolved, path.join(userData, 'runs'))
    assert.equal(resolved.includes(`${path.sep}Documents${path.sep}`), false)
  })
})

describe('resolveSiteCatalogPath', () => {
  const repo = path.join(os.tmpdir(), 'bioinformatics-hub-catalog-repo')

  it('uses resources/ui in packaged mode', () => {
    const resourcesPath = path.join(os.tmpdir(), 'bioinformatics-hub-resources')
    assert.equal(
      resolveSiteCatalogPath({ packaged: true, resourcesPath, repo }),
      path.join(resourcesPath, 'ui', 'site-catalog.json'),
    )
  })

  it('falls back to the development dist catalog when source is absent', () => {
    assert.equal(
      resolveSiteCatalogPath({ packaged: false, repo }),
      path.join(repo, 'apps', 'bioinformatics-hub', 'dist', 'site-catalog.json'),
    )
  })
})

describe('safeRunId', () => {
  it('sanitizes path separators and traversal', () => {
    // "." kept by charset; "/" → "_"; leading dots stripped → "_etc_passwd"
    assert.equal(safeRunId('../etc/passwd'), '_etc_passwd')
    const id = safeRunId('..\\..\\secret')
    assert.ok(!id.includes('/') && !id.includes('\\'))
    assert.ok(!id.startsWith('.'))
    assert.notEqual(id, '..')
    assert.equal(id, '_.._secret')
  })

  it('handles empty / nullish', () => {
    assert.equal(safeRunId(''), 'gene')
    assert.equal(safeRunId(null), 'gene')
    assert.equal(safeRunId(undefined), 'gene')
  })

  it('truncates to 128 chars', () => {
    const long = 'a'.repeat(200)
    assert.equal(safeRunId(long).length, 128)
  })

  it('prefixes Windows reserved device names', () => {
    assert.equal(safeRunId('CON'), '_CON')
    assert.equal(safeRunId('con'), '_con')
    assert.equal(safeRunId('PRN'), '_PRN')
    assert.equal(safeRunId('AUX'), '_AUX')
    assert.equal(safeRunId('NUL'), '_NUL')
    assert.equal(safeRunId('COM1'), '_COM1')
    assert.equal(safeRunId('com9'), '_com9')
    assert.equal(safeRunId('LPT1'), '_LPT1')
    assert.equal(safeRunId('lpt9.txt'), '_lpt9.txt')
  })

  it('allows normal gene ids', () => {
    assert.equal(safeRunId('CCA0859S0013'), 'CCA0859S0013')
    assert.equal(safeRunId('CcAZF2'), 'CcAZF2')
    assert.equal(safeRunId('gene-1.2'), 'gene-1.2')
  })

  it('strips trailing dots/spaces', () => {
    assert.equal(safeRunId('foo.'), 'foo')
    assert.equal(safeRunId('bar   '), 'bar')
  })
})

describe('isPathInside / containment', () => {
  let tmpRoot
  let insideDir
  let outsideDir

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bioinformatics-hub-path-'))
    insideDir = path.join(tmpRoot, 'runs')
    outsideDir = path.join(tmpRoot, 'outside')
    fs.mkdirSync(insideDir, { recursive: true })
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.writeFileSync(path.join(insideDir, 'ok.txt'), 'x')
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'y')
  })

  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('lexical: allows children, rejects siblings and parent escape', () => {
    assert.equal(isPathInsideLexical(insideDir, path.join(insideDir, 'a', 'b')), true)
    assert.equal(isPathInsideLexical(insideDir, insideDir), true)
    assert.equal(isPathInsideLexical(insideDir, outsideDir), false)
    assert.equal(
      isPathInsideLexical(insideDir, path.join(insideDir, '..', 'outside', 'secret.txt')),
      false,
    )
    assert.equal(
      isPathInsideLexical(insideDir, path.join(insideDir, '..', '..', 'Windows')),
      false,
    )
  })

  it('non-existing target keeps lexical containment', () => {
    const planned = path.join(insideDir, 'new_run', 'status.json')
    assert.equal(isPathInside(insideDir, planned), true)
    const escape = path.join(insideDir, '..', 'outside', 'nope')
    assert.equal(isPathInside(insideDir, escape), false)
  })

  it('existing target uses realpath containment', () => {
    const existing = path.join(insideDir, 'ok.txt')
    assert.equal(isPathInside(insideDir, existing), true)
    assert.equal(isPathInside(insideDir, path.join(outsideDir, 'secret.txt')), false)
  })

  it('symlink/junction escape rejected when target realpath leaves root', () => {
    const linkPath = path.join(insideDir, 'escape_link')
    const target = path.join(outsideDir, 'secret.txt')
    let created = false
    try {
      fs.symlinkSync(target, linkPath)
      created = true
    } catch {
      try {
        // Windows may need elevated privileges for symlinks; try junction for dir
        const linkDir = path.join(insideDir, 'escape_junc')
        fs.symlinkSync(outsideDir, linkDir, 'junction')
        assert.equal(isPathInside(insideDir, path.join(linkDir, 'secret.txt')), false)
        created = true
        fs.rmSync(linkDir, { recursive: true, force: true })
      } catch {
        // Skip if OS disallows reparse points in this environment
        return
      }
    }
    if (created && fs.existsSync(linkPath)) {
      assert.equal(isPathInside(insideDir, linkPath), false)
      try {
        fs.unlinkSync(linkPath)
      } catch {
        /* ignore */
      }
    }
  })
})

describe('resolveDeclaredArtifact', () => {
  let runDir
  let outsideDir

  before(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bioinformatics-hub-artifacts-'))
    runDir = path.join(root, 'run')
    outsideDir = path.join(root, 'outside')
    fs.mkdirSync(path.join(runDir, '01_local'), { recursive: true })
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, '01_local', 'declared.png'), 'png')
    fs.writeFileSync(path.join(runDir, '01_local', 'undeclared.png'), 'png')
    fs.writeFileSync(path.join(outsideDir, 'secret.png'), 'secret')
  })

  after(() => {
    try {
      fs.rmSync(path.dirname(runDir), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('allows only an exactly declared relative artifact', () => {
    const target = resolveDeclaredArtifact(
      runDir,
      ['01_local/declared.png'],
      '01_local/declared.png',
    )
    assert.equal(target, path.resolve(runDir, '01_local', 'declared.png'))
  })

  it('rejects undeclared files even when they are inside the run directory', () => {
    assert.throws(
      () =>
        resolveDeclaredArtifact(
          runDir,
          ['01_local/declared.png'],
          '01_local/undeclared.png',
        ),
      /未在会话中声明/,
    )
  })

  it('rejects traversal before touching an outside file', () => {
    assert.throws(
      () => resolveDeclaredArtifact(runDir, ['../outside/secret.png'], '../outside/secret.png'),
      /越界/,
    )
    assert.throws(
      () =>
        resolveDeclaredArtifact(
          runDir,
          ['01_local/declared.png'],
          '01_local/../../outside/secret.png',
        ),
      /越界|未在会话中声明/,
    )
    assert.throws(
      () =>
        resolveDeclaredArtifact(
          runDir,
          ['01_local/declared.png'],
          '01_local/../01_local/declared.png',
        ),
      /越界/,
    )
    assert.throws(
      () => resolveDeclaredArtifact(runDir, ['C:/outside.png'], 'C:/outside.png'),
      /无效/,
    )
  })

  it('rejects a declared symlink/junction whose canonical target escapes the run', () => {
    const linkFile = path.join(runDir, '01_local', 'escape.png')
    let fileLinkCreated = false
    try {
      fs.symlinkSync(path.join(outsideDir, 'secret.png'), linkFile)
      fileLinkCreated = true
    } catch {
      /* try a directory junction below */
    }
    if (fileLinkCreated) {
      try {
      assert.throws(
        () => resolveDeclaredArtifact(runDir, ['01_local/escape.png'], '01_local/escape.png'),
        /越界/,
      )
      } finally {
        try {
          fs.unlinkSync(linkFile)
        } catch {
          /* ignore */
        }
      }
      return
    }

    const linkDir = path.join(runDir, '01_local', 'escape-dir')
    let dirLinkCreated = false
    try {
      fs.symlinkSync(outsideDir, linkDir, 'junction')
      dirLinkCreated = true
    } catch {
      // Reparse point creation is unavailable in some Windows test environments.
    }
    try {
      if (dirLinkCreated) {
      assert.throws(
        () =>
          resolveDeclaredArtifact(
            runDir,
            ['01_local/escape-dir/secret.png'],
            '01_local/escape-dir/secret.png',
        ),
        /越界/,
      )
      }
    } finally {
      try {
        if (fs.existsSync(linkDir)) fs.rmSync(linkDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })
})

describe('session alignment copy', () => {
  let root
  let runDir
  let selectedPath

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bioinformatics-hub-alignment-'))
    runDir = path.join(root, 'runs', 'geneA')
    selectedPath = path.join(root, 'picked.aln')
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(selectedPath, '>a\nAAAA\n>b\nAA-A\n', 'utf8')
  })

  after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('copies the selected alignment to the fixed session-relative path', () => {
    const copied = copyAlignmentIntoRun(selectedPath, runDir)
    assert.equal(copied.relativePath, SESSION_ALIGNMENT_PATH)
    assert.equal(copied.path, path.resolve(runDir, '00_input', 'alignment.fasta'))
    assert.equal(fs.readFileSync(copied.path, 'utf8'), '>a\nAAAA\n>b\nAA-A\n')
    assert.equal(isPathInside(runDir, copied.path), true)
  })

  it('enforces the documented alignment byte limit', () => {
    assert.equal(MAX_ALIGNMENT_BYTES, 25 * 1024 * 1024)
    const secondRun = path.join(root, 'runs', 'geneB')
    fs.mkdirSync(secondRun, { recursive: true })
    assert.throws(() => copyAlignmentIntoRun(selectedPath, secondRun, 4), /25 MiB/)
  })

  it('allows only FASTA-family alignment extensions', () => {
    assert.deepEqual(ALIGNMENT_EXTENSIONS, [
      '.fa',
      '.fasta',
      '.faa',
      '.fna',
      '.afa',
      '.aln',
      '.txt',
    ])
    for (const extension of ALIGNMENT_EXTENSIONS) {
      assert.equal(assertAlignmentFileExtension(`alignment${extension}`), extension)
    }
    for (const extension of ['.clustal', '.msa', '.tree', '.nwk', '.pdf']) {
      assert.throws(() => assertAlignmentFileExtension(`alignment${extension}`), /多序列 FASTA/)
    }
  })
})

describe('session terminal-state gate', () => {
  const ready = {
    childClosed: true,
    runnerDone: true,
    pendingManualCount: 0,
    manualInFlight: 0,
    cancelled: false,
    outcomeEmitted: false,
  }

  it('waits for runner close, done, timers, and in-flight browser opens', () => {
    assert.equal(canFinalizeSession(ready), true)
    assert.equal(canFinalizeSession({ ...ready, childClosed: false }), false)
    assert.equal(canFinalizeSession({ ...ready, runnerDone: false }), false)
    assert.equal(canFinalizeSession({ ...ready, pendingManualCount: 1 }), false)
    assert.equal(canFinalizeSession({ ...ready, manualInFlight: 1 }), false)
    assert.equal(canFinalizeSession({ ...ready, cancelled: true }), false)
    assert.equal(canFinalizeSession({ ...ready, outcomeEmitted: true }), false)
  })

  it('requires real website results and completed/skipped local tools', () => {
    const sites = [
      { status: 'result_ready', resultUrl: 'https://official.example/result' },
      { status: 'completed_manual' },
    ]
    const tools = [{ status: 'completed' }, { status: 'skipped' }]
    const validResult = { isValidSiteResult: () => true }
    assert.equal(deriveSessionFinalStatus('ok', sites, tools, validResult), 'completed')
    assert.equal(deriveSessionFinalStatus('partial', sites, tools), 'partial')
    assert.equal(deriveSessionFinalStatus('ok', [{ status: 'result_ready' }], tools), 'partial')
    assert.equal(
      deriveSessionFinalStatus(
        'ok',
        [{ status: 'result_ready', resultUrl: 'https://evil.example/result' }],
        tools,
        { isValidSiteResult: () => false },
      ),
      'partial',
    )
    for (const status of ['opened_manual', 'queued', 'opening', 'needs_manual', 'failed']) {
      assert.equal(deriveSessionFinalStatus('ok', [{ status }], tools), 'partial')
    }
    for (const status of ['queued', 'running', 'failed', 'needs_setup']) {
      assert.equal(deriveSessionFinalStatus('ok', sites, [{ status }]), 'partial')
    }
    assert.equal(deriveSessionFinalStatus('ok', [], tools), 'completed')
  })
})

describe('resolveRunDir / resolveRunDirFromArg', () => {
  let runsRoot

  before(() => {
    runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bioinformatics-hub-runs-'))
  })

  after(() => {
    try {
      fs.rmSync(runsRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('resolves id under runs root', () => {
    const { runId, runDir } = resolveRunDir('CCA0859S0013', runsRoot)
    assert.equal(runId, 'CCA0859S0013')
    assert.equal(runDir, path.resolve(runsRoot, 'CCA0859S0013'))
  })

  it('rejects traversal ids that escape after sanitize basename check', () => {
    // safeRunId turns separators into _; still must stay under root
    const { runDir, runsRoot: root } = resolveRunDir('foo/../../bar', runsRoot)
    assert.ok(isPathInside(root, runDir))
  })

  it('resolveRunDirFromArg accepts path under root only', () => {
    const child = path.join(runsRoot, 'geneA')
    fs.mkdirSync(child, { recursive: true })
    const r = resolveRunDirFromArg(child, runsRoot)
    assert.equal(r.runDir, path.resolve(child))
    assert.throws(() => resolveRunDirFromArg(path.join(runsRoot, '..', 'nope'), runsRoot))
  })
})

describe('isAllowedNavigation', () => {
  const uiFile = path.join(os.tmpdir(), 'bioinformatics-hub-ui-index.html')
  const fallback = path.join(os.tmpdir(), 'bioinformatics-hub-fallback.html')
  const otherFile = path.join(os.tmpdir(), 'evil.html')

  it('allows only configured dev origin, not arbitrary hosts', () => {
    const prev = process.env.BIOINFORMATICS_HUB_DEV_URL
    process.env.BIOINFORMATICS_HUB_DEV_URL = 'http://127.0.0.1:5173'
    try {
      const origins = getDevOrigins()
      assert.equal(
        isAllowedNavigation('http://127.0.0.1:5173/', { devOrigins: origins }),
        true,
      )
      assert.equal(
        isAllowedNavigation('http://127.0.0.1:5173/src/main.tsx', { devOrigins: origins }),
        true,
      )
      assert.equal(
        isAllowedNavigation('http://localhost:5173/', { devOrigins: origins }),
        false,
      )
      assert.equal(
        isAllowedNavigation('https://evil.example/', { devOrigins: origins }),
        false,
      )
      assert.equal(
        isAllowedNavigation('http://127.0.0.1:3000/', { devOrigins: origins }),
        false,
      )
    } finally {
      if (prev === undefined) delete process.env.BIOINFORMATICS_HUB_DEV_URL
      else process.env.BIOINFORMATICS_HUB_DEV_URL = prev
    }
  })

  it('allows only listed UI file URLs, not blanket file://', () => {
    const allowedFilePaths = [uiFile, fallback]
    const uiUrl = pathToFileURL(uiFile).href
    const fallUrl = pathToFileURL(fallback).href
    const evilUrl = pathToFileURL(otherFile).href

    assert.equal(isAllowedNavigation(uiUrl, { allowedFilePaths }), true)
    assert.equal(isAllowedNavigation(fallUrl, { allowedFilePaths }), true)
    assert.equal(isAllowedNavigation(evilUrl, { allowedFilePaths }), false)
    assert.equal(
      isAllowedNavigation('file:///C:/Windows/System32/drivers/etc/hosts', {
        allowedFilePaths,
      }),
      false,
    )
  })

  it('rejects non-http(s)/file schemes', () => {
    assert.equal(isAllowedNavigation('javascript:alert(1)'), false)
    assert.equal(isAllowedNavigation('data:text/html,hi'), false)
  })
})

describe('FASTA size + appendBounded', () => {
  it('exports 10 MiB constant', () => {
    assert.equal(MAX_FASTA_BYTES, 10 * 1024 * 1024)
  })

  it('assertFastaByteLimit accepts small, rejects oversize', () => {
    assert.equal(assertFastaByteLimit('>seq\nATGC\n'), Buffer.byteLength('>seq\nATGC\n', 'utf8'))
    const big = 'A'.repeat(MAX_FASTA_BYTES + 1)
    assert.throws(() => assertFastaByteLimit(big), /10 MiB/)
  })

  it('appendBounded caps memory growth', () => {
    let s = ''
    s = appendBounded(s, 'hello', 8)
    s = appendBounded(s, 'WORLD', 8)
    assert.equal(s, 'helloWOR')
    s = appendBounded(s, 'xxx', 8)
    assert.equal(s, 'helloWOR')
  })
})

describe('assertHttpUrl', () => {
  it('canonicalizes http and https URLs', () => {
    assert.equal(assertHttpUrl('https://example.org/path'), 'https://example.org/path')
    assert.equal(assertHttpUrl('http://example.org'), 'http://example.org/')
  })

  it('rejects local, executable, malformed, and credential-bearing URLs', () => {
    assert.throws(() => assertHttpUrl('file:///C:/secret.txt'), /http\/https/)
    assert.throws(() => assertHttpUrl('javascript:alert(1)'), /http\/https/)
    assert.throws(() => assertHttpUrl('not-a-url'), /无效/)
    assert.throws(() => assertHttpUrl('https://user:pass@example.org/'), /用户名或密码/)
  })
})

describe('isEntryEquivalentResultUrl', () => {
  const entry = 'https://www.ncbi.nlm.nih.gov/orffinder/?b=2&a=1'

  it('treats protocol, fragment, trailing slash, and query order as entry-equivalent', () => {
    assert.equal(
      isEntryEquivalentResultUrl(entry, 'http://www.ncbi.nlm.nih.gov/orffinder?a=1&b=2#results'),
      true,
    )
  })

  it('accepts a distinct result path or query', () => {
    assert.equal(
      isEntryEquivalentResultUrl(entry, 'https://www.ncbi.nlm.nih.gov/orffinder/result/123?a=1&b=2'),
      false,
    )
    assert.equal(
      isEntryEquivalentResultUrl(entry, 'https://www.ncbi.nlm.nih.gov/orffinder/?a=1&b=2&job=123'),
      false,
    )
  })

  it('does not collapse a different host into the entry', () => {
    assert.equal(
      isEntryEquivalentResultUrl(entry, 'https://results.ncbi.nlm.nih.gov/orffinder/?a=1&b=2'),
      false,
    )
  })
})

describe('normalizeFsPathFromUrlOrPath / toFileUrl', () => {
  it('round-trips absolute paths', () => {
    const p = path.resolve(__dirname, 'paths.helpers.test.cjs')
    const url = toFileUrl(p)
    assert.ok(url.startsWith('file:'))
    assert.equal(normalizeFsPathFromUrlOrPath(url), normalizeFsPathFromUrlOrPath(p))
  })
})

describe('Electron 0.3 IPC and preload surface', () => {
  const originalPython = process.env.BIOINFORMATICS_HUB_PYTHON
  const originalEngine = process.env.BIOINFORMATICS_HUB_ENGINE
  before(() => {
    // Force resolvePython() to a real, existing executable so probeEngine can
    // run deterministically without scanning the host PATH.
    process.env.BIOINFORMATICS_HUB_PYTHON = process.execPath
  })
  after(() => {
    if (originalPython === undefined) delete process.env.BIOINFORMATICS_HUB_PYTHON
    else process.env.BIOINFORMATICS_HUB_PYTHON = originalPython
    if (originalEngine === undefined) delete process.env.BIOINFORMATICS_HUB_ENGINE
    else process.env.BIOINFORMATICS_HUB_ENGINE = originalEngine
  })

  it('registers the session/site/file handlers without legacy pipeline handlers', () => {
    const handlers = new Map()
    const mockElectron = {
      app: {
        isPackaged: false,
        whenReady: () => new Promise(() => {}),
        on: () => undefined,
      },
      BrowserWindow: class BrowserWindow {
        static getAllWindows() {
          return []
        }
      },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: {},
      shell: {},
      Menu: {},
      protocol: { registerSchemesAsPrivileged: () => undefined },
    }
    const originalLoad = Module._load
    Module._load = function mockLoad(request, parent, isMain) {
      if (request === 'electron') return mockElectron
      return originalLoad.call(this, request, parent, isMain)
    }
    try {
      delete require.cache[require.resolve('../main.cjs')]
      require('../main.cjs')
    } finally {
      Module._load = originalLoad
      delete require.cache[require.resolve('../main.cjs')]
    }

    assert.deepEqual(
      [...handlers.keys()].sort(),
      [
        'app:setLocale',
        'artifact:reveal',
        'engine:status',
        'fs:exportResearchBundle',
        'fs:pickAlignment',
        'fs:pickFasta',
        'session:cancel',
        'session:list',
        'session:load',
        'session:start',
        'site:open',
        'site:saveResult',
      ],
    )
    assert.equal([...handlers.keys()].some((channel) => channel.startsWith('pipeline:')), false)
  })

  it('waits for input_ready before opening manual sites and preserves empty run directories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bioinformatics-hub-input-gate-'))
    const runsRoot = path.join(root, 'runs')
    const reservedEmptyDir = path.join(runsRoot, 'geneD')
    fs.mkdirSync(reservedEmptyDir, { recursive: true })
    const handlers = new Map()
    const openedUrls = []
    class MockChild extends EventEmitter {
      constructor() {
        super()
        this.pid = 4141
        this.stdout = new EventEmitter()
        this.stderr = new EventEmitter()
        this.exitCode = null
        this.signalCode = null
      }
    }
    const child = new MockChild()
    const mockElectron = {
      app: {
        isPackaged: false,
        whenReady: () => new Promise(() => {}),
        on: () => undefined,
      },
      BrowserWindow: class BrowserWindow {
        static getAllWindows() {
          return []
        }
      },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: {},
      shell: {
        openExternal: async (url) => {
          openedUrls.push(url)
        },
        showItemInFolder: () => undefined,
      },
      Menu: {},
      protocol: { registerSchemesAsPrivileged: () => undefined },
    }
    const originalRuns = process.env.BIOINFORMATICS_HUB_RUNS
    const originalLoad = Module._load
    process.env.BIOINFORMATICS_HUB_RUNS = runsRoot
    Module._load = function mockLoad(request, parent, isMain) {
      if (request === 'electron') return mockElectron
      if (request === 'child_process') return { spawn: () => child, spawnSync: engineReadySpawnSync }
      return originalLoad.call(this, request, parent, isMain)
    }
    try {
      delete require.cache[require.resolve('../main.cjs')]
      require('../main.cjs')
      const started = await handlers.get('session:start')(null, {
        fastaText: '>geneD\nATGGCC\n',
        geneId: 'geneD',
        inputKind: 'cds',
        siteIds: ['orf_finder'],
        localToolIds: [],
      })

      assert.notEqual(started.sessionId, 'geneD')
      assert.deepEqual(fs.readdirSync(reservedEmptyDir), [])
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(openedUrls, [])

      child.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'input_ready', input: { inputKind: 'cds' } })}\n`),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(openedUrls.length, 1)
      assert.match(openedUrls[0], /ncbi\.nlm\.nih\.gov\/orffinder/)

      child.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'done', overall: 'ok' })}\n`),
      )
      child.exitCode = 0
      child.emit('close', 0)
    } finally {
      Module._load = originalLoad
      delete require.cache[require.resolve('../main.cjs')]
      if (originalRuns === undefined) delete process.env.BIOINFORMATICS_HUB_RUNS
      else process.env.BIOINFORMATICS_HUB_RUNS = originalRuns
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('copies picker alignment into the session and waits for child close after done', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bioinformatics-hub-main-session-'))
    const runsRoot = path.join(root, 'runs')
    const selectedPath = path.join(root, 'selected.aln')
    const externalExecutable = path.join(root, 'secret-user', 'tool.exe')
    fs.writeFileSync(selectedPath, '>a\nAAAA\n>b\nAA-A\n', 'utf8')
    const handlers = new Map()
    const spawnCalls = []
    class MockChild extends EventEmitter {
      constructor() {
        super()
        this.pid = 4242
        this.stdout = new EventEmitter()
        this.stderr = new EventEmitter()
        this.exitCode = null
        this.signalCode = null
      }
    }
    const child = new MockChild()
    const mockElectron = {
      app: {
        isPackaged: false,
        whenReady: () => new Promise(() => {}),
        on: () => undefined,
      },
      BrowserWindow: class BrowserWindow {
        static getAllWindows() {
          return []
        }
      },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [selectedPath] }),
      },
      shell: { openExternal: async () => undefined, showItemInFolder: () => undefined },
      Menu: {},
      protocol: { registerSchemesAsPrivileged: () => undefined },
    }
    const mockChildProcess = {
      spawn: (...args) => {
        spawnCalls.push(args)
        return child
      },
      spawnSync: engineReadySpawnSync,
    }
    const originalRuns = process.env.BIOINFORMATICS_HUB_RUNS
    const originalLoad = Module._load
    const originalReadFileSync = fs.readFileSync
    let alignmentReads = 0
    process.env.BIOINFORMATICS_HUB_RUNS = runsRoot
    Module._load = function mockLoad(request, parent, isMain) {
      if (request === 'electron') return mockElectron
      if (request === 'child_process') return mockChildProcess
      return originalLoad.call(this, request, parent, isMain)
    }
    try {
      delete require.cache[require.resolve('../main.cjs')]
      require('../main.cjs')
      const picked = await handlers.get('fs:pickAlignment')()
      const started = await handlers.get('session:start')(null, {
        fastaText: '>geneA\nATGGCC\n',
        geneId: 'geneA',
        inputKind: 'cds',
        siteIds: [],
        localToolIds: ['nucleic'],
        alignmentPath: picked.path,
      })
      const sessionFile = path.join(started.sessionDir, 'session.json')
      const copiedPath = path.join(started.sessionDir, '00_input', 'alignment.fasta')
      assert.equal(fs.readFileSync(copiedPath, 'utf8'), fs.readFileSync(selectedPath, 'utf8'))
      assert.equal(spawnCalls.length, 1)
      const runnerArgs = spawnCalls[0][1]
      assert.equal(runnerArgs[runnerArgs.indexOf('--alignment') + 1], copiedPath)

      fs.readFileSync = function trackedRead(filePath, ...args) {
        if (path.resolve(String(filePath)) === path.resolve(copiedPath)) alignmentReads += 1
        return originalReadFileSync.call(this, filePath, ...args)
      }

      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'input_ready',
            input: { alignmentFastaPath: selectedPath },
          })}\n${JSON.stringify({
            type: 'local_update',
            id: 'nucleic',
            state: 'completed',
            source: externalExecutable,
            version: '1.2.3',
            parameters: { mode: 'deterministic' },
            provenance: {
              kind: 'local',
              method: 'test',
              executable: externalExecutable,
              nested: { binary: externalExecutable },
              metadata: { value: 'preserved' },
            },
          })}\n${JSON.stringify({ type: 'done', overall: 'ok' })}\n`,
        ),
      )
      const beforeClose = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
      assert.equal(beforeClose.status, 'running')
      assert.equal(beforeClose.input.alignmentFastaPath, SESSION_ALIGNMENT_PATH)
      assert.equal(JSON.stringify(beforeClose).includes(selectedPath), false)
      const local = beforeClose.localTools[0]
      assert.equal(local.source, 'tool.exe')
      assert.equal(local.version, '1.2.3')
      assert.deepEqual(local.parameters, { mode: 'deterministic' })
      assert.equal(local.provenance.executable, 'tool.exe')
      assert.equal(local.provenance.location, 'external')
      assert.equal(local.provenance.nested.binary, 'tool.exe')
      assert.equal(local.provenance.nested.location, 'external')
      assert.deepEqual(local.provenance.metadata, { value: 'preserved' })
      assert.equal(JSON.stringify(beforeClose).includes(externalExecutable), false)
      // input_ready/local_update/done all emit renderer updates, but routine
      // updates must not reread or resend the potentially 25 MiB alignment.
      assert.equal(alignmentReads, 0)

      const loaded = await handlers.get('session:load')(null, started.sessionId)
      assert.equal(loaded.input.alignmentFasta, '>a\nAAAA\n>b\nAA-A\n')
      assert.equal(alignmentReads, 1)

      child.exitCode = 0
      child.emit('close', 0)
      const afterClose = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
      assert.equal(afterClose.status, 'completed')
      assert.equal(alignmentReads, 1)

      afterClose.input.fastaText = '>legacy-inline\nAAAA\n'
      afterClose.input.alignmentFasta = '>legacy-inline\nAAAA\n'
      fs.writeFileSync(sessionFile, `${JSON.stringify(afterClose)}\n`, 'utf8')
      const listed = await handlers.get('session:list')()
      const listedSession = listed.find((item) => item.sessionId === started.sessionId)
      assert.equal('fastaText' in listedSession.input, false)
      assert.equal('alignmentFasta' in listedSession.input, false)
      assert.equal(alignmentReads, 1)
    } finally {
      fs.readFileSync = originalReadFileSync
      Module._load = originalLoad
      delete require.cache[require.resolve('../main.cjs')]
      if (originalRuns === undefined) delete process.env.BIOINFORMATICS_HUB_RUNS
      else process.env.BIOINFORMATICS_HUB_RUNS = originalRuns
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('downgrades result_ready without a catalog-valid result URL', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bioinformatics-hub-site-result-'))
    const runsRoot = path.join(root, 'runs')
    const handlers = new Map()
    const openedUrls = []
    class MockChild extends EventEmitter {
      constructor() {
        super()
        this.pid = 4343
        this.stdout = new EventEmitter()
        this.stderr = new EventEmitter()
        this.exitCode = null
        this.signalCode = null
      }
    }
    const child = new MockChild()
    const mockElectron = {
      app: {
        isPackaged: false,
        whenReady: () => new Promise(() => {}),
        on: () => undefined,
      },
      BrowserWindow: class BrowserWindow {
        static getAllWindows() {
          return []
        }
      },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: {},
      shell: {
        openExternal: async (url) => {
          openedUrls.push(url)
        },
        showItemInFolder: () => undefined,
      },
      Menu: {},
      protocol: { registerSchemesAsPrivileged: () => undefined },
    }
    const originalRuns = process.env.BIOINFORMATICS_HUB_RUNS
    const originalLoad = Module._load
    process.env.BIOINFORMATICS_HUB_RUNS = runsRoot
    Module._load = function mockLoad(request, parent, isMain) {
      if (request === 'electron') return mockElectron
      if (request === 'child_process') return { spawn: () => child, spawnSync: engineReadySpawnSync }
      return originalLoad.call(this, request, parent, isMain)
    }
    try {
      delete require.cache[require.resolve('../main.cjs')]
      require('../main.cjs')
      const started = await handlers.get('session:start')(null, {
        fastaText: '>geneB\nMPEPTIDE\n',
        geneId: 'geneB',
        inputKind: 'protein',
        siteIds: ['plant_mploc'],
        localToolIds: [],
      })
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            type: 'site_update',
            id: 'plant_mploc',
            state: 'result_ready',
          })}\n${JSON.stringify({
            type: 'site_update',
            id: 'plant_mploc',
            state: 'result_ready',
            resultUrl: 'https://evil.example/result',
          })}\n${JSON.stringify({ type: 'done', overall: 'ok' })}\n`,
        ),
      )
      child.exitCode = 0
      child.emit('close', 0)
      await new Promise((resolve) => setImmediate(resolve))

      const persisted = JSON.parse(
        fs.readFileSync(path.join(started.sessionDir, 'session.json'), 'utf8'),
      )
      assert.equal(persisted.status, 'partial')
      assert.equal(persisted.sites[0].status, 'needs_manual')
      assert.equal(persisted.sites[0].resultUrl, null)
      assert.equal(openedUrls.length, 1)
      assert.equal(openedUrls[0], persisted.sites[0].entryUrl)
      assert.equal(openedUrls.includes('https://evil.example/result'), false)
    } finally {
      Module._load = originalLoad
      delete require.cache[require.resolve('../main.cjs')]
      if (originalRuns === undefined) delete process.env.BIOINFORMATICS_HUB_RUNS
      else process.env.BIOINFORMATICS_HUB_RUNS = originalRuns
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('supports legacy result URLs and explicit no-link completion', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bioinformatics-hub-manual-result-'))
    const runsRoot = path.join(root, 'runs')
    const handlers = new Map()
    class MockChild extends EventEmitter {
      constructor() {
        super()
        this.pid = 4545
        this.stdout = new EventEmitter()
        this.stderr = new EventEmitter()
        this.exitCode = null
        this.signalCode = null
      }
    }
    const child = new MockChild()
    const mockElectron = {
      app: {
        isPackaged: false,
        getLocale: () => 'zh-CN',
        whenReady: () => new Promise(() => {}),
        on: () => undefined,
      },
      BrowserWindow: class BrowserWindow {
        static getAllWindows() {
          return []
        }
      },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: {
        showSaveDialog: async () => ({ filePath: null }),
      },
      shell: { openExternal: async () => undefined, showItemInFolder: () => undefined },
      Menu: {},
      protocol: { registerSchemesAsPrivileged: () => undefined },
    }
    const originalRuns = process.env.BIOINFORMATICS_HUB_RUNS
    const originalLoad = Module._load
    process.env.BIOINFORMATICS_HUB_RUNS = runsRoot
    Module._load = function mockLoad(request, parent, isMain) {
      if (request === 'electron') return mockElectron
      if (request === 'child_process') return { spawn: () => child, spawnSync: engineReadySpawnSync }
      return originalLoad.call(this, request, parent, isMain)
    }
    try {
      delete require.cache[require.resolve('../main.cjs')]
      require('../main.cjs')
      const started = await handlers.get('session:start')(null, {
        fastaText: '>geneC\nATGGCC\n',
        geneId: 'geneC',
        inputKind: 'cds',
        siteIds: ['orf_finder'],
        localToolIds: [],
      })

      await assert.rejects(
        () => handlers.get('site:saveResult')(null, {
          sessionId: started.sessionId,
          siteId: 'orf_finder',
        }),
        /必须明确保存结果链接/,
      )
      await assert.rejects(
        () => handlers.get('site:saveResult')(null, {
          sessionId: started.sessionId,
          siteId: 'orf_finder',
          resultMode: 'result_url',
          resultUrl: 'http://www.ncbi.nlm.nih.gov/orffinder/#viewer',
        }),
        /仍是 .*入口页/,
      )

      const legacySaved = await handlers.get('site:saveResult')(null, {
        sessionId: started.sessionId,
        siteId: 'orf_finder',
        resultUrl: 'https://www.ncbi.nlm.nih.gov/orffinder/result?id=42',
        notes: 'legacy URL call',
      })
      assert.equal(legacySaved.session.sites[0].status, 'completed_manual')
      assert.equal(
        legacySaved.session.sites[0].resultUrl,
        'https://www.ncbi.nlm.nih.gov/orffinder/result?id=42',
      )

      const withoutLink = await handlers.get('site:saveResult')(null, {
        sessionId: started.sessionId,
        siteId: 'orf_finder',
        resultMode: 'no_persistent_url',
        notes: '提交后地址没有变化',
      })
      assert.equal(withoutLink.session.sites[0].status, 'completed_manual')
      assert.equal(withoutLink.session.sites[0].resultUrl, null)
      assert.equal(withoutLink.session.sites[0].notes, '提交后地址没有变化')

      child.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'done', overall: 'ok' })}\n`),
      )
      child.exitCode = 0
      child.emit('close', 0)
      await new Promise((resolve) => setImmediate(resolve))

      const persisted = JSON.parse(
        fs.readFileSync(path.join(started.sessionDir, 'session.json'), 'utf8'),
      )
      assert.equal(persisted.status, 'completed')
      assert.equal(persisted.sites[0].resultUrl, null)

      const exported = await handlers.get('fs:exportResearchBundle')(null, started.sessionId)
      const bundle = fs.readFileSync(exported.path, 'utf8')
      assert.match(bundle, /无可复开链接/)
      assert.match(bundle, /提交后地址没有变化/)
    } finally {
      Module._load = originalLoad
      delete require.cache[require.resolve('../main.cjs')]
      if (originalRuns === undefined) delete process.env.BIOINFORMATICS_HUB_RUNS
      else process.env.BIOINFORMATICS_HUB_RUNS = originalRuns
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('degraded mode opens manual sites immediately and marks tools needs_setup when the engine is unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bioinformatics-hub-degraded-'))
    const runsRoot = path.join(root, 'runs')
    const handlers = new Map()
    const openedUrls = []
    let spawnCalled = false
    const mockElectron = {
      app: {
        isPackaged: false,
        getLocale: () => 'zh-CN',
        whenReady: () => new Promise(() => {}),
        on: () => undefined,
      },
      BrowserWindow: class BrowserWindow {
        static getAllWindows() {
          return []
        }
      },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: {},
      shell: {
        openExternal: async (url) => {
          openedUrls.push(url)
        },
        showItemInFolder: () => undefined,
      },
      Menu: {},
      protocol: { registerSchemesAsPrivileged: () => undefined },
    }
    const originalRuns = process.env.BIOINFORMATICS_HUB_RUNS
    const originalPython = process.env.BIOINFORMATICS_HUB_PYTHON
    const originalLoad = Module._load
    process.env.BIOINFORMATICS_HUB_RUNS = runsRoot
    delete process.env.BIOINFORMATICS_HUB_PYTHON
    // No engine: probe reports no packages and no Python is resolvable.
    const mockChildProcess = {
      spawn: () => {
        spawnCalled = true
        throw new Error('runner must not be spawned in degraded mode')
      },
      spawnSync: () => ({ error: null, status: 0, stdout: '{"packages":{},"chromium":false}' }),
    }
    Module._load = function mockLoad(request, parent, isMain) {
      if (request === 'electron') return mockElectron
      if (request === 'child_process') return mockChildProcess
      return originalLoad.call(this, request, parent, isMain)
    }
    try {
      delete require.cache[require.resolve('../main.cjs')]
      require('../main.cjs')
      const started = await handlers.get('session:start')(null, {
        fastaText: '>geneE\nATGGCC\n',
        geneId: 'geneE',
        inputKind: 'cds',
        siteIds: ['orf_finder', 'plant_mploc'],
        localToolIds: ['nucleic'],
      })

      // Manual sites (orf_finder + downgraded plant_mploc) open without a runner.
      // Intra-batch delay is ~750ms, so wait past it for the second tab.
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const persisted = JSON.parse(
        fs.readFileSync(path.join(started.sessionDir, 'session.json'), 'utf8'),
      )
      assert.equal(spawnCalled, false)
      assert.equal(persisted.localTools[0].status, 'needs_setup')
      // plant_mploc was downgraded to open_only and opened as a manual tab.
      const mploc = persisted.sites.find((site) => site.siteId === 'plant_mploc')
      assert.equal(mploc.execution, 'open_only')
      assert.equal(openedUrls.length, 2)
      assert.equal(persisted.status, 'partial')
    } finally {
      Module._load = originalLoad
      delete require.cache[require.resolve('../main.cjs')]
      if (originalRuns === undefined) delete process.env.BIOINFORMATICS_HUB_RUNS
      else process.env.BIOINFORMATICS_HUB_RUNS = originalRuns
      if (originalPython === undefined) delete process.env.BIOINFORMATICS_HUB_PYTHON
      else process.env.BIOINFORMATICS_HUB_PYTHON = originalPython
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('finalizes immediately when degraded and no manual sites are requested', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bioinformatics-hub-degraded-none-'))
    const runsRoot = path.join(root, 'runs')
    const handlers = new Map()
    let spawnCalled = false
    const mockElectron = {
      app: {
        isPackaged: false,
        getLocale: () => 'zh-CN',
        whenReady: () => new Promise(() => {}),
        on: () => undefined,
      },
      BrowserWindow: class BrowserWindow {
        static getAllWindows() {
          return []
        }
      },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: {},
      shell: { openExternal: async () => undefined, showItemInFolder: () => undefined },
      Menu: {},
      protocol: { registerSchemesAsPrivileged: () => undefined },
    }
    const originalRuns = process.env.BIOINFORMATICS_HUB_RUNS
    const originalPython = process.env.BIOINFORMATICS_HUB_PYTHON
    const originalLoad = Module._load
    process.env.BIOINFORMATICS_HUB_RUNS = runsRoot
    delete process.env.BIOINFORMATICS_HUB_PYTHON
    const mockChildProcess = {
      spawn: () => {
        spawnCalled = true
        throw new Error('runner must not be spawned in degraded mode')
      },
      spawnSync: () => ({ error: null, status: 0, stdout: '{"packages":{},"chromium":false}' }),
    }
    Module._load = function mockLoad(request, parent, isMain) {
      if (request === 'electron') return mockElectron
      if (request === 'child_process') return mockChildProcess
      return originalLoad.call(this, request, parent, isMain)
    }
    try {
      delete require.cache[require.resolve('../main.cjs')]
      require('../main.cjs')
      const started = await handlers.get('session:start')(null, {
        fastaText: '>geneF\nATGGCC\n',
        geneId: 'geneF',
        inputKind: 'cds',
        siteIds: [],
        localToolIds: ['nucleic'],
      })
      await new Promise((resolve) => setImmediate(resolve))
      const persisted = JSON.parse(
        fs.readFileSync(path.join(started.sessionDir, 'session.json'), 'utf8'),
      )
      assert.equal(spawnCalled, false)
      assert.equal(persisted.localTools[0].status, 'needs_setup')
      // No manual tabs and no runner: the session must finalize to partial
      // instead of staying stuck in "running".
      assert.equal(persisted.status, 'partial')
    } finally {
      Module._load = originalLoad
      delete require.cache[require.resolve('../main.cjs')]
      if (originalRuns === undefined) delete process.env.BIOINFORMATICS_HUB_RUNS
      else process.env.BIOINFORMATICS_HUB_RUNS = originalRuns
      if (originalPython === undefined) delete process.env.BIOINFORMATICS_HUB_PYTHON
      else process.env.BIOINFORMATICS_HUB_PYTHON = originalPython
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('exposes only the approved context-isolated renderer bridge', async () => {
    let exposed = null
    const invocations = []
    const listeners = new Map()
    const mockElectron = {
      contextBridge: {
        exposeInMainWorld: (name, value) => {
          exposed = { name, value }
        },
      },
      ipcRenderer: {
        invoke: async (channel, ...args) => {
          invocations.push({ channel, args })
          return { channel }
        },
        on: (channel, handler) => listeners.set(channel, handler),
        removeListener: (channel, handler) => {
          if (listeners.get(channel) === handler) listeners.delete(channel)
        },
      },
    }
    const originalLoad = Module._load
    Module._load = function mockLoad(request, parent, isMain) {
      if (request === 'electron') return mockElectron
      return originalLoad.call(this, request, parent, isMain)
    }
    try {
      delete require.cache[require.resolve('../preload.cjs')]
      require('../preload.cjs')
    } finally {
      Module._load = originalLoad
      delete require.cache[require.resolve('../preload.cjs')]
    }

    assert.equal(exposed.name, 'bioinformaticsHub')
    assert.deepEqual(
      Object.keys(exposed.value).sort(),
      [
        'engineStatus',
        'exportResearchBundle',
        'isDesktop',
        'listSessions',
        'loadSession',
        'onLog',
        'onSessionCancelled',
        'onSessionDone',
        'onSessionError',
        'onSessionUpdate',
        'openSite',
        'pickAlignment',
        'pickFasta',
        'revealArtifact',
        'saveSiteResult',
        'sessionCancel',
        'sessionStart',
        'setLocale',
      ],
    )
    await exposed.value.sessionStart({ geneId: 'G' })
    await exposed.value.openSite({ sessionId: 'G', siteId: 'blastp' })
    await exposed.value.revealArtifact({ sessionId: 'G', path: '01_local/result.png' })
    await exposed.value.exportResearchBundle('G')
    assert.deepEqual(
      invocations.map((item) => item.channel),
      ['session:start', 'site:open', 'artifact:reveal', 'fs:exportResearchBundle'],
    )

    const unsubscribe = exposed.value.onSessionUpdate(() => undefined)
    assert.equal(listeners.has('session:update'), true)
    unsubscribe()
    assert.equal(listeners.has('session:update'), false)
  })
})

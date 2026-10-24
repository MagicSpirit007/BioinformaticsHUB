'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

test('Windows browser commands deliver the exact URL without the Chromium raw-tail marker', { skip: process.platform !== 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biohub-browser-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const receiver = path.join(dir, 'argument receiver.cjs')
  fs.writeFileSync(receiver, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
  const psLiteral = value => "'" + value.replaceAll("'", "''") + "'"
  const target = pathToFileURL(path.join(dir, '中文 空格 & $ ; # 100% 引号".html')).href
  const cases = [
    ['--single-argument %1', [target]], // Actual MSEdgeHTM registration.
    ['--single-argument "%1"', [target]],
    ['--profile-directory="Profile 1" --single-argument %1', ['--profile-directory=Profile 1', target]],
    ['-- "%1"', ['--', target]],
    ['-osint -url "%L"', ['-osint', '-url', target]],
    ['--new-window', ['--new-window', target]],
  ]
  const script = path.join(dir, 'check.ps1')
  fs.writeFileSync(script, '\ufeff' + [
    "$ErrorActionPreference = 'Stop'",
    '. ' + psLiteral(path.resolve(__dirname, '../workflow/open-browser.ps1')),
    ...cases.flatMap(([tail]) => [
      '$info = New-BrowserStartInfo -RegisteredCommand ' + psLiteral(`"${process.execPath}" "${receiver}" ${tail}`) + ' -Target ' + psLiteral(target),
      // Assert the actual serialized command, not just an in-memory argv list.
      "if ($info.Arguments.Contains('--single-argument')) { throw 'Raw-tail browser marker was retained' }",
      '$info.RedirectStandardOutput = $true',
      '$process = [System.Diagnostics.Process]::Start($info)',
      '$output = $process.StandardOutput.ReadToEnd(); $process.WaitForExit()',
      "if ($process.ExitCode -ne 0) { throw 'Argument receiver failed' }",
      'Write-Output $output',
    ]),
  ].join('\r\n'))
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  assert.deepEqual(output.trim().split(/\r?\n/).map(line => JSON.parse(line)), cases.map(([, expected]) => expected))
})

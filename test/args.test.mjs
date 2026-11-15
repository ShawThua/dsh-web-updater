// Regression tests for the 2026-11-14 21:15 failure: the installer script never
// started because `Start-Process -ArgumentList @(...)` joins without quoting and
// "D:\Program Files (x86)\DeepSeekHarness" arrived as two arguments.
//
// The PowerShell side (bin/dsh_update.ps1 `Join-Args`) mirrors this behavior;
// `-RestartOnly -WhatIfOnly` prints the real command line for a manual check.
import { test, done, assert } from './helpers.mjs'
import { quoteArg, buildArgString, buildStartProcessCommand } from '../lib/args.js'

const INSTALL_DIR = 'D:\\Program Files (x86)\\DeepSeekHarness'
const STATE = 'C:\\Users\\LEGION\\.dsh\\storages\\dsh-web-updater'

test('arguments without spaces are passed through', () => {
  assert.equal(quoteArg('-Install'), '-Install')
  assert.equal(quoteArg('7979'), '7979')
})

test('arguments with spaces are quoted', () => {
  assert.equal(quoteArg(INSTALL_DIR), `"${INSTALL_DIR}"`)
  assert.equal(quoteArg('C:\\My Data\\relaunch.json'), '"C:\\My Data\\relaunch.json"')
})

test('embedded quotes are doubled instead of terminating the argument', () => {
  assert.equal(quoteArg('a"b'), '"a""b"')
})

test('non-string arguments are stringified, not dropped', () => {
  assert.equal(quoteArg(0), '0')
  assert.equal(quoteArg(false), 'false')
})

test('the installer command quotes the install directory (the 21:15 bug)', () => {
  const args = ['-Install', '-InstallerPath', `${STATE}\\installers\\x.exe`, '-InstallDir', INSTALL_DIR]
  const line = buildArgString(args)
  assert.ok(line.includes(`-InstallDir "${INSTALL_DIR}"`), line)
  assert.ok(!line.includes(`-InstallDir ${INSTALL_DIR}`), 'install directory must not be split')
})

test('the relaunch path with spaces stays one argument', () => {
  const spec = 'C:\\Users\\Legion User\\.dsh\\storages\\dsh-web-updater\\relaunch.json'
  const line = buildArgString(['-RestartOnly', '-RelaunchJson', spec])
  assert.equal(line, `-RestartOnly -RelaunchJson "${spec}"`)
})

test('the wrapper keeps the child hidden and passes one pre-quoted string', () => {
  const command = buildStartProcessCommand('powershell.exe', ['-NoProfile', '-File', `${INSTALL_DIR}\\a b.ps1`])
  assert.ok(command.startsWith("Start-Process -FilePath 'powershell.exe' -ArgumentList '"), command)
  assert.ok(command.includes(`-File "${INSTALL_DIR}\\a b.ps1"`), command)
  assert.ok(command.endsWith("' -WindowStyle Hidden"), command)
})

test('single quotes in paths cannot escape the outer PowerShell string', () => {
  const command = buildStartProcessCommand('powershell.exe', ['-LogPath', "C:\\it's here\\log.txt"])
  assert.ok(command.includes("C:\\it''s here\\log.txt"), command)
})

done('args')

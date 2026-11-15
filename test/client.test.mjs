// Client-half tests. lib/client.js is a browser module (it registers itself into
// window.__ModuleLoader__ and takes React from the module table), so the test
// installs both stubs and imports it for the exported __test hooks. No DOM is
// needed: the copy functions and dictionaries are pure.
import { test, done, assert } from './helpers.mjs'

let mod

globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, 'dsh-web-updater')
      mod = { exports: {} }
      const exports = factory((name) => {
        if (name !== 'react') throw new Error(`unexpected module request: ${name}`)
        return {}
      })
      Object.assign(mod.exports, exports)
    },
  },
}

await import('../lib/client.js')

const { humanPhase, failureText, interpolate, EN, ZH, NS } = mod.exports.__test

const zhT = (key, vars) => interpolate(ZH[key] || key, vars)
const enT = (key, vars) => interpolate(EN[key] || key, vars)

test('registers under one namespace with the English and Chinese baselines', () => {
  assert.equal(NS, 'dsh-web-updater')
  assert.equal(typeof EN, 'object')
  assert.equal(typeof ZH, 'object')
})

test('every key exists in both locales (no missing translation fallbacks)', () => {
  const en = Object.keys(EN).sort()
  const zh = Object.keys(ZH).sort()
  assert.deepEqual(zh, en)
  for (const key of en) {
    assert.ok(String(EN[key]).trim().length > 0, key)
    assert.ok(String(ZH[key]).trim().length > 0, key)
  }
})

test('placeholders are identical between locales', () => {
  const names = (text) => (String(text).match(/\{(\w+)\}/g) || []).sort()
  for (const key of Object.keys(EN)) assert.deepEqual(names(ZH[key]), names(EN[key]), key)
})

test('interpolate fills named placeholders and keeps unknown ones', () => {
  assert.equal(interpolate('a {b} c', { b: 1 }), 'a 1 c')
  assert.equal(interpolate('a {b} c'), 'a {b} c')
  assert.equal(interpolate('{x}{y}', { x: 0, y: false }), '0false')
})

test('available update shows both versions', () => {
  const info = humanPhase({ phase: 'available', current: '0.2.2-rc.1', latest: '0.2.2-rc.3' }, 'ok', enT)
  assert.equal(info.title, 'Version 0.2.2-rc.3 is available')
  assert.equal(info.detail, 'Installed 0.2.2-rc.1 → available 0.2.2-rc.3')
})

test('available update includes the release date when known', () => {
  const info = humanPhase({
    phase: 'available', current: '0.2.2-rc.1', latest: '0.2.2-rc.3', releaseDate: '2026-11-13T07:31:42.937Z',
  }, 'ok', zhT)
  assert.equal(info.detail, '当前版本 0.2.2-rc.1 → 可用 0.2.2-rc.3（发布于 2026-11-13）')
})

test('download progress is rendered as a percentage', () => {
  assert.equal(humanPhase({ phase: 'downloading', percent: 42 }, 'ok', enT).title, 'Downloading the installer (42%)')
  assert.equal(humanPhase({ phase: 'downloading' }, 'ok', zhT).title, '正在下载安装包 0%')
})

test('an unreachable host is reported in both locales', () => {
  assert.equal(humanPhase(null, 'error', enT).title, 'Update status unavailable')
  assert.equal(humanPhase(null, 'error', zhT).title, '更新状态不可用')
  assert.equal(humanPhase(null, 'connecting', enT).title, 'Reading the installed version…')
})

test('failure reasons map to their own messages', () => {
  assert.equal(failureText({ failure: 'check-network' }, zhT), ZH['failure.checkNetwork'])
  assert.equal(failureText({ failure: 'install', error: 'sha512 mismatch' }, enT),
    'Installation failed; the previous version was restarted. (sha512 mismatch)')
  assert.equal(failureText({}, enT), EN['failure.generic'])
})

test('idle state never shows an undefined version', () => {
  assert.equal(humanPhase({ phase: 'idle' }, 'ok', enT).title, 'Version —')
  assert.equal(humanPhase({ phase: 'idle', latest: '0.2.2-rc.3' }, 'ok', zhT).detail, '最近检查到 0.2.2-rc.3')
})

done('client')

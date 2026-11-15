// dsh-web-updater — Host half.
//
// Responsibilities:
//   * read the installed DSH version (app.asar/dsh/package.json) and the update
//     feed configuration (resources/app-update.yml)
//   * fetch <feedUrl><channel>.yml, compare versions, expose state over HTTP
//   * download + sha512-verify the installer when needed
//   * hand installation to a detached PowerShell script, because the host must
//     exit before the installer can replace its own executable
//
// The client half (lib/client.js) renders status in Settings → General and a
// badge on the collapsed sidebar toggle. All routes live under /dsh-update.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync, copyFileSync } from 'node:fs'
import { once } from 'node:events'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStartProcessCommand } from './args.js'

export const name = 'dsh-web-updater'
export const inject = ['webServer', 'connection']

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'bin', 'dsh_update.ps1')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'storages', 'dsh-web-updater')
const STATE_FILE = join(STATE_DIR, 'state.json')
const INSTALLERS = join(STATE_DIR, 'installers')
const RESULT_FILE = join(STATE_DIR, 'last-install.json')
const RELAUNCH_FILE = join(STATE_DIR, 'relaunch.json')
const LOG_FILE = join(STATE_DIR, 'updater.log')
// Filled in by apply(); the installer script needs the real port to wait for.
let runtimePort = 0
const AUTO_CHECK_DELAY_MS = 120_000
const AUTO_CHECK_EVERY_MS = 6 * 60 * 60 * 1000

// ---------------------------------------------------------------- utilities

function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }) } catch { /* best effort */ }
}

function log(line) {
  try {
    ensureDir(STATE_DIR)
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 1_000_000) writeFileSync(LOG_FILE, '')
    writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, { flag: 'a' })
  } catch { /* logging must never break the update path */ }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

function writeJson(file, value) {
  try {
    ensureDir(dirname(file))
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2))
    renameSync(tmp, file)
  } catch (error) { log(`write ${file} failed: ${error.message}`) }
}

function argvValue(argv, flag) {
  const index = argv.indexOf(flag)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
}

/**
 * Describe how this host was started so a detached script can start it again
 * after the installer replaced the executable. Replaying `execPath + argv` is
 * what makes the updater machine-independent: no launcher script, no fixed
 * install directory, no guessed port.
 */
function buildRelaunchSpec() {
  const argv = process.argv.slice(1)
  return {
    schema: 1,
    writtenAt: new Date().toISOString(),
    pid: process.pid,
    exe: process.execPath,
    argv,
    cwd: process.cwd(),
    // dsh.cmd sets this before handing control to Electron; without it the
    // replay would open the desktop GUI instead of the web host.
    // DSH_HOME must survive the replay too: a host started against a custom
    // home (isolated test host, second data dir) would otherwise come back up
    // on ~/.dsh and start writing the real storage.
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      ...(process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {}),
    },
    publicUrl: argvValue(argv, '--public-url'),
    port: runtimePort || Number(argvValue(argv, '--port')) || undefined,
    installDir: install.installDir,
  }
}

function writeRelaunchSpec() {
  const spec = buildRelaunchSpec()
  writeJson(RELAUNCH_FILE, spec)
  return spec
}

/** Compare two semver-ish versions (including -rc.N suffixes). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim())
    if (!m) return undefined
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
  }
  const pa = parse(a); const pb = parse(b)
  if (!pa || !pb) return String(a) === String(b) ? 0 : String(a) > String(b) ? 1 : -1
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0
  if (pa.pre.length === 0) return 1
  if (pb.pre.length === 0) return -1
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i]; const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x); const ny = /^\d+$/.test(y)
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1; continue }
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** Parse the small subset of the electron-updater feed we need. */
export function parseFeed(text) {
  const version = (text.match(/^version:\s*(\S+)\s*$/m) || [])[1]
  const releaseDate = (text.match(/^releaseDate:\s*'?([^'\r\n]+)'?\s*$/m) || [])[1]
  const url = (text.match(/https:\/\/\S+?\.exe/g) || [])[0]
  // `size` lives under `files:` in the real feed, so it is indented.
  const size = Number((text.match(/^\s*size:\s*(\d+)\s*$/m) || [])[1] || 0)
  const sha512 = (text.match(/sha512:\s*(?:>-?[^\S\r\n]*\r?\n\s*)?([A-Za-z0-9+/=]{40,})/) || [])[1]
  if (!version || !url) return undefined
  return { version, releaseDate, url, size, sha512 }
}

function readInstallInfo() {
  const installDir = dirname(process.execPath)
  let version
  for (const candidate of [
    join(installDir, 'resources', 'app.asar', 'dsh', 'package.json'),
    join(installDir, 'resources', 'app.asar.unpacked', 'dsh', 'package.json'),
  ]) {
    try { version = JSON.parse(readFileSync(candidate, 'utf8')).version } catch { /* try next */ }
    if (version) break
  }
  let feedBase = 'https://download.deepseek.com/dsh-desk/feeds/win-x64/'
  let channel = 'nightly'
  let updaterCacheDirName = '@deepseek-aidsh-desktop-updater'
  try {
    const yml = readFileSync(join(installDir, 'resources', 'app-update.yml'), 'utf8')
    feedBase = ((yml.match(/^url:\s*(\S+)\s*$/m) || [])[1] || feedBase).replace(/\/?$/, '/')
    channel = (yml.match(/^channel:\s*(\S+)\s*$/m) || [])[1] || channel
    updaterCacheDirName = (yml.match(/^updaterCacheDirName:\s*'?([^'\r\n]+)'?\s*$/m) || [])[1] || updaterCacheDirName
  } catch { /* keep defaults */ }
  return { installDir, version, feedBase, channel, updaterCacheDirName }
}

async function sha512OfFile(file) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

// ------------------------------------------------------------------- state

const install = readInstallInfo()
const state = {
  phase: 'idle',
  current: install.version ?? '(unknown)',
  channel: install.channel,
  feedUrl: install.feedBase + install.channel + '.yml',
  latest: undefined,
  releaseDate: undefined,
  asset: undefined,
  percent: 0,
  failure: undefined,
  error: undefined,
  checkedAt: undefined,
  installer: undefined,
  dismissed: undefined,
  autoCheck: true,
}

const persisted = readJson(STATE_FILE)
if (persisted) {
  state.latest = persisted.latest
  state.releaseDate = persisted.releaseDate
  state.checkedAt = persisted.checkedAt
  state.dismissed = persisted.dismissed
  state.installer = persisted.installer
}

const lastInstall = readJson(RESULT_FILE)
if (lastInstall) {
  state.lastInstall = lastInstall
  if (lastInstall.ok === false && lastInstall.finishedAt && Date.now() - Date.parse(lastInstall.finishedAt) < 30 * 60_000) {
    state.phase = 'error'
    state.failure = lastInstall.failure || 'install'
    state.error = lastInstall.error
  }
}
if (state.phase === 'idle' && state.latest) {
  state.phase = compareVersions(state.latest, state.current) > 0 ? 'available' : 'up-to-date'
}

function persist() {
  writeJson(STATE_FILE, {
    latest: state.latest,
    releaseDate: state.releaseDate,
    checkedAt: state.checkedAt,
    dismissed: state.dismissed,
    installer: state.installer,
  })
}

function snapshot() {
  const newer = state.latest ? compareVersions(state.latest, state.current) > 0 : false
  return {
    phase: state.phase,
    current: state.current,
    latest: state.latest,
    releaseDate: state.releaseDate,
    channel: state.channel,
    feedUrl: state.feedUrl,
    newer,
    dismissed: Boolean(state.latest) && state.dismissed === state.latest,
    percent: state.percent,
    failure: state.failure,
    error: state.error,
    checkedAt: state.checkedAt,
    installer: state.installer ? { path: state.installer.path, size: state.installer.size, verified: state.installer.verified } : undefined,
    lastInstall: state.lastInstall,
    serverTime: Date.now(),
  }
}

// -------------------------------------------------------------------- SSE

const subscribers = new Set()

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`
  for (const res of subscribers) {
    try { res.write(payload) } catch { subscribers.delete(res) }
  }
}

function setPhase(phase, extra = {}) {
  state.phase = phase
  Object.assign(state, extra)
  broadcast()
}

// ------------------------------------------------------------------ checks

async function fetchFeed() {
  const response = await fetch(state.feedUrl, {
    headers: { 'user-agent': `dsh-web-updater/0.1 dsh/${state.current}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`feed HTTP ${response.status}`)
  return parseFeed(await response.text())
}

async function checkNow({ auto = false } = {}) {
  if (state.phase === 'downloading' || state.phase === 'installing' || state.phase === 'verifying') return snapshot()
  setPhase('checking', { failure: undefined, error: undefined })
  try {
    const feed = await fetchFeed()
    if (!feed) throw new Error('feed has no version/url')
    state.latest = feed.version
    state.releaseDate = feed.releaseDate
    state.asset = { url: feed.url, size: feed.size, sha512: feed.sha512 }
    state.checkedAt = new Date().toISOString()
    const newer = compareVersions(feed.version, state.current) > 0
    persist()
    setPhase(newer ? 'available' : 'up-to-date', { percent: 0 })
    log(`check ok: current=${state.current} latest=${feed.version} newer=${newer}${auto ? ' (auto)' : ''}`)
  } catch (error) {
    const network = /fetch failed|HTTP|timeout|ENOTFOUND|ECONN|EAI_AGAIN|abort/i.test(String(error && error.message))
    setPhase('error', { failure: network ? 'check-network' : 'check', error: String(error && error.message) })
    log(`check failed: ${error && error.message}`)
  }
  return snapshot()
}

// ---------------------------------------------------------------- download

function candidateCachePaths(version) {
  const file = `deepseek-harness-${version}-win-x64.exe`
  const list = [join(INSTALLERS, file)]
  if (process.env.LOCALAPPDATA) list.push(join(process.env.LOCALAPPDATA, install.updaterCacheDirName, 'pending', file))
  return list
}

async function ensureInstaller() {
  if (!state.asset) throw Object.assign(new Error('no update metadata; run a check first'), { failure: 'check' })
  const { url, size, sha512 } = state.asset
  const dest = join(INSTALLERS, `deepseek-harness-${state.latest}-win-x64.exe`)
  ensureDir(INSTALLERS)

  const verify = async (file) => {
    if (!sha512) return true // feed without checksum: accept size match only
    setPhase('verifying', { percent: state.percent })
    const actual = await sha512OfFile(file)
    return actual === sha512
  }

  for (const file of candidateCachePaths(state.latest)) {
    if (!existsSync(file)) continue
    try {
      const info = statSync(file)
      if (size && info.size !== size) continue
      if (await verify(file)) {
        if (file !== dest) copyFileSync(file, dest)
        state.installer = { path: dest, size: info.size, verified: true, version: state.latest }
        persist()
        setPhase('available', { percent: 0 })
        log(`reused installer ${file}`)
        return state.installer
      }
      log(`cached installer failed checksum: ${file}`)
    } catch (error) { log(`cache probe failed for ${file}: ${error.message}`) }
  }

  setPhase('downloading', { percent: 0 })
  log(`downloading ${url} -> ${dest}`)
  const part = `${dest}.part`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) })
    if (!response.ok || !response.body) throw new Error(`download HTTP ${response.status}`)
    const hash = createHash('sha512')
    let received = 0
    let lastBroadcast = 0
    const out = createWriteStream(part)
    try {
      for await (const chunk of response.body) {
        hash.update(chunk)
        received += chunk.length
        const total = size || Number(response.headers.get('content-length')) || 0
        state.percent = total ? Math.min(99, Math.floor((received / total) * 100)) : 0
        const now = Date.now()
        if (now - lastBroadcast > 400) { lastBroadcast = now; broadcast() }
        if (!out.write(chunk)) await once(out, 'drain')
      }
      await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
    } catch (error) {
      out.destroy()
      throw error
    }
    const digest = hash.digest('base64')
    if (sha512 && digest !== sha512) throw Object.assign(new Error('sha512 mismatch'), { failure: 'download' })
    renameSync(part, dest)
    const info = statSync(dest)
    state.installer = { path: dest, size: info.size, verified: Boolean(sha512), version: state.latest }
    persist()
    setPhase('available', { percent: 100 })
    log(`download ok: ${dest} (${info.size} bytes)`)
    return state.installer
  } catch (error) {
    try { if (existsSync(part)) unlinkSync(part) } catch { /* ignore */ }
    const network = /fetch failed|HTTP|timeout|ENOTFOUND|ECONN|EAI_AGAIN|abort/i.test(String(error && error.message))
    setPhase('error', { failure: error.failure || (network ? 'download-network' : 'download'), error: String(error && error.message) })
    log(`download failed: ${error && error.message}`)
    throw error
  }
}

// ----------------------------------------------------------------- install

function isLoopback(req) {
  const address = (req.socket && req.socket.remoteAddress) || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function spawnInstaller(installerPath) {
  if (!existsSync(SCRIPT)) throw Object.assign(new Error(`updater script missing: ${SCRIPT}`), { failure: 'install' })
  ensureDir(STATE_DIR)
  const relaunch = writeRelaunchSpec()
  const marker = join(STATE_DIR, 'install.started')
  try { if (existsSync(marker)) unlinkSync(marker) } catch { /* ignore */ }
  const scriptArgs = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    '-Install',
    '-InstallerPath', installerPath,
    '-ExpectedVersion', state.latest,
    '-CurrentVersion', state.current,
    '-WaitPid', String(process.pid),
    '-InstallDir', install.installDir,
    '-Port', String(runtimePort || 7979),
    '-ResultPath', RESULT_FILE,
    '-LogPath', join(STATE_DIR, 'install.log'),
    '-StartedMarker', marker,
    // Primary restart path: replay exe + argv (portable across machines).
    '-RelaunchJson', RELAUNCH_FILE,
    // Legacy fallback for hosts that have a custom launcher on this machine.
    '-LauncherVbs', join(process.env.LOCALAPPDATA || '', 'DSH', 'start-dsh-web.vbs'),
    '-PortalVbs', join(process.env.LOCALAPPDATA || '', 'DSH', 'portal-server.vbs'),
  ]
  log(`relaunch spec: exe=${relaunch.exe} argv=${JSON.stringify(relaunch.argv)}`)
  if (process.env.DSH_WEB_UPDATER_DRYRUN === '1') scriptArgs.push('-WhatIfOnly')
  // Node's `detached: true` produces a child that exits without running on this
  // machine, so ask PowerShell itself to start the installer in a new process.
  // `-ArgumentList @(...)` joins without quoting, which breaks on paths with
  // spaces ("D:\Program Files (x86)\..."), so pass one pre-quoted string
  // (lib/args.js owns that shape; test/args.test.mjs pins it).
  const wrapper = buildStartProcessCommand('powershell.exe', scriptArgs)
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrapper], {
    windowsHide: true,
    stdio: 'ignore',
  })
  child.unref()
  log(`spawned installer wrapper pid=${child.pid} installer=${installerPath}`)
  // If the script never starts (security software, execution policy, a broken
  // PATH), the host would otherwise sit in "installing" forever. Confirm the
  // hand-off by waiting for the marker file the script writes on entry.
  const spawnedAt = Date.now()
  const timer = setTimeout(() => {
    if (state.phase !== 'installing') return
    let confirmed = false
    try { confirmed = existsSync(marker) && statSync(marker).mtimeMs >= spawnedAt - 3000 } catch { /* ignore */ }
    if (!confirmed) {
      setPhase('error', { failure: 'install', error: '安装脚本没有启动成功（可能被安全软件或权限拦截），宿主仍在运行，可稍后重试' })
      log('installer handoff not confirmed: marker missing')
    }
  }, 25_000)
  if (timer.unref) timer.unref()
  return child.pid
}

async function installNow({ force = false } = {}) {
  if (state.phase === 'installing') return snapshot()
  if (!force && state.latest && compareVersions(state.latest, state.current) <= 0) {
    setPhase('up-to-date', { percent: 0 })
    return snapshot()
  }
  if (!state.asset) await checkNow()
  try {
    const installer = await ensureInstaller()
    const pid = spawnInstaller(installer.path)
    writeJson(join(STATE_DIR, 'handoff.json'), {
      at: new Date().toISOString(),
      hostPid: process.pid,
      installerPid: pid,
      from: state.current,
      to: state.latest,
      installer: installer.path,
    })
    setPhase('installing', { percent: 100, error: undefined })
  } catch (error) {
    setPhase('error', { failure: error.failure || 'install', error: String(error && error.message) })
    log(`install handoff failed: ${error && error.message}`)
  }
  return snapshot()
}

// ------------------------------------------------------------------ routes

function sendJson(res, body, status = 200) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

export function apply(ctx) {
  ensureDir(STATE_DIR)

  try {
    const webServer = ctx.get('webServer')
    if (webServer && webServer.port) runtimePort = Number(webServer.port)
  } catch { /* keep the argv/default port */ }
  const relaunch = writeRelaunchSpec()
  log(`relaunch.json written: exe=${relaunch.exe} publicUrl=${relaunch.publicUrl || '(none)'} port=${relaunch.port || '(none)'} argv=${JSON.stringify(relaunch.argv)}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-update',
    handler: async (req, res) => {
      let url
      try { url = new URL(req.url || '/', 'http://x') } catch { url = undefined }
      if (!url) return sendJson(res, { ok: false, error: 'bad url' }, 400)

      if (url.pathname === '/dsh-update/ping') return sendJson(res, { ok: true })

      if (url.pathname === '/dsh-update/status' && req.method === 'GET') {
        return sendJson(res, { ok: true, state: snapshot() })
      }

      if (url.pathname === '/dsh-update/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
        subscribers.add(res)
        const beat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, 20_000)
        res.on('close', () => { clearInterval(beat); subscribers.delete(res) })
        return
      }

      if (url.pathname === '/dsh-update/check' && req.method === 'POST') {
        if (!isLoopback(req)) return sendJson(res, { ok: false, error: 'remote browsers cannot trigger update checks' }, 403)
        return sendJson(res, { ok: true, state: await checkNow() })
      }

      if (url.pathname === '/dsh-update/install' && req.method === 'POST') {
        if (!isLoopback(req)) return sendJson(res, { ok: false, error: '升级只能在电脑本机操作（手机端仅可查看）' }, 403)
        const body = await readBody(req)
        if (body.confirm !== true) return sendJson(res, { ok: false, error: 'confirm required' }, 400)
        return sendJson(res, { ok: true, state: await installNow({ force: body.force === true }) })
      }

      if (url.pathname === '/dsh-update/skip' && req.method === 'POST') {
        if (!isLoopback(req)) return sendJson(res, { ok: false, error: 'forbidden' }, 403)
        state.dismissed = state.latest
        persist()
        broadcast()
        return sendJson(res, { ok: true, state: snapshot() })
      }

      if (url.pathname === '/dsh-update/download' && req.method === 'POST') {
        if (!isLoopback(req)) return sendJson(res, { ok: false, error: 'forbidden' }, 403)
        try {
          const installer = await ensureInstaller()
          return sendJson(res, { ok: true, state: snapshot(), installer })
        } catch (error) {
          return sendJson(res, { ok: false, error: String(error && error.message), state: snapshot() }, 500)
        }
      }

      if (url.pathname === '/dsh-update/web-url' && req.method === 'GET') {
        if (!isLoopback(req)) return sendJson(res, { ok: false, error: '只在本机读取链接' }, 403)
        try {
          const webServer = ctx.get('webServer')
          const connection = ctx.get('connection')
          const localUrl = connection.authenticatedUrl(`${webServer.protocol}//127.0.0.1:${String(webServer.port)}`)
          const token = new URL(localUrl).searchParams.get('token')
          // Public origin: the host's own --public-url wins (authoritative for
          // reverse proxies / Tailscale). Otherwise fall back to the Host header
          // of this request, which is what the browser actually used.
          const relaunch = readJson(RELAUNCH_FILE) || {}
          let origin = relaunch.publicUrl ? String(relaunch.publicUrl) : ''
          if (!origin && req.headers.host) {
            const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
              ((req.socket && req.socket.encrypted) ? 'https' : 'http')
            origin = `${proto}://${req.headers.host}`
          }
          let phoneUrl
          if (origin) {
            try { phoneUrl = `${new URL(origin).origin}/?token=${encodeURIComponent(token)}` } catch { /* keep local only */ }
          }
          return sendJson(res, { ok: true, localUrl, phoneUrl })
        } catch (error) {
          return sendJson(res, { ok: false, error: String(error && error.message) }, 500)
        }
      }

      if (url.pathname === '/dsh-update/preflight' && req.method === 'POST') {
        if (!isLoopback(req)) return sendJson(res, { ok: false, error: 'forbidden' }, 403)
        // Drives the real installer script in -WhatIfOnly mode: proves the whole
        // spawn → parameter-binding → marker handshake without stopping the host.
        const preLog = join(STATE_DIR, 'preflight.log')
        const preResult = join(STATE_DIR, 'preflight-result.json')
        const preMarker = join(STATE_DIR, 'preflight.started')
        for (const file of [preLog, preMarker, preResult]) { try { if (existsSync(file)) unlinkSync(file) } catch { /* ignore */ } }
        const preArgs = [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
          '-Install',
          '-InstallerPath', SCRIPT,
          '-ExpectedVersion', 'preflight',
          '-CurrentVersion', state.current,
          '-WaitPid', '0',
          '-InstallDir', install.installDir,
          '-Port', String(runtimePort || 7979),
          '-ResultPath', preResult,
          '-LogPath', preLog,
          '-StartedMarker', preMarker,
          '-RelaunchJson', RELAUNCH_FILE,
          '-LauncherVbs', join(process.env.LOCALAPPDATA || '', 'DSH', 'start-dsh-web.vbs'),
          '-PortalVbs', join(process.env.LOCALAPPDATA || '', 'DSH', 'portal-server.vbs'),
          '-WhatIfOnly',
        ]
        const wrapper = buildStartProcessCommand('powershell.exe', preArgs)
        try {
          const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrapper], { windowsHide: true, stdio: 'ignore' })
          child.unref()
          await new Promise((resolve) => setTimeout(resolve, 9000))
          const started = existsSync(preMarker)
          const tail = existsSync(preLog) ? readFileSync(preLog, 'utf8').split(/\r?\n/).filter(Boolean).slice(-4) : []
          log(`preflight: started=${started} wrapperPid=${child.pid}`)
          return sendJson(res, { ok: started, started, wrapperPid: child.pid, logTail: tail })
        } catch (error) {
          return sendJson(res, { ok: false, error: String(error && error.message) }, 500)
        }
      }

      if (url.pathname === '/dsh-update/selftest' && req.method === 'POST') {
        if (!isLoopback(req)) return sendJson(res, { ok: false, error: 'forbidden' }, 403)
        // Prove the host can start a detached PowerShell child at all. Used once
        // during rollout; harmless afterwards (writes one small marker file).
        const marker = join(STATE_DIR, 'selftest.txt')
        try { if (existsSync(marker)) unlinkSync(marker) } catch { /* ignore */ }
        const target = marker.replace(/'/g, "''")
        const wrapper = `Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c','echo ok>${target}') -WindowStyle Hidden`
        try {
          const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrapper], { windowsHide: true, stdio: 'ignore' })
          child.unref()
          await new Promise((resolve) => setTimeout(resolve, 5000))
          return sendJson(res, { ok: existsSync(marker), childPid: child.pid, marker })
        } catch (error) {
          return sendJson(res, { ok: false, error: String(error && error.message) }, 500)
        }
      }

      return sendJson(res, { ok: false, error: 'not found' }, 404)
    },
  }), 'dsh-web-updater: routes')

  if (process.env.DSH_WEB_UPDATER_NO_AUTO !== '1') {
    const first = setTimeout(() => { checkNow({ auto: true }).catch(() => {}) }, AUTO_CHECK_DELAY_MS)
    const repeat = setInterval(() => { checkNow({ auto: true }).catch(() => {}) }, AUTO_CHECK_EVERY_MS)
    if (first.unref) first.unref()
    if (repeat.unref) repeat.unref()
    ctx.effect(() => () => { clearTimeout(first); clearInterval(repeat) }, 'dsh-web-updater: auto check')
  }

  log(`plugin ready: current=${state.current} feed=${state.feedUrl} installDir=${install.installDir}`)
}

export default { name, inject, apply }

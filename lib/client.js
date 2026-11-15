// dsh-web-updater — Client half.
//
// Renders:
//   * a row in Settings → General (slot `settings.general.item`): current
//     version, check button, found-version banner, progress, two-step confirm
//   * a small dot on the collapsed sidebar toggle (slot `sidebar.toggle.badge`)
//     when an update is available / installing / failed
//
// Data comes from the host half over /dsh-update (SSE + JSON), never from a
// build constant, so the web page and the host always agree.
//
// All visible copy goes through the Client locale service under the namespace
// `dsh-web-updater` (dictionaries below, English + Chinese baseline). The
// `locale` slot option injects `t` into the row; the local fallback keeps the
// row readable if the locale service is unavailable.
window.__ModuleLoader__.load({
  id: 'dsh-web-updater',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const NS = 'dsh-web-updater'

    const EN = {
      'row.title': 'Update',
      'status.unavailable.title': 'Update status unavailable',
      'status.unavailable.detail': 'The host did not answer /dsh-update; the plugin may be disabled.',
      'status.loading.title': 'Reading the installed version…',
      'status.checking.title': 'Checking for updates…',
      'status.checking.detail': 'Current version {version}',
      'status.upToDate.title': 'Up to date',
      'status.upToDate.detail': 'Version {version} on the {channel} channel',
      'status.available.title': 'Version {version} is available',
      'status.available.detail': 'Installed {current} → available {version}',
      'status.available.detailDate': 'Installed {current} → available {version} (released {date})',
      'status.downloading.title': 'Downloading the installer ({percent}%)',
      'status.downloading.detail': 'Keep this page open until the download finishes',
      'status.verifying.title': 'Verifying the installer…',
      'status.verifying.detail': 'Checking the sha512 digest',
      'status.installing.title': 'Installing {version}…',
      'status.installing.detail': 'The host restarts now; this page reconnects in one to two minutes. Reload it then.',
      'status.error.title': 'Update failed',
      'status.idle.title': 'Version {version}',
      'status.idle.detailNever': 'Not checked yet',
      'status.idle.detailLatest': 'Last seen {version}',
      'ready.verified': 'The installer is downloaded and passed the sha512 check; it can be installed offline.',
      'confirm.warning': 'Updating restarts the host, so this page and the phone link disconnect for one to two minutes. Restarting also discards drafts that were not sent — send or copy them first.',
      'lastInstall.failed': 'The last update did not succeed: {reason}',
      'link.copied': 'Phone / other device link (copied):',
      'link.ready': 'Phone / other device link:',
      'link.error': 'Could not read the link: {error}',
      'failure.check': 'Checking for updates failed. Try again later.',
      'failure.checkNetwork': 'Checking for updates failed: the download server is unreachable. Check the network.',
      'failure.download': 'Downloading the installer failed. Try again.',
      'failure.downloadNetwork': 'Downloading the installer failed: the connection dropped.',
      'failure.install': 'Installation failed; the previous version was restarted.',
      'failure.generic': 'The update failed. Try again.',
      'failure.withReason': '{message} ({error})',
      'actions.confirm': 'Update and restart',
      'actions.cancel': 'Cancel',
      'actions.install': 'Install {version}',
      'actions.skip': 'Skip',
      'actions.check': 'Check for updates',
      'actions.checking': 'Checking…',
      'actions.phoneLink': 'Phone link',
      'actions.phoneLinkCopied': 'Copied',
      'actions.phoneLinkLoading': 'Reading…',
      'actions.phoneLinkTitle': 'Copy the phone link carrying the current token (the token changes on every host restart)',
    }

    const ZH = {
      'row.title': '更新',
      'status.unavailable.title': '更新状态不可用',
      'status.unavailable.detail': '宿主没有响应 /dsh-update 接口（插件可能未启用）。',
      'status.loading.title': '正在读取版本…',
      'status.checking.title': '正在检查更新…',
      'status.checking.detail': '当前版本 {version}',
      'status.upToDate.title': '已是最新版本',
      'status.upToDate.detail': '当前版本 {version}（渠道 {channel}）',
      'status.available.title': '发现新版本 {version}',
      'status.available.detail': '当前版本 {current} → 可用 {version}',
      'status.available.detailDate': '当前版本 {current} → 可用 {version}（发布于 {date}）',
      'status.downloading.title': '正在下载安装包 {percent}%',
      'status.downloading.detail': '下载期间请保持页面打开',
      'status.verifying.title': '正在校验安装包…',
      'status.verifying.detail': 'sha512 校验中',
      'status.installing.title': '正在安装 {version}…',
      'status.installing.detail': '宿主即将重启，页面会在 1–2 分钟后自动恢复，届时刷新即可。',
      'status.error.title': '更新失败',
      'status.idle.title': '当前版本 {version}',
      'status.idle.detailNever': '尚未检查过更新',
      'status.idle.detailLatest': '最近检查到 {version}',
      'ready.verified': '安装包已下载并通过 sha512 校验，可离线安装。',
      'confirm.warning': '更新会重启宿主，页面与手机端将断开约 1–2 分钟；重启会清空输入框里未发送的草稿——请先把草稿发出去或复制出来。',
      'lastInstall.failed': '上次更新未成功：{reason}',
      'link.copied': '手机/其它设备链接（已复制）：',
      'link.ready': '手机/其它设备链接：',
      'link.error': '读取链接失败：{error}',
      'failure.check': '检查更新失败，请稍后重试。',
      'failure.checkNetwork': '检查更新失败：连不上下载服务器，请检查网络。',
      'failure.download': '下载安装包失败，请重试。',
      'failure.downloadNetwork': '下载安装包失败：网络中断。',
      'failure.install': '安装失败，已尝试恢复旧版本。',
      'failure.generic': '更新失败，请重试。',
      'failure.withReason': '{message}（{error}）',
      'actions.confirm': '确认更新并重启',
      'actions.cancel': '取消',
      'actions.install': '安装 {version}',
      'actions.skip': '忽略',
      'actions.check': '检查更新',
      'actions.checking': '检查中…',
      'actions.phoneLink': '手机链接',
      'actions.phoneLinkCopied': '已复制',
      'actions.phoneLinkLoading': '读取中…',
      'actions.phoneLinkTitle': '复制带当前 token 的手机入口链接（宿主每次重启会换 token）',
    }

    /** Fill `{name}` placeholders. Shared by the fallback and the tests. */
    function interpolate(template, vars) {
      if (!vars) return String(template)
      return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole)
    }

    /**
     * Locale text without the locale service (first render before the slot seat
     * is ready, or a page built without it). Mirrors the service fallback:
     * requested key → key itself, active document language → English.
     */
    function fallbackTranslate(key, vars) {
      const zh = typeof document !== 'undefined' && /^zh/i.test(document.documentElement.lang || '')
      const table = zh ? ZH : EN
      return interpolate(table[key] || EN[key] || key, vars)
    }

    function translator(props) {
      return typeof props.t === 'function' ? props.t : fallbackTranslate
    }

    const TAG_ID = 'dsh-web-updater/ui.css'
    const CSS = [
      '.dsh-upd-row{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);}',
      '.dsh-upd-main{min-width:0;flex:1;}',
      '.dsh-upd-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);}',
      '.dsh-upd-desc{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-upd-desc code{font-family:var(--ds-font-family-code,monospace);font-size:11.5px;}',
      '.dsh-upd-note{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warning-primary,#e0a13c);}',
      '.dsh-upd-error{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#e06060);word-break:break-word;}',
      '.dsh-upd-actions{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end;}',
      '.dsh-upd-btn{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:5px 12px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-primary);white-space:nowrap;}',
      '.dsh-upd-btn:hover:not(:disabled){border-color:var(--dsw-static-blue-450,#3b82f6);}',
      '.dsh-upd-btn:disabled{opacity:.5;cursor:default;}',
      '.dsh-upd-btn.primary{background:var(--dsw-static-blue-450,#3b82f6);border-color:transparent;color:#fff;}',
      '.dsh-upd-btn.primary:hover:not(:disabled){filter:brightness(1.08);}',
      '.dsh-upd-btn.ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-tertiary);}',
      '.dsh-upd-progress{margin-top:8px;height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,#2a2f3a);overflow:hidden;}',
      '.dsh-upd-progress>i{display:block;height:100%;border-radius:2px;background:var(--dsw-static-blue-450,#3b82f6);transition:width .25s ease;}',
      '.dsh-upd-dot{position:absolute;top:3px;right:3px;width:7px;height:7px;border-radius:50%;background:var(--dsw-static-blue-450,#3b82f6);box-shadow:0 0 0 2px var(--dsw-specific-sidebar-fill,transparent);pointer-events:none;}',
      '.dsh-upd-dot.error{background:#e06060;}',
      '.dsh-upd-dot.installing{background:#e0a13c;}',
    ].join('\n')

    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + TAG_ID + '"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-web-updater'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function post(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then((r) => r.json())
    }

    function useUpdater() {
      const [state, setState] = React.useState(null)
      const [transport, setTransport] = React.useState('connecting')
      React.useEffect(() => {
        let alive = true
        fetch('/dsh-update/status')
          .then((r) => r.json())
          .then((j) => { if (alive && j && j.ok) { setState(j.state); setTransport('ok') } })
          .catch(() => { if (alive) setTransport('error') })
        let es
        try {
          es = new EventSource('/dsh-update/events')
          es.onmessage = (event) => {
            if (!alive) return
            try { setState(JSON.parse(event.data)); setTransport('ok') } catch { /* ignore malformed frame */ }
          }
          es.onerror = () => { if (alive) setTransport('error') }
        } catch { /* EventSource missing: fall back to the one-shot status read */ }
        return () => { alive = false; if (es) es.close() }
      }, [])
      return [state, transport]
    }

    function humanPhase(state, transport, t) {
      if (transport === 'error' && !state) {
        return { title: t('status.unavailable.title'), detail: t('status.unavailable.detail') }
      }
      if (!state) return { title: t('status.loading.title'), detail: '' }
      const cur = state.current || '—'
      switch (state.phase) {
        case 'checking':
          return { title: t('status.checking.title'), detail: t('status.checking.detail', { version: cur }) }
        case 'up-to-date':
          return { title: t('status.upToDate.title'), detail: t('status.upToDate.detail', { version: cur, channel: state.channel }) }
        case 'available': {
          const vars = { current: cur, version: state.latest }
          const detail = state.releaseDate
            ? t('status.available.detailDate', { ...vars, date: String(state.releaseDate).slice(0, 10) })
            : t('status.available.detail', vars)
          return { title: t('status.available.title', { version: state.latest }), detail }
        }
        case 'downloading':
          return { title: t('status.downloading.title', { percent: state.percent || 0 }), detail: t('status.downloading.detail') }
        case 'verifying':
          return { title: t('status.verifying.title'), detail: t('status.verifying.detail') }
        case 'installing':
          return { title: t('status.installing.title', { version: state.latest || '' }), detail: t('status.installing.detail') }
        case 'error':
          return { title: t('status.error.title'), detail: failureText(state, t) }
        default:
          return {
            title: t('status.idle.title', { version: cur }),
            detail: state.latest
              ? t('status.idle.detailLatest', { version: state.latest })
              : t('status.idle.detailNever'),
          }
      }
    }

    function failureText(state, t) {
      const map = {
        'check': 'failure.check',
        'check-network': 'failure.checkNetwork',
        'download': 'failure.download',
        'download-network': 'failure.downloadNetwork',
        'install': 'failure.install',
      }
      const base = t(map[state.failure] || 'failure.generic')
      return state.error ? t('failure.withReason', { message: base, error: state.error }) : base
    }

    function UpdateRow(props) {
      ensureCss()
      const t = translator(props)
      const [state, transport] = useUpdater()
      const [confirming, setConfirming] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [link, setLink] = React.useState(null)
      const info = humanPhase(state, transport, t)
      const phase = state && state.phase
      const newer = state && state.latest && state.newer
      const canCheck = !busy && phase !== 'downloading' && phase !== 'verifying' && phase !== 'installing'
      const canInstall = !busy && phase !== 'downloading' && phase !== 'verifying' && phase !== 'installing'

      const run = (promise) => {
        setBusy(true)
        promise.catch(() => {}).finally(() => setBusy(false))
      }
      const check = () => run(post('/dsh-update/check'))
      const install = () => run(post('/dsh-update/install', { confirm: true }))
      const skip = () => { setConfirming(false); run(post('/dsh-update/skip')) }
      const copyLink = () => {
        setLink({ status: 'loading' })
        fetch('/dsh-update/web-url')
          .then((response) => response.json())
          .then((body) => {
            if (!body || !body.ok) throw new Error((body && body.error) || 'failed')
            const text = body.phoneUrl || body.localUrl
            setLink({ status: 'ready', url: text, phone: Boolean(body.phoneUrl) })
            try { navigator.clipboard.writeText(text).then(() => setLink({ status: 'copied', url: text, phone: Boolean(body.phoneUrl) }), () => {}) } catch { /* clipboard may be unavailable */ }
          })
          .catch((error) => setLink({ status: 'error', error: String(error && error.message) }))
      }

      const children = [
        React.createElement('div', { className: 'dsh-upd-main', key: 'main' },
          React.createElement('div', { className: 'dsh-upd-title', key: 't' }, t('row.title')),
          React.createElement('div', { className: 'dsh-upd-desc', key: 'd' }, info.title),
          info.detail ? React.createElement('div', { className: 'dsh-upd-desc', key: 'dd' }, info.detail) : null,
          state && state.installer && state.installer.verified && newer
            ? React.createElement('div', { className: 'dsh-upd-desc', key: 'ready' }, t('ready.verified'))
            : null,
          phase === 'downloading'
            ? React.createElement('div', { className: 'dsh-upd-progress', key: 'p' },
              React.createElement('i', { style: { width: (state.percent || 0) + '%' } }))
            : null,
          confirming
            ? React.createElement('div', { className: 'dsh-upd-note', key: 'warn' }, t('confirm.warning'))
            : null,
          state && state.lastInstall && state.lastInstall.ok === false && phase !== 'error'
            ? React.createElement('div', { className: 'dsh-upd-error', key: 'last' },
              t('lastInstall.failed', { reason: state.lastInstall.error || state.lastInstall.failure || '—' }))
            : null,
          link && link.url
            ? React.createElement('div', { className: 'dsh-upd-desc', key: 'link' },
              t(link.status === 'copied' ? 'link.copied' : 'link.ready'),
              React.createElement('code', { key: 'u' }, link.url))
            : null,
          link && link.status === 'error'
            ? React.createElement('div', { className: 'dsh-upd-error', key: 'linkerr' }, t('link.error', { error: link.error }))
            : null,
        ),
        React.createElement('div', { className: 'dsh-upd-actions', key: 'actions' },
          confirming
            ? [
              React.createElement('button', { key: 'go', className: 'dsh-upd-btn primary', onClick: install, disabled: !canInstall }, t('actions.confirm')),
              React.createElement('button', { key: 'no', className: 'dsh-upd-btn ghost', onClick: () => setConfirming(false) }, t('actions.cancel')),
            ]
            : [
              newer
                ? React.createElement('button', { key: 'install', className: 'dsh-upd-btn primary', onClick: () => setConfirming(true), disabled: !canInstall }, t('actions.install', { version: state.latest }))
                : null,
              newer
                ? React.createElement('button', { key: 'later', className: 'dsh-upd-btn ghost', onClick: skip, disabled: busy }, t('actions.skip'))
                : null,
              React.createElement('button', { key: 'check', className: 'dsh-upd-btn', onClick: check, disabled: !canCheck }, phase === 'checking' ? t('actions.checking') : t('actions.check')),
              React.createElement('button', {
                key: 'link',
                className: 'dsh-upd-btn ghost',
                onClick: copyLink,
                disabled: link && link.status === 'loading',
                title: t('actions.phoneLinkTitle'),
              }, link && link.status === 'copied' ? t('actions.phoneLinkCopied') : link && link.status === 'loading' ? t('actions.phoneLinkLoading') : t('actions.phoneLink')),
            ],
        ),
      ]
      return React.createElement('div', { className: 'dsh-upd-row' }, children)
    }

    function UpdateBadge() {
      ensureCss()
      const [state] = useUpdater()
      if (!state) return null
      const phase = state.phase
      if (phase === 'installing') return React.createElement('span', { className: 'dsh-upd-dot installing', 'aria-hidden': 'true' })
      if (phase === 'error') return React.createElement('span', { className: 'dsh-upd-dot error', 'aria-hidden': 'true' })
      if (state.newer && !state.dismissed) return React.createElement('span', { className: 'dsh-upd-dot', 'aria-hidden': 'true' })
      return null
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'dsh-web-updater: locale')
      ctx.effect(() => slots.inject('settings.general.item', () => slots.register(
        { name: 'settings.general.item', id: 'web-updater', order: 98, locale: NS },
        UpdateRow,
      )), 'dsh-web-updater: settings row')
      ctx.effect(() => slots.inject('sidebar.toggle.badge', () => slots.register(
        { name: 'sidebar.toggle.badge', priority: -10 },
        UpdateBadge,
      )), 'dsh-web-updater: sidebar badge')
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = { humanPhase, failureText, interpolate, EN, ZH, NS }
    return module.exports
  },
})

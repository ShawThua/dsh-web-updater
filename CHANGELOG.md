# Changelog

## 0.1.4 — 2026-11-15

Package asset only; no host or client code change.

- New plugin icon: a blue rounded tile with the `DSH` wordmark, replacing the
  download-arrow mark (the arrow read as "download" first and "updater" second).

## 0.1.3 — 2026-11-15

Documentation only; no change to the host or client code.

- Added **"If you want an icon on the phone's home screen"**: a `302` redirector
  cannot back a home-screen icon (the icon stores the post-redirect URL), the
  page must carry `apple-touch-icon` and `apple-mobile-web-app-title`, the image
  should be 180×180, and adding the icon is a one-time action.
- This is the trap that made the author re-copy the phone link every day; the
  published guidance previously implied a token URL was a normal bookmark.

## 0.1.2 — 2026-11-15

Documentation and release pipeline only; no change to the host or client code.

- **Corrected the phone-link guidance.** The token in the URL is minted at every
  host start, so a saved token URL dies at the next start (boot, login, update,
  manual restart). The session cookie the host issues lasts 30 days and survives
  restarts, so a browser that keeps its cookies stays signed in. A bookmark
  should point at a redirector rather than at a token URL — and a phone
  home-screen icon cannot rely on a redirector that answers with `302`, because
  the icon is saved with the URL you land on after the redirect.
- **Stated what `--trusted-host` actually gates.** DSH fences `/api` requests by
  `Host`: an authority that is neither loopback nor listed answers `403`, while
  the page itself may still load.
- Documented the npm package name as an install source.
- Releases now publish from GitHub Releases through npm trusted publishing
  (OIDC) with provenance.

## 0.1.0 — 2026-11-15

First public release.

- Host half: reads the installed version and the update feed
  (`resources/app-update.yml` → `nightly.yml`), compares release candidates,
  downloads the installer with progress over SSE, and verifies its sha512
  digest. All routes live under `/dsh-update`; the mutating ones are
  loopback-only, so a remote browser can watch but not install.
- Installation hand-off: the host writes `relaunch.json` (executable, argv,
  cwd, `ELECTRON_RUN_AS_NODE=1`) and starts a detached PowerShell script with a
  single pre-quoted argument string. The script waits for the host to exit,
  runs the NSIS installer silently (`/S /D=<dir>`), verifies the new file
  version, writes `last-install.json`, and restarts the host by replaying the
  recorded command line. It falls back to `dsh.cmd` when no launch record
  exists.
- Client half: an Update row in Settings → General with check, download
  progress, two-step install confirmation, phone-link copy, and a status dot on
  the collapsed sidebar toggle. All copy goes through the Client locale
  service (English and Chinese baseline).
- Failures never strand the host: a failed install restarts the previous
  version and reports the reason on the next page load.
- 32 unit tests (version ordering, feed parsing against a captured nightly
  feed, installer argument quoting, client copy), run in CI on Node 22 and 24.
- Verified on DSH 0.2.2-rc.3 on Windows 11: one real in-place upgrade
  (0.2.2-rc.1 → 0.2.2-rc.3) through the settings row, plus rehearsal runs of the
  stop → install → verify → restart path in an isolated host.




# Changelog

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

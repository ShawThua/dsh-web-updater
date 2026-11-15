# dsh-web-updater

[![CI](https://github.com/ShawThua/dsh-web-updater/actions/workflows/ci.yml/badge.svg)](https://github.com/ShawThua/dsh-web-updater/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-web-updater.svg)](https://www.npmjs.com/package/dsh-web-updater)

Update the **DSH web host** from its own web GUI: check the nightly feed, download the installer, verify it, install it — and let the host come back up by itself.

English | [中文](README.zh-CN.md)

## Why this exists

The Desktop app carries an electron-updater. A host started with `dsh web --profile web` does not: there is no `dsh update` command, and the updater that ships with the product only runs inside the Desktop shell. A web-only installation therefore stays on the version it was installed with, forever.

This plugin moves the same job into the web GUI. Everything it needs already exists on disk — `resources/app-update.yml` names the feed, `app.asar/dsh/package.json` holds the installed version, and the Desktop updater's cache is a ready-made installer copy.

## What it does

- Adds an **Update** row to **Settings → General**: installed version, check button, found version, download progress, two-step install confirmation, and the reason of a failed attempt.
- Puts a small dot on the collapsed sidebar toggle: blue = update available, amber = installing, red = last attempt failed.
- Compares versions with release-candidate ordering (`0.2.2-rc.10` is newer than `0.2.2-rc.9`, `0.2.2` is newer than any `0.2.2-rc.N`).
- Reuses the installer the Desktop updater already downloaded when its size and sha512 match; otherwise downloads it with progress over Server-Sent Events and verifies the digest.
- Hands the install to a **detached PowerShell script**, because the host cannot replace its own executable. The script records the host's full command line first, stops the host, installs silently, checks the new `FileVersion`, and starts the host again by replaying the recorded command line.
- Never strands you: if the install fails, the previous version is restarted and the failure is reported in the row on the next page load.

## Requirements

- **Windows.** The installer path is NSIS (`/S /D=<dir>`), the version check reads the executable's `FileVersion`, and the restart depends on the `ELECTRON_RUN_AS_NODE` environment variable.
- A **web host** (`dsh web --profile web`); built and verified against **DSH 0.2.2-rc.3**.
- Node `^22.19.0 || >=24.0.0` (the Host half runs inside DSH; there is no separate process).
- No runtime dependencies and no build step: both halves are plain ESM/JS.

## Install

Install it through DSH's plugin manager — do not hand-edit the profile's `package.json` or `cordis.patch.yml`; the manager owns those files.

1. **From this repository** (plugin manager, Settings → Plugins, or the `plugin_manager` agent tool):
   - repository spec: `ShawThua/dsh-web-updater`
   - npm package: `dsh-web-updater`
   - or a local checkout: `link:<absolute path to the checkout>`
2. The manager adds the dependency and selects the bundle; profile configuration HMR usually applies it immediately (look for `application: "applied"`), otherwise restart the Host.
3. **Verify** the host half is alive:

   ```bash
   curl -X POST "http://127.0.0.1:7979/dsh-update/preflight?token=<current token>"
   # {"ok":true,"started":true,"wrapperPid":…,"logTail":[…]}
   ```

   `started:true` means the installer script really started and bound all of its parameters, without stopping the host. The current token is printed by `dsh web` at startup.

Then open **Settings → General → Update**. The row shows the installed version; **Check for updates** compares it with the feed.

## Usage

- **Check for updates** — reads `<feed url>/nightly.yml`. The check also runs automatically two minutes after the host starts and every six hours.
- **Install <version>** — asks once (`Update and restart`). The installer is downloaded and verified before the host is touched.
- **Skip** — remembers the shown version and hides the install button and the sidebar dot until something newer appears.
- **Phone link** — copies the phone / reverse-proxy URL carrying the *current* launch token (the token changes on every host restart).

The row warns before installing because the host restarts: the page and the phone connection drop for one to two minutes, and **drafts that were never sent are lost**. Send or copy them first. (The [draft-persistence](https://github.com/ShawThua/dsh-draft-persistence) plugin covers the part that already reached the host.)

## Phone and remote access

The **Phone link** button exists because of one detail of `dsh web`: the host prints a new launch token on every start, so a bookmarked URL answers `401` after a restart.

- `GET /web-url` (loopback only) returns `localUrl` and `phoneUrl`, both carrying the *current* token.
- The origin of `phoneUrl` is the host's own `--public-url`, which the plugin records in `relaunch.json` when it starts. Start the host without one and the origin falls back to the `Host` header the browser sent — right for a LAN address, empty when nothing is publishing the host.
- The host keeps listening on `127.0.0.1` only. Something else has to publish it to another device.

[Tailscale](https://tailscale.com/) is the setup this plugin was written against; it is not required:

```powershell
# publish https://<machine>.<tailnet>.ts.net:8443/ -> 127.0.0.1:7979
tailscale serve --bg --https=8443 http://127.0.0.1:7979

# start the host so the button can build the phone URL
dsh web --profile web --host 127.0.0.1 --port 7979 `
  --public-url https://<machine>.<tailnet>.ts.net:8443 `
  --trusted-host <machine>.<tailnet>.ts.net:8443
```

- `--public-url` is the origin the button substitutes for `127.0.0.1`.
- `--trusted-host` is needed because the proxy forwards the tailnet name as the `Host` header, and DSH fences `/api` requests by `Host`: an authority that is neither loopback nor listed gets `403`. (The page itself may still load; the failing part is the API.)
- `serve` needs HTTPS certificates enabled for the tailnet; `tailscale serve status` shows what is actually published.
- Any other reverse proxy or tunnel that terminates TLS and forwards to `127.0.0.1:7979` while preserving the original host works the same way.
- A machine usually cannot reach its own tailnet address through `serve`, so use the local link on the host itself and the phone link everywhere else.

**The link is a credential.** Whoever holds it, and can reach the host, is logged in. It rotates on every restart — re-copy it after an update — and it should never be pasted into a public issue, screenshot, or chat log.

Two things follow from that, and they are different:

- The **token** in the URL is produced at every host start, so a saved token URL dies at the next start (boot, login, update, manual restart).
- The **session cookie** the host issues after a first successful load lives for 30 days and survives host restarts, so a browser that keeps its cookies stays logged in even when the token in the bookmarked URL is long dead. A browser that does not (private window, an in-app webview, cleared site data) falls back to the `401` page.

For a bookmark that never expires, publish a redirector instead of a token URL: this setup runs a tiny portal on loopback that answers every request with `302` to `/portal/url.txt`, and Tailscale exposes it on its own port (`9443` here). Bookmark the redirector, not the token URL.

## How it works

```
feed  nightly.yml ──► compare ──► download + sha512 ──► relaunch.json
                                                   │
                                    detached PowerShell script
                                                   │
                    wait for host exit ─► NSIS /S /D=<dir> ─► FileVersion check
                                                   │
                          replay exe + argv ─► host is back on 127.0.0.1:7979
```

Two details make this work on a machine that is not the author's:

- **`relaunch.json`** is written by the host half into `$DSH_HOME/storages/dsh-web-updater/` and records `process.execPath`, `process.argv.slice(1)`, the working directory, the port, and `env: { ELECTRON_RUN_AS_NODE: "1" }`. Replaying that is what restarts the host; no launcher script, no hard-coded install directory.
- **Argument quoting happens in one place** (`lib/args.js`). `Start-Process -ArgumentList @(...)` joins its elements without quoting, so an install directory such as `D:\Program Files (x86)\DeepSeekHarness` used to arrive as two arguments and the script died before writing a log. The tests pin the pre-quoted string shape.

### HTTP API

All routes are under `/dsh-update`, on the host's own web server. Routes marked *loopback* refuse every peer other than `127.0.0.1` / `::1`, so a remote browser can watch progress but cannot install anything.

| Method and path | Access | Purpose |
|---|---|---|
| `GET /status` | any authenticated client | current state snapshot |
| `GET /events` | any authenticated client | SSE stream of state changes (download progress) |
| `POST /check` | loopback | read the feed and compare versions |
| `POST /download` | loopback | prepare the installer (reuse verified cache or download) |
| `POST /install` | loopback | `{ "confirm": true }` starts the detached install |
| `POST /skip` | loopback | dismiss the current version |
| `POST /selftest` | loopback | prove the host can start a detached hidden child |
| `POST /preflight` | loopback | run the installer script in `-WhatIfOnly` mode |
| `GET /web-url` | loopback | local URL and phone URL with the current token |

### State files

Runtime state lives outside the package, in `$DSH_HOME/storages/dsh-web-updater/`:

| File | Content |
|---|---|
| `state.json` | latest seen version, check time, installer path, dismissed version |
| `last-install.json` | last install result (`ok`, `from`, `to`, `actual`, `failure`, `error`, timestamps) |
| `install.log` | installer script log |
| `install.started` | hand-off marker; the host reports "the script did not start" when it never appears |
| `relaunch.json` | how to start this host again |
| `installers/` | installers downloaded by this plugin |

## Safety and privacy

- **Only a local process can change anything.** Checks, downloads, installs and the token endpoint require a loopback peer. Remote (phone, Tailscale) browsers only read `/status` and `/events`.
- **`GET /web-url` hands the current launch token to any local process**, and that token is equivalent to a login credential for the host. It is enabled by default because it is the only convenient way to move the link to a phone; remove the button if you expose the host beyond your own machine and do not want local programs to read tokens. In a browser, the token is only ever sent when you click the button.
- **The installer is the official one** for the channel in `resources/app-update.yml` (currently the nightly feed on `download.deepseek.com`). A feed without a `sha512` is accepted on a size match only; the plugin logs that it could not verify a digest.
- **The Desktop updater's cache is read, never modified or deleted.** Copies made by this plugin stay under `$DSH_HOME`.
- No telemetry, no accounts, no outbound requests other than the feed and the installer.

## Limitations

- Windows only, and only for the channel the installed build points at.
- Installing restarts the host: this page, other tabs, and the phone link disconnect for one to two minutes. Unsent drafts are lost.
- A version is verified through the executable's `FileVersion` (falling back to `app.asar/dsh/package.json`). The script cannot detect a partially replaced installation beyond that check.
- The installer runs for at most 15 minutes; after that the script stops it and restarts the previous version.
- One host at a time. Two hosts sharing one `$DSH_HOME` already fight over the workspace registry; this plugin does not change that.
- No downgrade, no channel switch, no automatic rollback beyond "restart the version that is still installed".

## Development

```bash
npm test      # 32 cases: version order, feed parsing, argument quoting, client copy
npm run check # node --check on every module
```

```bash
node test/version.test.mjs   # release-candidate ordering
node test/feed.test.mjs      # parses test/fixtures/nightly.yml (captured real feed)
node test/args.test.mjs      # the 2026-11-14 quoting regression
node test/client.test.mjs    # locale parity and status copy
```

- `bin/dsh_update.ps1` **must stay UTF-8 with BOM.** Windows PowerShell 5.1 decodes a BOM-less UTF-8 file as GBK, which eats quotes inside Chinese comments and turns the script into a `ParserError`; `POST /preflight` then answers `started:false` with an empty `logTail`. Check the first three bytes (`EF BB BF`) after every edit.
- Verify argument assembly without installing anything:

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File bin\dsh_update.ps1 `
    -RestartOnly -RelaunchJson "$env:USERPROFILE\.dsh\storages\dsh-web-updater\relaunch.json" `
    -LogPath "$env:TEMP\dsh-update-whatif.log" -WhatIfOnly
  ```

Layout:

```
lib/index.js      Host half: feed, download, verification, routes, installer spawn
lib/client.js     Client half: settings row + sidebar dot, locale dictionaries
lib/args.js       PowerShell argument quoting (shared with the tests)
bin/dsh_update.ps1 Detached installer: stop → install → verify → restart
locale/           plugin list metadata (en, zh)
docs/             detail document and its feature image
icon.svg          plugin icon
test/             unit tests and the captured feed fixture
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The row says *Update status unavailable* | The host does not answer `/dsh-update`; the plugin is disabled or failed to activate. Re-enable it in Settings → Plugins. |
| Every token URL answers 401 | A plugin hot reload invalidated the launch token. Restart the host. |
| *The installer script did not start* (after ~25 s) | `bin/dsh_update.ps1` lost its BOM or is not executable. `POST /preflight` and read `logTail`. |
| The version did not change after installing | Read `last-install.json` and `install.log`; the script restarts the old version and records why. |
| The installer hangs | It waits up to 15 minutes and may be showing a UAC prompt; the script ends it and restarts the old host after the timeout. |

## Uninstall

Remove the bundle with the plugin manager. State in `$DSH_HOME/storages/dsh-web-updater/` is left in place; delete that directory to remove the cached installers and logs as well.

## License

MIT

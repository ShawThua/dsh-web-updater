# dsh-web-updater

[![CI](https://github.com/ShawThua/dsh-web-updater/actions/workflows/ci.yml/badge.svg)](https://github.com/ShawThua/dsh-web-updater/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-web-updater.svg)](https://www.npmjs.com/package/dsh-web-updater)

在 **DSH 网页端**自己的界面里更新宿主：检查 nightly 更新源、下载安装包、校验、安装，最后让宿主自己起来。

[English](README.md) | 中文

## 为什么需要它

桌面 App 自带 electron-updater，而用 `dsh web --profile web` 起的宿主没有：DSH 没有 `dsh update` 命令，产品自带的更新器只在桌面外壳里运行。于是纯网页端安装会永远停在安装时那个版本。

本插件把同一件事搬进网页端。需要的东西磁盘上本来就有：`resources/app-update.yml` 指定更新源，`app.asar/dsh/package.json` 是已安装版本，桌面更新器的缓存就是现成的安装包副本。

## 它做什么

- 在 **设置 → 通用** 增加一行「更新」：当前版本、检查按钮、发现的新版本、下载进度、两步确认、失败原因。
- 折叠侧栏的展开按钮上出现小圆点：蓝色 = 有新版，橙色 = 安装中，红色 = 上次失败。
- 版本比较按发布候选规则：`0.2.2-rc.10` 比 `0.2.2-rc.9` 新，`0.2.2` 比任何 `0.2.2-rc.N` 新。
- 桌面更新器已下载的安装包在大小与 sha512 都一致时直接复用；否则重新下载（进度走 SSE）并校验摘要。
- 安装交给**脱离宿主的 PowerShell 脚本**，因为宿主无法替换自己的可执行文件。脚本先记录宿主的完整命令行，再停宿主、静默安装、核对新文件的 `FileVersion`，最后按记录的命令行把宿主原样拉起来。
- 不会把环境留在半死状态：安装失败会把旧版本重新拉起，下次打开设置就能看到原因。

## 要求

- **Windows**。安装器走 NSIS（`/S /D=<目录>`），版本校验读 exe 的 `FileVersion`，重启依赖 `ELECTRON_RUN_AS_NODE` 环境变量。
- **网页端宿主**（`dsh web --profile web`）；在 **DSH 0.2.2-rc.3** 上验证。
- Node `^22.19.0 || >=24.0.0`（Host 半边跑在 DSH 里，没有独立进程）。
- 无运行时依赖、无构建步骤，两半都是普通 ESM/JS。

## 安装

用 DSH 的插件管理器安装——不要手改 profile 的 `package.json` 或 `cordis.patch.yml`，那两个文件由管理器维护。

1. **从本仓库**（插件管理器、设置 → 插件，或 `plugin_manager` 工具）：
   - 仓库标识：`ShawThua/dsh-web-updater`
   - npm 包名：`dsh-web-updater`
   - 或本地检出：`link:<检出的绝对路径>`
2. 管理器会加依赖并选中 bundle；profile 的配置 HMR 通常立即生效（日志里有 `application: "applied"`），否则重启宿主。
3. **确认 Host 半边活着**：

   ```bash
   curl -X POST "http://127.0.0.1:7979/dsh-update/preflight?token=<当前 token>"
   # {"ok":true,"started":true,"wrapperPid":…,"logTail":[…]}
   ```

   `started:true` 说明安装脚本真的起来了、参数全部绑定成功，且没有停宿主。当前 token 由 `dsh web` 启动时打印。

然后打开 **设置 → 通用 → 更新**，那一行会显示已安装版本；点「检查更新」与更新源比较。

## 用法

- **检查更新** — 读 `<更新源>/nightly.yml`。宿主启动两分钟后、之后每六小时也会自动检查。
- **安装 <版本>** — 先确认一次（「确认更新并重启」）。安装包一定先下载并校验，才会动宿主。
- **忽略** — 记住当前显示的版本，隐藏安装按钮与侧栏圆点，直到出现更新的版本。
- **手机链接** — 复制带**当前**启动 token 的手机/反代地址（宿主每次重启都会换 token）。

安装前那一行会给出警告：宿主会重启，页面与手机连接将断开一到两分钟，**没发出去的草稿会丢**。请先发送或复制出来。（已经落到宿主的部分由 [draft-persistence](https://github.com/ShawThua/dsh-draft-persistence) 兜住。）

## 手机与远程访问

「手机链接」按钮的存在，只因为 `dsh web` 的一个细节：宿主每次启动都会打印新的 launch token，收藏下来的旧链接重启后一律 `401`。

- `GET /web-url`（仅回环）返回 `localUrl` 与 `phoneUrl`，两者都带着**当前** token。
- `phoneUrl` 的 origin 取自宿主自己的 `--public-url`（插件启动时记进 `relaunch.json`）。启动时没带这个参数，就退回浏览器请求的 `Host` 头——局域网地址够用，没做任何发布时则为空。
- 宿主始终只监听 `127.0.0.1`，要让别的设备访问，得另外把它发布出去。

本插件是按 [Tailscale](https://tailscale.com/) 的形态写的，但它不是必须的：

```powershell
# 把 https://<机器名>.<tailnet>.ts.net:8443/ 发布到 127.0.0.1:7979
tailscale serve --bg --https=8443 http://127.0.0.1:7979

# 这样启动宿主，按钮才拼得出手机地址
dsh web --profile web --host 127.0.0.1 --port 7979 `
  --public-url https://<机器名>.<tailnet>.ts.net:8443 `
  --trusted-host <机器名>.<tailnet>.ts.net:8443
```

- `--public-url` 就是按钮替换 `127.0.0.1` 用的 origin。
- `--trusted-host` 必须加：反代会把 tailnet 域名作为 `Host` 头转进来，而 DSH 用 `Host` 给 `/api` 请求做白名单——既不是回环、也没登记的 authority 一律 `403`。首页可能照样能打开，被挡的是 API。
- `serve` 需要为 tailnet 启用 HTTPS 证书；`tailscale serve status` 能看到实际发布了什么。
- 任何能终止 TLS、转发到 `127.0.0.1:7979` 并保留原始 Host 的反代或隧道都一样可用。
- 本机通常连不上自己的 tailnet 地址（`serve` 只对 tailnet 对端放行），所以本机用 localUrl，别的设备用 phoneUrl。

**这条链接等价于密码。** 谁拿到它、又能连到宿主，就等于登录了这份宿主。它每次重启都会变（更新完记得重新复制），也永远不要贴进公开的 issue、截图或聊天记录里。

由此有两件事，性质不同：

- URL 里的 **token** 是宿主每次启动现生成的，所以存下来的带 token 链接在下次启动（开机、登录、更新、手动重启）后就失效。
- 首次成功打开后宿主下发的**会话 cookie** 有效期 30 天，并且能撑过宿主重启——只要浏览器留着 cookie，就算书签里的 token 早就过期，照样能进。留不住的（无痕窗口、App 内置 webview、清过站点数据）才会掉回 `401` 页面。

想要一个永不过期的书签，就别存 token URL，而是存一个跳转器：本机这套跑了一个小的 portal，它的页面只有一个按钮，链接到 `portal\url.txt` 里的当前 token（加 `?go=1` 则退回纯 `302`），Tailscale 给它单独开了端口（这里是 `9443`）。

### 想在手机主屏幕放一个图标的话

这里有个坑值得写明白——本项目就是被它拖了一周「每天重新复制链接」：

- **纯 `302` 的跳转器撑不起主屏幕图标。** iOS / Android 保存的是**重定向之后**落地的地址，图标里存的就成了 token URL，下次宿主启动即失效。跳转器必须以「一个带链接的页面」回应，图标才会保存住那个固定地址。
- **页面要带上图标和名称。** 没有 `<link rel="apple-touch-icon">`，iOS 会拿网页截图当图标；没有 `apple-mobile-web-app-title`，名字会退化成被截断的 `<title>`。
- **图标按 180×180 出图。** 更大的 PNG 也能用，但 iOS 会粗暴缩放。
- **加图标是「在那个页面上」的一次性动作。** 之后图标永远指向当前 token，不用再复制——这正是稳定入口的意义。

本机 portal 就是个可用的例子：一个回环监听，读 `portal\url.txt`，返回一页「一个大按钮」，并带上 `apple-touch-icon`、`apple-mobile-web-app-title=DSH`、`theme-color`、`apple-mobile-web-app-capable`。

## 工作原理

```
更新源 nightly.yml ──► 比较版本 ──► 下载 + sha512 ──► relaunch.json
                                                 │
                                脱离宿主的 PowerShell 脚本
                                                 │
              等宿主退出 ─► NSIS /S /D=<目录> ─► 核对 FileVersion
                                                 │
                        重放 exe + argv ─► 宿主重新监听 127.0.0.1:7979
```

能在别人的机器上跑通，靠两个细节：

- **`relaunch.json`** 由 Host 半边写进 `$DSH_HOME/storages/dsh-web-updater/`，记录 `process.execPath`、`process.argv.slice(1)`、工作目录、端口与 `env: { ELECTRON_RUN_AS_NODE: "1" }`。重放它就是重启宿主：不需要启动器脚本，也不写死安装目录。
- **参数拼装只有一处**（`lib/args.js`）。`Start-Process -ArgumentList @(...)` 不会替含空格的参数加引号，`D:\Program Files (x86)\DeepSeekHarness` 曾被拆成两个参数，脚本还没写日志就退出。单元测试锁住了「已引号化字符串」的形状。

### HTTP 接口

全部在宿主自己的 web server 上，前缀 `/dsh-update`。标 **回环** 的接口会拒绝 `127.0.0.1` / `::1` 以外的对端，所以远程浏览器只能看进度，不能安装。

| 方法与路径 | 访问 | 作用 |
|---|---|---|
| `GET /status` | 任意已认证客户端 | 状态快照 |
| `GET /events` | 任意已认证客户端 | SSE，状态变化即推（下载进度） |
| `POST /check` | 回环 | 读更新源并比较版本 |
| `POST /download` | 回环 | 准备安装包（复用已验证缓存或下载） |
| `POST /install` | 回环 | `{ "confirm": true }` 启动脱离宿主的安装 |
| `POST /skip` | 回环 | 忽略当前版本 |
| `POST /selftest` | 回环 | 诊断：宿主能不能起脱离的隐藏子进程 |
| `POST /preflight` | 回环 | 用 `-WhatIfOnly` 跑一遍安装脚本 |
| `GET /web-url` | 回环 | 带当前 token 的本机 / 手机地址 |

### 运行时状态

状态不放进包内，在 `$DSH_HOME/storages/dsh-web-updater/`：

| 文件 | 内容 |
|---|---|
| `state.json` | 最近看到的版本、检查时间、安装包路径、已忽略版本 |
| `last-install.json` | 上次安装结果（`ok`、`from`、`to`、`actual`、`failure`、`error`、时间） |
| `install.log` | 安装脚本日志 |
| `install.started` | 交接标记；没出现时宿主会报「安装脚本没有启动成功」 |
| `relaunch.json` | 怎么把当前宿主重新起来 |
| `installers/` | 本插件下载的安装包 |

## 安全与隐私

- **只有本机进程能改变任何东西。** 检查、下载、安装、取 token 都要求回环对端；远程（手机、Tailscale）浏览器只能读 `/status` 与 `/events`。
- **`GET /web-url` 会把当前启动 token 交给本机任意进程**，而 token 等价于这份宿主的登录凭据。它默认开启，因为这是把链接搬到手机上最方便的做法；如果你把宿主暴露到本机之外、又不愿本机程序读到 token，可以去掉那个按钮。浏览器里只有你点按钮时才会发出请求。
- **安装包是官方的那一份**，来源是 `resources/app-update.yml` 里指定的渠道（当前是 `download.deepseek.com` 的 nightly）。更新源没给 `sha512` 时只按大小放行，日志里会写明没能校验摘要。
- **桌面更新器的缓存只读**，不修改、不删除；本插件自己的副本留在 `$DSH_HOME` 下。
- 没有遥测、没有账号，除了更新源与安装包不发任何外部请求。

## 限制

- 仅 Windows，且只对已安装版本指向的那个渠道有效。
- 安装会重启宿主：本页、其它标签页、手机入口都会断开一到两分钟，未发送的草稿会丢。
- 版本只核对 exe 的 `FileVersion`（取不到时退回 `app.asar/dsh/package.json`），除这一项外无法发现「装了一半」。
- 安装器最多等 15 分钟，超时后脚本会结束它并把旧版本重新拉起。
- 同一时间只能有一个宿主。两个宿主共用一个 `$DSH_HOME` 本来就会互写会话名单，本插件不改变这一点。
- 不支持降级、不支持切换渠道，除了「重启仍在磁盘上的那个版本」之外没有自动回滚。

## 开发

```bash
npm test      # 32 个用例：版本排序、更新源解析、参数引号、客户端文案
npm run check # 对每个模块跑 node --check
```

```bash
node test/version.test.mjs   # 发布候选排序
node test/feed.test.mjs      # 解析 test/fixtures/nightly.yml（抓的真实更新源）
node test/args.test.mjs      # 2026-11-14 的引号回归
node test/client.test.mjs    # 中英文键一致性、状态文案
```

- `bin/dsh_update.ps1` **必须保持 UTF-8 with BOM**。Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 GBK 解，中文注释里的字节会吃掉引号，脚本变成 `ParserError`，`POST /preflight` 于是返回 `started:false` 且 `logTail` 为空。每次改完都检查前三字节（`EF BB BF`）。
- 不安装任何东西也能核对 argv 拼装：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File bin\dsh_update.ps1 `
    -RestartOnly -RelaunchJson "$env:USERPROFILE\.dsh\storages\dsh-web-updater\relaunch.json" `
    -LogPath "$env:TEMP\dsh-update-whatif.log" -WhatIfOnly
  ```

目录：

```
lib/index.js       Host 半边：更新源、下载、校验、路由、拉起安装脚本
lib/client.js      Client 半边：设置行 + 侧栏圆点、locale 字典
lib/args.js        PowerShell 参数引号（与测试共用）
bin/dsh_update.ps1 脱离宿主的安装脚本：停 → 装 → 校验 → 重启
locale/            插件列表元数据（en、zh）
docs/              详情文档与其配图
icon.svg           插件图标
test/              单元测试与抓下来的更新源样本
```

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 那一行显示「更新状态不可用」 | 宿主没有响应 `/dsh-update`：插件被禁用或激活失败。到 设置 → 插件 重新启用。 |
| 所有带 token 的链接都 401 | 插件热重载让启动 token 失效了。重启宿主。 |
| 约 25 秒后报「安装脚本没有启动成功」 | `bin/dsh_update.ps1` 丢了 BOM 或无法执行。跑 `POST /preflight` 看 `logTail`。 |
| 装完版本没变 | 看 `last-install.json` 与 `install.log`；脚本会把旧版本拉起来并记录原因。 |
| 安装器卡住 | 最多等 15 分钟，期间可能弹了 UAC；超时后脚本结束它并重启旧宿主。 |

## 卸载

用插件管理器移除 bundle。`$DSH_HOME/storages/dsh-web-updater/` 里的状态会保留；想连缓存与日志一起清掉，手动删这个目录。

## 许可证

MIT

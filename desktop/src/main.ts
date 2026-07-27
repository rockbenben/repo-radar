import { app, BrowserWindow, dialog, Menu, session, shell, Tray } from "electron"
import { homedir } from "node:os"
import { join } from "node:path"
import { createBackend } from "../../server/src/backend"
import { loadConfig } from "../../server/src/config"
import { FileLog, installConsoleTee, logFilePath } from "../../server/src/logger"
import { DEFAULT_PORT, PORT, PORT_IS_EXPLICIT } from "../../server/src/port"
import { cleanupLegacyEntries, getAutostart, setAutostart } from "./autostart"
import { resolveConfigFile } from "./config-path"
import { showNotification, summarizeInboxChanges } from "./notify"
import { createQuit } from "./quit"
import { createTray } from "./tray"
import { createWindow, saveWindowState } from "./window"
import { startsHidden } from "./cli"
import { loadLastVersion, saveLastVersion } from "./version-state"
// 版本号唯一事实源是根 package.json（release CI 校验 git tag 与其 version 一致）；
// desktop/package.json 故意不带 version 字段，不能用 app.getVersion()——未打包时它会
// 回退成 Electron 自身的版本号（如 43.1.1）。esbuild 打包时会把这个 JSON import 内联进产物。
import { version as appVersion } from "../../package.json"

// REPO_RADAR_CONFIG 设置时必须是绝对路径。上一轮曾经用 path.resolve() 把相对路径按 cwd
// 兜底展开，理由是下面 app.setPath("userData", ...) 对相对路径会直接抛 `Path must be
// absolute`；但那把「响亮的失败」换成了「静默地按一个不可预期的目录去找配置文件」——
// 打包应用启动时的 cwd 由系统决定（双击桌面图标、任务计划程序启动等场景下可能是
// System32 之类），用户以为在用 `./work.json`，实际用的是他找不到的地方的文件，
// 找不到就被当成"首次运行"写出一份全新默认配置，原来的文件分毫未动、且没有任何报错。
// 判定逻辑抽成 resolveConfigFile（纯函数，见 ./config-path），这里只负责在校验失败时
// 弹错误框、退出。必须用 process.exit 而不是 app.exit——app.exit() 不会中断当前 tick 的
// 同步执行（下面 requestSingleInstanceLock 那段注释也提到这一点），模块顶层紧随其后的
// 代码仍会跑下去；showErrorBox 是少数 app.whenReady() 之前可用的 dialog API
// （process.on("uncaughtException") 那段已经是先例），配合 process.exit 才能保证
// "弹完错误框、一行后续代码都不跑"。
const configResolution = resolveConfigFile(process.env.REPO_RADAR_CONFIG, homedir())
if (!configResolution.ok) {
  dialog.showErrorBox(
    "repo-radar",
    `${configResolution.error}\n\n打包后应用启动时的当前工作目录由系统决定、不可预期，相对路径会被解析到一个无法预期的位置，` +
      "而不是你期望的那份配置文件，因此这里要求必须是绝对路径。请改用绝对路径重新设置这个环境变量。",
  )
  process.exit(1)
}
const configFile = configResolution.configFile
const configDir = join(configFile, "..")

// 日志最先装：打包后的应用没有控制台，启动阶段出问题只能靠这个文件复盘
installConsoleTee(new FileLog(logFilePath(configDir)))

// 未捕获异常兜底：后端跑在主进程内，未捕获异常会让整个应用崩溃；打包后无控制台时最难排查
process.on("uncaughtException", (err) => {
  const errorMsg = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error(`[repo-radar] 未捕获异常: ${errorMsg}`)
  try {
    const errorDetail = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox("repo-radar 遇到问题", `${errorDetail}\n\n日志：${logFilePath(configDir)}`)
  } catch (dialogErr) {
    console.error(`[repo-radar] 弹错误对话框失败:`, dialogErr)
  }
  // 直接 app.exit(1) 绕过 quit() 的完整收尾：发生未捕获异常后进程状态已不可信，
  // 继续跑收尾逻辑可能卡住或造成更大破坏，因此无条件快速退出。
  app.exit(1)
})

// 必须尽早设置应用名，否则未打包运行时 Electron 用默认名 "Electron"——
// 这个名字会体现在所有外部可见的地方：写进开机自启的值名/Label（比如 Windows 注册表里
// 会出现 electron.app.Electron，任何人都看不出这是谁的条目）、app.getPath("userData")
// 的默认目录名等。本项目的配置/日志都走上面的 REPO_RADAR_CONFIG，不依赖 userData，
// 所以改名不会影响它们的落盘位置。
// 注意：这个名字**不会**决定 Windows 上系统通知的来源——那边认的是下面的 AppUserModelID。
app.setName("repo-radar")

// Windows 的 toast 通知走 AppUserModelID（AUMID）+ 开始菜单快捷方式识别来源，不认进程名/窗口标题。
// 不设置的话 Notification.isSupported() 仍然返回 true（它只判断系统是否支持通知这个概念），
// 但 new Notification(...).show() 可能悄无声息地不显示——没有任何报错，问题完全无声。
// 本项目主力平台就是 Windows，这行必须补上。
// 取值必须与 electron-builder.yml 的 appId **逐字相同**：NSIS 安装器会把开始菜单快捷方式的 AUMID
// 设成 appId，系统靠这个值把 toast 关联回快捷方式。两者不一致时，系统找不到对应快捷方式，
// 通知就不显示——而且照样没有任何报错。改动其中一处，另一处必须同步改。
app.setAppUserModelId("com.rockbenben.repo-radar")

// Finder/Dock 双击 .app 启动时拿到的是 launchd 的精简 PATH（/usr/bin:/bin:…），
// Homebrew 装的 gh（GitHub 集成）和 code（一键打开编辑器）会静默找不到——补上常见安装目录。
// 判断条件用 app.isPackaged 而不是原 server/src/index.ts 里的 isSea()：那是 SEA 时代
// 判断「是否为打包后的可执行文件」的写法，Electron 下等价物就是 app.isPackaged
// （未打包跑 `electron .` 走的是开发者自己的终端，PATH 本就完整，不需要也不该补）。
if (process.platform === "darwin" && app.isPackaged) {
  process.env.PATH = `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`
}

// REPO_RADAR_CONFIG 是「再跑一份互不干扰的实例」这个能力的入口（19 份 README 都如此承诺），
// 但 Electron 的单实例锁（requestSingleInstanceLock）锁的是 userData 目录，与端口/配置文件无关——
// 不改 userData 的话，换了端口换了配置文件的第二个进程照样会在锁竞争里直接输掉、退场。
// 因此用**非默认**配置时派生一个独立的 userData 目录，让锁域跟着配置走。
//
// 条件是「配置文件是不是那份默认的」，不是「有没有设环境变量」。差别很关键：
// `REPO_RADAR_CONFIG=<默认路径>` 用的是同一份配置、同一批仓库，却会因为 userData 被挪走而
// 自成一个锁域，于是两个后端同时跑——两边都往 config.json 写（后写的把前面的设置抹掉）、
// 都对同一批仓库做 git 写操作（抢 .git/index.lock）。端口曾经是这种情况的最后一道拦截
// （第二个进程绑不上就死掉），而端口回退把那道拦截也拿掉了，只剩这里。
//
// 默认配置继续用 Electron 的默认 userData 目录，不能改：那里存着窗口的 localStorage
// （保存的视图、活动日志、主题、语言），换目录等于把老用户的数据全部丢掉。
// 必须在 app.whenReady() 之前调用（Electron 的硬性要求），这里在 requestSingleInstanceLock()
// 之前设置，天然满足。
if (!configResolution.isDefault) {
  app.setPath("userData", join(configDir, "electron-userData"))
}

// 开发时前端由 vite dev server 提供（热更新）；打包后由后端从 asar 里的 web/dist 服务。
// 不能只判 !app.isPackaged：根 package.json 的 "start" 脚本（npm start）跑的也是未打包的
// electron，但它不会顺带起 vite——那样会一直去连 5173、连不上白屏（ERR_CONNECTION_REFUSED）。
// 因此额外要求显式环境变量 REPO_RADAR_DEV=1（由 "dev" 脚本设置），"start" 没设它就老实走后端端口。
const isDev = !app.isPackaged && process.env.REPO_RADAR_DEV === "1"
// 不能用 app.getAppPath()：它返回的是 desktop/package.json 所在目录（desktop/），
// 拼出来的 desktop/web/dist（以及 desktop/scripts/icon-256.png）根本不存在。
// 真正的前端产物在仓库根的 web/dist，图标在仓库根的 scripts/icon-256.png，
// 因此都改用 __dirname 推导：esbuild 打包产物是 desktop/dist/main.cjs（CJS 下 __dirname 可用），
// 从它出发向上两级即回到仓库根，打包后只要保持这个相对目录结构，该表达式依然成立。
const repoRoot = join(__dirname, "..", "..")
const staticRoot = join(repoRoot, "web", "dist")
// 窗口任务栏图标与通知弹窗共用这份 256px 大图（任务栏约 48px、通知图标更大，256 缩下去没问题）
const appIconPath = join(repoRoot, "scripts", "icon-256.png")
// 托盘图标单独选：macOS 菜单栏高约 22px，直接塞 256px 会被猛缩、还没有 @2x，Retina 上糊；
// 专门给它一份 16px（+同目录的 @2x=32px，createFromPath 会自动带上）的托盘图。
// Windows/Linux 的托盘对尺寸更宽容（系统托盘约 16-24px 但缩放质量比 macOS 菜单栏好），仍用 256px。
const trayIconPath =
  process.platform === "darwin" ? join(repoRoot, "scripts", "tray-icon.png") : appIconPath

// Linux 上不做「关窗收托盘」：GNOME 40+ 移除了传统托盘图标，要装 AppIndicator 扩展才有，
// 而 new Tray(...) 在那种环境下通常不报错、只是图标不出现——一旦关窗，窗口已隐藏、
// Linux 又没有 macOS 那种 Dock/activate 路径，用户就再也叫不回面板，只能去杀进程。
// 因此 Linux 上关窗即退出；托盘照常创建，有就是额外入口，没有也不影响正常使用。
const hideOnClose = process.platform !== "linux"

// 只有拿到单实例锁的那个进程才该做后续初始化：创建 backend、注册监听器、起窗口。
// 全部收进这个函数里（包括 mainWindow/showWindow，因为 showWindow 要引用 backend.port），
// 配合下面「拿不到锁就直接退场、不调用」的写法，确保输掉竞争的进程不会跑到这些有副作用的代码。
function bootstrap(): void {
  let mainWindow: BrowserWindow | null = null
  let tray: Tray | null = null
  let quitting = false // 只有走 quit() 才置真；窗口的 close 处理器靠它区分「隐藏」与「真退出」
  // 提到 bootstrap 顶层：showWindow() 建窗口时要用，quit() 的 beforeExit 收尾补存时也要用，
  // 两处必须用同一份路径，不能各算一遍
  const windowStateFile = join(configDir, "window-state.json")
  // 缺陷 4：SEA 自启迁移标记不再存进用户可见的 config.json（那是公开 API 能改的用户配置），
  // 改成与 window-state.json 同级的桌面端专属状态文件，见 desktop/src/autostart-state.ts
  const autostartStateFile = join(configDir, "autostart-state.json")
  // 升级后清一次 HTTP 缓存的依据文件（见 version-state.ts 的说明）：窗口经 HTTP 加载前端，
  // 旧 index.html 若被 Electron 缓存留住，升级后仍会端出旧界面（正是"装了新版还是旧样子"的根源）
  const versionStateFile = join(configDir, "version-state.json")

  // 界面完全是网页，Electron 默认那套 File/Edit/View/Window/Help 菜单在这里没有任何用处，
  // 只会在窗口顶部占一条、并提供一堆与本应用无关的动作。
  // macOS 不能一并去掉：那里的 Cmd+C/V/A、Cmd+Q 等标准快捷键是由菜单项的 role 提供的，
  // 整个菜单设成 null 会让页面里连复制粘贴都失效——所以只保留最小的一份（应用菜单 + 编辑菜单）。
  Menu.setApplicationMenu(
    process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]) : null,
  )

  // 后端绑定完成的信号。窗口 URL 里烧的是 backend.port，而这个值在 listen 回调里才定下来
  // （端口回退可能要试好几轮）。second-instance / activate 是在 whenReady 之前就注册的，
  // 用户在启动过程中再双击一次图标就会在绑定完成前调到 showWindow()，把回退前的端口烧进
  // 窗口 URL——createWindow 不做重试也不重载，结果是永久白屏 ERR_CONNECTION_REFUSED，
  // 只能杀进程。因此建窗口前先等这个 promise。
  let markBackendReady!: () => void
  let markBackendFailed!: (err: unknown) => void
  const backendReady = new Promise<void>((res, rej) => {
    markBackendReady = res
    markBackendFailed = rej
  })
  backendReady.catch(() => {}) // 启动失败已有专门的错误框+退出流程，这里只是避免 unhandled rejection

  async function showWindow(): Promise<void> {
    try {
      await backendReady
    } catch {
      return // 后端没起来，错误框已经弹过、进程正在退出，不该再建窗口
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      return
    }
    mainWindow = createWindow({
      url: isDev ? "http://localhost:5173" : `http://127.0.0.1:${backend.port}`,
      stateFile: windowStateFile,
      iconPath: appIconPath, // 只有 Linux 会用到（见 window.ts 里的注释）：任务栏用 256px 大图
      isQuitting: () => quitting,
      hideOnClose,
    })
  }

  app.on("second-instance", () => void showWindow()) // 再次双击应用 = 把面板叫回来

  // shutdown 引用的 quit 在下面才用 const 声明——这里只是把箭头函数存进 extras，
  // 真正求值 quit 是在 /api/shutdown 被调用时（那时 quit 早已初始化），不构成 TDZ 违规
  const backend = createBackend({
    configFile,
    staticRoot,
    version: appVersion,
    // 端口绑不上时可否改用别的。两种情况下必须响亮地失败，而不是换个端口装作一切正常：
    // - 用户显式设了 REPO_RADAR_PORT：那是对外承诺（书签、反向代理上游、脚本里写死的 URL），
    //   悄悄换掉之后它们全部 ECONNREFUSED，而窗口一切正常，用户没有任何线索
    // - 开发模式：vite 的代理目标在配置加载时就定死了（web/vite.config.ts），后端换端口
    //   等于 /api 全部 502、WebSocket 连不上，看板空白且没有任何报错——比起不来还难查
    allowPortFallback: !PORT_IS_EXPLICIT && !isDev,
    // vite dev server（5173）只在开发模式下可信。5173 是 vite 的默认端口，发行版里放行它
    // 等于让用户机器上任何别的前端项目、或一个恶意页面都能驱动本地 API（见 routes.ts）
    devOrigins: isDev,
    extras: {
      autostart: { get: () => getAutostart(), set: (enabled) => setAutostart(enabled) },
      shutdown: () => void quit(),
    },
  })

  // 唯一退出出口：托盘菜单、系统关机/注销、（后续）/api/shutdown 全部走这里
  const quit = createQuit({
    stopBackend: () => backend.stop(),
    beforeExit: () => {
      quitting = true // 放行窗口的 close，不再拦截成隐藏
      tray?.destroy()
      // 主动补存一次窗口尺寸/位置：唯一的真退出路径最终调用 app.exit()，是强制终止进程，
      // 根本不会触发窗口的 close 事件（window.ts 里挂在 close 上的持久化因此从未在这条路径上
      // 跑过）——最终几何尺寸只有恰好触发过 resized/moved 才被存下过，比如用户启动后直接
      // 最大化、中途没再拖动/缩放就从托盘退出，这次的尺寸就完全没存过，下次启动布局被静默
      // 丢弃。窗口可能从未创建（--tray 模式下用户全程没点开过面板），这里只判空；
      // 已销毁、或窗口当前处于最小化状态（bounds 不可信，见 saveWindowState 内部注释）
      // 这两种情况由 saveWindowState 自己跳过，这里不重复判断
      if (mainWindow) saveWindowState(mainWindow, windowStateFile)
    },
    exit: (code) => app.exit(code),
  })

  // 「等我的」有新增时弹系统通知。开关读的是服务端 config（不是 localStorage）——
  // 面板关着时渲染进程根本不在，只有主进程能发出这条通知，而主进程读不到 localStorage
  backend.onInboxChanged((changes) => {
    // 面板正开着且聚焦：用户已经在盯着看板看，再弹一条重复信息只是打扰，不弹
    if (mainWindow?.isVisible() && mainWindow.isFocused()) return
    // 退出收尾进行中：这时弹通知没有意义（面板可能已经在关闭路径上），也别再弹
    if (quitting) return
    let enabled = false
    try {
      enabled = loadConfig(configFile).notifications
    } catch {
      /* 配置损坏时按「关」处理：宁可不弹，也不能让一个坏文件把通知变成骚扰 */
    }
    if (!enabled) return
    const content = summarizeInboxChanges(changes)
    if (content) showNotification(content, appIconPath, () => void showWindow()) // 点通知 = 把面板叫回来；通知图标用 256px 大图
  })

  // 托盘退出、显式 app.quit() 都走 before-quit，收尾路径不能被绕开
  app.on("before-quit", (event) => {
    if (quitting) return
    event.preventDefault()
    void quit()
  })

  // SIGINT：Ctrl-C（终端里跑起来时）；SIGTERM：systemd/launchd 停服、`kill`、容器编排下发的
  // 默认信号；SIGHUP：终端窗口被关掉、用户注销。三个都不接的话，macOS/Linux 上这些场景会让
  // 进程被直接杀死——不走 quit() 就不会排空 server/src/queue.ts 里正在跑的 git 写操作，
  // 留下 .git/index.lock 是唯一会造成真实损害的后果（原 server/src/index.ts 的
  // installSignalHandlers() 干的就是这件事，Electron 化后被整体删掉了，这里补回来）。
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void quit())

  // Windows 上系统关机/重启/注销时，before-quit 经常根本不会触发（Electron 已知行为，
  // 见 electron/electron#9613、#21093、#15880），进程会被系统直接结束——这正是
  // index.lock 最容易产生的场景之一，而这套收尾就是为了防它。session-end 是 Electron
  // 在 Windows 上专门用来表示「会话因关机/重启/注销即将结束」的事件，因此这里也接上它；
  // 但它挂在 BrowserWindow 上而不是 app 上（Electron 类型定义如此，没有 app 版本），
  // 所以通过 browser-window-created 给每个新建的窗口都补上这个监听，覆盖 mainWindow。
  // 要诚实，这条路径有两处覆盖不到：
  //   1. 操作系统留给进程收尾的时间通常很短（有时只有几秒），可能等不完 git 排空
  //      （quit() 里那步上限是 10 秒）
  //   2. 开机自启是 --tray 模式，用户没点开面板前**根本没有窗口**，也就没有这个监听——
  //      而那恰恰是进程活得最久、最可能撞上关机的形态。Windows 只把会话结束消息发给
  //      顶层窗口，无窗口进程收不到，除非常驻一个隐藏窗口（那要为收尾额外养一个窗口，
  //      代价与收益不成比例，故不做）
  // 所以这不是绝对保证，只是尽力而为——能抢救到多少算多少，比完全不处理要好。
  app.on("browser-window-created", (_event, window) => {
    window.on("session-end", () => {
      if (quitting) return
      void quit()
    })
  })

  app.on("window-all-closed", () => {
    // 常驻应用：Windows/macOS 上关窗只是收进托盘（窗口并未真的关闭），这里通常不会触发。
    // Linux 例外——那里关窗就是真的关闭（见上面的 hideOnClose），没有托盘兜底时必须退出，
    // 否则会剩下一个看不见、也叫不回来的进程
    if (!hideOnClose) void quit()
  })

  // macOS 惯例：关闭所有窗口后应用仍在 Dock 里活着，点 Dock 图标要能把面板叫回来。
  // 不接这个事件的话，配合上面 macOS 上 hideOnClose 为真、window-all-closed 因此不退出，
  // 用户在 macOS 上关窗后点 Dock 图标会毫无反应——而 macOS 的托盘惯例是左键弹菜单（见 tray.ts），
  // 不像 Windows/Linux 那样点一下就能显示面板，Dock 图标就是 macOS 上唯一的等价入口。
  app.on("activate", () => void showWindow())

  app
    .whenReady()
    .then(async () => {
      cleanupLegacyEntries(autostartStateFile) // 迁移：旧 SEA 版的自启项会拉起旧 exe，和本应用抢端口

      // 版本变化即清一次 HTTP 缓存：必须在任何窗口 loadURL 之前（showWindow 最早在本回调末尾
      // 才被调用，这里天然满足）。窗口经 http://127.0.0.1:{port} 加载带哈希的前端资源，旧的
      // 入口 index.html 一旦被 Electron 的 HTTP 缓存留住，升级后仍会指向旧哈希、端出整套旧界面；
      // 重装应用不会清 userData 里的这份缓存，因此在这里按版本号自己清。读不出上次版本（缺失/
      // 损坏）时 loadLastVersion 返回 null，与当前版本必不相等，于是也清一次——无害（顶多多一次
      // 资源重新拉取），见 version-state.ts。clearCache 失败不应阻断启动，包在 try 里记日志即可。
      const lastVersion = loadLastVersion(versionStateFile)
      if (lastVersion !== appVersion) {
        try {
          await session.defaultSession.clearCache()
          console.log(`[repo-radar] 版本变化（${lastVersion ?? "未知"} → ${appVersion}），已清 HTTP 缓存`)
        } catch (err) {
          console.warn(`[repo-radar] 清 HTTP 缓存失败（不影响启动）:`, err)
        }
        // 无论清缓存成功与否都记下当前版本：失败也记，避免每次启动都重复尝试清（顶多这一次没清成，
        // 下次升级前不再打扰）；写盘失败同样只记日志、不阻断启动
        try {
          saveLastVersion(versionStateFile, appVersion)
        } catch (err) {
          console.warn(`[repo-radar] 记录版本号失败（下次启动可能重复清一次缓存）:`, err)
        }
      }

      try {
        await backend.start()
        markBackendReady() // 端口定下来了，showWindow() 可以放行
      } catch (err) {
        markBackendFailed(err)
        const e = err as NodeJS.ErrnoException
        const portIssue = e.code === "EADDRINUSE" || e.code === "EACCES"
        // 关掉回退时（显式端口 / 开发模式）失败的就是那一个端口，得说清楚是哪个、以及为什么
        // 没有自动换——否则用户会以为应用"随便挑个端口"这件事失灵了
        const msg = !portIssue
          ? `启动失败：${e.message}`
          : PORT_IS_EXPLICIT
            ? `端口 ${PORT} 无法监听（${e.code}）。这是你通过 REPO_RADAR_PORT 指定的端口，不会自动改用别的——` +
              `换一个再试，或去掉该变量改用默认端口 ${DEFAULT_PORT}。`
            : isDev
              ? `端口 ${PORT} 无法监听（${e.code}）。开发模式下不自动换端口（vite 的代理目标是固定的），` +
                `请设置 REPO_RADAR_PORT 换一个端口，它会同时作用于后端和 vite。`
              : `本机所有候选端口都无法监听（${e.code}）：${e.message}\n可能是安全软件/防火墙拦截了本地回环监听。`
        // 必须先落日志再弹框：对话框里指向的就是这个日志文件，而"启动失败"恰恰是最需要
        // 日志的场景。原先这条路径只弹框不写日志，用户打开日志只会看到一片与本次失败无关的
        // 旧内容，等于把唯一的线索指向了空白
        console.error(`[repo-radar] 后端启动失败（${e.code ?? "no code"}）: ${e.stack ?? e.message}`)
        dialog.showErrorBox("repo-radar", `${msg}\n\n日志：${logFilePath(configDir)}`)
        app.exit(1)
        return
      }
      tray = createTray(trayIconPath, {
        show: () => void showWindow(),
        rescan: () => void fetch(`http://127.0.0.1:${backend.port}/api/scan`, { method: "POST" }).catch(() => {}),
        openLogs: () => void shell.openPath(logFilePath(configDir)),
        quit: () => void quit(),
      })
      if (!startsHidden(process.argv, app.getLoginItemSettings().wasOpenedAsHidden)) void showWindow()
    })
    .catch((err) => {
      // backend.start() 失败已经在上面的 try/catch 里弹过框、app.exit(1) 并 return 了，
      // 不会流到这个 .catch；能走到这里的，一定是它之后的代码抛的——比如托盘图标文件缺失时
      // new Tray() 会抛。不接这个 .catch 的话就是一个 unhandled rejection，应用悄悄没反应，
      // 用户毫无线索。
      // 注意这里能走到，说明 backend.start() 已经成功过：后端正在监听、watcher 持有文件句柄、
      // 启动扫描可能还没跑完——"quit() 是唯一出口"这条不变量在这个窗口期依然要成立。原先这里
      // 直接 app.exit(1)，会绕开 quit()/backend.stop()：排空 git 写操作被跳过、
      // inboxCache.flush() 也不会跑。改成 quit(1) 走完整收尾——退出码仍传 1，
      // 表示这是一次失败退出（区别于托盘/正常退出的 0），不代表收尾步骤本身有任何不同。
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
      console.error(`[repo-radar] 启动阶段未处理的异常: ${msg}`)
      dialog.showErrorBox("repo-radar", `启动失败：${msg}\n\n日志：${logFilePath(configDir)}`)
      void quit(1)
    })
}

// 单实例：拿不到锁说明已有实例在跑，本进程立刻退场，由在位实例把窗口叫回来。
// 这取代了原先「绑定端口 + 探测占用者身份」那一整套——进程级的锁没有端口那种释放窗口期。
//
// 注意：这里必须用 if/else 分流到 bootstrap()，不能只调 app.exit() 就完事——
// app.exit() 不会中断当前 tick 的同步执行，模块顶层紧随其后的语句（createBackend、
// second-instance 监听、app.whenReady 回调）仍会被求值。真正跑起来的话，
// createBackend 会在配置文件不存在时写出默认配置（并发写同一文件），
// whenReady 回调里的 backend.start() 还会因为端口已被在位实例占用而弹出
// 「端口被占用」错误对话框——这正是引入进程级锁想要消灭的东西。
if (!app.requestSingleInstanceLock()) {
  // 输掉竞争：在位实例会收到 second-instance 事件把窗口叫回来，本进程不做任何事直接退场
  console.log("[repo-radar] 已有实例在运行，本进程退场 / already running, exiting")
  app.exit(0)
} else {
  bootstrap()
}

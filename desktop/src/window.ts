import { BrowserWindow, screen, shell } from "electron"
import { loadState, MIN_HEIGHT, MIN_WIDTH, saveState, type WindowState } from "./window-state"

/**
 * 缺陷 4：拦下来的导航（will-navigate 拦截的站外跳转、setWindowOpenHandler 拦下的
 * target="_blank"/window.open）之前被原样交给 shell.openExternal——它会按系统协议关联
 * 启动对应程序，不做协议限制的话，页面里的 file:/ms-msdt:/smb: 等自定义协议会被原样
 * 交给操作系统处理，等于把"点一下链接"变成任意协议触发的入口。这个应用的所有外链
 * 都是 GitHub 网页，因此只放行 http/https，其余一律拒绝——两个入口共用这一个判定，
 * 不重复写协议白名单。解析失败的字符串同样拒绝："看不懂就当作允许"是把守卫开了个后门。
 */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

/**
 * will-navigate 专用：导航目标是否与站内同源。必须比较解析后的 origin，不能用字符串
 * 前缀比较（曾经的写法 `targetUrl.startsWith(baseUrl)`）——`http://127.0.0.1:7420@evil.example/`
 * 这类带 userinfo 的地址会通过前缀比较（`@` 前面只是 userinfo，真正的 host 是
 * evil.example），`http://127.0.0.1:74209/`（端口只是多一位数字）也会通过；而窗口没有
 * 地址栏、菜单也被去掉了，用户完全看不出已经离开本应用。解析失败的一律判定为非同源
 * （拦下交给系统浏览器），不能因为解析失败就放行。
 */
export function isSameOrigin(url: string, baseOrigin: string): boolean {
  try {
    return new URL(url).origin === baseOrigin
  } catch {
    return false
  }
}

export type WindowShortcut = "devtools" | "zoom-in" | "zoom-out" | "zoom-reset" | null

/**
 * 键盘输入 → 窗口快捷键动作。应用菜单被去掉后（见 main.ts），默认菜单 View 项提供的开发者
 * 工具（F12）与缩放（Ctrl/Cmd +/-/0）一并失去了入口，这里把它们补回来。抽成纯函数便于测试：
 * 只读 type/key/control/meta，不碰 webContents。macOS 认 Cmd（meta），其它平台认 Ctrl（control）。
 * 注意主键盘的 '+' 在未按 Shift 时上报为 '='，小键盘上报 '+'，两者都算放大；没有修饰键的
 * +/-/0 是正常输入，不能当快捷键。keyUp 一律忽略，否则一次按键会触发两遍。
 */
export function resolveShortcut(
  input: { type: string; key: string; control: boolean; meta: boolean },
  platform: NodeJS.Platform,
): WindowShortcut {
  if (input.type !== "keyDown") return null
  if (input.key === "F12") return "devtools"
  const mod = platform === "darwin" ? input.meta : input.control
  if (!mod) return null
  if (input.key === "=" || input.key === "+") return "zoom-in"
  if (input.key === "-") return "zoom-out"
  if (input.key === "0") return "zoom-reset"
  return null
}

/**
 * 渲染进程崩溃后是否自动重载。常驻托盘的应用崩了只会剩个空白窗口，点托盘也叫不回内容，
 * 所以默认重载把界面救回来；但用滑动窗口防抖——windowMs 内崩溃次数超过 max，说明是某个
 * "必崩"状态、重载也救不回，继续硬重载只会把 CPU 打满，于是停手交给调用方记日志。
 * 返回是否重载 + 裁掉过期记录后的新时间戳数组（纯函数，便于测试）。
 */
export function decideCrashReload(
  recent: number[],
  now: number,
  windowMs = 60_000,
  max = 3,
): { reload: boolean; recent: number[] } {
  const pruned = recent.filter((t) => now - t < windowMs)
  pruned.push(now)
  return { reload: pruned.length <= max, recent: pruned }
}

export interface WindowOptions {
  url: string
  stateFile: string
  iconPath: string
  isQuitting: () => boolean
  hideOnClose: boolean // false 时关窗即真正关闭（Linux；见 main.ts 里的取舍说明）
}

/**
 * 保存窗口当前的位置/尺寸/最大化状态到 stateFile。createWindow 内部的高频保存
 * （resized/moved/close）与 main.ts 里 quit() 收尾时的一次性补存共用同一份实现，
 * 避免两处各写一份、口径跑偏。导出它是因为唯一的真退出路径 quit() -> app.exit() 是
 * 强制终止，根本不会触发窗口的 close 事件——main.ts 必须能在收尾阶段主动调用它，
 * 而不是继续指望「凑巧最近触发过 resized/moved」。
 */
export function saveWindowState(win: BrowserWindow, stateFile: string): void {
  // 已销毁的窗口查询 bounds 要么拿不到有意义的值、要么直接抛异常——跳过，保留磁盘上已有的状态
  if (win.isDestroyed()) return
  // 缺陷 3：最小化的窗口在 Windows 上 getBounds()/getNormalBounds() 常常返回占位坐标
  // （典型值如 x=-32000,y=-32000,width=160,height=28），isMaximized() 也是 false——不是
  // 用户想要恢复的布局。用户最大化 -> 最小化 -> 从托盘退出，这条路径若不跳过就会把这份
  // 占位值当成"最后的好状态"存下去，尺寸小于 MIN_WIDTH/MIN_HEIGHT 还会被下次加载时的
  // sanitizeState 当"太小"丢弃，窗口回退到默认 1280x860 居中——用户精心摆好的布局被
  // 无声抹掉。跳过持久化，保留上一次（未最小化时）已经存下的好状态，才是正确行为。
  if (win.isMinimized()) return
  const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
  const next: WindowState = { ...bounds, maximized: win.isMaximized() }
  saveState(stateFile, next)
}

/**
 * 主窗口。前端仍通过 HTTP 与本机后端通信，因此渲染进程不需要任何 Node 能力——
 * 保持 contextIsolation 开、nodeIntegration 关，也就不需要 preload。
 */
export function createWindow(options: WindowOptions): BrowserWindow {
  const { url, stateFile, iconPath, isQuitting, hideOnClose } = options
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const state = loadState(stateFile, displays)

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false, // 等 ready-to-show 再显示，避免白屏闪一下
    // 只有 Linux 真正需要这个：Windows 从 exe 的图标资源取（NSIS 打包时嵌进去的），
    // macOS 从 .app 包的 Info.plist/icns 取，两者都不认 BrowserWindow 的 icon 选项；
    // Linux 桌面环境没有等价的"可执行文件自带图标"机制，Electron 不会自动反查，
    // 不传的话任务栏/Alt-Tab 切换器上会显示通用的 Electron 图标。iconPath 由调用方
    // （main.ts）传入，这里不硬编码路径——window.ts 不该关心图标文件实际在哪。
    icon: iconPath,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  if (state.maximized) win.maximize()
  win.once("ready-to-show", () => win.show())

  // 站内 origin：前端所有 `target="_blank"`/`window.open` 都指向外部链接（GitHub 仓库/PR/issue），
  // 不拦截的话 Electron 默认行为是新建一个没有地址栏/前进后退、却与主窗口共用 session 的裸窗口——
  // 既是功能倒退（用户到不了系统浏览器），也是安全边界缺口（该窗口仍能任意导航、加载任意站点）。
  // baseUrl 用调用方传入的 url 派生，dev（5173）与 prod（7420）都能正确算作「站内」。
  const baseUrl = new URL(url).origin
  // 打开外部链接前统一过一遍协议白名单（见 isAllowedExternalUrl 的注释）——
  // 只放行 http/https，其余记一行日志、直接忽略，不交给 shell.openExternal
  const openExternalIfAllowed = (targetUrl: string): void => {
    if (isAllowedExternalUrl(targetUrl)) {
      void shell.openExternal(targetUrl)
    } else {
      console.warn(`[repo-radar] 拒绝打开非 http/https 链接: ${targetUrl}`)
    }
  }
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    openExternalIfAllowed(targetUrl)
    return { action: "deny" }
  })
  // will-navigate 防的是站内页面被整体导航到外部地址（比如某个 <a> 忘了加 target="_blank"）；
  // 只放行同源导航（isSameOrigin），其余一律拦下，再过一遍协议白名单后交给系统浏览器打开。
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isSameOrigin(targetUrl, baseUrl)) {
      event.preventDefault()
      openExternalIfAllowed(targetUrl)
    }
  })

  // 应用菜单被去掉了（见 main.ts），默认菜单 View 项提供的开发者工具（F12）与缩放
  // （Ctrl/Cmd +/-/0）一并失去了入口，这里用 before-input-event 补回来。判定抽到 resolveShortcut。
  win.webContents.on("before-input-event", (_event, input) => {
    const wc = win.webContents
    switch (resolveShortcut(input, process.platform)) {
      case "devtools":
        wc.toggleDevTools()
        break
      case "zoom-in":
        wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 3)) // 上限 +3 ≈ 300%，防误触无限放大
        break
      case "zoom-out":
        wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3)) // 下限 -3 ≈ 50%
        break
      case "zoom-reset":
        wc.setZoomLevel(0)
        break
    }
  })

  // 崩溃/加载失败兜底：常驻托盘的应用一旦渲染进程崩了或页面没加载出来，用户点托盘只会看到
  // 一片空白，除了杀进程无路可走——这里尽力把界面救回来。
  // render-process-gone：渲染进程异常结束（崩溃/OOM/被杀）就重载；clean-exit（正常退出，
  // 比如我们自己关窗）不处理。用 decideCrashReload 做滑动窗口防抖，避免"崩溃→重载→崩溃"死循环。
  let crashTimes: number[] = []
  win.webContents.on("render-process-gone", (_event, details) => {
    if (win.isDestroyed() || details.reason === "clean-exit") return
    console.error(`[repo-radar] 渲染进程异常结束: reason=${details.reason} exitCode=${details.exitCode}`)
    const decision = decideCrashReload(crashTimes, Date.now())
    crashTimes = decision.recent
    if (decision.reload) win.webContents.reload()
    else console.error("[repo-radar] 渲染进程 1 分钟内反复崩溃，停止自动重载以免死循环；请从托盘退出后重启")
  })

  // did-fail-load：主frame 加载失败（如后端短暂抽风、连接被拒）就延时重试；errorCode -3 是
  // ERR_ABORTED（正常导航被打断，比如我们主动再次 loadURL），不是错误，忽略。重试设上限防止
  // 后端一直起不来时无限重试刷屏。did-finish-load 成功后清零，让下次真失败能重获完整重试额度。
  let loadRetries = 0
  win.webContents.on("did-finish-load", () => {
    loadRetries = 0
  })
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return
    console.error(`[repo-radar] 页面加载失败: ${errorCode} ${errorDescription} @ ${validatedURL}`)
    if (loadRetries >= 5) {
      console.error("[repo-radar] 多次重试仍无法加载，停止重试；请检查后端是否在运行、或从托盘退出后重启")
      return
    }
    loadRetries++
    setTimeout(() => {
      if (!win.isDestroyed()) void win.loadURL(url)
    }, 1000)
  })

  // 渲染进程卡住（长任务/死循环）：先记一行，通常会自行恢复；不弹框打扰、也不强杀
  win.on("unresponsive", () => console.error("[repo-radar] 窗口无响应（渲染进程卡住），等待恢复中"))

  const persist = (): void => saveWindowState(win, stateFile)
  // 拖动/缩放会高频触发，但落盘只是一次小 JSON 写；关闭时再存一次，覆盖最后的状态
  win.on("resized", persist)
  win.on("moved", persist)
  win.on("close", (event) => {
    persist()
    // 关窗口 = 收到托盘继续后台跑——但仅当 hideOnClose 为真时（Linux 上为假，见 main.ts）。
    // 注意：当前唯一的退出路径 quit() 最终调用 app.exit()，它是强制终止进程，根本不会
    // 触发窗口的 close 事件——所以下面「isQuitting() 为真则放行」这条分支眼下永远走不到。
    // 窗口状态在这条路径上的持久化，靠的是 main.ts 的 quit() 收尾主动调用上面导出的
    // saveWindowState()（见那边的注释），不再单靠这里。留着这条 close 分支是为了未来可能
    // 出现的 win.close() / app.quit() 路径（那些路径会真的触发 close 事件），不代表它是当前主路径。
    if (hideOnClose && !isQuitting()) {
      event.preventDefault()
      win.hide()
    }
  })

  void win.loadURL(url)
  return win
}

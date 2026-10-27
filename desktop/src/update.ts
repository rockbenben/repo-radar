import { app, type BrowserWindow, dialog } from "electron"
import { autoUpdater, type UpdateCheckResult } from "electron-updater"
import { repository } from "../../package.json"
import { mainT } from "./i18n"

/**
 * 应用内更新检查。
 *
 * **默认关闭**：开关在设置面板里（config.checkUpdates），用户不打开就一次网络请求都不发。
 * 这个应用是本地优先的，联网这件事得由用户自己按下那个开关。
 *
 * **下载和安装都要用户点头**：electron-updater 默认 autoDownload=true（一发现新版就开下）、
 * autoInstallOnAppQuit=true（下载完退出应用就顺手装上）。两条都要关掉——否则
 * 「告诉用户有新版」就变成了「悄悄把用户的二进制换掉」。
 */

/** 一次检查的结果。调用方（设置面板、托盘菜单）只需要知道这个，不必知道 electron-updater 的细节 */
export type UpdateOutcome = "upToDate" | "available" | "downloaded" | "failed" | "skipped"

export interface UpdateHost {
  /** 主窗口。托盘应用大部分时间没有可见窗口，弹窗挂到它身上才不会飘在别处 */
  getWindow: () => BrowserWindow | null
}

/**
 * 发布页地址。**唯一事实源是 package.json 的 repository 字段**，不另写一份副本。
 * 下载失败时它是指给用户看的第二条路——应用内更新失败不该是死路。
 */
const RELEASES_URL = (() => {
  const url = (repository as { url?: string }).url ?? ""
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
  return m ? `https://github.com/${m[1]}/${m[2]}/releases/latest` : ""
})()

// 开发运行不是产品界面：这两种语言够开发者看懂，不值得为它扩 18 语词表
const DEV_TITLE = "开发运行不检查更新 / Update checks are disabled in development"
const DEV_DETAIL = "只有打包后的应用才有更新可查 / Only packaged builds have releases to check."

/**
 * autoUpdater 是进程级单例，事件挂在它身上。
 *
 * error 事件**必须**有人听：EventEmitter 在没有监听者时会抛未捕获异常，而打包后的
 * 应用没有控制台，这一次崩溃会直接带走整个应用（连日志都来不及写）。
 */
let errorListenerAttached = false
function attachErrorListener(): void {
  if (errorListenerAttached) return
  errorListenerAttached = true
  autoUpdater.on("error", (err: Error) => {
    // 只记日志：检查失败（离线、限流、发布页还没准备好）都不值得弹一个用户没法处理的框
    console.warn(`[repo-radar] 更新检查出错: ${err?.message ?? err}`)
  })
}

type ConfirmOptions = {
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

/**
 * 统一弹原生框。dialog 在主窗口销毁的瞬间可能 reject；不接住的话它会在 Node 24
 * 变成 unhandledRejection → uncaughtException → app.exit(1)，一次查更新把应用带走。
 * 失败按「用户取消」处理，让调用方什么都不做。
 */
async function confirm(host: UpdateHost, options: ConfirmOptions): Promise<number> {
  const win = host.getWindow()
  const full = { type: "info" as const, ...options }
  try {
    const result = win && !win.isDestroyed() ? await dialog.showMessageBox(win, full) : await dialog.showMessageBox(full)
    return result.response
  } catch (err) {
    console.warn(`[repo-radar] 更新对话框失败: ${err instanceof Error ? err.message : String(err)}`)
    return options.cancelId ?? 1
  }
}

/** 弹一个只有「好」按钮的框。有窗口就挂在窗口上 */
async function say(host: UpdateHost, lang: string, message: string, detail: string): Promise<void> {
  await confirm(host, {
    message,
    detail,
    buttons: [mainT(lang, "update.ok")],
    defaultId: 0,
    cancelId: 0,
  })
}

// 同一次更新流程只跑一遍：启动 5 秒后的自动检查、托盘、设置面板可能同时触发；
// 每个调用都跑自己的对话框会把「发现新版本」叠成一摞。
let inFlight: Promise<UpdateOutcome> | null = null
let inFlightManual = false
// 自动检查失败是静默的；手动检查恰好加入时要把真实原因补给它
let lastError: string | null = null

/**
 * 查一次更新。
 *
 * manual=true（设置面板/托盘菜单点的那一下）**一定**给用户一个说法：已是最新、
 * 失败了、还是有新版——点了没反应会被误读成「已是最新」。
 * manual=false（启动时的自动检查）只在真有新版时才出声，其余一律沉默。
 *
 * lang 是 web 传来的当前界面语言；托盘/启动检查不传，回退到系统 locale。
 */
export function checkForUpdates(host: UpdateHost, manual: boolean, lang?: string): Promise<UpdateOutcome> {
  if (inFlight) {
    // 手动点击加入了一场自动检查：自动检查本身不报「已是最新」，这里补一次回执
    if (!manual || inFlightManual) return inFlight
    const pending = inFlight
    return pending.then(async (outcome) => {
      const tag = lang ?? app.getLocale()
      if (outcome === "upToDate") {
        await say(host, tag, mainT(tag, "update.upToDateTitle"), mainT(tag, "update.upToDateDetail"))
      } else if (outcome === "failed") {
        await say(host, tag, mainT(tag, "msg.updateCheckFail"), mainT(tag, "update.failedDetail", { err: lastError ?? "—" }))
      }
      return outcome
    })
  }
  inFlightManual = manual
  inFlight = runCheck(host, manual, lang).finally(() => {
    inFlight = null
    inFlightManual = false
  })
  return inFlight
}

/** 兜底：更新流程不能把 rejection 漏给 void 调用点（那会走 uncaughtException 直接退出） */
async function runCheck(host: UpdateHost, manual: boolean, lang?: string): Promise<UpdateOutcome> {
  try {
    return await runCheckInner(host, manual, lang)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    lastError = msg
    console.warn(`[repo-radar] 更新流程异常: ${msg}`)
    return "failed"
  }
}

async function runCheckInner(host: UpdateHost, manual: boolean, lang?: string): Promise<UpdateOutcome> {
  const tag = lang ?? app.getLocale()
  const t = (key: string, params?: Record<string, string | number>) => mainT(tag, key, params)
  attachErrorListener()
  // 开发运行不查：本地跑起来的版本号和发布页上的没有可比性，查了只会得到一句噪声
  if (!app.isPackaged) {
    if (manual) await say(host, tag, DEV_TITLE, DEV_DETAIL)
    return "skipped"
  }
  // 发现新版只通知，下载由用户点「下载」触发
  autoUpdater.autoDownload = false
  // 下载完也不在退出时自动装：装不装必须用户点过「现在安装」
  autoUpdater.autoInstallOnAppQuit = false

  let result: UpdateCheckResult | null
  try {
    result = await autoUpdater.checkForUpdates()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    lastError = msg
    console.warn(`[repo-radar] 检查更新失败: ${msg}`)
    if (manual) await say(host, tag, t("msg.updateCheckFail"), t("update.failedDetail", { err: msg }))
    return "failed"
  }
  lastError = null
  if (!result?.isUpdateAvailable) {
    if (manual) await say(host, tag, t("update.upToDateTitle"), t("update.upToDateDetail"))
    return "upToDate"
  }

  const newVersion = result.updateInfo.version
  const first = await confirm(host, {
    message: t("update.availableTitle", { version: newVersion }),
    detail: t("update.availableDetail"),
    buttons: [t("update.download"), t("update.later")],
    defaultId: 0,
    cancelId: 1,
  })
  if (first !== 0) return "available" // 用户说「稍后」：什么都不做，也不留半个下载

  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[repo-radar] 下载更新失败: ${msg}`)
    const detail = RELEASES_URL
      ? t("update.downloadFailedDetail", { err: msg, url: RELEASES_URL })
      : t("update.failedDetail", { err: msg })
    await say(host, tag, t("update.downloadFailedTitle"), detail)
    return "failed"
  }

  const second = await confirm(host, {
    message: t("update.downloadedTitle", { version: newVersion }),
    detail: t("update.downloadedDetail"),
    buttons: [t("update.installNow"), t("update.later")],
    defaultId: 0,
    cancelId: 1,
  })
  if (second !== 0) return "downloaded" // 装不装由用户决定；已经下好的包留在缓存里
  try {
    autoUpdater.quitAndInstall()
  } catch (err) {
    console.warn(`[repo-radar] 启动安装失败: ${err instanceof Error ? err.message : String(err)}`)
    return "failed"
  }
  return "downloaded"
}

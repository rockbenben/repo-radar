import { app, type BrowserWindow, dialog } from "electron"
import { autoUpdater, type UpdateCheckResult } from "electron-updater"
import { repository } from "../../package.json"

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

/** 弹一个只有「好」按钮的框。有窗口就挂在窗口上 */
async function say(host: UpdateHost, message: string, detail: string): Promise<void> {
  const win = host.getWindow()
  const options = { type: "info" as const, message, detail, buttons: ["好"], defaultId: 0 }
  if (win && !win.isDestroyed()) await dialog.showMessageBox(win, options)
  else await dialog.showMessageBox(options)
}

/**
 * 查一次更新。
 *
 * manual=true（设置面板/托盘菜单点的那一下）**一定**给用户一个说法：已是最新、
 * 失败了、还是有新版——点了没反应会被误读成「已是最新」。
 * manual=false（启动时的自动检查）只在真有新版时才出声，其余一律沉默。
 */
export async function checkForUpdates(host: UpdateHost, manual: boolean): Promise<UpdateOutcome> {
  attachErrorListener()
  // 开发运行不查：本地跑起来的版本号和发布页上的没有可比性，查了只会得到一句噪声
  if (!app.isPackaged) {
    if (manual) await say(host, "开发运行不检查更新", "只有打包后的应用才有更新可查。")
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
    console.warn(`[repo-radar] 检查更新失败: ${msg}`)
    if (manual) await say(host, "检查更新失败", `没能连上发布服务器：${msg}`)
    return "failed"
  }
  if (!result?.isUpdateAvailable) {
    if (manual) await say(host, "已是最新版本", "当前运行的就是最新发布版。")
    return "upToDate"
  }

  const newVersion = result.updateInfo.version
  const win = host.getWindow()
  const first = await (win && !win.isDestroyed()
    ? dialog.showMessageBox(win, {
        type: "info",
        message: `发现新版本 v${newVersion}`,
        detail: "要现在下载吗？下载完成后还会再问一次是否安装。",
        buttons: ["下载", "稍后"],
        defaultId: 0,
        cancelId: 1,
      })
    : dialog.showMessageBox({
        type: "info",
        message: `发现新版本 v${newVersion}`,
        detail: "要现在下载吗？下载完成后还会再问一次是否安装。",
        buttons: ["下载", "稍后"],
        defaultId: 0,
        cancelId: 1,
      }))
  if (first.response !== 0) return "available" // 用户说「稍后」：什么都不做，也不留半个下载

  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[repo-radar] 下载更新失败: ${msg}`)
    await say(host, "下载更新失败", RELEASES_URL ? `${msg}\n\n也可以到发布页手动下载：${RELEASES_URL}` : msg)
    return "failed"
  }

  const second = await (win && !win.isDestroyed()
    ? dialog.showMessageBox(win, {
        type: "info",
        message: `新版本 v${newVersion} 已下载`,
        detail: "现在退出并安装吗？安装会重启应用。",
        buttons: ["现在安装", "稍后"],
        defaultId: 0,
        cancelId: 1,
      })
    : dialog.showMessageBox({
        type: "info",
        message: `新版本 v${newVersion} 已下载`,
        detail: "现在退出并安装吗？安装会重启应用。",
        buttons: ["现在安装", "稍后"],
        defaultId: 0,
        cancelId: 1,
      }))
  if (second.response !== 0) return "downloaded" // 装不装由用户决定；已经下好的包留在缓存里
  autoUpdater.quitAndInstall()
  return "downloaded"
}

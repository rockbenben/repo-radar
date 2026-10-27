import { Menu, nativeImage, Tray } from "electron"

export interface TrayActions {
  show: () => void
  rescan: () => void
  openLogs: () => void
  checkUpdate: () => void
  quit: () => void
}

export interface TrayLabels {
  show: string
  rescan: string
  checkUpdate: string
  openLogs: string
  quit: string
}

/**
 * 托盘。窗口关闭后应用继续在这里活着——监听、定时拉取都还在跑，
 * 所以「退出」必须在这个菜单里，否则用户没有正经的退出入口。
 */
export function createTray(iconPath: string, actions: TrayActions, labels: TrayLabels): Tray {
  const tray = new Tray(nativeImage.createFromPath(iconPath))
  tray.setToolTip("repo-radar")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.show, click: actions.show },
      { label: labels.rescan, click: actions.rescan },
      { label: labels.checkUpdate, click: actions.checkUpdate },
      { label: labels.openLogs, click: actions.openLogs },
      { type: "separator" },
      { label: labels.quit, click: actions.quit },
    ]),
  )
  // macOS 的托盘惯例是点击即弹菜单，Electron 已默认如此；Windows/Linux 上左键点图标应当显示面板
  if (process.platform !== "darwin") tray.on("click", actions.show)
  return tray
}

import { Menu, nativeImage, Tray } from "electron"

export interface TrayActions {
  show: () => void
  rescan: () => void
  openLogs: () => void
  quit: () => void
}

/**
 * 托盘。窗口关闭后应用继续在这里活着——监听、定时拉取都还在跑，
 * 所以「退出」必须在这个菜单里，否则用户没有正经的退出入口。
 */
export function createTray(iconPath: string, actions: TrayActions): Tray {
  const tray = new Tray(nativeImage.createFromPath(iconPath))
  tray.setToolTip("repo-radar")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示面板", click: actions.show },
      { label: "立即重扫", click: actions.rescan },
      { label: "打开日志", click: actions.openLogs },
      { type: "separator" },
      { label: "退出", click: actions.quit },
    ]),
  )
  // macOS 的托盘惯例是点击即弹菜单，Electron 已默认如此；Windows/Linux 上左键点图标应当显示面板
  if (process.platform !== "darwin") tray.on("click", actions.show)
  return tray
}

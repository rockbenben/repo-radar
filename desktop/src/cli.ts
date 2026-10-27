/** 自启注册项带的参数：登录后静默起托盘，用户想看面板时再点托盘/双击应用 */
export const TRAY_FLAG = "--tray"

/**
 * 是否应当「只起托盘、不弹窗」。两个来源：
 *   Windows/Linux —— 自启项的命令行里带 --tray
 *   macOS —— 登录项不带参数，由 app.getLoginItemSettings().wasOpenedAtLogin 告知
 * 用精确相等而不是 includes 子串匹配：路径里出现 "--tray" 字样不该被当成参数。
 *
 * wasOpenedAtLogin 是 Electron 44 起的新字段，顶掉了被移除的 wasOpenedAsHidden：
 * 后者连同写入侧的 openAsHidden 一起没了——官方说法是「这些只在 macOS 12 及更早版本上
 * 有效」，而 macOS 12 已被 Chromium 放弃。新的字段直接回答「这次是不是登录时自动拉起来的」，
 * 不再依赖「能不能被隐藏着拉起」这个在现代 macOS 上已经不成立的机制。
 */
export function startsHidden(argv: string[], wasOpenedAtLogin: boolean): boolean {
  return wasOpenedAtLogin || argv.slice(1).some((a) => a === TRAY_FLAG)
}

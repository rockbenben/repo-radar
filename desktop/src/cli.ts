/** 自启注册项带的参数：登录后静默起托盘，用户想看面板时再点托盘/双击应用 */
export const TRAY_FLAG = "--tray"

/**
 * 是否应当「只起托盘、不弹窗」。两个来源：
 *   Windows/Linux —— 自启项的命令行里带 --tray
 *   macOS —— 登录项不带参数，由 app.getLoginItemSettings().wasOpenedAsHidden 告知
 * 用精确相等而不是 includes 子串匹配：路径里出现 "--tray" 字样不该被当成参数。
 */
export function startsHidden(argv: string[], wasOpenedAsHidden: boolean): boolean {
  return wasOpenedAsHidden || argv.slice(1).some((a) => a === TRAY_FLAG)
}

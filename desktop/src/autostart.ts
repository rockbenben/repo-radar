import { app } from "electron"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { TRAY_FLAG } from "./cli"
import {
  loadMigrationState,
  saveMigrationState,
  type AutostartMigrationState,
} from "./autostart-state"

/**
 * 开机自启。**OS 即事实源**：不落 config，读取时直接问系统，开关永远与现实一致。
 * 三平台实现不同——Windows/macOS 用 Electron 的 setLoginItemSettings，
 * Linux 上该 API 不受支持，沿用 XDG autostart 的 .desktop 文件（逻辑从 server 搬来）。
 */

export interface AutostartState {
  supported: boolean
  enabled: boolean
}

const NAME = "repo-radar"
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
const desktopEntryFile = (home = homedir()): string => join(home, ".config", "autostart", `${NAME}.desktop`)

/** Desktop Entry 规范：Exec 引号内的 " ` $ \ 需反斜杠转义 */
export function autostartDesktopEntry(exePath: string): string {
  const quoted = exePath.replace(/["`$\\]/g, (m) => `\\${m}`)
  return `[Desktop Entry]
Type=Application
Name=repo-radar
Comment=Local Git repo dashboard
Exec="${quoted}" ${TRAY_FLAG}
X-GNOME-Autostart-enabled=true
`
}

/**
 * Linux 自启 .desktop 的 Exec 行该写哪个可执行文件路径。
 * Linux 打包成 AppImage（见 electron-builder.yml），运行时会以 FUSE 挂载到一个临时目录，
 * app.getPath("exe") 拿到的是那个挂载出来的 AppRun（形如 /tmp/.mount_XXXX/AppRun）——
 * 这个路径只在本次运行期间存在，进程一退出挂载就消失，写进自启项下次登录时这条路径
 * 已经不存在，什么都不会启动，而且开关仍显示"已开启"（getAutostart 只检查文件是否存在）。
 * AppImage 运行时会设置 APPIMAGE 环境变量指向用户双击的那个 .AppImage 文件本身，那才是
 * 稳定、跨运行不变的路径，因此优先使用；没有这个变量（比如从源码跑，或未来换成其它
 * Linux 打包形式）时才退回 app.getPath("exe")。
 * appImagePath 做成可注入参数（默认读 process.env.APPIMAGE），这样测试不用真的碰 process.env。
 */
export function autostartExecutablePath(exePath: string, appImagePath = process.env.APPIMAGE): string {
  return appImagePath || exePath
}

export function parseDesktopTarget(text: string): string | null {
  const m = text.match(/^Exec="((?:[^"\\]|\\.)*)"/m)
  return m ? m[1].replace(/\\(["`$\\])/g, "$1") : null
}

/**
 * 从 .desktop 文件内容里取出 Exec 行「路径部分之后」的参数——用来判断这个条目是
 * 上一代（SEA）程序还是当前 Electron 版写的：前者带 --no-open，后者带 --tray（即 TRAY_FLAG）。
 * 解析不出 Exec 行时返回 null，交给 isLegacyEntry 保守处理（无法确认身份就不当成遗留条目）。
 */
export function parseDesktopFlag(text: string): string | null {
  const m = text.match(/^Exec="(?:[^"\\]|\\.)*"\s+(.*)$/m)
  return m ? m[1].trim() : null
}

const xmlUnescape = (s: string): string =>
  s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&")

/** 从 LaunchAgent plist 取出 exe 路径：ProgramArguments 数组的第一个 <string> */
export function parsePlistTarget(xml: string): string | null {
  const m = xml.match(/<array>\s*<string>([\s\S]*?)<\/string>/)
  return m ? xmlUnescape(m[1]) : null
}

/**
 * 从 HKCU Run 值里取出 exe 路径。旧 SEA 版写的是 "<exe>" --no-open，
 * 更早的版本还包过一层 PowerShell（用于隐藏窗口启动）；两种形式都要认，
 * 才能在 cleanupLegacyEntries 里正确判断旧条目是否已指向当前应用。
 * 顺序不能反：包装形式里第一个带引号的词是 powershell 自己的路径——那个文件必然
 * 存在于系统里，按"先取第一个引号内容"的朴素规则解析会把它当成目标，永远判定错误。
 */
export function parseRunValue(value: string): string | null {
  const wrapped = value.match(/-FilePath\s+'((?:[^']|'')*)'/)
  if (wrapped) return wrapped[1].replaceAll("''", "'")
  return value.match(/^"([^"]+)"/)?.[1] ?? null
}

/**
 * 从 HKCU Run 值里取出「路径之后的参数」——用来判断这个值是不是上一代（SEA）程序写的
 * （缺陷 2）。SEA 时代 autostartCommand 写的直接形式是 `"<exe>" --no-open`；更早的
 * PowerShell 包装形式把参数放在 -ArgumentList '...' 里。Electron 版写的是 --tray（TRAY_FLAG），
 * 从不会出现 --no-open。解析不出时返回 null，交给 isLegacyEntry 保守处理。
 */
export function parseRunFlag(value: string): string | null {
  const wrapped = value.match(/-ArgumentList\s+'((?:[^']|'')*)'/)
  if (wrapped) return wrapped[1].replaceAll("''", "'")
  const direct = value.match(/^"[^"]*"\s+(.*)$/)
  return direct ? direct[1].trim() : null
}

/**
 * 从 `reg export` 出来的 .reg 文本里取出某个值。单独抽成纯函数便于测试——
 * 这段解析的正确性只在非 ASCII 路径下才体现，而 CI 跑不到那种环境。
 * .reg 里的值形如：`"repo-radar"="\"C:\\Users\\小明\\app.exe\" --no-open"`，
 * 只有 `\` 和 `"` 会被转义，单趟还原即可。
 */
export function parseRegExport(text: string, name: string): string | null {
  const prefix = `"${name}"=`
  const line = text.split(/\r?\n/).find((l) => l.startsWith(prefix))
  if (!line) return null
  const raw = line.slice(prefix.length).trim()
  if (!raw.startsWith('"') || !raw.endsWith('"')) return null // 非字符串型（REG_DWORD 等）
  return raw.slice(1, -1).replace(/\\(["\\])/g, "$1")
}

/**
 * 读取 Run 键里某个值。**刻意用 `reg export` 而不是 `reg query`**：
 * reg query 按「控制台输出代码页」写 stdout，spawnSync 又固定按 UTF-8 解码 stdout——
 * 中文 Windows 的传统代码页是 936，两者一凑非 ASCII 路径就会被读成乱码（实测
 * `C:\Users\小明\repo-radar.exe` 会读成一串问号/替换字符），进而让子串匹配或路径比较
 * 全部失真：cleanupLegacyEntries 可能把明明指向当前应用的条目误判成"别处"而去删它，
 * 或反过来把已经不同的旧条目误判成"已是当前应用"而放过不清理。
 * .reg 文件则固定是 UTF-16LE 编码，与运行时的控制台代码页无关，解码结果确定，
 * 因此改为导出到临时文件再按 utf16le 读取——这正是历史上已验证过的解法（见 git 历史里
 * 被误删的 server/src/autostart.ts），这里原样接回来。任何一步失败（reg 不在 PATH、
 * 临时目录不可写等）都返回 null，交给 shouldReplaceLegacyEntry 的保守分支处理。
 */
function regReadValue(name: string): string | null {
  const out = join(tmpdir(), `rr-autostart-${process.pid}-${name}.reg`)
  try {
    if (spawnSync("reg", ["export", RUN_KEY, out, "/y"], { stdio: "ignore" }).status !== 0) return null
    return parseRegExport(readFileSync(out, "utf16le"), name)
  } catch {
    return null
  } finally {
    rmSync(out, { force: true })
  }
}

export function getAutostart(home = homedir()): AutostartState {
  // 未打包（开发版）不声称支持自启：真支持的话界面的开关会显示成"打开"，
  // 但 setAutostart 在未打包时其实什么也没写，会呈现"看起来开了、实际没生效"的假象。
  // 显式返回 supported:false，界面据此把开关渲染成"不支持"，语义诚实。
  if (!app.isPackaged) return { supported: false, enabled: false }
  if (process.platform === "linux") return { supported: true, enabled: existsSync(desktopEntryFile(home)) }
  // 写入与读回必须用同一组 args，否则 Windows 上永远匹配不上：Electron 在 Windows 上是拿
  // 传入的 args 拼出命令行，与注册表里存的值做精确字符串比较（见 electron.d.ts 里
  // getLoginItemSettings 的说明："If you provided path and args options to
  // app.setLoginItemSettings, then you need to pass the same arguments here for openAtLogin
  // to be set correctly"）。setAutostart 写入时带的是 args:[TRAY_FLAG]，这里不传就会用空数组
  // 拼出 `"<exe>"` 去与注册表里的 `"<exe>" --tray` 比较，永远不相等，openAtLogin 就恒为 false——
  // 用户打开开关后界面立刻弹回关闭，而自启其实已经注册成功。
  return { supported: true, enabled: app.getLoginItemSettings({ args: [TRAY_FLAG] }).openAtLogin }
}

export function setAutostart(enabled: boolean, home = homedir()): AutostartState {
  // 未打包时 app.getPath("exe") 是 node_modules/electron/dist/electron.exe——
  // 一个随时会被 npm install 覆盖的临时路径，写进开机自启毫无意义且有害
  // （开发者本机调试一次，就会把自己的登录项改成指向这个临时文件）。
  // 因此未打包时直接跳过实际写入，只把当前（必然是"未启用"）状态如实返回。
  if (app.isPackaged) {
    if (process.platform === "linux") {
      const file = desktopEntryFile(home)
      if (enabled) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, autostartDesktopEntry(autostartExecutablePath(app.getPath("exe"))))
      } else {
        rmSync(file, { force: true })
      }
    } else {
      // Windows 走 --tray 参数；macOS 登录项不带参数，用 openAsHidden 表达同一意图
      app.setLoginItemSettings({ openAtLogin: enabled, args: [TRAY_FLAG], openAsHidden: true })
    }
  }
  return getAutostart(home)
}

/**
 * 这份实例要不要把「开机自启」这条能力接给后端（main.ts 的 extras.autostart）。
 *
 * 自启在三个平台上都是**全局唯一一条 OS 条目**：Windows 是 HKCU Run 下值名等于 AUMID 的那一条
 * （com.rockbenben.repo-radar，见 build/installer.nsh）、Linux 是固定路径的
 * ~/.config/autostart/repo-radar.desktop（路径里没有任何 profile 成分）、macOS 是 LaunchServices
 * 里的同一个 .app。而写进去的命令行只有 `"<exe>" --tray`，**带不上 REPO_RADAR_CONFIG /
 * REPO_RADAR_PORT**——README 承诺的「用这两个变量再跑一份完全独立的实例」在自启这条路上兑现不了。
 *
 * 不按配置区分的话：两个实例操作同一条条目、互相覆盖；更实在的是用户为工作 profile 打开的自启，
 * 登录后拉起来的必然是**默认配置**那一份——它会在 ~/.repo-radar/ 现写一份空 roots 的默认配置，
 * 托盘里常驻一个空看板；用户再点自己的快捷方式，锁域不同（main.ts 给非默认配置挪了 userData）
 * 所以两个都跑得起来，托盘里于是两个一模一样的图标、其中一个是空的，全程零提示。
 *
 * 因此非默认配置直接不注入：/api/autostart 会如实回 supported:false（见 server/src/routes.ts），
 * 界面本就按 supported 把整行开关隐藏，不必新增任何文案。
 * 让自启支持多 profile 是另一回事（条目名与 Exec 都要带 profile，且 macOS 登录项不接受参数），
 * 那是新功能，不在这里做。
 */
export function autostartExtra(
  isDefaultConfig: boolean,
): { get: () => AutostartState; set: (enabled: boolean) => AutostartState } | undefined {
  if (!isDefaultConfig) return undefined
  return { get: () => getAutostart(), set: (enabled) => setAutostart(enabled) }
}

/**
 * 判断一个自启条目是不是「上一代（SEA 时代）程序」留下的遗留条目。
 *
 * 缺陷 1（上一轮）的语义修复：上一轮误把 SEA 时代 healAutostart 的规则（"自启指向你放它的
 * 地方；只有当那个文件消失了，才改为当前这份"）搬来当作"是否清理遗留条目"的判据——但那条
 * 规则管的是完全不同的问题：healAutostart 管的是"我们自己的条目指向了被移动/删除的副本"，
 * 目标还在就不该动；这里要管的是"上一代程序留下的条目必须清掉"，目标还在恰恰是问题本身
 * （旧 exe 还在，旧条目就会在下次登录时把它拉起来，抢占端口）。
 *
 * 正确判据是「身份」，与目标文件是否存在无关——三个平台各有稳定的身份标记，
 * 不会随文件被移动/删除而改变：
 *   - Windows（本轮缺陷 2 修复）：不能只看值名是不是 "repo-radar"——用户完全可能手工建过
 *     一个恰好叫这个名字、但指向别的东西的自启项，只看值名会把它也无条件删掉。必须与
 *     Linux 分支同一判据形状：解析出目标路径（parseRunValue）**且**带有 SEA 时代专属的
 *     --no-open 标志（parseRunFlag，SEA 时代 autostartCommand 写的就是 "<exe>" --no-open；
 *     Electron 写的是 --tray，即 TRAY_FLAG，见 setAutostart），两个条件都满足才是遗留条目；
 *     解析不出路径或没带 --no-open，一律保守不动
 *   - macOS：~/Library/LaunchAgents/com.rockbenben.repo-radar.plist 是否存在——Electron 的
 *     setLoginItemSettings 走 LaunchServices（NSApplication 的登录项 API），从不写这个
 *     plist 文件，只有 SEA 时代自己手动 writeFileSync 出来的才会有，因此它存在本身就是
 *     身份标记，不需要看内容
 *   - Linux：.desktop 的 Exec 行带的是 --no-open（SEA）还是 --tray（Electron，即 TRAY_FLAG）——
 *     两代共用同一个文件路径，只能靠内容区分
 *
 * 三个平台的判据形状不同（字符串/布尔/字符串），用一个带 platform 标签的联合类型统一签名，
 * 但仍是同一个函数、同一层语义：identity，not existence。
 */
export type LegacyEntryEvidence =
  | { platform: "win32"; entryValue: string | null }
  | { platform: "darwin"; plistExists: boolean }
  | { platform: "linux"; execFlag: string | null }

export function isLegacyEntry(evidence: LegacyEntryEvidence): boolean {
  switch (evidence.platform) {
    case "win32": {
      if (evidence.entryValue === null) return false // 读不到这个值名，无法确认身份，保守不动
      const targetPath = parseRunValue(evidence.entryValue)
      const flag = parseRunFlag(evidence.entryValue)
      // 两个条件缺一不可：只有值名对上、内容却解析不出路径（格式完全不认识），或者
      // 路径解析得出但带的不是 --no-open（比如用户手工建的同名条目），都不能当成遗留条目
      return targetPath !== null && flag !== null && flag.includes("--no-open")
    }
    case "darwin":
      return evidence.plistExists
    case "linux":
      // null 代表解析不出 Exec 行，无法确认身份，保守不动
      return evidence.execFlag !== null && evidence.execFlag.includes("--no-open")
  }
}

/**
 * 清理遗留条目之后要不要重新启用自启，纯判定（不碰任何 I/O）。
 *
 * 迁移只做一次：`legacyAutostartMigrated` 为 false 说明这是第一次遇到遗留条目，
 * 遗留条目的存在本身就代表"用户在 SEA 时代原本开着自启"（旧程序的自启机制是"存在即启用"），
 * 这份意图需要继承过来，因此调用方应据此调 setAutostart(true)；迁移过一次之后
 * （标记已为 true），哪怕又发现了遗留条目，也不再重新启用——用户可能已经在设置里
 * 主动关掉了自启，不能在没有任何提示的情况下又把它打开。
 *
 * 缺陷 4：参数从 server 端的用户 Config 换成了桌面端专属的 AutostartMigrationState——
 * 这个标记本就是纯粹的桌面端实现细节，不该出现在用户可见/可通过 API 修改的配置里。
 */
export function planLegacyMigration(
  state: AutostartMigrationState,
): { enableAutostart: boolean; nextState: AutostartMigrationState } {
  return {
    enableAutostart: !state.legacyAutostartMigrated,
    nextState: { legacyAutostartMigrated: true },
  }
}

/**
 * 删除遗留条目之后的收尾：按 plan 的决定决定是否重新启用，并把迁移标记落盘。
 *
 * 缺陷 1 第 4 点：setAutostart(true) 与写标记之间如果写盘失败（磁盘满/只读），
 * 自启已经打开了，但标记没能落盘——下次启动 loadMigrationState 仍会读到"未迁移"，
 * 若用户在这期间又手动关掉过自启，会被这次的重试无声打开。无法阻止，但至少要能在
 * 日志里查到原因，因此这里不能吞掉 saveMigrationState 抛出的异常。
 */
function finishMigration(
  stateFile: string,
  home: string,
  plan: { enableAutostart: boolean; nextState: AutostartMigrationState },
): void {
  if (plan.enableAutostart) setAutostart(true, home)
  try {
    saveMigrationState(stateFile, plan.nextState)
  } catch (err) {
    console.error(
      `[repo-radar] 自启迁移标记写入失败，下次启动可能会重复触发迁移（若发现自启被意外重新打开，这就是原因）: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

/**
 * 清理 SEA 版留下的自启条目。不清理的话登录时会把旧 exe 一起拉起来，
 * 两个实例争抢同一个端口——而且失败的那个是新版（旧版先起来占住端口）。
 * 判定是否遗留见 isLegacyEntry；清理后是否重新启用见 planLegacyMigration。
 * home 可注入（默认真实 homedir()），只为了让测试能在临时目录里跑完整流程，
 * 不必也不该在测试中触碰真实用户目录。
 *
 * 缺陷 1 的顺序修复：三个平台分支都改成「先读取并决定，再删除，最后设置自启与写标记」——
 * 上一轮是先删除遗留条目、再调 loadConfig（本轮已改成 loadMigrationState）；后者若因为
 * 状态文件被截断而抛异常，会被本函数末尾的 catch 悄悄吞掉，而条目已经删了、标记也没写，
 * 迁移永远不会再有机会重新跑一次。现在顺序反过来：先探测是不是遗留条目（只读，不破坏
 * 任何东西），确认是之后再读迁移状态——读失败就直接跳过本次清理、记一行日志，一次删除
 * 都不做；只有状态读取成功，才真正删除条目、调用 finishMigration 收尾。
 *
 * stateFile 参数：桌面端专属的迁移状态文件路径（main.ts 里与 window-state.json 放在同一个
 * 配置目录下），不再是 server 端的用户 config 文件（缺陷 4）。
 */
export function cleanupLegacyEntries(stateFile: string, home = homedir()): void {
  // 未打包（开发版）时 app.getPath("exe") 是 node_modules 里的临时 electron.exe：
  // 既不该拿它做任何判断，更不该调用 setAutostart(true) 把它写进用户的真实登录项——
  // 开发者跑一次调试，不该改动自己机器的开机自启配置。
  if (!app.isPackaged) return
  try {
    if (process.platform === "win32") {
      // 旧版写的是 "<exe>" --no-open（或更早的 PowerShell 包装形式），值名固定为 repo-radar；
      // isLegacyEntry 现在同时核验解析出的路径与 --no-open 标志（缺陷 2），这一步只读不写
      const entryValue = regReadValue(NAME)
      if (!isLegacyEntry({ platform: "win32", entryValue })) return
      const stateResult = loadMigrationState(stateFile)
      if (!stateResult.ok) {
        console.error(
          `[repo-radar] 自启迁移状态文件损坏，本次跳过清理遗留自启条目、保留旧条目原样` +
            `（下次启动若状态文件恢复正常会重试）: ${stateResult.error}`,
        )
        return
      }
      const plan = planLegacyMigration(stateResult.state)
      // spawnSync 对非零退出码不抛异常——这里必须显式检查返回值，之前完全没人看它：
      // reg 不在 PATH、或这个值受组策略保护导致删除失败时，会照样把"已迁移"标记写下去。
      // 后果是旧的 SEA 自启项存活下来：此后每次登录新旧两个版本一起启动，旧版先抢到端口，
      // 新版 backend.start() 撞 EADDRINUSE 弹错误框，而标记却说"已迁移"，清理逻辑再也不会
      // 重跑，用户只能自己去 regedit 里删。与 darwin/linux 分支对齐：那两个分支用的是
      // rmSync，失败会抛、被下面的外层 catch 接住，标记不写、下次启动重试——只有 win32
      // 这里之前把没验证过的"成功"记了下来。删除失败就只记日志、不调 finishMigration，
      // 让下次启动重试。
      const deleteResult = spawnSync("reg", ["delete", RUN_KEY, "/v", NAME, "/f"], { stdio: "ignore" })
      if (deleteResult.error || deleteResult.status !== 0) {
        console.error(
          `[repo-radar] 删除遗留自启注册表项失败，本次不标记迁移完成（下次启动会重试）: ${
            deleteResult.error ? deleteResult.error.message : `reg 退出码 ${deleteResult.status}`
          }`,
        )
        return
      }
      finishMigration(stateFile, home, plan)
    } else if (process.platform === "darwin") {
      const plist = join(home, "Library", "LaunchAgents", "com.rockbenben.repo-radar.plist")
      if (!isLegacyEntry({ platform: "darwin", plistExists: existsSync(plist) })) return
      const stateResult = loadMigrationState(stateFile)
      if (!stateResult.ok) {
        console.error(
          `[repo-radar] 自启迁移状态文件损坏，本次跳过清理遗留自启条目、保留旧条目原样` +
            `（下次启动若状态文件恢复正常会重试）: ${stateResult.error}`,
        )
        return
      }
      const plan = planLegacyMigration(stateResult.state)
      rmSync(plist, { force: true })
      finishMigration(stateFile, home, plan)
    } else {
      const file = desktopEntryFile(home)
      if (!existsSync(file)) return
      const flag = parseDesktopFlag(readFileSync(file, "utf8"))
      if (!isLegacyEntry({ platform: "linux", execFlag: flag })) return
      const stateResult = loadMigrationState(stateFile)
      if (!stateResult.ok) {
        console.error(
          `[repo-radar] 自启迁移状态文件损坏，本次跳过清理遗留自启条目、保留旧条目原样` +
            `（下次启动若状态文件恢复正常会重试）: ${stateResult.error}`,
        )
        return
      }
      const plan = planLegacyMigration(stateResult.state)
      rmSync(file, { force: true }) // 显式删掉旧文件——若不重新启用（见上），不该让旧内容原地留着
      finishMigration(stateFile, home, plan)
    }
  } catch (err) {
    // 缺陷 1 第 3 点：这个函数会改动用户机器上的注册表/登录项/文件，静默失败不可接受——
    // 之前这里是空 catch {}，任何异常（reg 不在 PATH、文件系统只读等）都无声消失，
    // 用户看到自启"莫名其妙"地不对，日志里却什么线索都没有
    console.error(
      `[repo-radar] 清理遗留自启条目失败: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

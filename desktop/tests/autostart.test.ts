import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { app } from "electron"
import {
  autostartDesktopEntry,
  autostartExecutablePath,
  autostartExtra,
  cleanupLegacyEntries,
  getAutostart,
  isLegacyEntry,
  parseDesktopFlag,
  parseDesktopTarget,
  parsePlistTarget,
  parseRegExport,
  parseRunFlag,
  parseRunValue,
  planLegacyMigration,
} from "../src/autostart"
import { DEFAULT_MIGRATION_STATE, loadMigrationState } from "../src/autostart-state"

// electron 包在非 Electron 进程里 require 出来是可执行文件路径（字符串），不是 { app }——
// 必须整体 mock 掉，否则 app.isPackaged 会在一个字符串上取属性。同理 mock node:child_process，
// 这样才能对 spawnSync 断言「有没有被调用过」。
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => "/mock/exe"),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn(),
  },
}))
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))

/** process.platform 是只读的 getter，测试里要临时切换到某个平台，用完必须还原 */
const originalPlatform = process.platform
function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
}
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
})

describe("XDG .desktop 条目（Linux 分支，Electron 不支持 setLoginItemSettings）", () => {
  const PATHS = ["/opt/repo-radar/repo-radar", "/home/me/R&D/repo-radar", '/opt/we"ird$path/repo-radar', "/home/me/my repo/repo-radar"]

  it("Exec 带 --tray：登录后静默起托盘", () => {
    expect(autostartDesktopEntry("/opt/repo-radar")).toContain('Exec="/opt/repo-radar" --tray')
  })

  it("Type=Application，且写入后能原样解析回路径", () => {
    for (const p of PATHS) {
      const entry = autostartDesktopEntry(p)
      expect(entry).toContain("Type=Application")
      expect(parseDesktopTarget(entry)).toBe(p)
    }
  })

  it("引号内的 Exec 保留字符按规范做反斜杠转义", () => {
    expect(autostartDesktopEntry('/opt/we"ird$path/repo-radar')).toContain('Exec="/opt/we\\"ird\\$path/repo-radar" --tray')
  })

  it("解析不出路径时返回 null", () => {
    expect(parseDesktopTarget("[Desktop Entry]\nType=Application\n")).toBeNull()
  })
})

// 缺陷 1 的语义修复：cleanupLegacyEntries 判定的是「这个条目是不是上一代（SEA 时代）程序
// 写的」，与「它现在指向的目标文件是否还存在」完全无关——上一轮把 SEA 时代 healAutostart 的
// 规则（"目标还在就别动"，管的是"我们自己的条目指向了被移动的副本"）错误地搬到这里用，
// 后果是：用户从 SEA 版升级到 Electron 版、没删旧 exe → 旧条目的目标文件还在 → 被判定为
// "不动" → 旧版每次登录都会被拉起来，抢占端口。正确判据是身份标记（见下方三个子测试），
// 与目标存在与否无关。
describe("isLegacyEntry — 是否为上一代程序留下的条目，纯粹按身份标记判定（缺陷 1）", () => {
  // 缺陷 2：不能只看值名是不是 repo-radar——用户完全可能手工建过一个恰好叫这个名字、
  // 但指向别的东西的自启项，光看值名存在就无条件删会把它也清掉。必须与 Linux 分支同一
  // 判据形状：解析出目标路径 且 带有 SEA 时代专属的 --no-open 标志，两者都满足才算遗留条目。
  describe("Windows：解析出路径 且 带 --no-open 才算遗留条目，不能只看值名（缺陷 2）", () => {
    it("值名对上、内容能解析出路径、且带 --no-open（SEA 时代 autostartCommand 写的形式）→ 是遗留条目", () => {
      expect(isLegacyEntry({ platform: "win32", entryValue: '"D:\\old-sea\\repo-radar.exe" --no-open' })).toBe(true)
      // 目标文件是否存在完全不影响判定
      expect(isLegacyEntry({ platform: "win32", entryValue: '"D:\\repo-radar\\repo-radar.exe" --no-open' })).toBe(true)
    })

    it("值名对上、能解析出路径，但带的是 --tray（当前 Electron 版自己会写的标志）→ 不是遗留条目", () => {
      expect(isLegacyEntry({ platform: "win32", entryValue: '"D:\\repo-radar\\repo-radar.exe" --tray' })).toBe(false)
    })

    it("值名对上，但内容解析不出路径（格式完全不认识，比如用户手工写的自定义命令）→ 不是遗留条目，保守不动", () => {
      expect(isLegacyEntry({ platform: "win32", entryValue: "SomeOtherApp.exe --whatever" })).toBe(false)
    })

    it("PowerShell 包装形式（更早版本），能解析出路径与 --no-open → 是遗留条目", () => {
      const wrapped =
        `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden ` +
        `-Command "Start-Process -FilePath 'C:\\Apps\\repo-radar.exe' -ArgumentList '--no-open' -WindowStyle Hidden"`
      expect(isLegacyEntry({ platform: "win32", entryValue: wrapped })).toBe(true)
    })

    it("读不到该值名（reg export 失败，或这个值名本就不存在）→ 不是遗留条目，保守不动", () => {
      expect(isLegacyEntry({ platform: "win32", entryValue: null })).toBe(false)
    })
  })

  describe("macOS：LaunchAgents plist 是否存在（Electron 的 setLoginItemSettings 走 LaunchServices，从不写这个文件）", () => {
    it("文件存在 → 一定是遗留条目，不需要看内容、也不需要看目标文件是否存在", () => {
      expect(isLegacyEntry({ platform: "darwin", plistExists: true })).toBe(true)
    })

    it("文件不存在 → 不是遗留条目", () => {
      expect(isLegacyEntry({ platform: "darwin", plistExists: false })).toBe(false)
    })
  })

  describe("Linux：.desktop 的 Exec 行带的是 --no-open（SEA）还是 --tray（Electron，即 TRAY_FLAG）", () => {
    it("带 --no-open → 是遗留条目", () => {
      expect(isLegacyEntry({ platform: "linux", execFlag: "--no-open" })).toBe(true)
    })

    it("带 --tray（当前版本自己写的）→ 不是遗留条目，即使目标文件已经不存在也不动", () => {
      expect(isLegacyEntry({ platform: "linux", execFlag: "--tray" })).toBe(false)
    })

    it("解析不出 Exec 行的参数 → 无法确认身份，保守当作不是遗留条目", () => {
      expect(isLegacyEntry({ platform: "linux", execFlag: null })).toBe(false)
    })
  })
})

describe("parseDesktopFlag — 从 .desktop 文件内容取出 Exec 行末尾的参数", () => {
  it("取出 Exec=\"...\" 之后的参数部分", () => {
    expect(parseDesktopFlag(autostartDesktopEntry("/opt/repo-radar"))).toBe("--tray")
  })

  it("旧版格式（--no-open）同样能取到", () => {
    const legacy = '[Desktop Entry]\nType=Application\nExec="/opt/old/repo-radar" --no-open\n'
    expect(parseDesktopFlag(legacy)).toBe("--no-open")
  })

  it("没有 Exec 行 → null", () => {
    expect(parseDesktopFlag("[Desktop Entry]\nType=Application\n")).toBeNull()
  })
})

// 缺陷 2（上一轮）的语义修复：迁移只做一次。清理掉遗留条目后，只有第一次迁移
// （legacyAutostartMigrated 为 false）才把"用户在 SEA 时代原本开着自启"这个意图继承过来；
// 迁移过一次之后，哪怕又发现了遗留条目（理论上不该发生，但防御性地也不该重新打开），
// 也不再重新启用——不能覆盖用户后来在设置里主动关掉自启这个明确选择。
// 本轮缺陷 4：参数从 server 端 Config 换成了桌面端专属的 AutostartMigrationState。
describe("planLegacyMigration — 清理遗留条目后要不要重新启用自启，纯判定（缺陷 2 + 缺陷 4）", () => {
  it("legacyAutostartMigrated 为 false（第一次迁移）→ 继承自启意图，并把标记置为 true", () => {
    const { enableAutostart, nextState } = planLegacyMigration({ legacyAutostartMigrated: false })
    expect(enableAutostart).toBe(true)
    expect(nextState.legacyAutostartMigrated).toBe(true)
  })

  it("legacyAutostartMigrated 已为 true（迁移过）→ 不再重新启用，标记保持 true", () => {
    const { enableAutostart, nextState } = planLegacyMigration({ legacyAutostartMigrated: true })
    expect(enableAutostart).toBe(false)
    expect(nextState.legacyAutostartMigrated).toBe(true)
  })

  it("与 DEFAULT_MIGRATION_STATE 一致：全新安装默认未迁移", () => {
    expect(DEFAULT_MIGRATION_STATE.legacyAutostartMigrated).toBe(false)
  })
})

describe("parseRunValue — 从 HKCU Run 值里取出 exe 路径", () => {
  /** 更早版本写进 Run 键的 PowerShell 包装形式，现在不再生成，但清理旧条目时仍要认得出 */
  const legacyWrapper = (exe: string): string =>
    `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden ` +
    `-Command "Start-Process -FilePath '${exe.replaceAll("'", "''")}' -ArgumentList '--no-open' -WindowStyle Hidden"`

  it("直接启动形式：取引号内的路径", () => {
    expect(parseRunValue('"C:\\Apps\\repo-radar.exe" --no-open')).toBe("C:\\Apps\\repo-radar.exe")
  })

  it("PowerShell 包装形式：取 -FilePath 后的路径，而不是 powershell.exe 自己", () => {
    const v = legacyWrapper("C:\\Apps\\repo-radar.exe")
    expect(v.startsWith('"C:\\Windows')).toBe(true) // 起手确实是 powershell 的路径
    expect(parseRunValue(v)).toBe("C:\\Apps\\repo-radar.exe") // 但解析出来的必须是 exe，不是 powershell
  })

  it("包装形式里的单引号做过 '' 转义，需要还原", () => {
    expect(parseRunValue(legacyWrapper("C:\\Users\\it's mine\\repo-radar.exe"))).toBe("C:\\Users\\it's mine\\repo-radar.exe")
  })

  it("解析不出（没有引号包裹）→ null", () => {
    expect(parseRunValue("C:\\unquoted\\repo-radar.exe --no-open")).toBeNull()
  })
})

// 缺陷 2：isLegacyEntry 的 win32 分支现在同时需要 parseRunValue（路径）与 parseRunFlag（标志）
// 都解析成功，才能判定是遗留条目——parseRunFlag 单独测试解析本身的正确性
describe("parseRunFlag — 从 HKCU Run 值里取出路径之后的参数（缺陷 2）", () => {
  const legacyWrapper = (exe: string): string =>
    `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden ` +
    `-Command "Start-Process -FilePath '${exe.replaceAll("'", "''")}' -ArgumentList '--no-open' -WindowStyle Hidden"`

  it("直接启动形式：取引号之后的参数", () => {
    expect(parseRunFlag('"C:\\Apps\\repo-radar.exe" --no-open')).toBe("--no-open")
    expect(parseRunFlag('"D:\\repo-radar\\repo-radar.exe" --tray')).toBe("--tray")
  })

  it("PowerShell 包装形式：取 -ArgumentList 里的参数，不是 powershell.exe 自己的参数", () => {
    expect(parseRunFlag(legacyWrapper("C:\\Apps\\repo-radar.exe"))).toBe("--no-open")
  })

  it("解析不出（没有引号包裹、也没有 -ArgumentList）→ null", () => {
    expect(parseRunFlag("SomeOtherApp.exe --whatever")).toBeNull()
  })
})

describe("parseRegExport — .reg 文本解析（reg export 输出，UTF-16LE，与代码页无关）", () => {
  const reg = (value: string) =>
    ["Windows Registry Editor Version 5.00", "", "[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]", value, ""].join(
      "\r\n",
    )

  it("取出目标项的值并还原 \\ 与 \" 转义", () => {
    const line = String.raw`"repo-radar"="\"C:\\Program Files\\repo-radar\\repo-radar.exe\" --no-open"`
    expect(parseRegExport(reg(line), "repo-radar")).toBe('"C:\\Program Files\\repo-radar\\repo-radar.exe" --no-open')
  })

  it("非 ASCII 路径原样保留（本修复的核心场景：reg query 按控制台代码页解码会产生乱码，reg export 不会）", () => {
    const line = String.raw`"repo-radar"="\"C:\\Users\\小明\\repo-radar.exe\" --no-open"`
    const val = parseRegExport(reg(line), "repo-radar")
    expect(parseRunValue(val!)).toBe("C:\\Users\\小明\\repo-radar.exe")
  })

  it("只认自己那一项，不会串到同一个键下的别家条目", () => {
    const text = reg([String.raw`"OtherApp"="C:\\other.exe"`, String.raw`"repo-radar"="\"D:\\rr.exe\" --no-open"`].join("\r\n"))
    expect(parseRunValue(parseRegExport(text, "repo-radar")!)).toBe("D:\\rr.exe")
    expect(parseRegExport(text, "NotThere")).toBeNull()
  })

  it("条目不存在或不是字符串型 → null", () => {
    expect(parseRegExport(reg(String.raw`"repo-radar"="C:\\x.exe"`), "missing")).toBeNull()
    expect(parseRegExport(reg('"repo-radar"=dword:00000001'), "repo-radar")).toBeNull()
  })
})

describe("parsePlistTarget — 从 LaunchAgent plist 取出 exe 路径（ProgramArguments 数组第一项）", () => {
  const plist = (exeXml: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.rockbenben.repo-radar</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exeXml}</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`

  it("取出 ProgramArguments 数组的第一个 <string>", () => {
    const path = "/Applications/repo-radar.app/Contents/MacOS/repo-radar"
    expect(parsePlistTarget(plist(path))).toBe(path)
  })

  it("还原 XML 转义字符（写出时若含 & < > 等不转义，plist 不是合法 XML，launchd 会静默拒载）", () => {
    expect(parsePlistTarget(plist("/Users/x/R&amp;D/repo-radar"))).toBe("/Users/x/R&D/repo-radar")
    expect(parsePlistTarget(plist("/opt/we&quot;ird&apos;path/repo-radar"))).toBe("/opt/we\"ird'path/repo-radar")
  })

  it("解析不出（没有 ProgramArguments 数组）→ null", () => {
    expect(parsePlistTarget("<plist><dict></dict></plist>")).toBeNull()
  })
})

// 事故复现用例：本分支执行期间，开发版（未打包）真实删过用户 Windows 注册表里的自启项——
// cleanupLegacyEntries() 本该在 !app.isPackaged 时直接 return，但当时这条防线不在测试覆盖里。
// 这里直接断言"开发版一次都不会碰 spawnSync"（Windows 分支删注册表项、Windows/macOS 改登录项
// 都经由它或 setLoginItemSettings），把这条防线钉死，不再依赖人读代码判断。
describe("cleanupLegacyEntries — 开发版绝不触碰登录项（事故复现用例）", () => {
  it("app.isPackaged === false 时不调用 spawnSync", () => {
    // 传入的路径本身不会被读取——isPackaged 为 false 时函数在碰任何 I/O 之前就已经 return
    cleanupLegacyEntries(join(tmpdir(), "rr-should-never-be-read", "config.json"))
    expect(spawnSync).not.toHaveBeenCalled()
  })
})

// 本轮缺陷 1 + 缺陷 2 + 缺陷 4 端到端：cleanupLegacyEntries 在 macOS / Linux 分支上的完整行为。
// Windows 分支的常规判定逻辑（是否为遗留条目、迁移一次性）继续靠上面 isLegacyEntry /
// planLegacyMigration / parseRegExport / parseRunValue / parseRunFlag 这几个纯函数的单元测试
// 保证；Windows 分支里 spawnSync 返回值处理（reg delete 失败不能被当成迁移完成）另有专门的
// 端到端测试，见下方"Windows 端到端：reg delete 失败不能被当成迁移完成"。macOS 与 Linux 分支
// 不需要 spawnSync，用临时目录当「home」（两个函数都支持注入，见 desktop/src/autostart.ts 里
// cleanupLegacyEntries 新增的 home 参数）即可端到端跑一遍，全程不碰真实用户目录/注册表。
//
// 缺陷 4：迁移状态不再存进 server 端的用户 config.json，改用桌面端专属的 stateFile
// （main.ts 里对应 autostart-state.json），这里用 loadMigrationState 读回验证，
// 不再是 loadConfig。
describe("cleanupLegacyEntries — macOS 端到端（本轮缺陷 1 + 2 + 4，全程用临时目录当 home）", () => {
  const mockApp = app as unknown as { isPackaged: boolean }
  const tmpHome = () => mkdtempSync(join(tmpdir(), "rr-home-"))
  const tmpStateFile = () => join(mkdtempSync(join(tmpdir(), "rr-state-")), "autostart-state.json")
  const plistPathOf = (home: string) => join(home, "Library", "LaunchAgents", "com.rockbenben.repo-radar.plist")
  const cleanupDirs: string[] = []
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  afterEach(() => {
    mockApp.isPackaged = false
    errorSpy.mockClear()
    for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
  })

  it("plist 存在（身份标记本身）→ 删除；首次迁移（legacyAutostartMigrated=false）继承自启意图", () => {
    stubPlatform("darwin")
    mockApp.isPackaged = true
    const home = tmpHome()
    cleanupDirs.push(home)
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true })
    writeFileSync(plistPathOf(home), "<plist><dict></dict></plist>") // 内容本身不重要——文件存在就是身份标记
    const stateFile = tmpStateFile()
    cleanupDirs.push(join(stateFile, ".."))
    const before = vi.mocked(app.setLoginItemSettings).mock.calls.length

    cleanupLegacyEntries(stateFile, home)

    expect(existsSync(plistPathOf(home))).toBe(false) // 遗留条目已删除
    const calls = vi.mocked(app.setLoginItemSettings).mock.calls
    expect(calls.length).toBe(before + 1) // 继承了自启意图，重新注册了一次
    expect(calls[calls.length - 1][0]).toMatchObject({ openAtLogin: true })
    const result = loadMigrationState(stateFile)
    expect(result).toEqual({ ok: true, state: { legacyAutostartMigrated: true } })
  })

  it("已经迁移过（legacyAutostartMigrated=true）→ 只删除 plist，不再调用 setLoginItemSettings", () => {
    stubPlatform("darwin")
    mockApp.isPackaged = true
    const home = tmpHome()
    cleanupDirs.push(home)
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true })
    writeFileSync(plistPathOf(home), "<plist><dict></dict></plist>")
    const stateFile = tmpStateFile()
    cleanupDirs.push(join(stateFile, ".."))
    writeFileSync(stateFile, JSON.stringify({ legacyAutostartMigrated: true }))
    const before = vi.mocked(app.setLoginItemSettings).mock.calls.length

    cleanupLegacyEntries(stateFile, home)

    expect(existsSync(plistPathOf(home))).toBe(false) // 仍然要删——遗留条目不能留着
    expect(vi.mocked(app.setLoginItemSettings).mock.calls.length).toBe(before) // 但不重新启用
    const result = loadMigrationState(stateFile)
    expect(result).toEqual({ ok: true, state: { legacyAutostartMigrated: true } })
  })

  it("plist 不存在 → 什么都不做，不触碰状态文件", () => {
    stubPlatform("darwin")
    mockApp.isPackaged = true
    const home = tmpHome()
    cleanupDirs.push(home)
    const stateFile = tmpStateFile()
    cleanupDirs.push(join(stateFile, ".."))
    const before = vi.mocked(app.setLoginItemSettings).mock.calls.length

    cleanupLegacyEntries(stateFile, home)

    expect(vi.mocked(app.setLoginItemSettings).mock.calls.length).toBe(before)
    expect(existsSync(stateFile)).toBe(false) // 没有遗留条目，连状态文件都不会被创建
  })

  // 本轮缺陷 1 的核心：先探测遗留条目、再读状态、状态读不出来就整个跳过——一次删除都不做，
  // 不能像上一轮那样先删了 plist、才发现状态文件读不出来，那时条目已经没了、也没有第二次机会。
  it("状态文件损坏（JSON 解析失败）→ 整个跳过本次清理，plist 原样保留，并记一行日志", () => {
    stubPlatform("darwin")
    mockApp.isPackaged = true
    const home = tmpHome()
    cleanupDirs.push(home)
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true })
    writeFileSync(plistPathOf(home), "<plist><dict></dict></plist>")
    const stateFile = tmpStateFile()
    cleanupDirs.push(join(stateFile, ".."))
    writeFileSync(stateFile, "{ 坏掉的 JSON，模拟上次硬杀导致截断")
    const before = vi.mocked(app.setLoginItemSettings).mock.calls.length

    cleanupLegacyEntries(stateFile, home)

    expect(existsSync(plistPathOf(home))).toBe(true) // 没有被删除——这是本轮缺陷 1 要修的核心行为
    expect(vi.mocked(app.setLoginItemSettings).mock.calls.length).toBe(before) // 也没有重新启用
    expect(errorSpy).toHaveBeenCalled() // 必须留痕，不能是空 catch {}
  })

  // 本轮缺陷 1 第 4 点：setAutostart(true) 已经成功，但写状态标记这一步磁盘写失败——
  // 不能让这种情况完全无声：至少要在日志里能查到原因
  it("自启已重新启用，但状态标记写盘失败 → 仍完成清理与启用，只是记一行日志说明标记没能落盘", () => {
    stubPlatform("darwin")
    mockApp.isPackaged = true
    const home = tmpHome()
    cleanupDirs.push(home)
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true })
    writeFileSync(plistPathOf(home), "<plist><dict></dict></plist>")
    // 状态文件的父目录被一个同名文件占住，saveMigrationState 内部 mkdirSync 必然失败
    const stateDirParent = mkdtempSync(join(tmpdir(), "rr-state-"))
    cleanupDirs.push(stateDirParent)
    const blocked = join(stateDirParent, "blocked")
    writeFileSync(blocked, "x")
    const stateFile = join(blocked, "autostart-state.json")
    const before = vi.mocked(app.setLoginItemSettings).mock.calls.length

    cleanupLegacyEntries(stateFile, home)

    expect(existsSync(plistPathOf(home))).toBe(false) // 遗留条目仍然被删除
    const calls = vi.mocked(app.setLoginItemSettings).mock.calls
    expect(calls.length).toBe(before + 1) // 自启仍然被重新启用——这一步没有失败
    expect(calls[calls.length - 1][0]).toMatchObject({ openAtLogin: true })
    expect(errorSpy).toHaveBeenCalled() // 标记没能落盘，必须留痕
  })
})

describe("cleanupLegacyEntries — Linux 端到端（本轮缺陷 1 + 2 + 4，全程用临时目录当 home）", () => {
  const mockApp = app as unknown as { isPackaged: boolean }
  const tmpHome = () => mkdtempSync(join(tmpdir(), "rr-home-"))
  const tmpStateFile = () => join(mkdtempSync(join(tmpdir(), "rr-state-")), "autostart-state.json")
  const desktopFileOf = (home: string) => join(home, ".config", "autostart", "repo-radar.desktop")
  const cleanupDirs: string[] = []
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  afterEach(() => {
    mockApp.isPackaged = false
    errorSpy.mockClear()
    for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
  })

  it("Exec 带 --no-open（身份标记）→ 清理并首次迁移，即使解析出的目标文件根本不存在", () => {
    stubPlatform("linux")
    mockApp.isPackaged = true
    const home = tmpHome()
    cleanupDirs.push(home)
    const file = desktopFileOf(home)
    mkdirSync(join(home, ".config", "autostart"), { recursive: true })
    // 目标路径 /opt/old-sea/repo-radar 故意不真实存在——判定不看目标是否存在
    writeFileSync(file, '[Desktop Entry]\nType=Application\nExec="/opt/old-sea/repo-radar" --no-open\n')
    const stateFile = tmpStateFile()
    cleanupDirs.push(join(stateFile, ".."))

    cleanupLegacyEntries(stateFile, home)

    // 清理后 setAutostart(true) 会用当前格式（--tray）重写同一个文件
    expect(readFileSync(file, "utf8")).toContain("--tray")
    expect(readFileSync(file, "utf8")).not.toContain("--no-open")
    expect(loadMigrationState(stateFile)).toEqual({ ok: true, state: { legacyAutostartMigrated: true } })
  })

  it("已经迁移过 → 删除旧文件，不再重新启用（不会重新写出 --tray 文件）", () => {
    stubPlatform("linux")
    mockApp.isPackaged = true
    const home = tmpHome()
    cleanupDirs.push(home)
    const file = desktopFileOf(home)
    mkdirSync(join(home, ".config", "autostart"), { recursive: true })
    writeFileSync(file, '[Desktop Entry]\nType=Application\nExec="/opt/old-sea/repo-radar" --no-open\n')
    const stateFile = tmpStateFile()
    cleanupDirs.push(join(stateFile, ".."))
    writeFileSync(stateFile, JSON.stringify({ legacyAutostartMigrated: true }))

    cleanupLegacyEntries(stateFile, home)

    expect(existsSync(file)).toBe(false) // 遗留条目被删除、且没有被重新创建
    expect(loadMigrationState(stateFile)).toEqual({ ok: true, state: { legacyAutostartMigrated: true } })
  })

  it("Exec 带 --tray（已经是当前版本自己写的）→ 不清理，即使目标文件不存在", () => {
    stubPlatform("linux")
    mockApp.isPackaged = true
    const home = tmpHome()
    cleanupDirs.push(home)
    const file = desktopFileOf(home)
    mkdirSync(join(home, ".config", "autostart"), { recursive: true })
    writeFileSync(file, '[Desktop Entry]\nType=Application\nExec="/does/not/exist/repo-radar" --tray\n')
    const stateFile = tmpStateFile()
    cleanupDirs.push(join(stateFile, ".."))

    cleanupLegacyEntries(stateFile, home)

    expect(existsSync(file)).toBe(true) // 没有被当成遗留条目动过
    expect(readFileSync(file, "utf8")).toContain("--tray")
    expect(existsSync(stateFile)).toBe(false) // 没有触发迁移，状态文件都不会被创建
  })

  // 本轮缺陷 1：与 macOS 端到端那条同名用例一样，验证「先读状态、读失败就整个跳过」
  // 在 Linux 分支上同样成立——不是只对某一个平台打了补丁
  it("状态文件损坏 → 整个跳过本次清理，.desktop 文件原样保留（不会被删，也不会被改写成 --tray），并记日志", () => {
    stubPlatform("linux")
    mockApp.isPackaged = true
    const home = tmpHome()
    cleanupDirs.push(home)
    const file = desktopFileOf(home)
    mkdirSync(join(home, ".config", "autostart"), { recursive: true })
    writeFileSync(file, '[Desktop Entry]\nType=Application\nExec="/opt/old-sea/repo-radar" --no-open\n')
    const stateFile = tmpStateFile()
    cleanupDirs.push(join(stateFile, ".."))
    writeFileSync(stateFile, "{ 坏掉的 JSON")

    cleanupLegacyEntries(stateFile, home)

    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, "utf8")).toContain("--no-open") // 原样保留，没被删也没被重写
    expect(errorSpy).toHaveBeenCalled()
  })
})

// 本轮修复：reg delete 失败却照样标记"迁移完成"。win32 分支用 spawnSync 删除 SEA 时代的
// 自启项，spawnSync 对非零退出码不抛异常，之前这里从不检查返回值，删除失败也照常调
// finishMigration 写下 legacyAutostartMigrated:true——reg 不在 PATH、或该值受组策略保护时，
// 旧的 SEA 自启项就会存活下来，此后每次登录新旧两个版本一起启动，旧版先抢到端口，新版
// backend.start() 撞 EADDRINUSE 弹错误框，而标记却说"已迁移"，清理逻辑再也不会重跑。
//
// spawnSync 已整体 mock（见文件顶部），这里进一步区分 "export"（regReadValue 判断是否为
// 遗留条目那一步）与 "delete"（真正的删除动作）：export 那一步写出一份能被 regReadValue/
// parseRegExport 解析成"遗留条目"的假 .reg 文件（UTF-16LE，格式与 parseRegExport 测试用的
// 一致），delete 那一步按场景返回成功或失败——全程只在 spawnSync 这一层拦截，不碰真实注册表。
describe("cleanupLegacyEntries — Windows 端到端：reg delete 失败不能被当成迁移完成", () => {
  const mockApp = app as unknown as { isPackaged: boolean }
  const tmpStateFile = () => join(mkdtempSync(join(tmpdir(), "rr-state-")), "autostart-state.json")
  const cleanupDirs: string[] = []
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

  // 一份能被 regReadValue/parseRegExport 解析出「SEA 时代遗留条目」的 .reg 导出内容
  const legacyRegExport = [
    "Windows Registry Editor Version 5.00",
    "",
    "[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run]",
    String.raw`"repo-radar"="\"D:\\old-sea\\repo-radar.exe\" --no-open"`,
    "",
  ].join("\r\n")

  function mockRegSpawn(deleteResult: { status: number | null; error?: Error }): void {
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => {
      const a = args as string[]
      if (a[0] === "export") {
        writeFileSync(a[2], legacyRegExport, "utf16le")
        return { status: 0 } as unknown as ReturnType<typeof spawnSync>
      }
      if (a[0] === "delete") {
        return { status: deleteResult.status, error: deleteResult.error } as unknown as ReturnType<typeof spawnSync>
      }
      return { status: 0 } as unknown as ReturnType<typeof spawnSync>
    })
  }

  afterEach(() => {
    mockApp.isPackaged = false
    errorSpy.mockClear()
    vi.mocked(spawnSync).mockReset()
    for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
  })

  it("reg delete 退出码非零 → 不标记迁移完成、不重新启用自启，记一行日志（下次启动会重试）", () => {
    stubPlatform("win32")
    mockApp.isPackaged = true
    mockRegSpawn({ status: 1 })
    const stateFile = tmpStateFile()
    cleanupDirs.push(join(stateFile, ".."))
    const before = vi.mocked(app.setLoginItemSettings).mock.calls.length

    cleanupLegacyEntries(stateFile)

    expect(vi.mocked(app.setLoginItemSettings).mock.calls.length).toBe(before) // 没有被当成"已迁移"重新启用
    expect(existsSync(stateFile)).toBe(false) // 迁移标记没有落盘，下次启动会重试
    expect(errorSpy).toHaveBeenCalled()
  })

  it("reg 不在 PATH（spawnSync 返回 error）→ 同样不标记迁移完成", () => {
    stubPlatform("win32")
    mockApp.isPackaged = true
    mockRegSpawn({ status: null, error: new Error("spawnSync reg ENOENT") })
    const stateFile = tmpStateFile()
    cleanupDirs.push(join(stateFile, ".."))
    const before = vi.mocked(app.setLoginItemSettings).mock.calls.length

    cleanupLegacyEntries(stateFile)

    expect(vi.mocked(app.setLoginItemSettings).mock.calls.length).toBe(before)
    expect(existsSync(stateFile)).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
  })

  it("reg delete 成功（退出码 0）→ 正常标记迁移完成、按计划重新启用自启", () => {
    stubPlatform("win32")
    mockApp.isPackaged = true
    mockRegSpawn({ status: 0 })
    const stateFile = tmpStateFile()
    cleanupDirs.push(join(stateFile, ".."))
    const before = vi.mocked(app.setLoginItemSettings).mock.calls.length

    cleanupLegacyEntries(stateFile)

    const calls = vi.mocked(app.setLoginItemSettings).mock.calls
    expect(calls.length).toBe(before + 1) // 首次迁移，继承自启意图
    expect(calls[calls.length - 1][0]).toMatchObject({ openAtLogin: true })
    expect(loadMigrationState(stateFile)).toEqual({ ok: true, state: { legacyAutostartMigrated: true } })
  })
})

// 缺陷 1：setAutostart 写入时带 args:[TRAY_FLAG]，Electron 在 Windows 上是拿传入的 args
// 拼出命令行与注册表里的值做精确字符串比较——读回时如果不传同一组 args，空 args 拼出来的是
// `"<exe>"`，而存的是 `"<exe>" --tray`，永远不相等，openAtLogin 就会恒为 false。
// 已读 node_modules/electron/electron.d.ts 的 getLoginItemSettings 文档确认：
// "If you provided `path` and `args` options to `app.setLoginItemSettings`, then you need to
// pass the same arguments here for `openAtLogin` to be set correctly."
describe("getAutostart — Windows 读回状态必须与写入时用同一组 args（缺陷 1）", () => {
  it("windows 平台调用 getLoginItemSettings 时带上与 setAutostart 相同的 args", () => {
    // app.isPackaged 在真实 Electron 类型里是只读属性，mock 对象上没有这个限制——
    // 这里过一层 unknown 断言只是绕开 TS 的只读检查，不是绕开真实运行时行为
    const mockApp = app as unknown as { isPackaged: boolean }
    stubPlatform("win32")
    mockApp.isPackaged = true
    try {
      getAutostart()
      expect(app.getLoginItemSettings).toHaveBeenCalledWith({ args: ["--tray"] })
    } finally {
      mockApp.isPackaged = false
    }
  })
})

/**
 * 自启是全局唯一一条 OS 条目，而写进去的命令行只有 `"<exe>" --tray`，带不上
 * REPO_RADAR_CONFIG / REPO_RADAR_PORT——用非默认配置（README 承诺的"完全独立的实例"）打开的
 * 自启，登录后拉起来的是**默认配置**那一份：托盘里常驻一个空 roots 的空看板，用户再点自己的
 * 快捷方式又起一个（锁域不同，两个都跑得起来），托盘里两个一模一样的图标、全程零提示。
 * 因此非默认配置根本不该拿到这条能力——不注入，/api/autostart 就如实回 supported:false，
 * 界面据此把整行开关隐藏。
 */
describe("autostartExtra — 只有默认配置那份实例才提供开机自启", () => {
  it("非默认配置（REPO_RADAR_CONFIG 指向别处）→ 不注入，后端只能回 supported:false", () => {
    expect(autostartExtra(false)).toBeUndefined()
  })

  it("默认配置 → 注入，且 get/set 接的是真正问系统的那两个函数", () => {
    const extra = autostartExtra(true)
    expect(extra).toBeDefined()
    // 未打包时 getAutostart 一律回 supported:false（见其注释），这里只验证接线：
    // 拿到的确实是 getAutostart/setAutostart 的返回值形状，而不是一个空壳
    expect(extra!.get()).toEqual({ supported: false, enabled: false })
    expect(extra!.set(true)).toEqual({ supported: false, enabled: false })
  })
})

// 缺陷 4：AppImage 运行时 app.getPath("exe") 是本次运行的临时 FUSE 挂载路径
// （/tmp/.mount_XXXX/AppRun），写进 .desktop 的 Exec 行毫无意义——进程一退出挂载就消失，
// 下次登录什么都不会启动。AppImage 运行时会设置 APPIMAGE 环境变量指向用户双击的那个
// .AppImage 文件，应优先使用；没有该变量（源码跑、其它打包形式）才退回 app.getPath("exe")。
// 抽成纯函数、把 APPIMAGE 值作为可注入参数，这样不用真的读写 process.env 也能测。
describe("autostartExecutablePath — Linux 自启该写哪个可执行文件路径（缺陷 4）", () => {
  it("设置了 APPIMAGE（AppImage 运行时）→ 用它，不用临时挂载路径", () => {
    expect(autostartExecutablePath("/tmp/.mount_abc123/AppRun", "/home/me/Downloads/repo-radar.AppImage")).toBe(
      "/home/me/Downloads/repo-radar.AppImage",
    )
  })

  it("没有 APPIMAGE（源码跑 / 其它打包形式）→ 退回 app.getPath(\"exe\")", () => {
    expect(autostartExecutablePath("/opt/repo-radar/repo-radar", undefined)).toBe("/opt/repo-radar/repo-radar")
  })

  it("APPIMAGE 是空字符串 → 视为未设置，仍退回 exePath", () => {
    expect(autostartExecutablePath("/opt/repo-radar/repo-radar", "")).toBe("/opt/repo-radar/repo-radar")
  })
})

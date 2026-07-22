import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FileLog, formatLine, installConsoleTee, logFilePath } from "../src/logger"

const dirs: string[] = []
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "rr-log-"))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

describe("日志路径与格式", () => {
  it("落在 config 同目录的 logs/ 下（跟随 REPO_RADAR_CONFIG）", () => {
    expect(logFilePath(join("/home/me", ".repo-radar"))).toBe(join("/home/me", ".repo-radar", "logs", "repo-radar.log"))
  })

  it("每行带 ISO 时间与级别，正文原样保留", () => {
    const at = new Date("2026-07-20T12:34:56.000Z")
    expect(formatLine("log", "[repo-radar] hello", at)).toBe("2026-07-20T12:34:56.000Z LOG [repo-radar] hello\n")
    expect(formatLine("error", "boom", at)).toBe("2026-07-20T12:34:56.000Z ERR boom\n")
  })
})

describe("FileLog", () => {
  it("自动建目录并追加写", () => {
    const file = join(tmp(), "logs", "repo-radar.log")
    const log = new FileLog(file)
    log.write("log", "first")
    log.write("error", "second")
    const text = readFileSync(file, "utf8")
    expect(text.split("\n").filter(Boolean)).toHaveLength(2)
    expect(text).toContain("LOG first")
    expect(text).toContain("ERR second")
  })

  it("超过上限轮转成 .1，新文件从空开始（长期跑的服务不能让日志无界增长）", () => {
    const file = join(tmp(), "repo-radar.log")
    const log = new FileLog(file, 200)
    log.write("log", "x".repeat(300)) // 写完就超限了，下一次写触发轮转
    log.write("log", "after rotate")

    expect(existsSync(`${file}.1`)).toBe(true)
    expect(readFileSync(`${file}.1`, "utf8")).toContain("xxx")
    const current = readFileSync(file, "utf8")
    expect(current).toContain("after rotate")
    expect(current).not.toContain("xxx") // 新文件不含旧内容
  })

  it("只保留一份备份：再次轮转会覆盖上一份（Windows 的 rename 不覆盖已存在目标）", () => {
    const file = join(tmp(), "repo-radar.log")
    writeFileSync(`${file}.1`, "很久以前的备份")
    const log = new FileLog(file, 50)
    log.write("log", "y".repeat(100))
    log.write("log", "trigger")
    expect(readFileSync(`${file}.1`, "utf8")).not.toContain("很久以前")
  })

  it("写盘失败绝不抛：日志是诊断手段，不能自己变成故障源", () => {
    const dir = tmp()
    const blocked = join(dir, "blocked")
    writeFileSync(blocked, "x") // 把父目录的位置占成文件
    const log = new FileLog(join(blocked, "repo-radar.log"))
    expect(() => log.write("log", "whatever")).not.toThrow()
  })
})

describe("installConsoleTee", () => {
  it("console 照常输出，同时抄进文件；还原后不再写", () => {
    const file = join(tmp(), "repo-radar.log")
    const seen: unknown[][] = []
    const realLog = console.log
    console.log = (...a: unknown[]) => void seen.push(a)

    const restore = installConsoleTee(new FileLog(file))
    console.log("[repo-radar] hello %s", "world")
    console.error("boom")
    const passthrough = seen.length // tee 之下，原始 console.log 仍被调用（不吞输出）
    restore()
    console.log("[repo-radar] after restore")

    const text = readFileSync(file, "utf8")
    expect(text).toContain("LOG [repo-radar] hello world") // util.format 的占位符已展开
    expect(text).toContain("ERR boom")
    expect(text).not.toContain("after restore") // 还原后不再写文件
    expect(passthrough).toBe(1)
    expect(seen.length).toBe(2) // 还原把原来的 console.log 装了回去

    console.log = realLog
  })
})

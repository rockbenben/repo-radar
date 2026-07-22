import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { InboxCache } from "../src/inbox-cache"
import type { GithubInbox } from "../src/types"

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "rr-inbox-"))
  return { file: join(dir, "github-inbox.json"), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
}

const INBOX = { prs: 2, issues: 1, ci: "passing" } as unknown as GithubInbox

// 落盘是 1 秒防抖的，退出路径必须能把它立刻挤出去，否则最后一轮拉取结果随进程一起丢
describe("InboxCache.flush — 退出前落盘", () => {
  it("set 之后立刻 flush，内容已经在磁盘上（不必等防抖窗口）", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.set("repo1", "https://github.com/a/b", INBOX)
    expect(existsSync(file)).toBe(false) // 防抖中，还没写

    c.flush()
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf8")).repo1.url).toBe("https://github.com/a/b")

    // 重新加载能读回来——这正是「重启秒显上次结果」依赖的东西
    expect(new InboxCache(file).get("repo1", "https://github.com/a/b")).toEqual(INBOX)
    cleanup()
  })

  it("没有待写内容时 flush 不产生文件（退出路径不做无谓写盘）", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.flush()
    expect(existsSync(file)).toBe(false)
    cleanup()
  })

  it("flush 之后重复 flush 不再写（防抖定时器已清）", () => {
    const { file, cleanup } = tmpFile()
    const c = new InboxCache(file)
    c.set("repo1", "u", INBOX)
    c.flush()
    const first = readFileSync(file, "utf8")
    rmSync(file)
    c.flush() // 没有新的 set，不该再写出文件
    expect(existsSync(file)).toBe(false)
    expect(first).toContain("repo1")
    cleanup()
  })

  it("路径不可写时 flush 不抛（缓存只是加速，绝不能挡住退出）", () => {
    const { file, cleanup } = tmpFile()
    // 把「父目录」的位置先占成一个普通文件，mkdirSync 必然失败——确定性地触发写盘失败路径
    const blocked = join(dirname(file), "blocked")
    writeFileSync(blocked, "x")
    const c = new InboxCache(join(blocked, "github-inbox.json"))
    c.set("repo1", "u", INBOX)
    expect(() => c.flush()).not.toThrow()
    cleanup()
  })
})

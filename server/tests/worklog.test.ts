import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import * as worklog from "../src/worklog"
import { exportWorklog } from "../src/worklog-export"
import { cleanupFixtures, makeRepoWithDates } from "./fixtures"

const { getWorklog } = worklog

afterAll(cleanupFixtures)

describe("getWorklog", () => {
  it("aggregates commits within the day range, newest first", async () => {
    const dir = makeRepoWithDates(["2026-07-10T09:00:00", "2026-07-12T10:00:00", "2026-07-20T11:00:00"])
    const { commits, failed } = await getWorklog([{ id: "r1", name: "proj", displayName: null, path: dir }], "2026-07-10", "2026-07-15")
    expect(failed).toEqual([])
    expect(commits).toHaveLength(2) // 07-20 在范围外
    expect(new Date(commits[0].date).getTime() >= new Date(commits[1].date).getTime()).toBe(true) // 新→旧（按绝对时刻）
    expect(commits.every((c) => c.repoName === "proj")).toBe(true)
    expect(commits[0].hash).toMatch(/^[0-9a-f]{7,}$/)
    expect(commits[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/) // Node 算好的本地日期
    expect(commits[0].time).toMatch(/^\d{2}:\d{2}$/)
    expect(commits.map((c) => c.day).sort()).toEqual(["2026-07-10", "2026-07-12"]) // 分组日期正确
  })

  it("prefers displayName over name, and returns empty for an out-of-range window", async () => {
    const dir = makeRepoWithDates(["2026-07-10T09:00:00"])
    const named = await getWorklog([{ id: "r1", name: "proj", displayName: "My Project", path: dir }], "2026-07-10", "2026-07-10")
    expect(named.commits[0].repoName).toBe("My Project")
    const none = await getWorklog([{ id: "r1", name: "proj", displayName: null, path: dir }], "2026-01-01", "2026-01-31")
    expect(none.commits).toEqual([])
  })

  it("returns the author email for each commit (used by the client's committer filter)", async () => {
    const dir = makeRepoWithDates(["2026-07-10T09:00:00"])
    const { commits } = await getWorklog([{ id: "r1", name: "proj", displayName: null, path: dir }], "2026-07-10", "2026-07-10")
    expect(commits[0].authorEmail).toBe("test@test.local")
    expect(commits[0].author).toBe("test")
  })

  it("includes an in-range commit even when a newer HEAD carries an older (out-of-range) date", async () => {
    // 非单调 committer 时间：c0 记为 07-12（区间内），其上再压 c1 记为 07-05（区间外、且更旧）。
    // 老实现用 --since 会在遇到 HEAD(c1,07-05) 这条更旧提交时立即停止回溯，漏掉 c0；Node 全量遍历再筛才不漏。
    const dir = makeRepoWithDates(["2026-07-12T10:00:00", "2026-07-05T09:00:00"])
    const { commits } = await getWorklog([{ id: "r1", name: "proj", displayName: null, path: dir }], "2026-07-10", "2026-07-15")
    expect(commits.map((c) => c.day)).toEqual(["2026-07-12"]) // c0 没被 HEAD 的旧日期挡住
  })

  it("records repos whose git log fails in `failed`", async () => {
    const notARepo = "/definitely/not/a/git/repo/xyz"
    const { commits, failed } = await getWorklog([{ id: "x", name: "broken", displayName: null, path: notARepo }], "2000-01-01", "2100-01-01")
    expect(commits).toEqual([])
    expect(failed).toEqual(["broken"]) // 读取失败如实记录，不静默吞掉
  })
})

it("preserves successful daily files and retries missing days after incomplete Git results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-worklog-archive-"))
  const file = join(dir, "worklog.json")
  const previous = join(dir, "archive", "2026", "07", "2026-07-14.json")
  const missing = join(dir, "archive", "2026", "07", "2026-07-15.json")
  const log = vi.fn()
  const query = vi.spyOn(worklog, "queryWorklog").mockImplementation(async (_, since, until) => ({
    since,
    until,
    commits: [],
    failed: [],
    me: null,
  }))
  try {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 6, 14, 15))
    await exportWorklog(file, [], () => true, log)
    const saved = readFileSync(previous, "utf8")

    vi.setSystemTime(new Date(2026, 6, 15, 15))
    query.mockImplementationOnce(async (_, since, until) => ({ since, until, commits: [], failed: ["offline"], me: null }))
    await exportWorklog(file, [], () => true, log)
    expect(readFileSync(previous, "utf8")).toBe(saved)
    expect(existsSync(missing)).toBe(false)
    expect(JSON.parse(readFileSync(file, "utf8")).failed).toEqual(["offline"])
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Incomplete Git results for: offline"))

    await exportWorklog(file, [], () => true, log)
    expect(JSON.parse(readFileSync(missing, "utf8"))).toMatchObject({ since: "2026-07-15", until: "2026-07-15", failed: [] })
  } finally {
    query.mockRestore()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
})

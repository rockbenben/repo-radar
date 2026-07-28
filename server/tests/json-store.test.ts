import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { JsonStore } from "../src/json-store"

// pruneStale 的批量落盘断言要数落盘次数——vi.spyOn 在 ESM 下挡在
// "Module namespace is not configurable" 报错上（node:fs 具名导出不可重新定义），
// 只能整模块 mock：默认原样代理给真实实现，只把 writeFileSync 包一层用于计数
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

interface Entry { v: number; at?: string }
const isEntry = (x: unknown): x is Entry =>
  typeof x === "object" && x !== null && typeof (x as Entry).v === "number"

const dirs: string[] = []
function tmpFile(name = "store.json"): string {
  const d = mkdtempSync(join(tmpdir(), "rr-json-"))
  dirs.push(d)
  return join(d, name)
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("JsonStore", () => {
  it("debounceMs 0：set 立即落盘，新实例能读回来", () => {
    const file = tmpFile()
    const a = new JsonStore<Entry>({ file, isValid: isEntry })
    a.set("k", { v: 1 })
    expect(new JsonStore<Entry>({ file, isValid: isEntry }).get("k")).toEqual({ v: 1 })
  })

  it("目录不存在时自动创建", () => {
    const file = join(tmpFile(), "nested", "deep.json")
    new JsonStore<Entry>({ file, isValid: isEntry }).set("k", { v: 1 })
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ k: { v: 1 } })
  })

  it("debounceMs > 0：set 不立即落盘，flush 后才写", async () => {
    const file = tmpFile()
    const s = new JsonStore<Entry>({ file, isValid: isEntry, debounceMs: 1000 })
    s.set("k", { v: 1 })
    expect(new JsonStore<Entry>({ file, isValid: isEntry }).get("k")).toBeUndefined()
    s.flush()
    expect(new JsonStore<Entry>({ file, isValid: isEntry }).get("k")).toEqual({ v: 1 })
  })

  it("防抖窗口过去后自动落盘，无需 flush", async () => {
    const file = tmpFile()
    const s = new JsonStore<Entry>({ file, isValid: isEntry, debounceMs: 50 })
    s.set("k", { v: 1 })
    await new Promise((r) => setTimeout(r, 200))
    expect(new JsonStore<Entry>({ file, isValid: isEntry }).get("k")).toEqual({ v: 1 })
  })

  // 坏文件不该让程序起不来——缓存只是加速，宁可当空
  it("文件是非法 JSON → 当作空，不抛", () => {
    const file = tmpFile()
    writeFileSync(file, "{not json")
    const s = new JsonStore<Entry>({ file, isValid: isEntry })
    expect(s.entries()).toEqual([])
  })

  // 逐条校验而不是整份丢弃：老版本写入的部分字段变化时，好条目应当留下
  it("非法条目被逐条丢弃，合法条目保留", () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ good: { v: 1 }, bad: { v: "x" }, alsoBad: null }))
    const s = new JsonStore<Entry>({ file, isValid: isEntry })
    expect(s.entries()).toEqual([["good", { v: 1 }]])
  })

  it("delete 也会安排落盘", () => {
    const file = tmpFile()
    const s = new JsonStore<Entry>({ file, isValid: isEntry })
    s.set("k", { v: 1 })
    expect(s.delete("k")).toBe(true)
    expect(s.delete("k")).toBe(false)
    expect(new JsonStore<Entry>({ file, isValid: isEntry }).entries()).toEqual([])
  })

  it("pruneStale：不在保留集合、且已过年龄护栏的条目被剪掉", () => {
    const s = new JsonStore<Entry>({ file: tmpFile(), isValid: isEntry })
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    s.set("keep-in-set", { v: 1, at: old })
    s.set("keep-young", { v: 2, at: new Date().toISOString() })
    s.set("drop", { v: 3, at: old })
    s.pruneStale(new Set(["keep-in-set"]), (e) => e.at ?? "")
    expect(s.entries().map(([k]) => k).sort()).toEqual(["keep-in-set", "keep-young"])
  })

  // 年龄护栏：网络盘根目录瞬时掉线会让一整批仓库在某轮扫描里消失，
  // 立即剪会把它们的落盘数据永久抹掉
  it("pruneStale：刚写入的条目即使不在保留集合里也不剪", () => {
    const s = new JsonStore<Entry>({ file: tmpFile(), isValid: isEntry })
    s.set("gone", { v: 1, at: new Date().toISOString() })
    s.pruneStale(new Set(), (e) => e.at ?? "")
    expect(s.entries().length).toBe(1)
  })

  // 时间戳损坏不能让条目永久赖着不走：NaN 一律视为已过期
  it("pruneStale：时间戳非法的条目按已过期处理", () => {
    const s = new JsonStore<Entry>({ file: tmpFile(), isValid: isEntry })
    s.set("bad", { v: 1, at: "not-a-date" })
    s.pruneStale(new Set(), (e) => e.at ?? "")
    expect(s.entries()).toEqual([])
  })

  // 性能钉子：debounceMs 0（DescCache 就是这个配置）时，剪 N 条不该触发 N 次
  // writeFileSync——网络盘瞬时掉线导致一整批条目同时过期，正是这种时候最不该串行全量写盘
  it("pruneStale：debounceMs 0 时一次剪多条也只落盘一次，不是逐条同步写", () => {
    const file = tmpFile()
    const s = new JsonStore<Entry>({ file, isValid: isEntry })
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    s.set("a", { v: 1, at: old })
    s.set("b", { v: 2, at: old })
    s.set("c", { v: 3, at: old })
    vi.mocked(writeFileSync).mockClear() // 只数 pruneStale 本身触发的落盘次数
    s.pruneStale(new Set(), (e) => e.at ?? "")
    expect(s.entries()).toEqual([])
    expect(writeFileSync).toHaveBeenCalledTimes(1)
  })

  it("没有待写内容时 flush 不写盘（不产生文件）", () => {
    const file = tmpFile()
    const s = new JsonStore<Entry>({ file, isValid: isEntry, debounceMs: 1000 })
    s.flush()
    expect(() => readFileSync(file, "utf8")).toThrow()
  })

  // 规格的错误处理表有两行明确要求「记日志」，而 load 只是 catch 后丢弃。对身份账本而言，
  // 这是「所有改过名的仓库标签消失了、但日志里有一行解释」和「用户数据丢失且零诊断面」
  // 之间的差别——打包之后日志是唯一诊断面
  it("文件损坏时 onCorrupt 被调用（不再静默吞掉）", () => {
    const file = tmpFile()
    writeFileSync(file, "{not json")
    const seen: unknown[] = []
    const s = new JsonStore<Entry>({ file, isValid: isEntry, onCorrupt: (err) => void seen.push(err) })
    expect(seen.length).toBe(1)
    expect(seen[0]).toBeInstanceOf(Error)
    expect(s.entries()).toEqual([]) // 仍然当空继续跑，不抛
  })

  it("文件正常时不调 onCorrupt（含文件根本不存在的情况）", () => {
    const file = tmpFile()
    let calls = 0
    new JsonStore<Entry>({ file, isValid: isEntry, onCorrupt: () => void calls++ }).set("k", { v: 1 })
    new JsonStore<Entry>({ file, isValid: isEntry, onCorrupt: () => void calls++ })
    // 逐条校验丢弃的坏条目也不算「文件损坏」：那是预期中的 schema 演进，不是诊断信号
    writeFileSync(file, JSON.stringify({ bad: { v: "x" } }))
    new JsonStore<Entry>({ file, isValid: isEntry, onCorrupt: () => void calls++ })
    expect(calls).toBe(0)
  })

  // 非原子写入：writeFileSync 先截断再写，崩溃/断电落在这个窗口里就留下一个截断的文件，
  // 下次启动整份丢掉。账本每轮扫描都重写，这个窗口真实且反复出现
  it("落盘走临时文件 + rename，目标文件不会被截断后半途暴露", () => {
    const file = tmpFile()
    const s = new JsonStore<Entry>({ file, isValid: isEntry })
    vi.mocked(writeFileSync).mockClear() // 只看本用例触发的写入（整模块 mock 的调用历史是跨用例累积的）
    s.set("k", { v: 1 })
    // 写入落在临时文件上，rename 之后目标文件才整份出现——写进去的那一次调用的是
    // `${file}.tmp` 而不是 file 本身
    const paths = vi.mocked(writeFileSync).mock.calls.map((c) => String(c[0]))
    expect(paths.length).toBe(1)
    expect(paths.every((x) => x.endsWith(".tmp"))).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ k: { v: 1 } })
    expect(existsSync(`${file}.tmp`)).toBe(false) // rename 之后临时文件不该留下
  })

  // 写盘失败静默：缓存只是加速，不能因为磁盘满/只读就让功能挂掉
  it("写盘失败不抛出", () => {
    const s = new JsonStore<Entry>({ file: join("\0invalid", "x.json"), isValid: isEntry })
    expect(() => s.set("k", { v: 1 })).not.toThrow()
  })
})

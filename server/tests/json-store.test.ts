import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

  // 写盘失败静默：缓存只是加速，不能因为磁盘满/只读就让功能挂掉
  it("写盘失败不抛出", () => {
    const s = new JsonStore<Entry>({ file: join("\0invalid", "x.json"), isValid: isEntry })
    expect(() => s.set("k", { v: 1 })).not.toThrow()
  })
})

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Config, DEFAULT_CONFIG, loadConfig, mergeConfig, saveConfig, validateConfigPatch } from "../src/config"

const dir = mkdtempSync(join(tmpdir(), "rr-config-"))
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

describe("config", () => {
  it("returns defaults when file does not exist", () => {
    const cfg = loadConfig(join(dir, "missing.json"))
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(cfg).not.toBe(DEFAULT_CONFIG) // 必须是副本，防止调用方改坏默认值
  })

  it("round-trips save and load", () => {
    const file = join(dir, "sub", "config.json") // 父目录不存在，save 要自动创建
    const cfg = loadConfig(file)
    cfg.roots = ["D:\\Projects"]
    saveConfig(file, cfg)
    expect(loadConfig(file).roots).toEqual(["D:\\Projects"])
    expect(JSON.parse(readFileSync(file, "utf8")).excludes).toEqual(DEFAULT_CONFIG.excludes)
  })

  it("merges partial file over defaults", () => {
    const file = join(dir, "partial.json")
    saveConfig(file, { ...DEFAULT_CONFIG, roots: ["X:\\a"] })
    const cfg = loadConfig(file)
    expect(cfg.roots).toEqual(["X:\\a"])
    expect(cfg.health.staleDays).toBe(90)
  })
})

describe("mergeConfig", () => {
  it("deep-merges health and open, shallow-merges the rest", () => {
    const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), {
      roots: ["X:\\a"],
      health: { staleDays: 30 } as never,
    })
    expect(merged.roots).toEqual(["X:\\a"])
    expect(merged.health.staleDays).toBe(30)
    expect(merged.health.disabledRules).toEqual([]) // 深合并保留
    expect(merged.open.editor).toBe(DEFAULT_CONFIG.open.editor)
  })
})

describe("validateConfigPatch", () => {
  it("accepts a valid partial patch", () => {
    expect(validateConfigPatch({ roots: ["D:\\x"], tags: { abc: ["web"] } })).toBeNull()
  })
  it("rejects non-object bodies", () => {
    expect(validateConfigPatch([1, 2])).toMatch(/object/)
    expect(validateConfigPatch(null)).toMatch(/object/)
  })
  it("rejects wrong-typed fields", () => {
    expect(validateConfigPatch({ tags: null })).toMatch(/tags/)
    expect(validateConfigPatch({ manualRepos: "D:\\x" })).toMatch(/manualRepos/)
    expect(validateConfigPatch({ health: { staleDays: "90" } })).toMatch(/staleDays/)
    expect(validateConfigPatch({ open: { editor: 5 } })).toMatch(/open/)
    expect(validateConfigPatch({ groupOverrides: { a: 1 } })).toMatch(/groupOverrides/)
  })
  it("accepts valid archived and notes fields", () => {
    expect(validateConfigPatch({ archived: ["x"], notes: { a: "hi" } })).toBeNull()
  })
  it("rejects wrong-typed archived and notes fields", () => {
    expect(validateConfigPatch({ archived: "x" })).toMatch(/archived/)
    expect(validateConfigPatch({ notes: { a: 1 } })).toMatch(/notes/)
  })
})

describe("loadConfig deep merge", () => {
  it("keeps disabledRules when file has partial health", () => {
    const file = join(dir, "deep.json")
    writeFileSync(file, JSON.stringify({ health: { staleDays: 30 } }))
    const cfg = loadConfig(file)
    expect(cfg.health.staleDays).toBe(30)
    expect(cfg.health.disabledRules).toEqual([])
  })
})

describe("notifications 字段", () => {
  it("默认关闭——通知是打扰，必须由用户主动打开", () => {
    expect(DEFAULT_CONFIG.notifications).toBe(false)
  })

  it("旧配置文件没有这个字段时按默认值合并", () => {
    const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), { roots: ["/a"] } as Partial<Config>)
    expect(merged.notifications).toBe(false)
  })

  it("校验：必须是布尔", () => {
    expect(validateConfigPatch({ notifications: true })).toBeNull()
    expect(validateConfigPatch({ notifications: "yes" })).toBe("notifications must be a boolean")
  })
})

// 缺陷 4：legacyAutostartMigrated 曾被错误地放进这份用户可见、可通过 PUT /api/config 修改的
// 配置——它是纯粹的桌面端一次性迁移状态（SEA 时代自启意图是否已经迁移过），用户在自己的
// config.json 里看到一个看不懂的内部字段，还能通过公开 API 把它改坏，进而干扰
// desktop/src/autostart.ts 的迁移判定。已挪到 desktop/src/autostart-state.ts 管理的桌面端
// 专属状态文件，这里只负责确认它已经从用户配置的 schema 里彻底移除，且老配置文件里可能
// 残留的这个字段会被静默剔除（与 openMode 走同一套 DROPPED_FIELDS 机制），不再声明、不再校验。
describe("legacyAutostartMigrated 已移除出用户配置（缺陷 4：挪到桌面端专属状态文件）", () => {
  it("默认配置里不再有这个字段", () => {
    expect("legacyAutostartMigrated" in DEFAULT_CONFIG).toBe(false)
  })

  // 老配置文件（升级前写入过）里可能还留着这个字段，加载时不该报错，也不该把它带进新配置
  it("老配置文件里的 legacyAutostartMigrated 被静默忽略", () => {
    const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), {
      legacyAutostartMigrated: true,
    } as unknown as Partial<Config>)
    expect("legacyAutostartMigrated" in merged).toBe(false)
  })

  it("不再校验它——写进 PUT /api/config 的 patch 也只是被忽略，而不是报错或生效", () => {
    expect(validateConfigPatch({ legacyAutostartMigrated: true })).toBeNull()
    expect(validateConfigPatch({ legacyAutostartMigrated: "not-a-boolean" })).toBeNull()
  })
})

describe("openMode 已移除", () => {
  it("默认配置里不再有这个字段", () => {
    expect("openMode" in DEFAULT_CONFIG).toBe(false)
  })

  // 老配置文件里可能还留着这个字段，加载时不该报错，也不该把它带进新配置
  it("老配置文件里的 openMode 被静默忽略", () => {
    const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), { openMode: "browser" } as unknown as Partial<Config>)
    expect("openMode" in merged).toBe(false)
  })

  it("不再校验它——写进 patch 也只是被忽略，而不是报错", () => {
    expect(validateConfigPatch({ openMode: "nonsense" })).toBeNull()
  })
})

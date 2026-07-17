import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, loadConfig, mergeConfig, saveConfig, validateConfigPatch } from "../src/config"

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

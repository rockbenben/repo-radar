import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DescCache } from "../src/desc-cache"

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "rr-desc-"))
  return { file: join(dir, "github-desc.json"), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
}

describe("DescCache", () => {
  it("is empty and stale before anything is cached", () => {
    const { file, cleanup } = tmpFile()
    const c = new DescCache(file)
    expect(c.get("x", "url")).toBeNull()
    expect(c.isStale("x", "url")).toBe(true)
    cleanup()
  })

  it("returns a cached non-empty description; caches null without re-fetching", () => {
    const { file, cleanup } = tmpFile()
    const c = new DescCache(file)
    c.set("a", "https://github.com/o/a", "hello")
    expect(c.get("a", "https://github.com/o/a")).toBe("hello")
    expect(c.isStale("a", "https://github.com/o/a")).toBe(false)
    // GitHub 上没有描述也缓存（null），避免每次扫描都空拉
    c.set("b", "https://github.com/o/b", null)
    expect(c.get("b", "https://github.com/o/b")).toBeNull()
    expect(c.isStale("b", "https://github.com/o/b")).toBe(false)
    cleanup()
  })

  it("is stale when the origin url changed", () => {
    const { file, cleanup } = tmpFile()
    const c = new DescCache(file)
    c.set("a", "https://github.com/o/a", "hi")
    expect(c.isStale("a", "https://github.com/o/OTHER")).toBe(true)
    cleanup()
  })

  it("get returns null when the requested url does not match the cached origin (no stale desc after origin swap)", () => {
    const { file, cleanup } = tmpFile()
    const c = new DescCache(file)
    c.set("a", "https://github.com/o/a", "hi")
    expect(c.get("a", "https://github.com/o/a")).toBe("hi") // 同 origin：可用
    expect(c.get("a", "https://github.com/o/OTHER")).toBeNull() // 换了 origin：别把旧描述顶上去
    expect(c.get("a", undefined)).toBeNull() // 当前无 github origin：也不用旧缓存
    cleanup()
  })

  it("is stale once the entry is older than the TTL", () => {
    const { file, cleanup } = tmpFile()
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
    writeFileSync(file, JSON.stringify({ a: { description: "hi", url: "u", fetchedAt: old } }))
    const c = new DescCache(file)
    expect(c.get("a", "u")).toBe("hi") // 值仍可用
    expect(c.isStale("a", "u")).toBe(true) // 但已过期，应重拉
    cleanup()
  })

  it("treats an unparseable fetchedAt as stale (not fresh-forever)", () => {
    const { file, cleanup } = tmpFile()
    writeFileSync(file, JSON.stringify({ a: { description: "hi", url: "u", fetchedAt: "" } }))
    const c = new DescCache(file)
    expect(c.isStale("a", "u")).toBe(true)
    cleanup()
  })

  it("persists across instances", () => {
    const { file, cleanup } = tmpFile()
    new DescCache(file).set("a", "u", "persisted")
    expect(existsSync(file)).toBe(true)
    expect(new DescCache(file).get("a", "u")).toBe("persisted")
    cleanup()
  })

  it("tolerates a corrupt cache file", () => {
    const { file, cleanup } = tmpFile()
    writeFileSync(file, "{not json", "utf8")
    const c = new DescCache(file)
    expect(c.get("a", "u")).toBeNull()
    cleanup()
  })
})

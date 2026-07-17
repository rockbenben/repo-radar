import { describe, expect, it } from "vitest"
import { daysSince, isSideBranch, langColor, remoteWeb } from "../src/lib/meta"

describe("remoteWeb", () => {
  it("converts https origin to a clickable web url", () => {
    expect(remoteWeb([{ name: "origin", url: "https://github.com/u/repo-radar.git" }])).toEqual({
      host: "github.com",
      url: "https://github.com/u/repo-radar",
      label: "github.com/u/repo-radar",
    })
  })
  it("converts scp-like origin", () => {
    expect(remoteWeb([{ name: "origin", url: "git@github.com:u/tool.git" }])?.url).toBe("https://github.com/u/tool")
  })
  it("prefers origin over other remotes", () => {
    const r = remoteWeb([
      { name: "backup", url: "D:\\bare\\x" },
      { name: "origin", url: "https://gitlab.com/u/x.git" },
    ])
    expect(r?.host).toBe("gitlab.com")
  })
  it("returns null for no remotes or non-http remote", () => {
    expect(remoteWeb([])).toBeNull()
    expect(remoteWeb([{ name: "origin", url: "D:\\bare\\repo" }])).toBeNull()
  })
})

describe("isSideBranch", () => {
  it("is false for main/master/detached, true otherwise", () => {
    expect(isSideBranch("main")).toBe(false)
    expect(isSideBranch("master")).toBe(false)
    expect(isSideBranch(null)).toBe(false)
    expect(isSideBranch("feat/x")).toBe(true)
  })
})

describe("daysSince", () => {
  it("computes whole days, null for null", () => {
    const now = new Date("2026-07-14T00:00:00Z").getTime()
    expect(daysSince("2026-07-09T00:00:00Z", now)).toBe(5)
    expect(daysSince(null, now)).toBeNull()
  })
})

describe("langColor", () => {
  it("maps known languages and falls back", () => {
    expect(langColor("TypeScript")).toBe("#3178c6")
    expect(langColor("Rust")).toBe("#dea584")
    expect(langColor(null)).toBe("#8a8a97")
    expect(langColor("Cobol")).toBe("#8a8a97")
  })
})

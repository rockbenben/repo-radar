import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { descriptionFromReadme, nameFromRemote, readRepoMeta, stripMarkdown } from "../src/meta"

const dirs: string[] = []
const makeDir = () => { const d = mkdtempSync(join(tmpdir(), "rr-meta-")); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 }) })

describe("nameFromRemote", () => {
  it("takes last segment of https url without .git", () => {
    expect(nameFromRemote([{ name: "origin", url: "https://github.com/u/repo-radar.git" }])).toBe("repo-radar")
  })
  it("handles scp-like urls", () => {
    expect(nameFromRemote([{ name: "origin", url: "git@github.com:u/my-tool.git" }])).toBe("my-tool")
  })
  it("prefers origin over other remotes", () => {
    expect(
      nameFromRemote([
        { name: "backup", url: "D:\\bare\\x" },
        { name: "origin", url: "https://github.com/u/real.git" },
      ]),
    ).toBe("real")
  })
  it("returns null for no remotes", () => {
    expect(nameFromRemote([])).toBeNull()
  })
})

describe("stripMarkdown", () => {
  it("removes emphasis, links, badges, inline code and html", () => {
    expect(stripMarkdown("**English** · [简体中文](docs/README.zh-Hans.md)")).toBe("English · 简体中文")
    expect(stripMarkdown("[中文文档](README.zh.md) · [![License](https://img.shields.io/x.svg)](y)")).toBe("中文文档")
    expect(stripMarkdown("Run `npm test` for the *fast* suite")).toBe("Run npm test for the fast suite")
    expect(stripMarkdown('<p align="center">Centered</p>')).toBe("Centered")
    expect(stripMarkdown("![badge](x) ![b2](y)")).toBe("")
  })
  it("leaves plain text and snake_case untouched", () => {
    expect(stripMarkdown("A plain line with my_var and a-dash")).toBe("A plain line with my_var and a-dash")
  })
})

describe("descriptionFromReadme", () => {
  it("returns first content paragraph, skipping headings and badges", () => {
    const d = makeDir()
    writeFileSync(join(d, "README.md"), "# title\n\n[![badge](x)](y)\n\n本地多仓库状态面板。\n\nmore\n")
    expect(descriptionFromReadme(d)).toBe("本地多仓库状态面板。")
  })
  it("strips markdown from the chosen line and skips badge-only lines", () => {
    const d = makeDir()
    writeFileSync(join(d, "README.md"), "# T\n\n[![CI](https://img.shields.io/ci.svg)](x)\n**Automatically** brings the window to [front](url).\n")
    expect(descriptionFromReadme(d)).toBe("Automatically brings the window to front.")
  })
  it("returns null when no readme or no content", () => {
    expect(descriptionFromReadme(makeDir())).toBeNull()
  })
})

describe("readRepoMeta", () => {
  it("prefers package.json name and description", () => {
    const d = makeDir()
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "repo-radar", description: "面板" }))
    writeFileSync(join(d, "README.md"), "ignored\n")
    expect(readRepoMeta(d, [{ name: "origin", url: "https://x/other.git" }])).toEqual({
      displayName: "repo-radar",
      description: "面板",
    })
  })
  it("falls back to remote name and readme description", () => {
    const d = makeDir()
    writeFileSync(join(d, "README.md"), "一个工具\n")
    expect(readRepoMeta(d, [{ name: "origin", url: "https://x/u/tool.git" }])).toEqual({
      displayName: "tool",
      description: "一个工具",
    })
  })
  it("returns nulls when nothing available and tolerates broken package.json", () => {
    const d = makeDir()
    writeFileSync(join(d, "package.json"), "{broken")
    expect(readRepoMeta(d, [])).toEqual({ displayName: null, description: null })
  })
})

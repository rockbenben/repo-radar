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

  // stripMarkdown 的两条 HTML 规则都要求闭合（`<!--…-->` / `<…>`），而它是逐行调用的，
  // 跨行的起始标记两条都不匹配，于是「整行只是 HTML」那个 clean === "" 的跳过分支走不到，
  // `<!--` / `<img` 这几个字符原样成为卡片描述和详情面板标题，还会进搜索 haystack
  it("README 以独占一行的 `<!--` 开头时跳过它，取真正的正文", () => {
    const d = makeDir()
    writeFileSync(join(d, "README.md"), "<!--\n![badge](x.svg)\n\n本地多仓库状态面板。\n")
    expect(descriptionFromReadme(d)).toBe("本地多仓库状态面板。")
  })

  // 只跳过起始那一行是不够的：续行（`auto-generated`、`src="logo.png"`）单看都是
  // 「闭合且非空」的普通文本，照样会成为描述——必须整块跳到结束标记那一行之后
  it("多行 HTML 注释的**续行**也不是描述（跳到 `-->` 那行之后）", () => {
    const d = makeDir()
    writeFileSync(join(d, "README.md"), "<!--\n  auto-generated, do not edit\n-->\n\n本地多仓库状态面板。\n")
    expect(descriptionFromReadme(d)).toBe("本地多仓库状态面板。")
  })

  it("多行 `<img` 标签的**续行**也不是描述（跳到含 `>` 的那行之后）", () => {
    const d = makeDir()
    writeFileSync(join(d, "README.md"), '<img\n  src="logo.png"\n  alt="logo" />\n\n本地多仓库状态面板。\n')
    expect(descriptionFromReadme(d)).toBe("本地多仓库状态面板。")
  })

  it("单行 HTML 注释开头（对照）与行内的 `<`（对照）都不受影响", () => {
    const a = makeDir()
    writeFileSync(join(a, "README.md"), "<!-- 隐藏说明 -->\n\n本地多仓库状态面板。\n")
    expect(descriptionFromReadme(a)).toBe("本地多仓库状态面板。")
    // 跳过判据要求**行首**是 `<`：正文里出现 `<` 的行不能被误跳
    const b = makeDir()
    writeFileSync(join(b, "README.md"), "扫描 < 100 个仓库时几乎瞬时。\n")
    expect(descriptionFromReadme(b)).toBe("扫描 < 100 个仓库时几乎瞬时。")
  })

  // 「跳整块」不能扩张到单行就闭合的 HTML 上：这三种写法在真实 README 里就是正文本身，
  // 误判成块起始的话会把它们之后的内容一起吃掉（最坏是整份 README 无描述）
  it("单行内闭合的三种 HTML 写法仍然照常取到描述", () => {
    const a = makeDir()
    writeFileSync(join(a, "README.md"), '<div align="center">本地多仓库状态面板。\n')
    expect(descriptionFromReadme(a)).toBe("本地多仓库状态面板。")

    const b = makeDir()
    writeFileSync(join(b, "README.md"), "<sub>本地多仓库状态面板。</sub>\n")
    expect(descriptionFromReadme(b)).toBe("本地多仓库状态面板。")

    const c = makeDir()
    writeFileSync(join(c, "README.md"), "<!-- 隐藏说明 -->本地多仓库状态面板。\n")
    expect(descriptionFromReadme(c)).toBe("本地多仓库状态面板。")
  })

  // `<div align="center">` 独占一行是最常见的 README 开头：它自身闭合、clean 为空（走原有
  // 的「整行只是 HTML」分支），绝不能因为「以 < 开头」就被当成跨行块把下一行一起跳掉
  it("独占一行且自闭合的 `<div>` 之后，下一行正文仍取得到", () => {
    const d = makeDir()
    writeFileSync(join(d, "README.md"), '<div align="center">\n\n本地多仓库状态面板。\n')
    expect(descriptionFromReadme(d)).toBe("本地多仓库状态面板。")
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

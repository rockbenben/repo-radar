import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { cloneRepo, createProject } from "../src/scaffold"
import { cleanupFixtures, makeRepo } from "./fixtures"

const dirs: string[] = []
const root = () => {
  const d = mkdtempSync(join(tmpdir(), "rr-scaffold-"))
  dirs.push(d)
  return d
}
afterAll(() => {
  cleanupFixtures()
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

describe("createProject", () => {
  it("creates a dir with git init and README under a configured root", async () => {
    const r = root()
    const res = await createProject(r, "028-new-thing", [r])
    expect(res.ok).toBe(true)
    const target = join(r, "028-new-thing")
    expect(existsSync(join(target, ".git"))).toBe(true)
    expect(existsSync(join(target, "README.md"))).toBe(true)
    // 真的是个 git 仓库
    expect(execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: target, encoding: "utf8" }).trim()).toBe("true")
  })

  it("rejects unsafe names", async () => {
    const r = root()
    expect((await createProject(r, "../evil", [r])).ok).toBe(false)
    expect((await createProject(r, "a/b", [r])).ok).toBe(false)
    expect((await createProject(r, "", [r])).ok).toBe(false)
  })

  it("rejects a parent outside all roots", async () => {
    const r = root()
    const other = root()
    expect((await createProject(other, "x", [r])).ok).toBe(false)
  })

  it("rejects when the target already exists", async () => {
    const r = root()
    expect((await createProject(r, "dup", [r])).ok).toBe(true)
    const again = await createProject(r, "dup", [r])
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/已存在/)
  })
})

describe("cloneRepo", () => {
  it("clones a local source repo into a parent under root", async () => {
    const src = makeRepo() // 有一个提交的普通仓库，可按本地路径 clone
    const parent = root()
    const res = await cloneRepo(src, parent, [parent])
    expect(res.ok).toBe(true)
    expect(existsSync(join(parent, basename(src), ".git"))).toBe(true)
  })
  it("rejects empty url, unsafe url, and parent outside roots", async () => {
    const parent = root()
    expect((await cloneRepo("", parent, [parent])).ok).toBe(false)
    expect((await cloneRepo("--upload-pack=evil", parent, [parent])).ok).toBe(false)
    expect((await cloneRepo(makeRepo(), root(), [parent])).ok).toBe(false) // parent 不在 root 内
  })
})

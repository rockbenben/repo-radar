import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { scan } from "../src/scanner"

const root = mkdtempSync(join(tmpdir(), "rr-scan-"))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

// 结构：
//   root/repo-a/.git                 → 发现
//   root/repo-a/nested/.git          → 忽略（在仓库内部）
//   root/group/repo-b/.git           → 发现
//   root/node_modules/repo-c/.git    → 忽略（excludes）
//   root/.hidden/repo-d/.git         → 忽略（隐藏目录）
//   root/plain/                      → 无 .git，不发现
for (const p of [
  ["repo-a", ".git"],
  ["repo-a", "nested", ".git"],
  ["group", "repo-b", ".git"],
  ["node_modules", "repo-c", ".git"],
  [".hidden", "repo-d", ".git"],
  ["plain"],
]) {
  mkdirSync(join(root, ...p), { recursive: true })
}

describe("scan", () => {
  it("finds repos, skips nested/excluded/hidden", () => {
    const found = scan([root], ["node_modules"])
    expect(found.sort()).toEqual([join(root, "group", "repo-b"), join(root, "repo-a")].sort())
  })

  it("returns empty for missing root", () => {
    expect(scan([join(root, "no-such-dir")], [])).toEqual([])
  })
})

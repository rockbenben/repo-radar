import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { CLONE_TMP_PREFIX } from "../src/scaffold"
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

  // 缺陷 5：scanner 对克隆临时目录的忽略实际上搭的是「目录名以 . 开头就跳过」这条通用隐藏目录规则
  // （CLONE_TMP_PREFIX 本身就是点号开头，见 scaffold.ts），而不是专门认 CLONE_TMP_PREFIX 这个字符串。
  // 这里验证匹配足够精确：判断依据是「目录名」本身，不是「路径里包含某个子串」——一个不带点号、
  // 名字里恰好包含 CLONE_TMP_PREFIX 子串（去掉开头的点）的真实目录，必须正常被发现，不能被误伤
  it("不会因为目录名里含有克隆临时前缀的子串就误伤真实仓库（忽略只认「点号开头」，不是子串匹配）", () => {
    const scanner2 = mkdtempSync(join(tmpdir(), "rr-scan2-"))
    try {
      const suspicious = CLONE_TMP_PREFIX.slice(1) + "not-hidden" // 去掉开头的点：repo-radar-clone-not-hidden
      mkdirSync(join(scanner2, suspicious, ".git"), { recursive: true })
      const found = scan([scanner2], [])
      expect(found).toEqual([join(scanner2, suspicious)]) // 正常被发现，没被当成克隆残骸忽略
    } finally {
      rmSync(scanner2, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createStash, dropStashes, listStashes, stashAction, stashDiff } from "../src/git"
import { cleanupFixtures, git, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

/** 在一个已有 1 次提交（f0.txt=v0）的仓库里压入 n 条可区分的 stash（msg-0 最先、最旧）。 */
function repoWithStashes(n: number): string {
  const dir = makeRepo()
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, "f0.txt"), `stash-content-${i}`)
    git(dir, "stash", "push", "-m", `msg-${i}`)
  }
  return dir
}

describe("listStashes", () => {
  it("returns entries newest-first with branch, message and change stats", async () => {
    const dir = repoWithStashes(2)
    const entries = await listStashes(dir)
    expect(entries).toHaveLength(2)
    // git stash list 顺序：最新在前
    expect(entries[0].message).toContain("msg-1")
    expect(entries[1].message).toContain("msg-0")
    expect(entries[0].sha).toMatch(/^[0-9a-f]{40}$/)
    expect(entries[0].branch).toBe("main")
    expect(entries[0].files).toBe(1)
    expect(entries[0].insertions).toBeGreaterThan(0)
    expect(entries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("returns empty array for a repo with no stashes", async () => {
    expect(await listStashes(makeRepo())).toEqual([])
  })

  it("createStash stashes tracked + untracked changes and cleans the tree", async () => {
    const dir = makeRepo() // f0.txt = v0
    writeFileSync(join(dir, "f0.txt"), "changed")
    writeFileSync(join(dir, "new.txt"), "untracked")
    const res = await createStash(dir, "wip")
    expect(res.ok).toBe(true)
    expect(readFileSync(join(dir, "f0.txt"), "utf8")).toBe("v0") // 工作区已变干净
    const stashes = await listStashes(dir)
    expect(stashes).toHaveLength(1)
    expect(stashes[0].message).toContain("wip")
  })

  it("createStash reports empty when there is nothing to stash", async () => {
    const res = await createStash(makeRepo(), "")
    expect(res.ok).toBe(false)
    expect(res.empty).toBe(true)
  })

  it("createStash with a message containing git's no-changes phrase still reports success", async () => {
    const dir = makeRepo()
    writeFileSync(join(dir, "f0.txt"), "changed")
    const res = await createStash(dir, "No local changes to save") // 消息会被 git 回显，但按条数判定不受影响
    expect(res.ok).toBe(true)
    expect(res.empty).toBeUndefined()
    expect(await listStashes(dir)).toHaveLength(1)
  })

  it("counts untracked-only stashes made with -u (must not report as empty)", async () => {
    const dir = makeRepo()
    writeFileSync(join(dir, "brand-new.txt"), "unsaved work")
    git(dir, "stash", "push", "-u", "-m", "untracked-only")
    const [entry] = await listStashes(dir)
    expect(entry.files).toBeGreaterThan(0) // 修复前 --include-untracked 缺失时会是 0（误报为空 → 有误删风险）
    const diff = await stashDiff(dir, entry.sha)
    expect(diff).toContain("brand-new.txt")
  })
})

describe("stashDiff", () => {
  it("returns the patch text for a known stash sha", async () => {
    const dir = repoWithStashes(1)
    const [entry] = await listStashes(dir)
    const diff = await stashDiff(dir, entry.sha)
    expect(diff).not.toBeNull()
    expect(diff).toContain("f0.txt")
    expect(diff).toContain("stash-content-0")
  })

  it("returns null for an unknown sha", async () => {
    const dir = repoWithStashes(1)
    expect(await stashDiff(dir, "0".repeat(40))).toBeNull()
  })

  // git 默认 core.quotePath=true 会把路径里的非 ASCII 字节 C-quote 掉，收纳箱里的 diff
  // 于是变成 `diff --git "a/\344\270\255\346\226\207.md"`
  it("非 ASCII 文件名原样返回，不是八进制转义", async () => {
    const dir = makeRepo()
    const named = "中文-😀.md"
    writeFileSync(join(dir, named), "v0")
    git(dir, "add", "-A")
    git(dir, "commit", "-m", "add-nonascii")
    writeFileSync(join(dir, named), "v1")
    git(dir, "stash", "push", "-m", "nonascii")
    const [entry] = await listStashes(dir)
    const diff = await stashDiff(dir, entry.sha)
    expect(diff).toContain(named)
    expect(diff).not.toMatch(/\\3\d\d/) // 八进制转义的形状，如 \344
  })
})

describe("stashAction", () => {
  it("apply restores content but keeps the stash", async () => {
    const dir = repoWithStashes(1)
    const [entry] = await listStashes(dir)
    const res = await stashAction(dir, entry.sha, "apply")
    expect(res.ok).toBe(true)
    expect(readFileSync(join(dir, "f0.txt"), "utf8")).toBe("stash-content-0")
    expect(await listStashes(dir)).toHaveLength(1)
  })

  it("pop restores content and removes the stash", async () => {
    const dir = repoWithStashes(1)
    const [entry] = await listStashes(dir)
    const res = await stashAction(dir, entry.sha, "pop")
    expect(res.ok).toBe(true)
    expect(readFileSync(join(dir, "f0.txt"), "utf8")).toBe("stash-content-0")
    expect(await listStashes(dir)).toHaveLength(0)
  })

  it("drop removes the stash without touching the working tree", async () => {
    const dir = repoWithStashes(1)
    const [entry] = await listStashes(dir)
    const res = await stashAction(dir, entry.sha, "drop")
    expect(res.ok).toBe(true)
    expect(readFileSync(join(dir, "f0.txt"), "utf8")).toBe("v0")
    expect(await listStashes(dir)).toHaveLength(0)
  })

  it("reports not-found for a sha that is not a stash", async () => {
    const res = await stashAction(makeRepo(), "0".repeat(40), "drop")
    expect(res.ok).toBe(false)
  })

  it("flags pop conflicts distinctly (changes applied, stash kept)", async () => {
    const dir = makeRepo() // f0.txt = v0
    writeFileSync(join(dir, "f0.txt"), "stash-side")
    git(dir, "stash", "push", "-m", "s")
    // 让 HEAD 在同一处有不同内容 → pop 必冲突
    writeFileSync(join(dir, "f0.txt"), "main-side")
    git(dir, "commit", "-am", "diverge")
    const [entry] = await listStashes(dir)
    const res = await stashAction(dir, entry.sha, "pop")
    expect(res.ok).toBe(false)
    expect(res.conflict).toBe(true) // 冲突而非纯失败
    expect(await listStashes(dir)).toHaveLength(1) // pop 冲突时 stash 保留
  })
})

describe("dropStashes", () => {
  it("drops the exact selected stashes despite index renumbering", async () => {
    // msg-0(idx2) · msg-1(idx1) · msg-2(idx0)。丢弃 msg-2 和 msg-0（不同 sha），应只剩 msg-1。
    const dir = repoWithStashes(3)
    const entries = await listStashes(dir)
    const shaOf = (m: string) => entries.find((x) => x.message.includes(m))!.sha
    const results = await dropStashes(dir, [shaOf("msg-2"), shaOf("msg-0")])
    expect(results.every((r) => r.ok)).toBe(true)
    const after = await listStashes(dir)
    expect(after).toHaveLength(1)
    expect(after[0].message).toContain("msg-1")
  })

  it("git collapses consecutive byte-identical stashes to one entry", async () => {
    const dir = makeRepo()
    const date = "2026-01-01T00:00:00 +0000"
    // 相同内容 + 相同日期 + 相同消息 → 两次 push 得到相同 sha；git 不会紧接着为同一 sha 再记一条 reflog
    for (let i = 0; i < 2; i++) {
      writeFileSync(join(dir, "f0.txt"), "same-content")
      execFileSync("git", ["stash", "push", "-m", "dup"], {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      })
    }
    expect(await listStashes(dir)).toHaveLength(1)
  })

  it("non-consecutive byte-identical stashes DO coexist with the same sha; drop clears them one at a time", async () => {
    // 反例：夹一条不同内容后再压回相同内容（X,Y,X）→ 两条真的共用同一 sha（连续压才会被折叠）。
    // 这才是 sha 并非绝对唯一的边界；此时两条字节相同、可互换，按 sha 逐次 drop 即可清空，不必退回 (sha,index)。
    const dir = makeRepo()
    const date = "2026-01-01T00:00:00 +0000"
    const push = (content: string) => {
      writeFileSync(join(dir, "f0.txt"), content)
      execFileSync("git", ["stash", "push", "-m", "dup"], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
    }
    push("X")
    push("Y")
    push("X")
    const entries = await listStashes(dir)
    expect(entries).toHaveLength(3)
    const dupSha = entries[0].sha
    expect(entries.filter((e) => e.sha === dupSha)).toHaveLength(2) // 两条共用同一 sha
    // 按该 sha drop 一次删掉一条，重复的另一条仍在（可再次 drop）——不会误删、不会卡死
    await dropStashes(dir, [dupSha])
    const afterOne = await listStashes(dir)
    expect(afterOne).toHaveLength(2)
    expect(afterOne.filter((e) => e.sha === dupSha)).toHaveLength(1)
    await dropStashes(dir, [dupSha])
    expect(await listStashes(dir)).toHaveLength(1) // 只剩下 Y
  })

  it("reports not-found shas without failing the batch or touching real stashes", async () => {
    const dir = repoWithStashes(1)
    const [entry] = await listStashes(dir)
    const results = await dropStashes(dir, [entry.sha, "0".repeat(40)])
    expect(results.find((r) => r.sha === entry.sha)?.ok).toBe(true)
    expect(results.find((r) => r.sha === "0".repeat(40))?.ok).toBe(false) // 未知 sha 报未找到，不误删
    expect(await listStashes(dir)).toHaveLength(0)
  })
})

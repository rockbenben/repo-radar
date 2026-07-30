import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { commitRepo, createBranch, discardChanges, getRepoDetail, getRepoDiff, getRepoStatus, switchBranch } from "../src/git"
import { cleanupFixtures, git, makeRepo, makeRepoWithSubmodule, makeRepoWithUpstream } from "./fixtures"

afterAll(cleanupFixtures)

describe("getRepoStatus", () => {
  it("lists merged local branches as cleanable, excluding current and main", async () => {
    const path = makeRepo({ commits: 1 })
    git(path, "branch", "feature-done") // 指向 main tip → 已合并
    const s = await getRepoStatus(path)
    expect(s.mergedBranches).toContain("feature-done")
    expect(s.mergedBranches).not.toContain("main")
  })

  it("reads a clean repo without upstream", async () => {
    const path = makeRepo()
    const s = await getRepoStatus(path)
    expect(s.name).toBe(basename(path))
    expect(s.branch).toBe("main")
    expect(s.dirty).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
    expect(s.ahead).toBe(-1)
    expect(s.behind).toBe(-1)
    expect(s.remotes).toEqual([])
    expect(s.stashCount).toBe(0)
    expect(s.lastCommit?.message).toBe("c0")
    expect(s.error).toBeNull()
    expect(s.displayName).toBeNull() // fixture 无 package.json、无 remote
    expect(s.description).toBeNull()
  })

  it("counts untracked file as dirty", async () => {
    const s = await getRepoStatus(makeRepo({ dirty: true }))
    expect(s.dirty.untracked).toBe(1)
  })

  it("reports detached HEAD as null branch", async () => {
    const s = await getRepoStatus(makeRepo({ detached: true }))
    expect(s.branch).toBeNull()
  })

  it("counts stash entries", async () => {
    const s = await getRepoStatus(makeRepo({ stash: true }))
    expect(s.stashCount).toBe(1)
  })

  it("reports ahead=1 behind=0 with upstream", async () => {
    const s = await getRepoStatus(makeRepoWithUpstream())
    expect(s.ahead).toBe(1)
    expect(s.behind).toBe(0)
    expect(s.remotes).toEqual([{ name: "origin", url: expect.any(String) }])
  })

  it("handles empty repo (no commits) with null lastCommit", async () => {
    const s = await getRepoStatus(makeRepo({ commits: 0 }))
    expect(s.lastCommit).toBeNull()
    expect(s.branch).toBe("main")
  })

  it("rejects for a non-git directory", async () => {
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    await expect(getRepoStatus(mkdtempSync(join(tmpdir(), "rr-notgit-")))).rejects.toThrow()
  })
})

describe("getRepoDetail", () => {
  it("returns recent commits (newest first) and structured stash entries", async () => {
    const path = makeRepo({ commits: 3, stash: true })
    const d = await getRepoDetail(path)
    expect(d.recentCommits.length).toBeGreaterThanOrEqual(3)
    expect(d.recentCommits[0].message).toBe("c2")
    expect(d.stashes).toHaveLength(1)
    expect(d.stashes[0].ref).toMatch(/stash@\{0\}/)
    expect(d.stashes[0].sha).toMatch(/^[0-9a-f]{40}$/)
  })
  // 签名提交的用户常在 gitconfig 里开 log.showSignature=true，git 于是在**每条**提交的
  // --format 输出之前往 stdout 插一行验签结果。四处 git log 都按「一行 = 一条提交」解析，
  // 不挡掉的话 N 条提交会解析成 2N 条，一半是 hash 为验签文本、其余字段 undefined 的空条目。
  // 这里不需要密钥：手工写一个带 gpgsig 头的 commit 对象就够触发验签（结果是失败，一样插行）
  it("不被 log.showSignature 插进来的验签行撑破提交列表", async () => {
    const dir = makeRepo({ commits: 1 })
    git(dir, "config", "log.showSignature", "true")
    const tree = git(dir, "rev-parse", "HEAD^{tree}").trim()
    const obj = [
      `tree ${tree}`,
      "author t <a@b.c> 1700000000 +0000",
      "committer t <a@b.c> 1700000000 +0000",
      "gpgsig -----BEGIN SSH SIGNATURE-----",
      " bogus",
      " -----END SSH SIGNATURE-----",
      "",
      "signed subject",
      "",
    ].join("\n")
    const sha = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: dir,
      encoding: "utf8",
      input: obj,
    }).trim()
    git(dir, "update-ref", "refs/heads/main", sha)
    const d = await getRepoDetail(dir, true)
    expect(d.recentCommits).toHaveLength(1)
    expect(d.recentCommits[0]).toMatchObject({ hash: sha, message: "signed subject", author: "t" })
  })
  // 用户 gitconfig 里的这三个键都会改变被解析的 git 输出：
  //   i18n.logOutputEncoding=GBK —— 中文 Windows 用户治 git log 乱码的标准做法，git 按 GBK
  //     输出字节，而 runGit 无条件按 utf8 解码，每个汉字都成 U+FFFD；乱码还会随 lastCommit
  //     写进按指纹失效的缓存，改回配置也不解
  //   color.ui/color.diff=always —— ANSI 转义进 diff 文本，前端按 `+`/`-`/`@@` 前缀上色的
  //     三个判据全落空
  //   status.showUntrackedFiles=no —— 大仓库的性能调优（git 文档自己推荐），porcelain v2
  //     不再输出 `? ` 行，卡片报「干净」而 diff 面板照列未跟踪文件，且「丢弃改动」照删不误
  it("不被用户 gitconfig 里的编码/颜色/未跟踪设置污染", async () => {
    const dir = makeRepo({ commits: 0 })
    writeFileSync(join(dir, "a.txt"), "1\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-m", "修复中文提交信息")
    git(dir, "config", "i18n.logOutputEncoding", "GBK")
    git(dir, "config", "color.diff", "always")
    git(dir, "config", "status.showUntrackedFiles", "no")
    writeFileSync(join(dir, "a.txt"), "2\n")
    writeFileSync(join(dir, "untracked.txt"), "u")

    const s = await getRepoStatus(dir)
    expect(s.lastCommit?.message).toBe("修复中文提交信息") // 不是 U+FFFD 乱码
    expect(s.dirty.untracked).toBe(1) // 不是被 showUntrackedFiles=no 抹成 0

    const d = await getRepoDetail(dir, true)
    expect(d.recentCommits[0].message).toBe("修复中文提交信息")

    const diff = await getRepoDiff(dir)
    expect(diff.diff).not.toMatch(/\[/) // 没有 ANSI 转义
    expect(diff.diff).toMatch(/^diff --git /m) // 行首仍是前端认得的前缀
  })
  it("lists local branches with main first, no remote-only branches", async () => {
    const dir = makeRepo({ commits: 1 })
    git(dir, "branch", "feature")
    const d = await getRepoDetail(dir)
    expect(d.branches).toEqual(["main", "feature"]) // main 置顶
    expect(d.remoteBranches).toEqual([])
  })
  it("degrades to empty arrays for an empty repo", async () => {
    const d = await getRepoDetail(makeRepo({ commits: 0 }))
    expect(d).toEqual({ recentCommits: [], stashes: [], branches: [], remoteBranches: [] })
  })
  // 游离 HEAD 时 `git branch` 会多打一行伪条目 `(HEAD detached at v1)`。它进了切换器就是一个
  // 选中即 `fatal: invalid reference` 的选项，而 parseStatus 此时 branch===null，
  // 那道剔除当前分支的过滤对它恒真、拦不住
  it("游离 HEAD 时不把 `(HEAD detached at …)` 伪条目当成本地分支", async () => {
    const dir = makeRepo({ commits: 1 })
    git(dir, "branch", "(weird)") // 名字带括号的**真**分支：判据不能是「( 开头就丢掉」，那会误杀它
    git(dir, "tag", "v1")
    git(dir, "checkout", "v1")
    const d = await getRepoDetail(dir)
    expect(d.branches).toEqual(["main", "(weird)"])
  })
})

describe("switchBranch", () => {
  it("switches to an existing local branch", async () => {
    const dir = makeRepo({ commits: 1 })
    git(dir, "branch", "feature")
    const res = await switchBranch(dir, "feature")
    expect(res.ok).toBe(true)
    expect((await getRepoStatus(dir)).branch).toBe("feature")
  })
  it("reports failure (not throw) for a non-existent branch", async () => {
    const res = await switchBranch(makeRepo({ commits: 1 }), "no-such-branch")
    expect(res.ok).toBe(false)
    expect(res.message).not.toBe("")
  })
  it("checks out a remote-only branch, creating a local tracking branch", async () => {
    const repo = makeRepoWithUpstream() // origin/main + 本地领先
    git(repo, "push", "origin", "HEAD:refs/heads/feature-remote") // origin 上造一个本地没有的分支
    git(repo, "fetch")
    const d = await getRepoDetail(repo)
    expect(d.remoteBranches).toContain("feature-remote")
    expect(d.branches).not.toContain("feature-remote") // 本地尚无
    const res = await switchBranch(repo, "feature-remote") // dwim：自动建跟踪分支
    expect(res.ok).toBe(true)
    expect((await getRepoStatus(repo)).branch).toBe("feature-remote")
  })
  it("excludes remote branch names present on multiple remotes (ambiguous DWIM)", async () => {
    const bare1 = mkdtempSync(join(tmpdir(), "rr-bare1-"))
    const bare2 = mkdtempSync(join(tmpdir(), "rr-bare2-"))
    git(bare1, "init", "--bare", "-b", "main")
    git(bare2, "init", "--bare", "-b", "main")
    const repo = makeRepo({ commits: 1 })
    git(repo, "remote", "add", "origin", bare1)
    git(repo, "remote", "add", "upstream", bare2)
    git(repo, "push", "origin", "HEAD:refs/heads/shared")
    git(repo, "push", "upstream", "HEAD:refs/heads/shared") // 两个远程同名
    git(repo, "push", "origin", "HEAD:refs/heads/only-origin") // 仅一个远程
    git(repo, "fetch", "--all")
    const d = await getRepoDetail(repo)
    expect(d.remoteBranches).toContain("only-origin") // 单远程可安全切换
    expect(d.remoteBranches).not.toContain("shared") // 多远程同名 → 排除（否则 git switch 歧义失败）
    rmSync(bare1, { recursive: true, force: true, maxRetries: 3 })
    rmSync(bare2, { recursive: true, force: true, maxRetries: 3 })
  })
})

describe("createBranch", () => {
  it("creates and switches to a new branch", async () => {
    const dir = makeRepo({ commits: 1 })
    const res = await createBranch(dir, "feature-x")
    expect(res.ok).toBe(true)
    expect((await getRepoStatus(dir)).branch).toBe("feature-x")
  })
  it("fails (not throw) on an already-existing branch name", async () => {
    const res = await createBranch(makeRepo({ commits: 1 }), "main")
    expect(res.ok).toBe(false)
    expect(res.message).not.toBe("")
  })
})

describe("discardChanges", () => {
  it("reverts tracked changes and removes untracked files, leaving a clean tree", async () => {
    const dir = makeRepo({ commits: 1 }) // f0.txt = v0
    writeFileSync(join(dir, "f0.txt"), "modified") // 已跟踪改动
    writeFileSync(join(dir, "untracked.txt"), "new") // 未跟踪
    const res = await discardChanges(dir)
    expect(res.ok).toBe(true)
    expect(readFileSync(join(dir, "f0.txt"), "utf8")).toBe("v0") // 已还原
    expect(existsSync(join(dir, "untracked.txt"))).toBe(false) // 已删除
    const s = await getRepoStatus(dir)
    expect(s.dirty.staged + s.dirty.unstaged + s.dirty.untracked).toBe(0) // 干净
  })
  // reset --hard 不递归 submodule、clean -fd 跳过嵌套仓库——少删是刻意的安全方向。但确认弹窗
  // 承诺「将丢弃 N 处未提交改动」、成功后前端弹「已丢弃未提交改动」，而 submodule 里的改动一个
  // 字节都没动、计数原样不变，再点几次都一样。不能一边什么都没丢一边宣告成功
  it("submodule 里的改动没丢掉时不谎报成功", async () => {
    const dir = makeRepoWithSubmodule()
    writeFileSync(join(dir, "sub", "f0.txt"), "modified in submodule")
    const before = await getRepoStatus(dir)
    expect(before.dirty.staged + before.dirty.unstaged).toBe(1) // 宿主看得见这处改动

    const res = await discardChanges(dir)
    expect(res).toMatchObject({ ok: false, code: "outOfScope" })
    expect(readFileSync(join(dir, "sub", "f0.txt"), "utf8")).toBe("modified in submodule") // 确实没动它
  })
  // `git clean -fd` 对**未跟踪的嵌套 git 仓库**是静默跳过（退出 0、无输出、条目原样留着），而它
  // 是 `? ` 行，与普通未跟踪目录长得一模一样。往项目里 clone 过参考库、vendored 依赖自带 .git、
  // submodule 被 deinit——都会留下这样一个目录。它若是唯一的脏项，两条 git 就一个字节都没动，
  // 却报绿色「已丢弃未提交改动」+ 一条成功日志，用户能一直点下去而磁盘毫无变化
  it("唯一脏项是未跟踪的嵌套 git 仓库时不谎报成功", async () => {
    const dir = makeRepo({ commits: 1 })
    const nested = join(dir, "vendor-ref")
    mkdirSync(nested)
    git(nested, "init", "-b", "main")
    git(nested, "config", "user.email", "test@test.local")
    git(nested, "config", "user.name", "test")
    writeFileSync(join(nested, "n.txt"), "n")
    git(nested, "add", "-A")
    git(nested, "commit", "-m", "n")

    const res = await discardChanges(dir)
    expect(res).toMatchObject({ ok: false, code: "outOfScope" })
    expect(existsSync(join(nested, ".git"))).toBe(true) // clean -fd 确实没碰它
  })
  // 复核用的 status 必须和 getRepoCore 一样带 --untracked-files=normal。缺了它，用户 gitconfig 里
  // 的 status.showUntrackedFiles=no（git 文档自己推荐的大仓库调优）会让 `? ` 行全部消失，
  // before 与 residual 双双是空串，nothingChanged 里的 `residual !== ""` 一票否决——上面那条
  // 「唯一脏项是嵌套仓库」的保护被一个配置原样解锁，又会报绿色成功
  it("复核不被 status.showUntrackedFiles=no 架空", async () => {
    const dir = makeRepo({ commits: 1 })
    git(dir, "config", "status.showUntrackedFiles", "no")
    const nested = join(dir, "vendor-ref")
    mkdirSync(nested)
    git(nested, "init", "-b", "main")

    const res = await discardChanges(dir)
    expect(res).toMatchObject({ ok: false, code: "outOfScope" })
    expect(existsSync(join(nested, ".git"))).toBe(true)
  })

  // orphan 分支（`git switch --orphan gh-pages`）：HEAD 未出生但仓库别处有提交，`reset --hard HEAD`
  // 必败。这里**刻意保留拒绝行为**——放宽判据去走空仓库路径会 read-tree --empty + clean -fd 把整个
  // 工作区清空。只是别把 `fatal: ambiguous argument 'HEAD'` 这种 git 内部术语丢给用户
  // 断言**code** 而不是 message 文本：message 按约定是中文原文（只作日志与兜底），界面靠 code 走
  // i18n。上一版断言 `message` 里含 "orphan"——那个拉丁词正好嵌在中文句子里，所以恒真，
  // 既没钉住「不吐 git 术语」，更没钉住「可本地化」。code:"error" 的不变量是「message 就是 git
  // 原始输出」（msg.discardFail 的 {err} 透传建立在它上面），塞中文进去就会漏给 18 种语言的用户
  it("orphan 分支上如实拒绝，且给出可本地化的 code", async () => {
    const dir = makeRepo({ commits: 1 })
    git(dir, "checkout", "--orphan", "gh-pages")
    const res = await discardChanges(dir)
    expect(res).toMatchObject({ ok: false, code: "unbornHead" })
    expect(existsSync(join(dir, "f0.txt"))).toBe(true) // 工作区一个文件都没动
  })

  // 对照：真改动 + 嵌套仓库并存时报成功是**对的**。丢弃确实生效了（f0.txt 已还原），而
  // `clean -fd` 保留嵌套仓库是既定的安全取舍（少删）。这一支若也报失败，等于对每个放了
  // vendored .git 的仓库长期唠叨一件已经接受的事——判据只该抓「一个字节都没动」那种空口宣告
  // `clean -fd` 失败时 reset 已经生效——已跟踪的改动是真的没了。此时若把整件事报成「丢弃失败」，
  // 用户读到的是一句以 warning 开头、主语是某个未跟踪文件的话，结论必然是「什么都没发生」，
  // 于是不会去重做那份工作：真实的数据丢失被一句错误提示盖住。
  //
  // **只在 win32 上真的跑**：造这个场景要让 clean 删不掉某个未跟踪文件，而 POSIX 允许删除已打开
  // 的文件，句柄占用造不出失败。Linux 那条腿上这个用例是空的——不假装它守住了什么。
  it.runIf(process.platform === "win32")("clean 失败时不报成一句笼统的「丢弃失败」", async () => {
    const dir = makeRepo({ commits: 1 }) // f0.txt = v0
    writeFileSync(join(dir, "f0.txt"), "modified") // 已跟踪改动：reset 会真的丢掉它
    const held = join(dir, "buildout")
    mkdirSync(held)
    writeFileSync(join(held, "x.txt"), "x") // 未跟踪，clean 本该连目录一起删
    // 以该目录为 CWD 的长命进程会占住它（用户开着的终端、跑在 buildout/ 里的 dev server 就是
    // 这个形状），clean -fd 于是 `warning: failed to remove buildout/: Permission denied` 退 1。
    // 文件句柄那条路造不出来——Node 用 FILE_SHARE_DELETE 打开，删得掉
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: held })
    try {
      await new Promise((r) => setTimeout(r, 400)) // 等进程真的把 CWD 占上
      const res = await discardChanges(dir)
      expect(res).toMatchObject({ ok: false, code: "outOfScope" })
      expect(readFileSync(join(dir, "f0.txt"), "utf8")).toBe("v0") // reset 确实已经生效
    } finally {
      holder.kill()
    }
  })

  it("真改动与嵌套仓库并存时照常报成功（丢弃确实生效了）", async () => {
    const dir = makeRepo({ commits: 1 }) // f0.txt = v0
    writeFileSync(join(dir, "f0.txt"), "modified")
    const nested = join(dir, "vendor-ref")
    mkdirSync(nested)
    git(nested, "init", "-b", "main")

    const res = await discardChanges(dir)
    expect(res).toMatchObject({ ok: true, code: "discarded" })
    expect(readFileSync(join(dir, "f0.txt"), "utf8")).toBe("v0") // 真改动确实还原了
    expect(existsSync(join(nested, ".git"))).toBe(true) // 嵌套仓库照旧保留
  })
  it("discards staged files in an unborn (no-commit) repo", async () => {
    const dir = makeRepo({ commits: 0 }) // 空仓库，无 HEAD
    writeFileSync(join(dir, "staged.txt"), "x")
    git(dir, "add", "-A") // 暂存新文件
    writeFileSync(join(dir, "loose.txt"), "y") // 未跟踪
    const res = await discardChanges(dir)
    expect(res.ok).toBe(true)
    expect(existsSync(join(dir, "staged.txt"))).toBe(false) // 暂存的新文件也被丢弃
    expect(existsSync(join(dir, "loose.txt"))).toBe(false)
    const s = await getRepoStatus(dir)
    expect(s.dirty.staged + s.dirty.unstaged + s.dirty.untracked).toBe(0)
  })
})

describe("getRepoDiff", () => {
  it("returns non-empty diff for a modified tracked file", async () => {
    const path = makeRepo()
    writeFileSync(join(path, "f0.txt"), "modified content")
    const d = await getRepoDiff(path)
    expect(d.diff.length).toBeGreaterThan(0)
    expect(d.diff).toMatch(/f0\.txt/)
  })

  it("returns untracked file paths", async () => {
    const path = makeRepo({ dirty: true })
    const d = await getRepoDiff(path)
    expect(d.untracked).toContain("new.txt")
  })

  it("returns empty diff and untracked for a clean repo", async () => {
    const d = await getRepoDiff(makeRepo())
    expect(d.diff).toBe("")
    expect(d.untracked).toEqual([])
  })

  // git 默认 core.quotePath=true，凡是路径都会被 C-quote：不关掉的话中文/emoji 文件名在详情面板
  // 显示成 "\344\270\255\346\226\207.md"。本应用的目标用户就是多语言仓库，这属日常状态
  it("非 ASCII 文件名原样返回，不是八进制转义", async () => {
    const path = makeRepo()
    const tracked = "中文-café.md"
    const untracked = "未跟踪-😀.txt"
    writeFileSync(join(path, tracked), "v0")
    git(path, "add", "-A")
    git(path, "commit", "-m", "add-nonascii")
    writeFileSync(join(path, tracked), "v1")
    writeFileSync(join(path, untracked), "x")
    const d = await getRepoDiff(path)
    expect(d.diff).toContain(tracked)
    expect(d.diff).not.toMatch(/\\3\d\d/) // 八进制转义的形状，如 \344
    expect(d.untracked).toContain(untracked)
  })
})

describe("commitRepo", () => {
  it("commits a dirty repo and leaves the working tree clean", async () => {
    const path = makeRepo()
    writeFileSync(join(path, "f0.txt"), "modified content")
    const r = await commitRepo(path, "wip", false)
    expect(r.ok).toBe(true)
    const s = await getRepoStatus(path)
    expect(s.dirty).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
  })

  it("returns ok:false when there is nothing to commit", async () => {
    const path = makeRepo()
    const r = await commitRepo(path, "empty", false)
    expect(r.ok).toBe(false)
  })
})

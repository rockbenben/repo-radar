import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const created: string[] = []

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" })
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

export interface MakeRepoOpts {
  dirty?: boolean // 加一个 untracked 文件
  detached?: boolean // checkout --detach
  stash?: boolean // 留一条 stash
  commits?: number // 提交数，默认 1；0 = 空仓库（无 HEAD）
}

export function makeRepo(opts: MakeRepoOpts = {}): string {
  const dir = tempDir("rr-repo-")
  git(dir, "init", "-b", "main")
  git(dir, "config", "user.email", "test@test.local")
  git(dir, "config", "user.name", "test")
  git(dir, "config", "commit.gpgsign", "false")
  const n = opts.commits ?? 1
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `f${i}.txt`), `v${i}`)
    git(dir, "add", "-A")
    git(dir, "commit", "-m", `c${i}`)
  }
  if (opts.stash) {
    writeFileSync(join(dir, "f0.txt"), "stash-me")
    git(dir, "stash")
  }
  if (opts.dirty) writeFileSync(join(dir, "new.txt"), "x")
  if (opts.detached) git(dir, "checkout", "--detach", "HEAD")
  return dir
}

/** bare 仓库作 upstream 的 clone，本地领先 1 个提交（ahead=1, behind=0） */
export function makeRepoWithUpstream(): string {
  const bare = tempDir("rr-bare-")
  git(bare, "init", "--bare", "-b", "main")
  const repo = tempDir("rr-clone-")
  git(repo, "init", "-b", "main")
  git(repo, "config", "user.email", "test@test.local")
  git(repo, "config", "user.name", "test")
  git(repo, "config", "commit.gpgsign", "false")
  writeFileSync(join(repo, "a.txt"), "1")
  git(repo, "add", "-A")
  git(repo, "commit", "-m", "c0")
  git(repo, "remote", "add", "origin", bare)
  git(repo, "push", "-u", "origin", "main")
  writeFileSync(join(repo, "a.txt"), "2")
  git(repo, "add", "-A")
  git(repo, "commit", "-m", "c1")
  return repo
}

/** 有 upstream 且落后 1 个提交的仓库（behind=1, ahead=0） */
export function makeBehindRepo(): string {
  const repo = makeRepoWithUpstream() // ahead=1
  git(repo, "push")
  git(repo, "reset", "--hard", "HEAD~1")
  git(repo, "fetch")
  return repo
}

/** 按给定 ISO 日期序列各提交一次（author/committer date 同步） */
export function makeRepoWithDates(dates: string[]): string {
  const dir = tempDir("rr-dated-")
  git(dir, "init", "-b", "main")
  git(dir, "config", "user.email", "test@test.local")
  git(dir, "config", "user.name", "test")
  git(dir, "config", "commit.gpgsign", "false")
  dates.forEach((date, i) => {
    writeFileSync(join(dir, `f${i}.txt`), String(i))
    git(dir, "add", "-A")
    execFileSync("git", ["commit", "-m", `c${i}`, `--date=${date}`], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_COMMITTER_DATE: date },
    })
  })
  return dir
}

export function cleanupFixtures(): void {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

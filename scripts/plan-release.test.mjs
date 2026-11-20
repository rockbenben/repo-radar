import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { nextVersion, planRelease } from "./plan-release.mjs"

test("chooses the largest Conventional Commit bump since the published release", () => {
  const plan = (...messages) => nextVersion("v1.4.2", messages, new Set())
  assert.equal(plan("docs: install", "chore(ci): upgrade"), "")
  assert.equal(plan("perf(scan): reduce disk reads"), "1.4.3")
  assert.equal(plan("feat: add filter", "fix(ui): restore selection"), "1.5.0")
  assert.equal(plan("feat: add filter", "refactor(api)!: remove legacy endpoint"), "2.0.0")
  assert.equal(plan("fix: update API\n\nBREAKING CHANGE: remove field"), "2.0.0")
})

test("skips reserved tags without losing changes after the last published release", () => {
  assert.equal(nextVersion("v1.4.0", ["feat: improve search"], new Set(["v1.5.0"])), "1.5.1")
})

test("resumes a matching draft and protects published or superseded commits", t => {
  const cwd = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), "rr-release-"))
  t.after(() => {
    process.chdir(cwd)
    rmSync(dir, { recursive: true, force: true })
  })
  process.chdir(dir)
  const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.org",
    "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("commit", "--allow-empty", "-qm", "feat: first release")
  assert.equal(planRelease([]), "0.1.0")
  git("tag", "v1.4.0")
  const releases = [{ tag_name: "v1.4.0" }]
  git("commit", "--allow-empty", "-qm", "feat: add history")
  git("tag", "v1.5.0")
  const head = git("rev-parse", "HEAD")
  releases.push({ tag_name: "v1.5.1", draft: true, target_commitish: head })
  assert.equal(planRelease(releases, "1.5.1"), "1.5.1")
  assert.throws(() => planRelease(releases, "1.5.0"), /Stale release plan/)
  git("tag", "v1.5.1")
  releases[1].draft = false
  assert.equal(planRelease(releases), "")
  assert.equal(planRelease(releases, "1.5.1"), "published")
  git("checkout", "-q", "--detach", "v1.4.0")
  assert.equal(planRelease(releases), "")
  assert.throws(() => planRelease(releases, "1.5.1"), /Stale release plan/)
})

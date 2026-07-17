import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { getRepoStatus, runRepoAction } from "../src/git"
import { cleanupFixtures, git, makeBehindRepo, makeRepo, makeRepoWithUpstream } from "./fixtures"

afterAll(cleanupFixtures)

describe("runRepoAction", () => {
  it("fetch succeeds on a repo with upstream", async () => {
    const r = await runRepoAction(makeRepoWithUpstream(), "fetch")
    expect(r.ok).toBe(true)
  })

  it("push clears ahead count", async () => {
    const repo = makeRepoWithUpstream() // ahead=1
    expect((await runRepoAction(repo, "push")).ok).toBe(true)
    expect((await getRepoStatus(repo)).ahead).toBe(0)
  })

  it("pull --ff-only clears behind count", async () => {
    const repo = makeBehindRepo() // behind=1
    expect((await getRepoStatus(repo)).behind).toBe(1)
    expect((await runRepoAction(repo, "pull")).ok).toBe(true)
    expect((await getRepoStatus(repo)).behind).toBe(0)
  })

  it("returns ok:false with message instead of throwing (no remote)", async () => {
    const r = await runRepoAction(makeRepo(), "push")
    expect(r.ok).toBe(false)
    expect(r.message.length).toBeGreaterThan(0)
  })

  it("pull on a diverged repo fails with git's own stderr message", async () => {
    const repo = makeBehindRepo() // behind=1
    writeFileSync(join(repo, "local-only.txt"), "local")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "local commit")
    const r = await runRepoAction(repo, "pull")
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/fast-forward/i)
  })
})

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config"
import { repoId } from "../src/git"
import { withRepoLock } from "../src/queue"
import { withRepoTarget } from "../src/repo-target"
import { createApi } from "../src/routes"
import { RepoStore } from "../src/store"
import { startExec } from "../src/tasks"
import type { BatchProgress } from "../src/types"
import { cleanupFixtures, git, makeRepo } from "./fixtures"

vi.mock("../src/queue", async (importOriginal) => {
  const queue = await importOriginal<typeof import("../src/queue")>()
  return { ...queue, withRepoLock: vi.fn(queue.withRepoLock) }
})

afterAll(cleanupFixtures)

it("keeps an invalid manual card but cannot commit changes in its parent", async () => {
  const parent = makeRepo()
  const child = join(parent, "child")
  mkdirSync(child)
  writeFileSync(join(parent, "outside.txt"), "pending")
  const config = { ...DEFAULT_CONFIG, manualRepos: [child] }
  const store = new RepoStore(() => config)
  const [card] = await store.refreshAll()
  const app = createApi(store, join(parent, "config.json"))
  const before = git(parent, "rev-parse", "HEAD")
  const response = await app.request(`/api/repos/${card.id}/commit`, {
    method: "POST",
    body: JSON.stringify({ message: "test commit" }),
  })
  expect(git(parent, "rev-parse", "HEAD")).toBe(before)
  expect(response.status).toBe(409)
  expect(card.id).toBe(repoId(child))
  expect(card.error).toBeTruthy()
})

it("rejects malformed branch cleanup without deleting any candidate", async () => {
  const path = makeRepo()
  git(path, "branch", "keep-this")
  const store = new RepoStore(() => ({ ...DEFAULT_CONFIG, manualRepos: [path] }))
  const [card] = await store.refreshAll()
  expect(card.mergedBranches).toContain("keep-this")
  const app = createApi(store, join(path, "config.json"))
  const res = await app.request(`/api/repos/${card.id}/prune-branches`, {
    method: "POST",
    body: JSON.stringify({ names: "keep-this" }),
  })
  expect(res.status).toBe(400)
  const malformed = await app.request(`/api/repos/${card.id}/prune-branches`, { method: "POST", body: "{" })
  expect(malformed.status).toBe(400)
  expect(git(path, "branch", "--list", "keep-this")).toContain("keep-this")
  git(path, "switch", "-c", "feature")
  const stale = await app.request(`/api/repos/${card.id}/prune-branches`, { method: "POST", body: "{}" })
  expect(stale.status).toBe(200)
  expect(git(path, "branch", "--list", "keep-this")).toContain("keep-this")
})

it("serializes writes across linked worktrees with distinct card IDs", async () => {
  const path = makeRepo()
  const linked = join(path, "linked")
  git(path, "worktree", "add", "-b", "side", linked)
  const store = new RepoStore(() => ({ ...DEFAULT_CONFIG, manualRepos: [path, linked] }))
  const cards = await store.refreshAll()
  expect(cards).toHaveLength(2)
  expect(new Set(cards.map((card) => card.id)).size).toBe(2)
  expect(cards.every((card) => card.error === null)).toBe(true)
  vi.mocked(withRepoLock).mockClear()
  const order: string[] = []
  await Promise.all(cards.map((card) => withRepoTarget(card, async () => {
    order.push("start")
    await new Promise<void>((resolve) => setImmediate(resolve))
    order.push("end")
  })))
  const keys = vi.mocked(withRepoLock).mock.calls.map(([key]) => key)
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
  expect(order).toEqual(["start", "end", "start", "end"])
})

it("reports an opening failure and leaves recent-open metadata alone", async () => {
  const path = makeRepo()
  const configFile = join(path, "config.json")
  saveConfig(configFile, {
    ...DEFAULT_CONFIG,
    manualRepos: [path],
    open: { ...DEFAULT_CONFIG.open, editor: "rr-test-editor-that-does-not-exist" },
  })
  const store = new RepoStore(() => loadConfig(configFile))
  const [card] = await store.refreshAll()
  const app = createApi(store, configFile)
  const res = await app.request(`/api/repos/${card.id}/open`, {
    method: "POST",
    body: JSON.stringify({ target: "editor" }),
  })
  expect(res.status).toBe(502)
  expect(loadConfig(configFile).lastOpened[card.id]).toBeUndefined()
})

it("does not record a launcher that exits immediately with an error", async () => {
  const path = makeRepo()
  const configFile = join(path, "config.json")
  saveConfig(configFile, {
    ...DEFAULT_CONFIG,
    manualRepos: [path],
    open: { ...DEFAULT_CONFIG.open, editor: `"${process.execPath}" -e "process.exit(1)"` },
  })
  const store = new RepoStore(() => loadConfig(configFile))
  const [card] = await store.refreshAll()
  const res = await createApi(store, configFile).request(`/api/repos/${card.id}/open`, {
    method: "POST",
    body: JSON.stringify({ target: "editor" }),
  })
  expect(res.status).toBe(502)
  expect(loadConfig(configFile).lastOpened[card.id]).toBeUndefined()
})

it.skipIf(process.platform !== "win32")("launches a Windows batch wrapper with the repository path intact", async () => {
  const parent = makeRepo()
  const path = join(parent, "项目 & (test)! %PATH%")
  git(parent, "init", "-b", "main", path)
  const wrapper = join(parent, "open & save.cmd")
  const record = join(parent, "opened.txt")
  const probe = join(parent, "record.cjs")
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${probe}" %*\r\n`)
  writeFileSync(probe, `require("node:fs").writeFileSync(${JSON.stringify(record)}, process.argv[2])\n`)
  const configFile = join(parent, "config.json")
  saveConfig(configFile, {
    ...DEFAULT_CONFIG,
    manualRepos: [path],
    open: { ...DEFAULT_CONFIG.open, editor: `"${wrapper}" "{path}"` },
  })
  const store = new RepoStore(() => loadConfig(configFile))
  const [card] = await store.refreshAll()
  const res = await createApi(store, configFile).request(`/api/repos/${card.id}/open`, {
    method: "POST",
    body: JSON.stringify({ target: "editor" }),
  })
  expect(res.status).toBe(200)
  await vi.waitFor(() => expect(readFileSync(record, "utf8")).toBe(path))
  expect(loadConfig(configFile).lastOpened[card.id]).toBeTruthy()
})

it("rejects a valid but different worktree installed at the queued path", async () => {
  const parent = makeRepo()
  const path = join(parent, "original")
  const replacement = join(parent, "replacement")
  git(parent, "init", "-b", "main", path)
  git(parent, "init", "-b", "main", replacement)
  const [card] = await new RepoStore(() => ({ ...DEFAULT_CONFIG, manualRepos: [path] })).refreshAll()
  vi.mocked(withRepoLock).mockClear()
  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const first = withRepoTarget(card, () => {
    started()
    return hold
  })
  const run = vi.fn(async () => {})
  try {
    await Promise.race([entered, first])
    const queued = withRepoTarget(card, run).catch((err: unknown) => err)
    await vi.waitFor(() => expect(withRepoLock).toHaveBeenCalledTimes(2))
    renameSync(path, join(parent, "moved"))
    renameSync(replacement, path)
    release()
    expect(await queued).toEqual(expect.objectContaining({ message: expect.stringContaining("changed") }))
    expect(run).not.toHaveBeenCalled()
  } finally {
    release()
    await first
  }
})

it.each([false, true])("rejects a replacement before a write (single-repo refresh: %s)", async (refreshOne) => {
  const parent = makeRepo()
  const path = join(parent, "original")
  const moved = join(parent, "moved")
  const replacement = makeRepo()
  renameSync(makeRepo(), path)
  const store = new RepoStore(() => ({ ...DEFAULT_CONFIG, manualRepos: [path] }))
  const [card] = await store.refreshAll()
  const app = createApi(store, join(parent, "config.json"))
  const createBranch = () => app.request(`/api/repos/${card.id}/branch`, {
    method: "POST",
    body: JSON.stringify({ name: "new-branch" }),
  })

  renameSync(path, moved)
  renameSync(replacement, path)
  if (refreshOne) await store.refreshOne(card.id)
  expect((await createBranch()).status).toBe(409)
  expect(git(moved, "branch", "--show-current").trim()).toBe("main")
  expect(git(path, "branch", "--show-current").trim()).toBe("main")

  const [rescanned] = await store.refreshAll()
  expect(rescanned.id).toBe(card.id)
  expect((await createBranch()).status).toBe(200)
  expect(git(path, "branch", "--show-current").trim()).toBe("new-branch")
})

it("scans and writes the selected repo despite inherited Git repository overrides", async () => {
  const selected = makeRepo()
  const unrelated = makeRepo()
  git(unrelated, "switch", "-c", "other-branch")
  const store = new RepoStore(() => ({ ...DEFAULT_CONFIG, manualRepos: [selected] }))
  const app = createApi(store, join(selected, "config.json"))
  let branch: string | null = null
  let status = 0
  vi.stubEnv("GIT_DIR", join(unrelated, ".git"))
  vi.stubEnv("GIT_WORK_TREE", selected)
  try {
    const [card] = await store.refreshAll()
    branch = card.branch
    const response = await app.request(`/api/repos/${card.id}/branch`, {
      method: "POST",
      body: JSON.stringify({ name: "selected-branch" }),
    })
    status = response.status
  } finally {
    vi.unstubAllEnvs()
  }
  expect(status).toBe(200)
  expect(git(unrelated, "branch", "--show-current").trim()).toBe("other-branch")
  expect(git(selected, "branch", "--show-current").trim()).toBe("selected-branch")
  expect(branch).toBe("main")
})

it("keeps a queued batch entry bound to the worktree selected when the task started", async () => {
  const workers = Array.from({ length: 4 }, () => makeRepo())
  const parent = makeRepo()
  const path = join(parent, "original")
  renameSync(makeRepo(), path)
  const replacement = makeRepo()
  const store = new RepoStore(() => ({ ...DEFAULT_CONFIG, manualRepos: [...workers, path] }))
  const cards = await store.refreshAll()
  const target = cards.find((card) => card.path === path)!
  const ids = [...cards.filter((card) => card.id !== target.id).map((card) => card.id), target.id]

  let release!: () => void
  const hold = new Promise<void>((resolve) => { release = resolve })
  const refreshOne = vi.fn(async () => { await hold; return undefined })
  let finish!: (progress: BatchProgress) => void
  const done = new Promise<BatchProgress>((resolve) => { finish = resolve })
  startExec("git branch batch-check", ids, {
    getRepo: (id) => store.get(id),
    refreshOne,
    broadcast: (type, payload) => {
      if (type === "batch:progress" && (payload as BatchProgress).finished) finish(payload as BatchProgress)
    },
  }, false)

  try {
    await vi.waitFor(() => expect(refreshOne).toHaveBeenCalledTimes(4), { timeout: 5_000 })
    renameSync(path, join(parent, "moved"))
    renameSync(replacement, path)
    await store.refreshAll()
  } finally {
    release()
    await done
  }
  expect((await done).results.find((result) => result.repoId === target.id)?.ok).toBe(false)
  expect(git(path, "branch", "--list", "batch-check")).toBe("")
}, 15_000)

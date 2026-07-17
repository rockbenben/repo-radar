import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, loadConfig, saveConfig, type Config } from "../src/config"
import { createApi } from "../src/routes"
import { RepoStore } from "../src/store"
import { cleanupFixtures, git, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rr-routes-"))
  const configFile = join(dir, "config.json")
  const repo = makeRepo()
  const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), manualRepos: [repo] }
  saveConfig(configFile, cfg)
  const store = new RepoStore(() => loadConfig(configFile))
  const app = createApi(store, configFile)

  const opened: { template: string; path: string }[] = []
  const appWithOpen = createApi(store, configFile, {
    openFn: (template, path) => opened.push({ template, path }),
  })

  return { app, appWithOpen, opened, store, configFile, repo, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
}

describe("api", () => {
  it("GET /api/repos returns list after scan", async () => {
    const t = setup()
    await t.store.refreshAll()
    const res = await t.app.request("/api/repos")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ name: string }>
    expect(body).toHaveLength(1)
    expect(body[0].name).toBe(basename(t.repo))
    t.cleanup()
  })

  it("POST /api/watch toggles watching and validates the body", async () => {
    const t = setup()
    const calls: boolean[] = []
    const app = createApi(t.store, t.configFile, { setWatch: async (e) => void calls.push(e) })
    const post = (body: unknown) =>
      app.request("/api/watch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

    const ok = await post({ enabled: true })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, autoWatch: true })
    expect(calls).toEqual([true])

    const bad = await post({ enabled: "yes" })
    expect(bad.status).toBe(400)
    expect(calls).toEqual([true]) // 校验失败不应调用 setWatch
    t.cleanup()
  })

  it("POST /api/auto-fetch sets the interval and validates the body", async () => {
    const t = setup()
    const calls: number[] = []
    const app = createApi(t.store, t.configFile, { setAutoFetch: async (m) => void calls.push(m) })
    const post = (body: unknown) =>
      app.request("/api/auto-fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

    const ok = await post({ minutes: 15 })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, autoFetchMinutes: 15 })
    expect(calls).toEqual([15])

    expect((await post({ minutes: -1 })).status).toBe(400)
    expect((await post({ minutes: "5" })).status).toBe(400)
    expect(calls).toEqual([15]) // 校验失败不应调用 setAutoFetch
    t.cleanup()
  })

  it("GET /api/repos/:id returns 404 for unknown id", async () => {
    const t = setup()
    const res = await t.app.request("/api/repos/nope")
    expect(res.status).toBe(404)
    t.cleanup()
  })

  it("POST /api/scan rescans and returns repos", async () => {
    const t = setup()
    const res = await t.app.request("/api/scan", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveLength(1)
    t.cleanup()
  })

  it("PUT /api/config returns 400 for malformed JSON body", async () => {
    const t = setup()
    const res = await t.app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })
    expect(res.status).toBe(400)
    t.cleanup()
  })

  it("GET/PUT /api/config round-trips and validates roots", async () => {
    const t = setup()
    const bad = await t.app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roots: "not-an-array" }),
    })
    expect(bad.status).toBe(400)

    const ok = await t.app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roots: ["D:\\somewhere"] }),
    })
    expect(ok.status).toBe(200)

    const got = (await (await t.app.request("/api/config")).json()) as Config
    expect(got.roots).toEqual(["D:\\somewhere"])
    expect(got.excludes).toEqual(DEFAULT_CONFIG.excludes) // 未提交字段保持
    t.cleanup()
  })

  it("PUT /api/config rejects wrong-typed non-roots fields with 400", async () => {
    const t = setup()
    const res = await t.app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: null }),
    })
    expect(res.status).toBe(400)
    t.cleanup()
  })

  it("POST /api/repos/:id/fetch returns a taskId; 404 for unknown id", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    const ok = await t.app.request(`/api/repos/${id}/fetch`, { method: "POST" })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { taskId: string }).taskId).toMatch(/^batch-/)
    const missing = await t.app.request("/api/repos/nope/fetch", { method: "POST" })
    expect(missing.status).toBe(404)
    t.cleanup()
  })

  it("POST /api/repos/:id/<malformed action> returns 404 and runs nothing", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    for (const bad of ["fetchx", "pullrequest", "xpush", "randomstring"]) {
      const res = await t.app.request(`/api/repos/${id}/${bad}`, { method: "POST" })
      expect(res.status).toBe(404)
    }
    t.cleanup()
  })

  it("POST /api/batch validates body and returns taskId", async () => {
    const t = setup()
    await t.store.refreshAll()
    const bad = await t.app.request("/api/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reset", repoIds: [] }),
    })
    expect(bad.status).toBe(400)
    const ok = await t.app.request("/api/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "fetch", repoIds: [t.store.list()[0].id] }),
    })
    expect(ok.status).toBe(200)
    t.cleanup()
  })

  it("POST /api/repos/:id/open uses the injected opener", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    const badTarget = await t.appWithOpen.request(`/api/repos/${id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "browser" }),
    })
    expect(badTarget.status).toBe(400)
    const res = await t.appWithOpen.request(`/api/repos/${id}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "editor" }),
    })
    expect(res.status).toBe(200)
    expect(t.opened).toEqual([{ template: 'code "{path}"', path: t.store.get(id)!.path }])
    t.cleanup()
  })

  it("GET /api/repos rejects disallowed origins and accepts allowed/absent ones", async () => {
    const t = setup()
    await t.store.refreshAll()

    const forbidden = await t.app.request("/api/repos", { headers: { origin: "https://evil.example" } })
    expect(forbidden.status).toBe(403)

    const allowed = await t.app.request("/api/repos", { headers: { origin: "http://localhost:5173" } })
    expect(allowed.status).toBe(200)

    const noOrigin = await t.app.request("/api/repos")
    expect(noOrigin.status).toBe(200)

    t.cleanup()
  })

  it("GET /api/stats/heatmap and /api/stats/activity respond with data", async () => {
    const t = setup()
    await t.store.refreshAll()
    const heat = (await (await t.app.request("/api/stats/heatmap?days=30")).json()) as { days: unknown[] }
    expect(Array.isArray(heat.days)).toBe(true)
    const act = (await (await t.app.request("/api/stats/activity")).json()) as { repos: unknown[] }
    expect(act.repos).toHaveLength(1)
    const missing = await t.app.request("/api/stats/heatmap?repoId=nope")
    expect(missing.status).toBe(404)
    t.cleanup()
  })

  it("GET /api/repos/:id/detail returns commits and stashes; 404 unknown", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    const res = await t.app.request(`/api/repos/${id}/detail`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { recentCommits: unknown[]; stashes: unknown[] }
    expect(Array.isArray(body.recentCommits)).toBe(true)
    expect(Array.isArray(body.stashes)).toBe(true)
    expect((await t.app.request("/api/repos/nope/detail")).status).toBe(404)
    t.cleanup()
  })

  it("GET /api/repos/:id/diff returns diff/untracked keys; 404 unknown", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    writeFileSync(join(t.repo, "untracked.txt"), "x")
    const res = await t.app.request(`/api/repos/${id}/diff`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { diff: string; untracked: string[] }
    expect(typeof body.diff).toBe("string")
    expect(body.untracked).toContain("untracked.txt")
    expect((await t.app.request("/api/repos/nope/diff")).status).toBe(404)
    t.cleanup()
  })

  it("POST /api/repos/:id/commit commits a dirty repo; validates body and id", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    writeFileSync(join(t.repo, "dirty.txt"), "x")

    const noMessage = await t.app.request(`/api/repos/${id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(noMessage.status).toBe(400)

    const missing = await t.app.request("/api/repos/nope/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "wip" }),
    })
    expect(missing.status).toBe(404)

    const res = await t.app.request(`/api/repos/${id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "wip" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; message: string }
    expect(body.ok).toBe(true)
    t.cleanup()
  })

  it("PATCH /api/repos/:id/meta updates favorite, tags and group override", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id

    const fav = await t.app.request(`/api/repos/${id}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: true, tags: ["web"], group: "手动组" }),
    })
    expect(fav.status).toBe(200)
    const body = (await fav.json()) as { favorite: boolean; tags: string[]; group: string }
    expect(body.favorite).toBe(true)
    expect(body.tags).toEqual(["web"])
    expect(body.group).toBe("手动组")

    // 落盘校验
    const cfg = loadConfig(t.configFile)
    expect(cfg.favorites).toContain(id)
    expect(cfg.tags[id]).toEqual(["web"])
    expect(cfg.groupOverrides[id]).toBe("手动组")

    // 清除分组覆盖：回退推导分组
    const cleared = await t.app.request(`/api/repos/${id}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: null }),
    })
    expect(cleared.status).toBe(200)
    expect(loadConfig(t.configFile).groupOverrides[id]).toBeUndefined()

    // 取消收藏 + 清空标签
    await t.app.request(`/api/repos/${id}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: false, tags: [] }),
    })
    const cfg2 = loadConfig(t.configFile)
    expect(cfg2.favorites).not.toContain(id)
    expect(cfg2.tags[id]).toBeUndefined()

    t.cleanup()
  })

  it("PATCH /api/repos/:id/meta clears group override on empty string and reverts to derived group", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    const derived = t.store.get(id)!.group // 覆盖前的推导分组
    await t.app.request(`/api/repos/${id}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: "临时" }),
    })
    const cleared = await t.app.request(`/api/repos/${id}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ group: "  " }), // 空白串等同清除
    })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as { group: string }).group).toBe(derived)
    expect(loadConfig(t.configFile).groupOverrides[id]).toBeUndefined()
    t.cleanup()
  })

  it("PATCH /api/repos/:id/meta trims and dedupes tags before persisting", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    const res = await t.app.request(`/api/repos/${id}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: [" web ", "web", "", "tool"] }),
    })
    expect(((await res.json()) as { tags: string[] }).tags).toEqual(["web", "tool"])
    t.cleanup()
  })

  it("PATCH /api/repos/:id/meta validates id and body", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    expect((await t.app.request("/api/repos/nope/meta", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404)
    const bad = (body: unknown) =>
      t.app.request(`/api/repos/${id}/meta`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    expect((await bad({ favorite: "yes" })).status).toBe(400)
    expect((await bad({ tags: "web" })).status).toBe(400)
    expect((await bad({ group: 5 })).status).toBe(400)
    expect((await bad({ archived: "yes" })).status).toBe(400)
    expect((await bad({ note: 5 })).status).toBe(400)
    t.cleanup()
  })

  it("PATCH /api/repos/:id/meta updates note and archived state", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id

    const set = await t.app.request(`/api/repos/${id}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "下次做 X", archived: true }),
    })
    expect(set.status).toBe(200)
    const body = (await set.json()) as { note: string | null; archived: boolean }
    expect(body.note).toBe("下次做 X")
    expect(body.archived).toBe(true)

    const cfg = loadConfig(t.configFile)
    expect(cfg.notes[id]).toBe("下次做 X")
    expect(cfg.archived).toContain(id)

    // 清空便签
    const cleared = await t.app.request(`/api/repos/${id}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "" }),
    })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as { note: string | null }).note).toBeNull()
    expect(loadConfig(t.configFile).notes[id]).toBeUndefined()

    // 取消归档
    const unarchived = await t.app.request(`/api/repos/${id}/meta`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: false }),
    })
    expect(unarchived.status).toBe(200)
    expect(((await unarchived.json()) as { archived: boolean }).archived).toBe(false)
    expect(loadConfig(t.configFile).archived).not.toContain(id)

    t.cleanup()
  })

  it("GET /api/worklog returns commits in range and validates the range", async () => {
    const t = setup()
    await t.store.refreshAll()
    const bad = await t.app.request("/api/worklog?since=2026-13-01&until=2026-07-15")
    expect(bad.status).toBe(400) // 非法日期
    const reversed = await t.app.request("/api/worklog?since=2026-07-15&until=2026-07-10")
    expect(reversed.status).toBe(400) // since > until
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` // 本地今天
    const ok = await t.app.request(`/api/worklog?since=2000-01-01&until=${today}`)
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { commits: { subject: string }[]; since: string; until: string }
    expect(Array.isArray(body.commits)).toBe(true)
    expect(body.commits.length).toBeGreaterThan(0) // fixture 仓库的 c0 提交（今天）应在范围内
    t.cleanup()
  })

  it("GET /api/stats/activity excludes archived repos", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    const before = (await (await t.app.request("/api/stats/activity")).json()) as { repos: { id: string }[] }
    expect(before.repos.some((r) => r.id === id)).toBe(true)

    await t.app.request(`/api/repos/${id}/meta`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) })
    const after = (await (await t.app.request("/api/stats/activity")).json()) as { repos: { id: string }[] }
    expect(after.repos.some((r) => r.id === id)).toBe(false)
    t.cleanup()
  })

  function stashSetup() {
    const dir = mkdtempSync(join(tmpdir(), "rr-stash-"))
    const configFile = join(dir, "config.json")
    const repo = makeRepo({ stash: true })
    saveConfig(configFile, { ...structuredClone(DEFAULT_CONFIG), manualRepos: [repo] })
    const store = new RepoStore(() => loadConfig(configFile))
    const app = createApi(store, configFile)
    return { app, store, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) }
  }
  type StashList = { repos: { id: string; stashes: { sha: string }[] }[] }
  const jsonPost = (app: ReturnType<typeof createApi>, url: string, body: unknown) =>
    app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  it("GET /api/stashes aggregates repos that actually have stashes", async () => {
    const t = stashSetup()
    await t.store.refreshAll()
    const body = (await (await t.app.request("/api/stashes")).json()) as StashList
    expect(body.repos).toHaveLength(1)
    expect(body.repos[0].stashes).toHaveLength(1)
    expect(body.repos[0].stashes[0].sha).toMatch(/^[0-9a-f]{40}$/)
    t.cleanup()
  })

  it("GET /api/repos/:id/stash/:sha/diff returns patch; validates sha; 404s unknown", async () => {
    const t = stashSetup()
    await t.store.refreshAll()
    const { id, stashes } = ((await (await t.app.request("/api/stashes")).json()) as StashList).repos[0]
    const ok = await t.app.request(`/api/repos/${id}/stash/${stashes[0].sha}/diff`)
    expect(ok.status).toBe(200)
    expect(typeof ((await ok.json()) as { diff: string }).diff).toBe("string")
    // 大写 sha 也应命中（服务端归一小写后再比对 git 的小写 %H），而非误报 404
    expect((await t.app.request(`/api/repos/${id}/stash/${stashes[0].sha.toUpperCase()}/diff`)).status).toBe(200)
    expect((await t.app.request(`/api/repos/${id}/stash/zzz/diff`)).status).toBe(400)
    expect((await t.app.request(`/api/repos/${id}/stash/${"0".repeat(40)}/diff`)).status).toBe(404)
    t.cleanup()
  })

  it("POST /api/repos/:id/stash validates action and sha, then drops", async () => {
    const t = stashSetup()
    await t.store.refreshAll()
    const { id, stashes } = ((await (await t.app.request("/api/stashes")).json()) as StashList).repos[0]
    expect((await jsonPost(t.app, `/api/repos/${id}/stash`, { action: "nope", sha: stashes[0].sha })).status).toBe(400)
    expect((await jsonPost(t.app, `/api/repos/${id}/stash`, { action: "drop", sha: "bad" })).status).toBe(400)
    const res = await jsonPost(t.app, `/api/repos/${id}/stash`, { action: "drop", sha: stashes[0].sha })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { result: { ok: boolean } }).result.ok).toBe(true)
    expect(t.store.get(id)!.stashCount).toBe(0)
    t.cleanup()
  })

  it("POST /api/stash/batch drops across repos and rejects non-drop actions", async () => {
    const t = stashSetup()
    await t.store.refreshAll()
    const { id, stashes } = ((await (await t.app.request("/api/stashes")).json()) as StashList).repos[0]
    expect((await jsonPost(t.app, "/api/stash/batch", { action: "pop", items: [] })).status).toBe(400)
    const res = await jsonPost(t.app, "/api/stash/batch", { action: "drop", items: [{ repoId: id, sha: stashes[0].sha }] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: { ok: boolean }[] }
    expect(body.results).toHaveLength(1)
    expect(body.results[0].ok).toBe(true)
    expect(t.store.get(id)!.stashCount).toBe(0)
    t.cleanup()
  })

  it("POST /api/repos/:id/switch switches branch; validates body and id", async () => {
    const t = setup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    git(t.repo, "branch", "feature") // 在 fixture 仓库里建一个分支
    const post = (body: unknown) =>
      t.app.request(`/api/repos/${id}/switch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    expect((await post({})).status).toBe(400) // 缺 branch
    expect((await t.app.request("/api/repos/nope/switch", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404)
    const ok = await post({ branch: "feature" })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { result: { ok: boolean } }).result.ok).toBe(true)
    expect(t.store.get(id)!.branch).toBe("feature")
    t.cleanup()
  })

  it("GET /api/repos/:id/detail returns structured stash entries (sha/branch/stats)", async () => {
    const t = stashSetup()
    await t.store.refreshAll()
    const id = t.store.list()[0].id
    const body = (await (await t.app.request(`/api/repos/${id}/detail`)).json()) as {
      stashes: { sha: string; branch: string | null; files: number; message: string }[]
    }
    expect(body.stashes).toHaveLength(1)
    expect(body.stashes[0].sha).toMatch(/^[0-9a-f]{40}$/)
    expect(body.stashes[0].branch).toBe("main")
    expect(body.stashes[0].files).toBeGreaterThan(0)
    t.cleanup()
  })
})

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG, loadConfig, saveConfig, type Config } from "../src/config"
import { pendingRepoOps } from "../src/queue"
import { createApi } from "../src/routes"
import { RepoStore } from "../src/store"
import { cleanupFixtures, git, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 两个 mocked scaffold 函数各自「开始跑」「跑完」的时间线，供并发测试判定二者是否重叠——
// 比写死的毫秒阈值更抗环境抖动：不管机器多慢/多忙，「两个 start 是否都先于任一个 end 出现」
// 这个先后关系本身不受绝对耗时影响，只反映有没有被串行化。测试用例里在断言前会清空它。
const scaffoldOrder: string[] = []

// new-project/clone 走的是 scaffold.ts 里真正的 mkdir/git init/git clone，速度快到没法在测试里
// 靠时序窗口可靠地观察到"操作进行中"这一刻——mock 掉，换成一个带可控延时的假实现，才能
// 确定性地断言：
//   - clone 进行中不会被 pendingRepoOps() 计入（它走的是 scaffold.ts 的临时目录方案，
//     耗时可能是分钟级，10 秒的排空上限对它形同虚设，见 routes.ts /api/clone 处的注释）
//   - new-project 进行中会被 pendingRepoOps() 计入（缺陷 4：createProject 秒级完成，
//     重新包回 withRepoLock，退出排空能真正等到它）
//   - 二者互不阻塞（各自的锁键不共享，不会重蹈上一轮合成键 "__scaffold__" 串行化的覆辙）
vi.mock("../src/scaffold", () => ({
  createProject: vi.fn(async (parent: string, name: string) => {
    scaffoldOrder.push("new:start")
    await sleep(30)
    scaffoldOrder.push("new:end")
    return { ok: true, path: join(parent, name) }
  }),
  cloneRepo: vi.fn(async (url: string, parent: string) => {
    scaffoldOrder.push("clone:start")
    await sleep(30)
    scaffoldOrder.push("clone:end")
    return { ok: true, path: join(parent, "repo") }
  }),
}))

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

  it("GET /api/version identifies the app and its version", async () => {
    const t = setup()
    const res = await t.app.request("/api/version")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { app: string; version: string }
    expect(body.app).toBe("repo-radar") // 接管逻辑靠 app 字段确认对面是自己，不能只看 200
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
    t.cleanup()
  })

  it("POST /api/shutdown requires the X-Repo-Radar header and triggers the shutdown hook", async () => {
    const t = setup()
    let calls = 0
    const app = createApi(t.store, t.configFile, { shutdown: () => void calls++ })

    const noHeader = await app.request("/api/shutdown", { method: "POST" })
    expect(noHeader.status).toBe(403)
    expect(calls).toBe(0) // 没带自定义头（如跨站请求）绝不能触发退出

    const withHeader = await app.request("/api/shutdown", { method: "POST", headers: { "x-repo-radar": "shutdown" } })
    expect(withHeader.status).toBe(200)
    expect(await withHeader.json()).toEqual({ ok: true })
    expect(calls).toBe(1)
    t.cleanup()
  })

  it("POST /api/shutdown does not exist when no shutdown hook is injected (source/PM2 deployments must not be killable over HTTP)", async () => {
    const t = setup()
    const res = await t.app.request("/api/shutdown", { method: "POST", headers: { "x-repo-radar": "shutdown" } })
    expect(res.status).toBe(404)
    t.cleanup()
  })

  it("POST /api/shutdown rejects cross-origin browser requests via the origin gate", async () => {
    const t = setup()
    let calls = 0
    const app = createApi(t.store, t.configFile, { shutdown: () => void calls++ })
    const res = await app.request("/api/shutdown", {
      method: "POST",
      headers: { origin: "http://evil.example", "x-repo-radar": "shutdown" },
    })
    expect(res.status).toBe(403)
    expect(calls).toBe(0)
    t.cleanup()
  })

  it("GET/POST /api/autostart proxies the injected hook; unsupported without it", async () => {
    const t = setup()
    // 未注入（源码/PM2 模式）：GET 报不支持，POST 400
    expect(await (await t.app.request("/api/autostart")).json()).toEqual({ supported: false, enabled: false })
    expect((await t.app.request("/api/autostart", { method: "POST", headers: { "content-type": "application/json" }, body: '{"enabled":true}' })).status).toBe(400)

    // 注入后（exe 模式）：GET 透传状态，POST 校验 body 并调用
    let state = { supported: true, enabled: false }
    const app = createApi(t.store, t.configFile, {
      autostart: { get: () => state, set: (enabled) => (state = { supported: true, enabled }) },
    })
    expect(await (await app.request("/api/autostart")).json()).toEqual({ supported: true, enabled: false })
    const on = await app.request("/api/autostart", { method: "POST", headers: { "content-type": "application/json" }, body: '{"enabled":true}' })
    expect(await on.json()).toEqual({ supported: true, enabled: true })
    expect((await app.request("/api/autostart", { method: "POST", headers: { "content-type": "application/json" }, body: '{"enabled":"yes"}' })).status).toBe(400)
    expect(state.enabled).toBe(true) // 校验失败不应改状态
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
    expect((await post({})).status).toBe(400) // 缺 minutes：旧版内联校验就是 400，不能回退
    expect(calls).toEqual([15]) // 校验失败不应调用 setAutoFetch
    // 旧版接受任何有限非负值，「两周 fetch 一次」一直是合法的——上限只挡溢出，不挡它
    expect((await post({ minutes: 20160 })).status).toBe(200)
    expect(calls).toEqual([15, 20160])
    t.cleanup()
  })

  it("POST /api/auto-scan sets the fallback rescan interval and validates the body", async () => {
    const t = setup()
    const calls: number[] = []
    const app = createApi(t.store, t.configFile, { setAutoScan: async (m) => void calls.push(m) })
    const post = (body: unknown) =>
      app.request("/api/auto-scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

    const ok = await post({ minutes: 30 })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, autoScanMinutes: 30 })
    expect(calls).toEqual([30])

    expect((await post({ minutes: 0 })).status).toBe(200) // 0 = 关，是合法值
    expect((await post({ minutes: -1 })).status).toBe(400)
    expect((await post({ minutes: "30" })).status).toBe(400)
    // minutes 在这个端点是必填的。checkMinutes 把 undefined 当「patch 没带字段」放行，
    // 不先挡住的话 NaN 会一路走到落盘、写成 null，功能静默永久关闭
    expect((await post({})).status).toBe(400)
    expect((await post({ mins: 30 })).status).toBe(400) // 拼错字段名同样是缺 minutes
    expect((await post({ minutes: 0.001 })).status).toBe(400) // 小数：会装表成 60ms 死循环
    // `null` 是合法 JSON：c.req.json() 不抛，直接 body.minutes 就是对 null 取属性 → 500。
    // 必须是 400 校验错，不是 TypeError
    const rawBody = (body: string) =>
      app.request("/api/auto-scan", { method: "POST", headers: { "content-type": "application/json" }, body })
    expect((await rawBody("null")).status).toBe(400)
    expect((await rawBody("[1,2]")).status).toBe(400) // 数组同理：不是对象就该 400
    // 报错必须写 minutes（本端点的请求字段）：写配置字段名的话，照着报错重试的集成方
    // 会带着 {"autoScanMinutes": 5} 死循环撞 400
    expect(((await (await post({ minutes: -1 })).json()) as { error: string }).error).toContain("minutes")
    expect(((await (await post({ minutes: -1 })).json()) as { error: string }).error).not.toContain("autoScanMinutes")
    // 和 PUT /api/config 同口径：Infinity 和超上限都要挡住，否则 setInterval 溢出成 1ms。
    // Infinity 必须用原始 JSON 文本喂进来——JSON.stringify(Infinity) 会先变成 null，
    // 那样走的是「不是数字」那条分支，测不到真正的 Infinity 路径
    const raw = (body: string) =>
      app.request("/api/auto-scan", { method: "POST", headers: { "content-type": "application/json" }, body })
    expect((await raw('{"minutes": 1e999}')).status).toBe(400)
    expect((await post({ minutes: 43200 })).status).toBe(400)
    expect(calls).toEqual([30, 0]) // 校验失败不应调用 setAutoScan
    t.cleanup()
  })

  it("GET /api/scan reports the last full-scan time and watch coverage", async () => {
    const t = setup()
    // 未注入（还没扫完过一轮）：null + 全零覆盖，而不是报错或缺字段
    expect(await (await t.app.request("/api/scan")).json()).toEqual({
      lastScanAt: null,
      watch: { watched: 0, total: 0 },
    })

    const at = "2026-07-27T03:14:00.000Z"
    const app = createApi(t.store, t.configFile, {
      lastScanAt: () => at,
      watchCoverage: () => ({ watched: 200, total: 250 }),
    })
    expect(await (await app.request("/api/scan")).json()).toEqual({
      lastScanAt: at,
      watch: { watched: 200, total: 250 },
    })
    t.cleanup()
  })

  // 监听上限硬编码时，超出的仓库为什么不刷新是无法回答的问题——常驻托盘的应用里
  // 那条 console.log 没人看得到。上限必须可设，且设完要把真实覆盖数报回界面
  it("POST /api/watch-limit 设置上限并回报覆盖数，校验非负整数", async () => {
    const t = setup()
    const calls: number[] = []
    const app = createApi(t.store, t.configFile, {
      setWatchLimit: async (n) => void calls.push(n),
      watchCoverage: () => ({ watched: 100, total: 250 }),
    })
    const post = (body: unknown) =>
      app.request("/api/watch-limit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

    const ok = await post({ limit: 100 })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, watchLimit: 100, watch: { watched: 100, total: 250 } })
    expect((await post({ limit: 0 })).status).toBe(200) // 0 = 无上限，是合法值

    expect((await post({})).status).toBe(400) // 缺 limit：不挡住会落盘成 null → 静默无上限
    expect((await post({ limit: -1 })).status).toBe(400)
    expect((await post({ limit: 1.5 })).status).toBe(400)
    expect((await post({ limit: "100" })).status).toBe(400)
    // body 为 JSON `null` 不能 500（对 null 取属性的 TypeError）；报错写 limit（请求字段）而非配置字段名
    const rawBody = (body: string) =>
      app.request("/api/watch-limit", { method: "POST", headers: { "content-type": "application/json" }, body })
    expect((await rawBody("null")).status).toBe(400)
    expect(((await (await post({ limit: -1 })).json()) as { error: string }).error).toContain("limit")
    expect(((await (await post({ limit: -1 })).json()) as { error: string }).error).not.toContain("watchLimit")
    expect(calls).toEqual([100, 0]) // 校验失败不应调用 setWatchLimit
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

  // autoWatch / autoScanMinutes / autoFetchMinutes 有运行期副作用（监听器 + 两个定时器）。
  // 通用写入口只落盘的话，读回来的值和真正在跑的东西能一直不一致到进程退出——面板显示
  // 「每 10 分钟」，实际还是启动时那个间隔，且毫无迹象。applyConfig 拿到 next+prev，
  // 由它逐字段 diff、只重装真变了的——这里验证两份配置传得对
  it("PUT /api/config 落盘后携带新旧配置调用 applyConfig", async () => {
    const t = setup()
    const calls: Array<{ next: number; prev: number }> = []
    const app = createApi(t.store, t.configFile, {
      applyConfig: async (next, prev) => void calls.push({ next: next.autoScanMinutes, prev: prev.autoScanMinutes }),
    })
    const put = (body: unknown) =>
      app.request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

    expect((await put({ autoScanMinutes: 10 })).status).toBe(200)
    expect(calls).toEqual([{ next: 10, prev: 30 }]) // 落盘之后拿着新旧两份配置重装
    expect(loadConfig(t.configFile).autoScanMinutes).toBe(10)

    await put({ notes: { x: "hi" } }) // 无关写入：next 与 prev 相同，diff 后什么都不会重装
    expect(calls[1]).toEqual({ next: 10, prev: 10 })
    t.cleanup()
  })

  // 落盘成功后 applyWatch 才抛错（chokidar EMFILE 等）不能整个 500：配置确实存上了，
  // 500 会让客户端以为没存上而重试/回滚 UI。以磁盘为准返回 200，错误进日志
  it("PUT /api/config 在 applyConfig 抛错时仍返回已保存的配置", async () => {
    const t = setup()
    const app = createApi(t.store, t.configFile, {
      applyConfig: async () => {
        throw new Error("EMFILE")
      },
    })
    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoScanMinutes: 10 }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { autoScanMinutes: number }).autoScanMinutes).toBe(10)
    expect(loadConfig(t.configFile).autoScanMinutes).toBe(10) // 磁盘上确实是新值
    t.cleanup()
  })

  it("PUT /api/config 拒绝会让 setInterval 溢出/落盘成 null 的间隔", async () => {
    const t = setup()
    const put = (body: string) =>
      t.app.request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body })

    expect((await put('{"autoScanMinutes": 1e999}')).status).toBe(400) // JSON.parse → Infinity
    expect((await put('{"autoScanMinutes": 43200}')).status).toBe(400) // 30 天，超 32 位毫秒
    expect((await put('{"autoFetchMinutes": 1e999}')).status).toBe(400)
    expect(loadConfig(t.configFile).autoScanMinutes).toBe(30) // 一个都没落盘
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

  // 缺陷 4：createProject 很快（mkdir + git init，秒级），重新包回 withRepoLock——退出时 10 秒
  // 的排空对它绰绰有余。用带可控延时的假实现确定性地断言操作进行中 pendingRepoOps() 确实被计入
  // （而不是像上一轮那样两头落空：既不进锁、临时目录方案又没做）
  it("POST /api/new-project 进行中会被 pendingRepoOps() 计入（缺陷 4：重新走仓库锁）", async () => {
    const t = setup()
    expect(pendingRepoOps()).toBe(0)
    const req = t.app.request("/api/new-project", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent: "C:\\fake\\parent", name: "demo" }),
    })
    await sleep(5) // mock 的 createProject 延时 30ms 还没到，此刻仍在进行中
    expect(pendingRepoOps()).toBe(1)
    const res = await req
    expect(res.status).toBe(200)
    expect(pendingRepoOps()).toBe(0)
    t.cleanup()
  })

  it("POST /api/clone 进行中不会被 pendingRepoOps() 计入（仍不走仓库锁，走临时目录方案）", async () => {
    const t = setup()
    expect(pendingRepoOps()).toBe(0)
    const req = t.app.request("/api/clone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/demo.git", parent: "C:\\fake\\parent" }),
    })
    await sleep(5)
    expect(pendingRepoOps()).toBe(0)
    const res = await req
    expect(res.status).toBe(200)
    expect(pendingRepoOps()).toBe(0)
    t.cleanup()
  })

  // 缺陷 4：createProject 重新包回 withRepoLock 之后，仍要保证它与 clone 互不阻塞——两者用的是
  // 完全不同的锁键（NEW_PROJECT_LOCK_KEY vs. clone 压根不过锁），不会重蹈上一轮合成键 "__scaffold__"
  // 的覆辙（一个慢 clone 能把另一个新建卡到 5 分钟）。判定标准是二者的执行区间有没有重叠：
  // 串行化的话 clone 要等 new-project 完全跑完（"new:end"）才会开始（"clone:start"）；
  // 真正并发跑的话两个 "start" 都该先于任一个 "end" 出现
  it("POST /api/new-project 与 POST /api/clone 并发执行，互不等待（各自的锁键不共享）", async () => {
    const t = setup()
    scaffoldOrder.length = 0
    const [res1, res2] = await Promise.all([
      t.app.request("/api/new-project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent: "C:\\fake\\parent", name: "demo" }),
      }),
      t.app.request("/api/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/demo.git", parent: "C:\\fake\\parent" }),
      }),
    ])
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    const firstEnd = scaffoldOrder.findIndex((e) => e.endsWith(":end"))
    expect(firstEnd).toBeGreaterThanOrEqual(0)
    // 第一个 "end" 出现之前，两边的 "start" 都该已经发生——证明二者是并发执行，不是排队等来的
    expect(scaffoldOrder.slice(0, firstEnd)).toEqual(expect.arrayContaining(["new:start", "clone:start"]))
    t.cleanup()
  })

  // 缺陷 4 补充：NEW_PROJECT_LOCK_KEY 只有 createProject 自己用，两个 new-project 请求会共用
  // 这同一把键，理应彼此串行（这是有意为之——秒级操作串行无妨，换来的是退出排空真能等到它）
  it("两个 POST /api/new-project 并发时彼此串行（共用同一把锁键），但不影响上面 clone 与它的并发", async () => {
    const t = setup()
    scaffoldOrder.length = 0
    const [res1, res2] = await Promise.all([
      t.app.request("/api/new-project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent: "C:\\fake\\parent", name: "a" }),
      }),
      t.app.request("/api/new-project", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent: "C:\\fake\\parent", name: "b" }),
      }),
    ])
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    // 严格串行：start → end → start → end，第二个的 start 不会抢在第一个的 end 之前发生
    expect(scaffoldOrder).toEqual(["new:start", "new:end", "new:start", "new:end"])
    t.cleanup()
  })
})

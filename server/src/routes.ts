import { type Context, Hono } from "hono"
import { loadConfig, mergeConfig, saveConfig, validateConfigPatch, type Config } from "./config"
import { WsHub } from "./events"
import { ACTION_ARGS, commitRepo, createBranch, createStash, currentGitIdentity, deleteBranches, discardChanges, dropStashes, getRepoDetail, getRepoDiff, listStashes, stashAction, stashDiff, switchBranch, type RepoAction } from "./git"
import { openTarget } from "./open"
import { withRepoLock } from "./queue"
import { getGithubStatus } from "./github"
import { buildManifest, importManifest, isManifest } from "./manifest"
import { cloneRepo, createProject } from "./scaffold"
import { aggregateHeatmap, buildActivity } from "./stats"
import { collectUserEmails, getWorklog } from "./worklog"
import { mapLimit, type RepoStore } from "./store"
import { startBatch, startExec, type BatchDeps } from "./tasks"
import type { RepoStatus } from "./types"

export interface ApiExtras {
  hub?: WsHub
  openFn?: (template: string, path: string) => void
  rescan?: () => Promise<RepoStatus[]>
  setWatch?: (enabled: boolean) => Promise<void> // 开/关文件监听实时刷新（持久化到 config.autoWatch）
  setAutoFetch?: (minutes: number) => Promise<void> // 设置定时后台 fetch 间隔（分钟，0=关）
  refreshInbox?: () => Promise<void> // 立即强制重拉各仓库的 GitHub PR/issue/CI（跳过 TTL）
}

const ACTIONS = new Set<string>(Object.keys(ACTION_ARGS))
const OPEN_TARGETS = new Set<string>(["editor", "terminal", "explorer"])

const ALLOWED_ORIGINS = new Set([
  "http://localhost:7420",
  "http://127.0.0.1:7420",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
])

/** 无 Origin 头（curl、同源导航）放行；有则必须在白名单内（防跨站页面驱动本地 API） */
export function originAllowed(origin: string | undefined): boolean {
  return origin === undefined || ALLOWED_ORIGINS.has(origin)
}

export function createApi(store: RepoStore, configFile: string, extras: ApiExtras = {}): Hono {
  const app = new Hono()
  const hub = extras.hub ?? new WsHub()
  const openFn = extras.openFn ?? openTarget
  const rescan = extras.rescan ?? (() => store.refreshAll())
  const batchDeps: BatchDeps = {
    getRepo: (id) => store.get(id),
    refreshOne: (id) => store.refreshOne(id),
    broadcast: (type, payload) => hub.broadcast(type, payload),
  }

  // 变更类端点的统一骨架：先查 repo（否则 404）→ 执行 run（run 内做 body 校验，失败可直接返回 Response，
  // git 操作自行用 withRepoLock 包）→ 刷新 + 广播 repo:updated + 返回 { result, repo }。
  async function mutateRepo(c: Context, run: (repo: RepoStatus) => Promise<Response | { result: unknown }>): Promise<Response> {
    const repo = store.get(c.req.param("id") ?? "")
    if (!repo) return c.json({ error: "repo not found" }, 404)
    const out = await run(repo)
    if (out instanceof Response) return out // 校验失败等，直接透传
    const updated = await store.refreshOne(repo.id)
    if (updated) hub.broadcast("repo:updated", { repo: updated })
    return c.json({ result: out.result, repo: updated ?? repo })
  }
  const jsonBody = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      return (await c.req.json()) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  app.use("/api/*", async (c, next) => {
    if (!originAllowed(c.req.header("origin"))) return c.json({ error: "forbidden origin" }, 403)
    await next()
  })

  app.get("/api/repos", (c) => c.json(store.list()))

  app.get("/api/repos/:id/detail", async (c) => {
    const repo = store.get(c.req.param("id"))
    if (!repo) return c.json({ error: "repo not found" }, 404)
    // ?basic=1：卡片「⋯」预览只要最近提交，跳过 stash/分支的重活
    return c.json(await getRepoDetail(repo.path, c.req.query("basic") === "1"))
  })

  app.get("/api/repos/:id/diff", async (c) => {
    const repo = store.get(c.req.param("id"))
    if (!repo) return c.json({ error: "repo not found" }, 404)
    return c.json(await getRepoDiff(repo.path))
  })

  // 按需查询 GitHub PR / CI（需本机 gh 已登录）；纯用户触发，无后台调用
  app.get("/api/repos/:id/github", async (c) => {
    const repo = store.get(c.req.param("id"))
    if (!repo) return c.json({ error: "repo not found" }, 404)
    return c.json(await getGithubStatus(repo.path))
  })

  app.post("/api/repos/:id/commit", async (c) => {
    const repo = store.get(c.req.param("id"))
    if (!repo) return c.json({ error: "repo not found" }, 404)
    let body: { message?: unknown; push?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    if (typeof body.message !== "string" || body.message.trim() === "")
      return c.json({ error: "message must be a non-empty string" }, 400)
    const push = body.push === true
    const r = await withRepoLock(repo.id, () => commitRepo(repo.path, body.message as string, push))
    const updated = await store.refreshOne(repo.id)
    if (updated) hub.broadcast("repo:updated", { repo: updated })
    return c.json(r)
  })

  // 清理已合并的本地分支；names 省略则删除该仓库当前探测到的全部已合并分支
  app.post("/api/repos/:id/prune-branches", async (c) => {
    const repo = store.get(c.req.param("id"))
    if (!repo) return c.json({ error: "repo not found" }, 404)
    let body: { names?: unknown }
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    const requested =
      Array.isArray(body.names) && body.names.every((x) => typeof x === "string")
        ? (body.names as string[])
        : repo.mergedBranches
    // 只允许删除探测到的已合并分支，避免误删未合并/主干
    const names = requested.filter((n) => repo.mergedBranches.includes(n))
    if (names.length === 0) return c.json({ results: [], repo })
    const results = await withRepoLock(repo.id, () => deleteBranches(repo.path, names))
    const updated = await store.refreshOne(repo.id)
    if (updated) hub.broadcast("repo:updated", { repo: updated })
    return c.json({ results, repo: updated ?? repo })
  })

  // 跨仓库 stash 收纳箱：聚合所有未排除、有 stash 的仓库（排除的仓库不在此出现，与统计一致）
  app.get("/api/stashes", async (c) => {
    const repos = store.list().filter((r) => !r.archived && r.stashCount > 0)
    // 限并发：避免仓库数×每仓 stash 数把 git 进程一次性铺开
    const groups = await mapLimit(repos, 8, async (r) => ({
      id: r.id,
      name: r.name,
      displayName: r.displayName,
      path: r.path,
      stashes: await listStashes(r.path).catch(() => []),
    }))
    return c.json({ repos: groups.filter((g) => g.stashes.length > 0) })
  })

  // 要求完整 sha（sha-1 40 位 / sha-256 64 位）：stash 操作全部按完整 %H 定位（前端始终传完整 sha）。
  // 放宽到短 sha 会因 `%H === sha` 不成立而误报 404；写死 40 位又会让 sha-256 仓库彻底不可用，故两者都收。
  const isSha = (s: string) => /^([0-9a-f]{40}|[0-9a-f]{64})$/i.test(s)

  // 只读：单条 stash 的完整 diff
  app.get("/api/repos/:id/stash/:sha/diff", async (c) => {
    const repo = store.get(c.req.param("id"))
    if (!repo) return c.json({ error: "repo not found" }, 404)
    const sha = (c.req.param("sha") ?? "").toLowerCase() // git %H 是小写：统一转小写再比对，免得大写 sha 被当成不存在
    if (!isSha(sha)) return c.json({ error: "bad sha" }, 400)
    try {
      const diff = await stashDiff(repo.path, sha)
      if (diff === null) return c.json({ error: "stash not found" }, 404) // 确实没有 → 404
      return c.json({ diff })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500) // 读取失败 → 500，前端显示错误
    }
  })

  // 单条 stash 的 apply / pop / drop
  app.post("/api/repos/:id/stash", (c) =>
    mutateRepo(c, async (repo) => {
      const body = await jsonBody(c)
      const op = body.action
      const sha = typeof body.sha === "string" ? body.sha.toLowerCase() : "" // 统一小写，匹配 git %H
      if (op !== "apply" && op !== "pop" && op !== "drop") return c.json({ error: "bad action" }, 400)
      if (!isSha(sha)) return c.json({ error: "bad sha" }, 400)
      return { result: await withRepoLock(repo.id, () => stashAction(repo.path, sha, op)) }
    }),
  )

  // 批量丢弃：可跨仓库，按仓库分组、各自加锁；仅支持 drop（前端只发 drop）
  app.post("/api/stash/batch", async (c) => {
    let body: { items?: unknown; action?: unknown }
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }
    if (body.action !== "drop") return c.json({ error: "batch only supports drop" }, 400)
    const byRepo = new Map<string, string[]>()
    for (const it of Array.isArray(body.items) ? body.items : []) {
      const repoId = (it as { repoId?: unknown })?.repoId
      const rawSha = (it as { sha?: unknown })?.sha
      if (typeof repoId !== "string" || typeof rawSha !== "string" || !isSha(rawSha)) continue
      const sha = rawSha.toLowerCase() // 统一小写，匹配 git %H
      const arr = byRepo.get(repoId) ?? []
      arr.push(sha)
      byRepo.set(repoId, arr)
    }
    const results: { repoId: string; name: string; sha: string; ok: boolean; message: string }[] = []
    for (const [repoId, shas] of byRepo) {
      const repo = store.get(repoId)
      if (!repo) {
        for (const sha of shas) results.push({ repoId, name: repoId, sha, ok: false, message: "repo not found" })
        continue
      }
      const res = await withRepoLock(repo.id, () => dropStashes(repo.path, shas))
      const label = repo.displayName ?? repo.name
      for (const r of res) results.push({ repoId, name: label, ...r })
      const updated = await store.refreshOne(repo.id)
      if (updated) hub.broadcast("repo:updated", { repo: updated })
    }
    return c.json({ results })
  })

  // 切换本地分支：有冲突未提交改动时 git 会拒绝，如实回报错误（不强切、不丢改动）
  app.post("/api/repos/:id/switch", (c) =>
    mutateRepo(c, async (repo) => {
      const body = await jsonBody(c)
      const branch = typeof body.branch === "string" ? body.branch.trim() : ""
      if (branch === "") return c.json({ error: "bad branch" }, 400)
      return { result: await withRepoLock(repo.id, () => switchBranch(repo.path, branch)) }
    }),
  )

  // 把当前未提交改动收进 stash
  app.post("/api/repos/:id/stash/create", (c) =>
    mutateRepo(c, async (repo) => {
      const body = await jsonBody(c)
      const message = typeof body.message === "string" ? body.message : ""
      return { result: await withRepoLock(repo.id, () => createStash(repo.path, message)) }
    }),
  )

  // 新建并切换到分支
  app.post("/api/repos/:id/branch", (c) =>
    mutateRepo(c, async (repo) => {
      const body = await jsonBody(c)
      const name = typeof body.name === "string" ? body.name.trim() : ""
      if (name === "") return c.json({ error: "bad name" }, 400)
      return { result: await withRepoLock(repo.id, () => createBranch(repo.path, name)) }
    }),
  )

  // 丢弃全部未提交改动（破坏性，前端二次确认）
  app.post("/api/repos/:id/discard", (c) => mutateRepo(c, async (repo) => ({ result: await withRepoLock(repo.id, () => discardChanges(repo.path)) })))

  app.patch("/api/repos/:id/meta", async (c) => {
    const repo = store.get(c.req.param("id"))
    if (!repo) return c.json({ error: "repo not found" }, 404)
    let body: { favorite?: unknown; tags?: unknown; group?: unknown; archived?: unknown; note?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    if (body.favorite !== undefined && typeof body.favorite !== "boolean")
      return c.json({ error: "favorite must be a boolean" }, 400)
    if (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string")))
      return c.json({ error: "tags must be a string array" }, 400)
    if (body.group !== undefined && body.group !== null && typeof body.group !== "string")
      return c.json({ error: "group must be a string or null" }, 400)
    if (body.archived !== undefined && typeof body.archived !== "boolean")
      return c.json({ error: "archived must be a boolean" }, 400)
    if (body.note !== undefined && body.note !== null && typeof body.note !== "string")
      return c.json({ error: "note must be a string or null" }, 400)

    const cfg = loadConfig(configFile)
    if (body.favorite !== undefined) {
      const set = new Set(cfg.favorites)
      if (body.favorite) set.add(repo.id)
      else set.delete(repo.id)
      cfg.favorites = [...set]
    }
    if (body.tags !== undefined) {
      // 去空白、去空串、去重，保证落盘 config 干净（不依赖前端）
      const tags = [...new Set((body.tags as string[]).map((t) => t.trim()).filter((t) => t !== ""))]
      if (tags.length === 0) delete cfg.tags[repo.id]
      else cfg.tags[repo.id] = tags
    }
    if (body.group !== undefined) {
      const group = body.group as string | null
      if (group === null || group.trim() === "") delete cfg.groupOverrides[repo.id]
      else cfg.groupOverrides[repo.id] = group.trim()
    }
    if (body.archived !== undefined) {
      const set = new Set(cfg.archived)
      if (body.archived) set.add(repo.id)
      else set.delete(repo.id)
      cfg.archived = [...set]
    }
    if (body.note !== undefined) {
      const note = body.note as string | null
      if (note === null || note.trim() === "") delete cfg.notes[repo.id]
      else cfg.notes[repo.id] = note.trim()
    }
    saveConfig(configFile, cfg)

    const updated = store.redecorate(repo.id)
    if (!updated) return c.json({ error: "repo not found" }, 404)
    hub.broadcast("repo:updated", { repo: updated })
    return c.json(updated)
  })

  app.get("/api/repos/:id", (c) => {
    const repo = store.get(c.req.param("id"))
    return repo ? c.json(repo) : c.json({ error: "repo not found" }, 404)
  })

  app.post("/api/scan", async (c) => c.json(await rescan()))

  // 立即重拉各仓库的 GitHub「等我的」（PR/issue/CI），跳过 TTL；结果经 repo:updated 广播回来。等整轮跑完再返回。
  app.post("/api/github/refresh", async (c) => {
    if (extras.refreshInbox) await extras.refreshInbox()
    return c.json({ ok: true })
  })

  // 开/关文件监听实时刷新；持久化到 config.autoWatch，默认关闭
  app.post("/api/watch", async (c) => {
    let body: { enabled?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400)
    if (extras.setWatch) await extras.setWatch(body.enabled)
    return c.json({ ok: true, autoWatch: body.enabled })
  })

  // 设置定时后台 fetch 间隔（分钟，0=关）；持久化到 config.autoFetchMinutes
  app.post("/api/auto-fetch", async (c) => {
    let body: { minutes?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    if (typeof body.minutes !== "number" || !Number.isFinite(body.minutes) || body.minutes < 0)
      return c.json({ error: "minutes must be a non-negative number" }, 400)
    const minutes = Math.floor(body.minutes)
    if (extras.setAutoFetch) await extras.setAutoFetch(minutes)
    return c.json({ ok: true, autoFetchMinutes: minutes })
  })

  app.post("/api/new-project", async (c) => {
    let body: { parent?: unknown; name?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    if (typeof body.parent !== "string" || typeof body.name !== "string")
      return c.json({ error: "parent 与 name 必填" }, 400)
    const cfg = loadConfig(configFile)
    const result = await createProject(body.parent, body.name, cfg.roots)
    if (!result.ok) return c.json({ error: result.error }, 400)
    await rescan() // 纳入新仓库
    return c.json({ path: result.path })
  })

  app.post("/api/clone", async (c) => {
    let body: { url?: unknown; parent?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    if (typeof body.url !== "string" || typeof body.parent !== "string")
      return c.json({ error: "url 与 parent 必填" }, 400)
    const cfg = loadConfig(configFile)
    const result = await cloneRepo(body.url, body.parent, cfg.roots)
    if (!result.ok) return c.json({ error: result.error }, 400)
    await rescan()
    return c.json({ path: result.path })
  })

  app.post("/api/repos/:id/open", async (c) => {
    const repo = store.get(c.req.param("id"))
    if (!repo) return c.json({ error: "repo not found" }, 404)
    let body: { target?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    if (typeof body.target !== "string" || !OPEN_TARGETS.has(body.target))
      return c.json({ error: "target must be editor|terminal|explorer" }, 400)
    const cfg = loadConfig(configFile)
    openFn(cfg.open[body.target as keyof Config["open"]], repo.path)
    // 记住"上次打开"时间，让常用项目能按此排序置顶
    cfg.lastOpened[repo.id] = new Date().toISOString()
    saveConfig(configFile, cfg)
    const updated = store.redecorate(repo.id)
    if (updated) hub.broadcast("repo:updated", { repo: updated })
    return c.json(updated ?? { ok: true })
  })

  app.post("/api/repos/:id/:action", (c) => {
    const action = c.req.param("action")
    if (!ACTIONS.has(action)) return c.json({ error: "unknown action" }, 404)
    const repo = store.get(c.req.param("id"))
    if (!repo) return c.json({ error: "repo not found" }, 404)
    const taskId = startBatch(action as RepoAction, [repo.id], batchDeps)
    return c.json({ taskId })
  })

  app.post("/api/batch", async (c) => {
    let body: { action?: unknown; repoIds?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    if (typeof body.action !== "string" || !ACTIONS.has(body.action))
      return c.json({ error: "action must be fetch|pull|push" }, 400)
    if (!Array.isArray(body.repoIds) || body.repoIds.length === 0 || !body.repoIds.every((x) => typeof x === "string"))
      return c.json({ error: "repoIds must be a non-empty string array" }, 400)
    const taskId = startBatch(body.action as RepoAction, body.repoIds, batchDeps)
    return c.json({ taskId })
  })

  // 在选中仓库批量执行一条 shell 命令；dryRun 只预演不执行
  app.post("/api/exec", async (c) => {
    let body: { command?: unknown; repoIds?: unknown; dryRun?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    const command = typeof body.command === "string" ? body.command.trim() : ""
    if (command === "") return c.json({ error: "command must be a non-empty string" }, 400)
    if (command.length > 500) return c.json({ error: "command too long (max 500)" }, 400)
    if (!Array.isArray(body.repoIds) || body.repoIds.length === 0 || !body.repoIds.every((x) => typeof x === "string"))
      return c.json({ error: "repoIds must be a non-empty string array" }, 400)
    const taskId = startExec(command, body.repoIds, batchDeps, body.dryRun === true)
    return c.json({ taskId })
  })

  // 导出：当前仓库清单（路径 + 远程 + 分组 + 标签），供备份 / 换机 / 分享
  app.get("/api/manifest", (c) => c.json(buildManifest(store.list(), new Date().toISOString())))

  // 导入：把清单里本机已存在的仓库并入 manualRepos；不存在的作为 missing 返回（不自动克隆）
  app.post("/api/manifest/import", async (c) => {
    let body: { manifest?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    if (!isManifest(body.manifest)) return c.json({ error: "manifest must have a repos array of { path }" }, 400)
    const cfg = loadConfig(configFile)
    const { manualRepos, summary } = importManifest(body.manifest, cfg.manualRepos)
    cfg.manualRepos = manualRepos
    saveConfig(configFile, cfg)
    return c.json(summary)
  })

  app.get("/api/config", (c) => c.json(loadConfig(configFile)))

  app.put("/api/config", async (c) => {
    let body: Partial<Config>
    try {
      body = (await c.req.json()) as Partial<Config>
    } catch {
      return c.json({ error: "invalid JSON body" }, 400)
    }
    const problem = validateConfigPatch(body)
    if (problem !== null) return c.json({ error: problem }, 400)
    const next = mergeConfig(loadConfig(configFile), body)
    saveConfig(configFile, next)
    return c.json(next)
  })

  app.get("/api/stats/heatmap", async (c) => {
    const raw = Number(c.req.query("days") ?? "365")
    const days = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 730) : 365
    const repoId = c.req.query("repoId")
    let targets: { id: string; path: string }[]
    if (repoId !== undefined) {
      const repo = store.get(repoId)
      if (!repo) return c.json({ error: "repo not found" }, 404)
      targets = [{ id: repo.id, path: repo.path }]
    } else {
      // 汇总统计排除「已排除」的仓库（单仓库热力图仍可查看被排除的）
      targets = store.list().filter((r) => !r.archived).map((r) => ({ id: r.id, path: r.path }))
    }
    return c.json({ days: await aggregateHeatmap(targets, days) })
  })

  app.get("/api/stats/activity", (c) => c.json({ repos: buildActivity(store.list().filter((r) => !r.archived)) }))

  // 工作记录：汇总未排除仓库在 [since, until] 天范围内的提交（全部本地分支、排除 merge）
  app.get("/api/worklog", async (c) => {
    const since = c.req.query("since") ?? ""
    const until = c.req.query("until") ?? ""
    const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
    if (!isDay(since) || !isDay(until) || since > until) return c.json({ error: "bad range" }, 400)
    // 查未排除、且扫描无错的仓库：扫描出错的仓库（路径被删/无权限/非 git）git log 必失败，会被误报成 partial，
    // 与 /api/stashes、/api/stats 一样不把 error 仓库当读取失败对外暴露。空仓库仍由 getWorklog 内部区分。
    const repos = store
      .list()
      .filter((r) => !r.archived && r.error === null)
      .map((r) => ({ id: r.id, name: r.name, displayName: r.displayName, path: r.path }))
    // 三路互不依赖，并行拿：提交流水 + 全局身份 + 各仓库有效 user.email 并集（含本地覆盖）。
    // 「只看我」按整组邮箱匹配——不然工作仓库里本地覆盖的邮箱下的提交会被静默漏掉。
    // 语义即「这台机器上配置过的身份都算我」；若某仓库配了别人/bot 的邮箱会被并入（前端下拉仍单列各邮箱可查）
    const [{ commits, failed }, me0, repoEmails] = await Promise.all([
      getWorklog(repos, since, until),
      currentGitIdentity(repos[0]?.path ?? process.cwd()),
      collectUserEmails(repos.map((r) => r.path)),
    ])
    const me = me0 ? { ...me0, emails: [...new Set([me0.email, ...repoEmails])] } : null
    return c.json({ commits, since, until, failed, me })
  })

  return app
}

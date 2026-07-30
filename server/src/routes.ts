import { type Context, Hono } from "hono"
import { checkMinutes, loadConfig, mergeConfig, saveConfig, validateConfigPatch, type Config } from "./config"
import { WsHub } from "./events"
import { ACTION_ARGS, commitRepo, createBranch, createStash, currentGitIdentity, deleteBranches, discardChanges, dropStashes, getRepoDetail, getRepoDiff, listStashes, stashAction, stashDiff, switchBranch, type RepoAction } from "./git"
import { openTarget } from "./open"
import { PORT } from "./port"
import { trackPending, withRepoLock } from "./queue"
import { getGithubStatus } from "./github"
import { buildManifest, importManifest, isManifest } from "./manifest"
import { cloneRepo, createProject } from "./scaffold"
import { aggregateHeatmap, buildActivity } from "./stats"
import { collectUserEmails, getWorklog } from "./worklog"
import { mapLimit } from "./map-limit"
import type { RepoStore } from "./store"
import { startBatch, startExec, type BatchDeps } from "./tasks"
import type { RepoStatus } from "./types"

export interface ApiExtras {
  hub?: WsHub
  openFn?: (template: string, path: string) => void
  rescan?: () => Promise<RepoStatus[]>
  rescanFresh?: () => Promise<RepoStatus[]> // 服务端自己改了磁盘（clone/新建）后的重扫：保证扫描在改动之后开始，不共乘进行中的一轮
  setWatch?: (enabled: boolean) => Promise<void> // 开/关文件监听实时刷新（持久化到 config.autoWatch）
  setAutoScan?: (minutes: number) => Promise<void> // 设置兜底全量重扫间隔（分钟，0=关）
  setAutoFetch?: (minutes: number) => Promise<void> // 设置定时后台 fetch 间隔（分钟，0=关）
  setWatchLimit?: (limit: number) => Promise<void> // 设置同时监听的仓库数上限（0=无上限）
  applyConfig?: (next: Config, prev: Config) => Promise<void> // PUT /api/config 落盘后让监听器/定时器跟上（内部按 prev 逐字段 diff，只重装变了的）
  /**
   * 把「当前仓库列表」重新交给监听器（automation.applyRepos）。纯 JS 改映射表，不碰任何句柄。
   *
   * 存在的理由：watcher 的静音名单（归档仓库）与 Linux 上的监听名额排序（收藏优先）只在
   * 全量重扫链（setRoots / setRepos）上重算，而 PATCH meta 只 saveConfig + redecorate + 广播，
   * 碰不到那条链。少了这一步，**取消归档之后 watcher 仍把这个仓库静音**：它的文件事件在归属
   * 之后就地丢弃，既不刷新卡片也不报结构变化——其它卡片 1 秒内更新，唯独这张停在取消归档
   * 那一刻，要等下一轮兜底重扫才恢复（默认 30 分钟，而 autoScanMinutes=0 是设置面板里能选的
   * 合法配置，那种情况下整个进程生命周期都不刷新）
   */
  syncRepos?: () => void
  lastScanAt?: () => string | null // 最近一次全量扫描完成时刻（ISO）；还没扫完过则为 null
  watchCoverage?: () => { watched: number; total: number } // 实际挂上监听的仓库数 / 本该监听的总数
  refreshInbox?: () => Promise<void> // 立即强制重拉各仓库的 GitHub PR/issue/CI（跳过 TTL）
  boundPort?: () => number // 实际绑定的端口，同源白名单按它算。取函数而非数值：createApi 在 bind 之前就调用了，那时端口还没定
  devOrigins?: boolean // 放行 vite dev server（5173）。**只能在开发模式下为真**，见 DEV_ORIGINS
  version?: string // 应用版本，由宿主注入（桌面应用用 app.getVersion()）
  shutdown?: () => void // /api/shutdown 的实际退出动作；不注入则端点不存在（仅单文件 exe 模式注入，服务器部署绝不暴露可杀进程的 HTTP 端点）
  autostart?: { get: () => { supported: boolean; enabled: boolean }; set: (enabled: boolean) => { supported: boolean; enabled: boolean } } // 开机自启（仅单文件 exe 模式注入）
}

const ACTIONS = new Set<string>(Object.keys(ACTION_ARGS))
const OPEN_TARGETS = new Set<string>(["editor", "terminal", "explorer"])

// createProject 专属的锁键：不是仓库 id，也不与 cloneRepo 共享。mkdir + git init 是秒级操作，
// 退出时 10 秒的排空上限对它绰绰有余，包一层 withRepoLock 就够（见 /api/new-project 处的注释）。
// 只有 createProject 用这个键——不会像上一轮 "__scaffold__" 那样把慢克隆也拖进来一起排队。
const NEW_PROJECT_LOCK_KEY = "__scaffold-new-project__"

// 自身端口按**实际绑定的**端口推导，不写死、也不能只按 PORT 推：原端口被占用/被系统保留时
// backend 会回退到别的端口（见 port.ts 的 portCandidates），白名单没跟着换的话，界面自己发的
// 请求就成了「跨站」，整个 API 当场 403——表现是「窗口开着、按钮全都点不动」，比起不来更难查。
/**
 * vite dev server 的固定端口。**必须由 allowDev 显式开启，绝不能编进发行版**：
 * 5173 是 vite 的默认端口，用户机器上随便哪个别的前端项目、或者一个恶意页面，都可能正跑在
 * 那上面。而本服务对 API 的唯一跨站防线就是 Origin 校验（全程不发任何 CORS 头），
 * 且破坏性端点全是无需预检的简单请求——一个 `fetch('http://127.0.0.1:17420/api/exec', {method:'POST'})`
 * 就够了，攻击者读不到响应也无所谓，副作用本身就是目的（discard 丢改动、pull/push、拉起编辑器）。
 */
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]

/**
 * 无 Origin 头（curl、同源导航）放行；有则必须在白名单内（防跨站页面驱动本地 API）。
 * port 省略时按 PORT——只有「还没绑定成功」的调用点会走到这个默认值。
 * allowDev 默认 false：漏传的后果是开发时自己不方便，而不是给发行版开一个洞。
 */
export function originAllowed(origin: string | undefined, port: number = PORT, allowDev = false): boolean {
  if (origin === undefined) return true
  if (origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`) return true
  return allowDev && DEV_ORIGINS.includes(origin)
}

export function createApi(store: RepoStore, configFile: string, extras: ApiExtras = {}): Hono {
  const app = new Hono()
  const hub = extras.hub ?? new WsHub()
  const openFn = extras.openFn ?? openTarget
  const rescan = extras.rescan ?? (() => store.refreshAll())
  const rescanFresh = extras.rescanFresh ?? rescan
  /**
   * 配置落盘之后，让运行期的监听器/定时器跟上。所有会改写 config.json 的端点都必须走这里，
   * 不只是 PUT /api/config：applyConfig 里的 `manualReposChanged` 分支是**唯一**会为
   * 「落在所有扫描根之外的仓库」建立监听句柄的地方（清单导入正是这种仓库的主要来源），
   * 少调一次的后果是卡片出现了、内容却直到进程结束都不实时刷新。
   *
   * 监听器失败只记日志，绝不推翻已经落盘的配置：500 会让客户端以为没存上而重试/回滚 UI，
   * 从此界面显示的和盘上存的对不上。以磁盘为准——也不会就此不了了之，automation 会把
   * 「有目标没建成」记进 watchDegraded，下一轮重扫补一次便宜的重挂
   */
  async function applyConfigSafely(next: Config, prev: Config): Promise<void> {
    if (!extras.applyConfig) return
    try {
      await extras.applyConfig(next, prev)
    } catch (err) {
      console.error(`[repo-radar] 配置已保存，但重装监听器失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const batchDeps: BatchDeps = {
    getRepo: (id) => store.get(id),
    // skipCache：批量动作与自定义命令刚在这个仓库里跑过 git/shell，必须实算（见 RefreshOptions）
    refreshOne: (id) => store.refreshOne(id, { skipCache: true }),
    broadcast: (type, payload) => hub.broadcast(type, payload),
  }

  // 变更类端点的统一骨架：先查 repo（否则 404）→ 执行 run（run 内做 body 校验，失败可直接返回 Response，
  // git 操作自行用 withRepoLock 包）→ 刷新 + 广播 repo:updated + 返回 { result, repo }。
  async function mutateRepo(c: Context, run: (repo: RepoStatus) => Promise<Response | { result: unknown }>): Promise<Response> {
    const repo = store.get(c.req.param("id") ?? "")
    if (!repo) return c.json({ error: "repo not found" }, 404)
    const out = await run(repo)
    if (out instanceof Response) return out // 校验失败等，直接透传
    // skipCache：run 里刚执行过写盘的 git 动作（switch / stash / branch / discard），
    // 指纹探针集合不可能证明完备，这里读缓存就是在把用户刚触发的变更从响应里抹掉
    const updated = await store.refreshOne(repo.id, { skipCache: true })
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

  const boundPort = extras.boundPort ?? (() => PORT)
  const devOrigins = extras.devOrigins ?? false
  app.use("/api/*", async (c, next) => {
    if (!originAllowed(c.req.header("origin"), boundPort(), devOrigins)) return c.json({ error: "forbidden origin" }, 403)
    await next()
  })

  // 「关于本实例」：
  //   app     — 身份标识，同端口再启动的进程靠它判断占着端口的是不是 repo-radar
  //             （防止把恰好返回 200 的别家服务误判成自己）
  //   version — 显示在设置面板，让用户能核对自己跑的是哪一版（升级后尤其需要）
  //   canQuit — 退出端点是否存在，UI 据此决定显不显示「退出」按钮。必须由 shutdown 是否注入
  //             如实推导，不能借用 autostart.supported：两者是独立能力，搭车会在任一侧改动时静默失效
  //   port    — 实际绑定的端口。默认端口绑不上时会自动换一个（见 backend.start），而端口是
  //             窗口 origin 的一部分——不显示出来的话，用户既不知道自己实际跑在哪个端口上
  //             （书签、脚本要用），也无从解释"保存的视图怎么没了"（换 origin = 换 localStorage）
  app.get("/api/version", (c) =>
    c.json({
      app: "repo-radar",
      version: extras.version ?? "0.0.0",
      canQuit: extras.shutdown !== undefined,
      port: boundPort(),
    }),
  )

  // 优雅退出：新版本启动时用它替换旧实例，UI 的「退出」按钮也走它。只在注入了 shutdown 时注册——
  // index 仅在单文件 exe 模式注入，源码/PM2 部署下这个端点不存在（长期跑的服务不能隔着 HTTP 被杀掉）。
  // 服务只绑 127.0.0.1，且要求自定义头：带自定义头的跨域请求会触发 CORS 预检（服务端不应答预检），
  // 恶意网页无法从浏览器把它发出来
  if (extras.shutdown) {
    const bye = extras.shutdown
    app.post("/api/shutdown", (c) => {
      if (c.req.header("x-repo-radar") !== "shutdown") return c.json({ error: "missing X-Repo-Radar header" }, 403)
      bye()
      return c.json({ ok: true })
    })
  }

  // 开机自启：OS 即事实源（注册表/plist/desktop 文件），不落 config。源码模式没有稳定的可执行路径，不注入即「不支持」
  app.get("/api/autostart", (c) => c.json(extras.autostart ? extras.autostart.get() : { supported: false, enabled: false }))
  app.post("/api/autostart", async (c) => {
    if (!extras.autostart) return c.json({ error: "autostart is only available in the packaged executable" }, 400)
    const body = await jsonBody(c)
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400)
    return c.json(extras.autostart.set(body.enabled))
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
    const updated = await store.refreshOne(repo.id, { skipCache: true }) // 刚 commit/push 过，见 RefreshOptions
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
    // skipCache 在这条路径上是硬性的：`git branch -d` 曾经完全不改指纹（松散引用只动
    // refs/heads 目录的 mtime，而那个目录当初不在探针里），于是删完分支返回和广播的
    // 仍是那几个已经不存在的分支——用户点了按钮、git 成功了、界面说什么都没发生
    const updated = await store.refreshOne(repo.id, { skipCache: true })
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
    // 整段循环算一笔待办（见 trackPending）：仓库之间那段 refreshOne 是放了锁的，
    // 只靠逐次 withRepoLock，退出排空会在这里答「已排空」，而循环随即又去 drop 下一个仓库的 stash
    await trackPending(async () => {
      for (const [repoId, shas] of byRepo) {
        const repo = store.get(repoId)
        if (!repo) {
          for (const sha of shas) results.push({ repoId, name: repoId, sha, ok: false, message: "repo not found" })
          continue
        }
        const res = await withRepoLock(repo.id, () => dropStashes(repo.path, shas))
        const label = repo.displayName ?? repo.name
        for (const r of res) results.push({ repoId, name: label, ...r })
        const updated = await store.refreshOne(repo.id, { skipCache: true }) // 刚 drop 过 stash，见 RefreshOptions
        if (updated) hub.broadcast("repo:updated", { repo: updated })
      }
    })
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
    // 落盘前记下这两个字段的旧值：它们不只是显示用的标记，还决定 watcher 怎么对待这个仓库
    // （归档 = 事件就地丢弃；收藏 = Linux 上监听名额不够时优先保留），而那份状态只在重扫链上
    // 重算。真的翻转时得通知一次，见下面 syncRepos 那段
    const wasArchived = cfg.archived.includes(repo.id)
    const wasFavorite = cfg.favorites.includes(repo.id)
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
    // 归档/收藏真的翻转了 → 让监听器按新列表重算静音名单与监听名额。必须排在 redecorate
    // 之后：syncRepos 读的是 store 里的仓库列表，早一步调它读到的还是旧的 archived。
    // 两个方向都调（归档那一侧其实是良性的：仓库照常刷新，只是不上看板），不为此加分支——
    // 代价只是一次纯 JS 的 setRepos，而覆盖不够时它自己会补一次 applyWatch，Linux 上正好把
    // 新解除归档的仓库挂回监听名额
    if (cfg.archived.includes(repo.id) !== wasArchived || cfg.favorites.includes(repo.id) !== wasFavorite) extras.syncRepos?.()
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

  /** 解析 JSON body 并要求它是个普通对象。`null` 是合法 JSON——c.req.json() 不会抛，
   *  直接 `body.xxx` 就是对 null 取属性，TypeError 会把本该 400 的校验错变成 500 */
  async function readBodyObject(c: Context): Promise<Record<string, unknown> | null> {
    try {
      const body: unknown = await c.req.json()
      return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  // 开/关文件监听实时刷新；持久化到 config.autoWatch，默认开启
  app.post("/api/watch", async (c) => {
    const body = await readBodyObject(c)
    if (body === null) return c.json({ error: "body must be a JSON object" }, 400)
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400)
    if (extras.setWatch) await extras.setWatch(body.enabled)
    return c.json({ ok: true, autoWatch: body.enabled })
  })

  // 设置兜底全量重扫间隔（分钟，0=关）；持久化到 config.autoScanMinutes
  app.post("/api/auto-scan", async (c) => {
    const body = await readBodyObject(c)
    if (body === null) return c.json({ error: "body must be a JSON object" }, 400)
    // 和 PUT /api/config 共用 checkMinutes：同一个字段两个入口，校验口径必须一致。
    // checkMinutes 把 undefined 当「patch 没带这个字段」放行，但这里 minutes 是必填——
    // 不先挡 undefined 的话 Math.floor(undefined)=NaN 会一路走到落盘，写成 null。
    // 报错一律写 minutes（本端点的请求字段），不写配置字段名
    if (body.minutes === undefined) return c.json({ error: "minutes must be a non-negative number" }, 400)
    const problem = checkMinutes({ autoScanMinutes: body.minutes }, "autoScanMinutes", "minutes")
    if (problem !== null) return c.json({ error: problem }, 400)
    const minutes = body.minutes as number // checkMinutes 已保证是整数，无须 floor
    if (extras.setAutoScan) await extras.setAutoScan(minutes)
    return c.json({ ok: true, autoScanMinutes: minutes })
  })

  // 最近一次全量扫描完成时刻 + 监听覆盖情况。挂载时和 WebSocket 重连后各拉一次即可——
  // 之后的每一轮扫描都会广播 scan:done，界面不需要轮询这个端点。
  // watch 让面板能如实显示「250 个中监听 200 个」：截断只写日志的话，常驻托盘的应用
  // 等于什么都没说，用户没法回答「为什么这个仓库不自动刷新」
  app.get("/api/scan", (c) =>
    c.json({
      lastScanAt: extras.lastScanAt?.() ?? null,
      watch: extras.watchCoverage?.() ?? { watched: 0, total: 0 },
    }),
  )

  // 设置同时监听的仓库数上限（0=无上限）；持久化到 config.watchLimit 并立即重挂监听
  app.post("/api/watch-limit", async (c) => {
    const body = await readBodyObject(c)
    if (body === null) return c.json({ error: "body must be a JSON object" }, 400)
    // limit 在这个端点是必填：validateConfigPatch 把 undefined 当「patch 没带这个字段」
    // 放行，不先挡住就会一路落盘成 null，`limit > 0` 恒假 → 静默变成「无上限」。
    // 和 PUT /api/config 同口径（见 validateConfigPatch 里的 watchLimit 分支），
    // 但报错写 limit（本端点的请求字段），不写配置字段名
    if (body.limit === undefined || validateConfigPatch({ watchLimit: body.limit }) !== null)
      return c.json({ error: "limit must be a non-negative integer" }, 400)
    const limit = body.limit as number
    if (extras.setWatchLimit) await extras.setWatchLimit(limit)
    return c.json({ ok: true, watchLimit: limit, watch: extras.watchCoverage?.() ?? { watched: 0, total: 0 } })
  })

  // 设置定时后台 fetch 间隔（分钟，0=关）；持久化到 config.autoFetchMinutes
  app.post("/api/auto-fetch", async (c) => {
    const body = await readBodyObject(c)
    if (body === null) return c.json({ error: "body must be a JSON object" }, 400)
    if (body.minutes === undefined) return c.json({ error: "minutes must be a non-negative number" }, 400)
    const problem = checkMinutes({ autoFetchMinutes: body.minutes }, "autoFetchMinutes", "minutes")
    if (problem !== null) return c.json({ error: problem }, 400)
    const minutes = body.minutes as number // checkMinutes 已保证是整数，无须 floor
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
    // 提到局部 const：body 是 let，上面的类型收窄只在当次判断成立，TS 不会把它带到后面的使用点
    const { parent, name } = body
    const cfg = loadConfig(configFile)
    // 走 withRepoLock（缺陷 4）：createProject 只是 mkdir + git init + 写一个 README，秒级操作，
    // 10 秒的排空上限绰绰有余——包上它，退出排空才能真正等到它跑完，而不是像克隆一样两头落空。
    // 不会重蹈上一轮 "__scaffold__" 合成键的覆辙：clone 走的是 scaffold.ts 里的临时目录方案
    // （耗时可能是分钟级，排空对它形同虚设，见下面 /api/clone 的注释），两者时长差两个数量级，
    // 不该用同一把锁——这里用的 NEW_PROJECT_LOCK_KEY 只有 createProject 自己在用。
    const result = await withRepoLock(NEW_PROJECT_LOCK_KEY, () => createProject(parent, name, cfg.roots))
    if (!result.ok) return c.json({ error: result.error }, 400)
    await rescanFresh() // 纳入新仓库：磁盘刚变，不能共乘可能已扫过父目录的进行中一轮
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
    // 同上：先落到局部 const，避免 body 的 let 声明让类型收窄在后面的使用点丢失
    const { url, parent } = body
    const cfg = loadConfig(configFile)
    // 不走 withRepoLock：克隆一个大仓库可能跑很久（远超 10 秒的排空上限），退出时排空对它
    // 形同虚设，包不包锁都一样等不到它跑完——真正的保护在 cloneRepo 内部：先克隆到临时目录，
    // 成功后才 rename 成最终名字，即便被硬切也不会留下一个顶着最终名字的半成品仓库（不做残骸
    // 自动清理，见 scaffold.ts 顶部注释）
    const result = await cloneRepo(url, parent, cfg.roots)
    if (!result.ok) return c.json({ error: result.error }, 400)
    await rescanFresh() // 同 new-project：保证扫描在 clone 落盘之后开始
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
    const prev = loadConfig(configFile)
    const { manualRepos, summary } = importManifest(body.manifest, prev.manualRepos)
    const next: Config = { ...prev, manualRepos }
    saveConfig(configFile, next)
    // 落盘不算改完：导入进来的仓库多半落在所有扫描根之外（跨机器清单的常见情形），
    // 而给这类仓库建立监听句柄的唯一入口就是 applyConfig 的 manualRepos 分支。少了这一步，
    // 前端随后那次 POST /api/scan（force=false，收尾走 applyRepos）只会把它加进归属映射表，
    // 卡片出现了却拿不到句柄——提交、切分支要等最长 30 分钟的兜底重扫，而那个开关可以关掉
    await applyConfigSafely(next, prev)
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
    const prev = loadConfig(configFile)
    const next = mergeConfig(prev, body)
    saveConfig(configFile, next)
    // 自动化字段有运行期副作用（监听器、两个定时器），光落盘不算改完；applyConfig 内部
    // 逐字段与 prev 比对，只重装真变了的——存标签/备注或原值 round-trip 都不会动监听器。
    // 抛错时仍返回 200，理由见 applyConfigSafely
    await applyConfigSafely(next, prev)
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

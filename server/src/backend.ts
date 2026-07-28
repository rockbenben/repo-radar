import { serve } from "@hono/node-server"
import { createNodeWebSocket } from "@hono/node-ws"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createAutomation } from "./automation"
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config"
import { DescCache } from "./desc-cache"
import { WsHub } from "./events"
import { runRepoAction } from "./git"
import { getGithubDescription, getGithubInbox, ghAvailable, githubRemoteUrl, githubSlug } from "./github"
import { InboxCache } from "./inbox-cache"
import { mapLimit } from "./map-limit"
import { isPortUnavailable, PORT, portCandidates } from "./port"
import { forgetRememberedPort, loadRememberedPort, saveRememberedPort } from "./port-state"
import { drainRepoLocks, pendingRepoOps, withRepoLock } from "./queue"
import { RepoCache } from "./repo-cache"
import { IdentityLedger } from "./repo-identity"
import { type ApiExtras, createApi, originAllowed } from "./routes"
import { createSerialQueue } from "./serial"
import { createShutdown } from "./shutdown"
import { diskStatic } from "./static"
import { evictRepoStats } from "./stats"
import { RepoStore } from "./store"
import type { GithubInbox, RepoStatus } from "./types"
import { RepoWatcher } from "./watcher"

export interface BackendOptions {
  configFile: string
  staticRoot: string // 前端 web/dist 的绝对路径
  version: string
  port?: number // 仅测试用；正常走 REPO_RADAR_PORT / DEFAULT_PORT
  allowPortFallback?: boolean // 端口绑不上时可否改用别的（默认 true）。显式端口/开发模式下必须关掉，见 portCandidateList
  devOrigins?: boolean // 是否放行 vite dev server（5173）作为同源。**只能在开发模式下为真**，见 routes.ts 的 DEV_ORIGINS
  extras?: Pick<ApiExtras, "autostart" | "shutdown">
}

/** 一轮 inbox 补全里，某个仓库的「等我的」发生了变化。before 为 null 表示此前没有缓存（首次拿到） */
export interface InboxChange {
  repoId: string
  name: string
  before: GithubInbox | null
  after: GithubInbox
}

/** before/after 是否完全一致（Minor 7）：InboxChange 这个名字承诺的是「变化」，
 * 之前实际塞进去的是「本轮所有拉取成功的仓库」（含毫无变化的）——两者不该混为一谈，
 * 名字要跟内容对上。before 为 null（首次拿到缓存）永远不算「一致」。 */
export function inboxEqual(before: GithubInbox | null, after: GithubInbox): boolean {
  if (before === null) return false
  return (
    before.prs === after.prs &&
    before.issues === after.issues &&
    before.ciFailed === after.ciFailed &&
    before.ciSha === after.ciSha &&
    before.byViewer === after.byViewer
  )
}

export interface Backend {
  readonly port: number
  start(): Promise<void>
  stop(): Promise<void>
  /** 订阅 inbox 变化。每轮补全只发一次（批量），空轮不发——消费方据此聚合成一条通知而不是刷屏 */
  onInboxChanged(listener: (changes: InboxChange[]) => void): void
}

/** inbox 事件缝的投递器：维护订阅者列表 + 逐个兜错投递 + 清空。
 * 单独抽成一个不依赖 gh/网络的小工厂——不这样做的话，「订阅者抛错不影响其它订阅者」
 * 「空轮不投递」「多订阅者按顺序都收到」这三条保证只能靠真拉一轮 GitHub 数据才能触发，
 * 在 CI 与本机都不可靠，实际上就等于永远测不到。createBackend 内部用它；
 * stop() 时调 clear()，避免同一进程重复 start/stop 时监听器无界增长，也避免退出后
 * 残留的订阅者还在收晚到的一轮回调。 */
export interface InboxEmitter {
  subscribe(listener: (changes: InboxChange[]) => void): void
  emit(changes: InboxChange[]): void
  clear(): void
}
export function createInboxEmitter(): InboxEmitter {
  const listeners: ((changes: InboxChange[]) => void)[] = []
  return {
    subscribe(listener) {
      listeners.push(listener)
    },
    emit(changes) {
      if (changes.length === 0) return // 空轮不投递：消费方不必自己再判一次空数组
      for (const listener of listeners) {
        try {
          listener(changes)
        } catch (err) {
          // 订阅者（主进程的通知逻辑）抛错绝不能把补全轮次带崩——它只是个旁观者
          console.error(`[repo-radar] inbox 订阅者出错: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },
    clear() {
      listeners.length = 0
    },
  }
}

const INBOX_REFRESH_MS = 12 * 60 * 1000
const DRAIN_TIMEOUT_MS = 10_000
export function createBackend(options: BackendOptions): Backend {
  const { configFile, staticRoot, version } = options
  const wantedPort = options.port ?? PORT
  // 默认允许回退：backend 是库，「什么时候可以换端口」是宿主的策略决定（desktop/src/main.ts
  // 按「显式端口 / 开发模式」关掉它）。测试里两种都要能构造，所以做成显式选项而不是内部推导
  const allowPortFallback = options.allowPortFallback ?? true
  const portStateFile = join(dirname(configFile), "port-state.json")
  // 实际绑定的端口。原端口绑不上时会回退（见 start()），窗口 URL、托盘的 rescan、同源白名单
  // 全都得按这个值走，不能各自按 wantedPort 推
  let boundPort = wantedPort

  if (!existsSync(configFile)) {
    saveConfig(configFile, DEFAULT_CONFIG)
    console.log(`[repo-radar] 已生成默认配置 / created default config: ${configFile}`)
  }

  const descCache = new DescCache(join(dirname(configFile), "github-desc.json"))
  const inboxCache = new InboxCache(join(dirname(configFile), "github-inbox.json"))
  const repoCache = new RepoCache(join(dirname(configFile), "repo-cache.json"))
  // 身份账本：仓库改名/移动后继续用老 id，config.json 里按 id 存的标签/收藏/归档/便签不受影响
  const identity = new IdentityLedger(join(dirname(configFile), "repo-identity.json"))
  const store = new RepoStore(
    () => loadConfig(configFile),
    (id, url) => descCache.get(id, url),
    (id, url) => inboxCache.get(id, url),
    repoCache,
    identity,
  )
  const hub = new WsHub()

  // 事件缝：主进程要据此弹系统通知。刻意只暴露「变化」而不是整个 inbox 状态——
  // 消费方不需要知道全量，只需要知道「什么变了、从什么变成什么」
  const inboxEmitter = createInboxEmitter()

  // 有 GitHub 远程、且 stale 判定为真的补全目标。inbox 与描述两个补全器共用这一份筛选——
  // 之前各抄一份，改挑选逻辑（如 origin 优先）就得改两处，漏一处两边的数据就对不上同一个仓库
  function githubTargets(stale: (id: string, url: string) => boolean): { id: string; url: string; slug: string }[] {
    return store
      .list()
      .filter((r) => r.error === null && !r.archived)
      .map((r) => {
        const url = githubRemoteUrl(r.remotes) // 主机名精确匹配 + origin 优先，与前端跳转同一挑选逻辑
        return { id: r.id, url, slug: url ? githubSlug(url) : null }
      })
      .filter((t): t is { id: string; url: string; slug: string } => t.url !== undefined && t.slug !== null && stale(t.id, t.url))
  }

  // 后台补全 GitHub「等我的」：对有 GitHub 远程、缓存缺失/过期的仓库限流拉取 PR/issue/CI，写缓存后 redecorate + 广播。
  // 与描述补全同样只读联网、gh 未装则跳过；扫描后触发，另有定时刷新（这些比描述变得频繁）。
  // promise 链 + 共乘：调用时若已有「排队未开跑」的一轮就共乘它（force 标记在开跑时才读，先到的设置都算数），
  // 否则在链尾排新一轮——↻ 手动刷新即便赶上上一轮正在收尾也一定跑到强制轮、等到它真结束
  // （单飞 + pending 标记有收尾关窗期会假成功；不共乘的话 gh 未登录时每个触发都排完整一轮，积压无上界）。
  const inboxQueue = createSerialQueue<void>()
  let inboxForce = false // 手动刷新：下一轮忽略 TTL，强制重拉全部 GitHub 仓库
  function enrichGithubInbox(): Promise<void> {
    return inboxQueue.share(async () => {
      const force = inboxForce
      inboxForce = false
      const targets = githubTargets((id, url) => force || inboxCache.isStale(id, url))
      if (targets.length === 0) return
      if (!(await ghAvailable())) return
      const changes: InboxChange[] = []
      // 6 并发：每次 gh graphql 约 1.8s（spawn+联网），并发拉满可把整轮从 ~37s 压到 ~18s；只读 API，不会触发写限流
      await mapLimit(targets, 6, async (t) => {
        try {
          // 传上次缓存的 PR 数与 issue 数：prOthers（PR 的 search 字段）与 mine（自己开的 issue 数）
          // 都可能被二级限流单独置空，各自沿用对应的上次计数——避免 PR 数在「不含自己/含总数」间震荡，
          // 也避免 issue 数因 mine 缺失被静默按 0 算而虚高（见 github.ts parseInboxResponse 的注释）
          const before = inboxCache.get(t.id, t.url)
          const inbox = await getGithubInbox(t.slug, before?.prs, before?.issues)
          if (inbox === null) return // 拉不到（未登录/网络）：保留旧缓存，别把状态抹空
          inboxCache.set(t.id, t.url, inbox)
          const updated = store.redecorate(t.id)
          if (updated) hub.broadcast("repo:updated", { repo: updated })
          // 只收「真变了」的：InboxChange 的名字承诺的是变化，不是「本轮所有拉取成功的仓库」——
          // 拉到手但与上次完全一致（before/after 全等）的不算变化，不该进这个数组
          if (!inboxEqual(before, inbox)) {
            changes.push({ repoId: t.id, name: updated?.displayName ?? updated?.name ?? t.id, before, after: inbox })
          }
        } catch {
          /* 单仓库失败不影响其它 */
        }
      })
      inboxEmitter.emit(changes)
    })
  }

  // 后台补全 GitHub 描述：同上走串行队列 + 共乘；缓存 TTL 7 天，通常一轮即 no-op
  const descQueue = createSerialQueue<void>()
  function enrichDescriptions(): Promise<void> {
    return descQueue.share(async () => {
      const targets = githubTargets((id, url) => descCache.isStale(id, url))
      if (targets.length === 0) return // 全部命中缓存：连 gh --version 都不必 spawn
      if (!(await ghAvailable())) return
      await mapLimit(targets, 3, async (t) => {
        try {
          const res = await getGithubDescription(t.slug) // 显式 owner/repo，不依赖 cwd 默认远程
          if (res === null) return // 查询失败（未登录/网络）：不缓存，下次重试——别把失败落盘成「确认无描述」压 7 天
          descCache.set(t.id, t.url, res.description)
          const updated = store.redecorate(t.id)
          if (updated) hub.broadcast("repo:updated", { repo: updated })
        } catch {
          /* 单仓库失败不影响其它 */
        }
      })
    })
  }

  let lastScanAt: string | null = null // 最近一次全量扫描完成时刻（ISO）；启动扫描跑完才有值
  const watcher = new RepoWatcher((id) => {
    evictRepoStats(id) // 仓库有变化，作废其热力图缓存，避免统计落后于实时状态
    void store
      .refreshOne(id)
      .then((repo) => {
        if (repo) hub.broadcast("repo:updated", { repo })
      })
      .catch((err) => {
        console.error(`[repo-radar] 监听刷新失败：${err instanceof Error ? err.message : String(err)}`)
      })
  })

  // 后台自动化（监听 + 两个定时器）统一由 automation 装表；rescan/fetchAll 以回调传入，
  // 让它不必知道扫描链和 hub 的存在
  const automation = createAutomation({
    configFile,
    watcher,
    listRepos: () => store.list(),
    rescan: () => rescanAndWatch(),
    fetchAll: () => autoFetchAll(),
  })

  async function doRescanAndWatch(): Promise<RepoStatus[]> {
    const repos = await store.refreshAll((scanned, total) => hub.broadcast("scan:progress", { scanned, total }))
    await automation.applyWatch(loadConfig(configFile).autoWatch, repos)
    const ids = new Set(repos.map((r) => r.id)) // 剪掉已不存在仓库的缓存条目，避免落盘缓存无界增长
    descCache.prune(ids)
    inboxCache.prune(ids)
    repoCache.prune(ids)
    // 账本的 30 天年龄护栏尤其要命：条目一剪，那批仓库回来时会被当成全新仓库，
    // 标签/收藏/归档全丢——正是本轮要消灭的行为。护栏在 JsonStore.pruneStale 里
    identity.prune(ids)
    // 扫描完成时刻：界面据此显示「上次扫描 …」。只在全量扫描后更新——文件监听的单仓库
    // refreshOne 不算「扫描」，把它算进来会让这个时间永远显示「刚刚」，等于没有信息量。
    // 放在 applyWatch 之后：那一步抛错时整轮扫描算失败（POST /api/scan 返回 500，界面弹
    // 红条），此时绝不能已经广播过「扫描完成」，让顶栏同时显示「上次扫描 刚刚」
    lastScanAt = new Date().toISOString()
    // 带上完整仓库列表：定时兜底重扫没有任何人在等 HTTP 响应，只发时刻的话服务端 store
    // 更新了、界面却还停在旧数据——新增/删除的仓库根本不会出现或消失，而顶栏偏偏在说
    // 「刚扫过」。repo:updated 只能表达「某个仓库变了」，表达不了「这个仓库没了」。
    // 列表必须现取而不是用上面 refreshAll 返回的那份：applyWatch 重建几百个监听要花
    // 好几秒，这窗口里 refreshOne 广播过的新状态若被扫描前的旧快照整份盖回去，看板会
    // 凭空回退且没有补救事件（watcher 正处冷却期）
    const current = store.list()
    hub.broadcast("scan:done", { at: lastScanAt, repos: current })
    void enrichDescriptions() // 后台补全 GitHub 描述，不阻塞扫描返回
    void enrichGithubInbox() // 后台补全 GitHub「等我的」（PR/issue/CI）
    return current
  }

  // 重扫链 + 按需共乘：进行中的一轮在开跑时就定死了扫描目标（roots/excludes/manualRepos 快照）——
  //   目标没变（重复点「重扫」）→ 共乘进行中的一轮：不排第二次全量扫描，等待不翻倍、进度条不倒退；
  //   目标变了（保存了新扫描目录）→ 链尾排新一轮：开跑时才读配置，新目录必然被扫到，不会被旧一轮静默吞掉；
  //   已排队未开跑的一轮任何触发都可共乘（它开跑时读到的配置一定是最新的）
  const scanTargets = (): string => {
    try {
      const cfg = loadConfig(configFile)
      return JSON.stringify({ roots: cfg.roots, excludes: cfg.excludes, manualRepos: cfg.manualRepos })
    } catch {
      return "config-unreadable" // 配置损坏：快照恒等 → 触发都共乘；真正的报错由扫描链的 catch 记日志
    }
  }
  const rescanQueue = createSerialQueue<RepoStatus[]>()
  let rescanRunning: { promise: Promise<RepoStatus[]>; targets: string } | null = null
  // force：磁盘刚被服务端自己改过（clone/新建项目）——进行中的一轮可能在写盘前就扫过了目标父目录，
  // 共乘它会漏掉新仓库，必须排新一轮；已排队未开跑的一轮仍可共乘（它开跑时读到的磁盘状态是新的）
  function rescanAndWatch(force = false): Promise<RepoStatus[]> {
    if (rescanQueue.queued) return rescanQueue.queued
    if (!force && rescanRunning && scanTargets() === rescanRunning.targets) return rescanRunning.promise
    return rescanQueue.share(async () => {
      const round = { promise: doRescanAndWatch(), targets: scanTargets() }
      rescanRunning = round
      try {
        return await round.promise
      } finally {
        if (rescanRunning === round) rescanRunning = null
      }
    })
  }

  // 定时后台 fetch：安静地为有远程的仓库 fetch，只广播 repo:updated（不占用批量进度条）
  let autoFetchRunning = false
  async function autoFetchAll(): Promise<void> {
    if (autoFetchRunning) return // 上一轮未结束则跳过，避免叠加
    autoFetchRunning = true
    try {
      const repos = store.list().filter((r) => r.remotes.length > 0 && r.error === null && !r.archived)
      await mapLimit(repos, 4, async (r) => {
        try {
          // 走仓库锁：一是别和用户正在做的 commit/push 在同一个 .git 上撞车，
          // 二是退出时的排空只认锁里的操作——不包进来，定时 fetch 就会被硬切在写 refs 的中途
          await withRepoLock(r.id, () => runRepoAction(r.path, "fetch"))
          const updated = await store.refreshOne(r.id)
          if (updated) hub.broadcast("repo:updated", { repo: updated })
        } catch {
          /* 单仓库 fetch 失败不影响其它 */
        }
      })
    } finally {
      autoFetchRunning = false
    }
  }

  // 手动刷新 GitHub「等我的」：强制标记后跑一轮（跳过 TTL），跑完再返回
  const refreshInbox = async (): Promise<void> => {
    inboxForce = true
    await enrichGithubInbox()
  }

  const app = createApi(store, configFile, {
    hub,
    rescan: () => rescanAndWatch(),
    rescanFresh: () => rescanAndWatch(true),
    setWatch: automation.setWatch,
    setAutoScan: automation.setAutoScan,
    setAutoFetch: automation.setAutoFetch,
    setWatchLimit: automation.setWatchLimit,
    applyConfig: automation.applyConfig,
    lastScanAt: () => lastScanAt,
    watchCoverage: () => automation.coverage(),
    refreshInbox,
    boundPort: () => boundPort,
    devOrigins: options.devOrigins ?? false,
    version,
    ...(options.extras ?? {}),
  })
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  const wsUpgrade = upgradeWebSocket(() => ({
    onOpen: (_evt, ws) => hub.add(ws),
    onClose: (_evt, ws) => hub.remove(ws),
  }))
  app.get("/ws", async (c, next) => {
    if (!originAllowed(c.req.header("origin"), boundPort, options.devOrigins ?? false)) return c.text("forbidden", 403)
    return wsUpgrade(c, next)
  })
  app.use("/*", diskStatic(staticRoot))

  let server: ReturnType<typeof serve> | null = null
  let intervalTimer: ReturnType<typeof setInterval> | null = null
  let stopped: Promise<void> | null = null

  /** 绑定端口。失败走返回值；绑定成功后的运行期 error 只记日志——文件描述符耗尽时
   *  服务器也会 emit error，绝不能因此把健康实例拆掉。
   *  端口 0 时实际端口由系统分配，只能从 listen 回调的 AddressInfo 里读 */
  function bindOnce(p: number): Promise<{ ok: true } | { ok: false; err: NodeJS.ErrnoException }> {
    return new Promise((resolve) => {
      let listening = false
      const s = serve({ fetch: app.fetch, port: p, hostname: "127.0.0.1" }, (info) => {
        listening = true
        server = s
        boundPort = info.port
        resolve({ ok: true })
      })
      s.on("error", (err: NodeJS.ErrnoException) => {
        if (listening) console.error(`[repo-radar] 服务器错误 / server error: ${err.message}`)
        else resolve({ ok: false, err })
      })
      injectWebSocket(s)
    })
  }

  /**
   * 本次启动要依次尝试的端口。
   *
   * 不允许回退时只有一个候选——绑不上就如实失败。这不是保守，是因为「悄悄换个端口」在两种
   * 场景下会制造出更难查的故障：
   * - 用户显式设了 REPO_RADAR_PORT：那是对外承诺（书签、反向代理上游、脚本），换掉之后
   *   它们全部 ECONNREFUSED，而界面一切正常
   * - 开发模式：vite 的代理目标在配置加载时就定死了，后端换端口 = /api 全部 502、
   *   WebSocket 连不上，看板空白且没有任何报错
   * 记住的端口排在最前（见 port-state.ts）：origin 稳定比用上默认端口重要。
   */
  function portCandidateList(): number[] {
    if (!allowPortFallback) return [wantedPort]
    const ladder = portCandidates(wantedPort)
    const remembered = loadRememberedPort(portStateFile)
    if (remembered === null || remembered === wantedPort) return ladder
    return [...new Set([remembered, ...ladder])]
  }

  const shutdown = createShutdown({
    stopListening: () => void server?.close(),
    drainOps: () => drainRepoLocks(DRAIN_TIMEOUT_MS),
    pendingOps: pendingRepoOps,
    closeWatcher: () => watcher.close(),
    flushCaches: () => {
      inboxCache.flush()
      repoCache.flush() // 防抖窗口 1s：硬退会丢最后一轮缓存写入，下次启动白白付一轮全价
      // 账本丢一轮写入的代价比缓存大得多：本轮认领/铸造的结果没落盘，下次启动这些仓库
      // 会按新路径重新铸造 id，标签/收藏/归档当场对不上
      identity.flush()
    },
    closeConnections: () => (server as { closeAllConnections?: () => void } | null)?.closeAllConnections?.(),
    log: (m) => console.log(m),
  })

  return {
    get port() {
      return boundPort
    },
    onInboxChanged(listener) {
      inboxEmitter.subscribe(listener)
    },
    async start() {
      const candidates = portCandidateList()
      let bound = await bindOnce(candidates[0])
      if (!bound.ok && bound.err.code === "EADDRINUSE") {
        // 上一个实例刚退出时端口可能还在释放中（「退出 → 立刻重开」是常见动作）。
        // 等一拍再抢一次；仍失败才是真的被别的程序占着
        await new Promise((r) => setTimeout(r, 300))
        bound = await bindOnce(candidates[0])
      }
      // 顺着阶梯换。tried 必须跟着走：日志里报错的端口如果永远是第一个候选，第二跳之后就在
      // 说谎——「17420 绑不上，改试 19420」会让照着日志去查 excludedportrange 的人永远
      // 不知道 18420 也被占了，然后手动设成 18420 再失败一次
      let tried = candidates[0]
      for (const alt of candidates.slice(1)) {
        if (bound.ok || !isPortUnavailable(bound.err)) break
        console.warn(
          `[repo-radar] 端口 ${tried} 无法绑定（${bound.err.code}），改试 ${alt === 0 ? "系统分配的端口" : alt} / port unavailable, trying next`,
        )
        bound = await bindOnce(alt)
        tried = alt
      }
      if (!bound.ok) throw bound.err
      if (boundPort !== wantedPort) {
        // 两种情况都不是 wantedPort，但原因完全不同，日志不能混为一谈：沿用记住的端口时
        // wantedPort 往往是空着的，写「原 X 不可用」就是在说假话，会把照着日志排查端口占用的人带偏
        const reason =
          boundPort === candidates[0]
            ? `沿用上次记住的端口 / reusing remembered port`
            : `原 ${wantedPort} 不可用 / ${wantedPort} unavailable`
        console.log(`[repo-radar] 使用端口 ${boundPort}（${reason}）`)
        saveRememberedPort(portStateFile, boundPort) // origin 稳定优先，见 port-state.ts
      } else {
        forgetRememberedPort(portStateFile) // 用回了原端口，别把一次偶发冲突永久固化
      }

      intervalTimer = setInterval(() => void enrichGithubInbox(), INBOX_REFRESH_MS)

      // 定时 fetch 按当前配置装上，不挂在扫描结果后面：扫描会失败（配置损坏时 loadConfig 直接抛），
      // 挂上去就意味着「扫描一失败，用户开着的定时拉取整局静默不生效」
      let cfg = DEFAULT_CONFIG
      try {
        cfg = loadConfig(configFile)
      } catch (err) {
        console.error(`[repo-radar] 配置读取失败，本次按默认设置运行: ${err instanceof Error ? err.message : String(err)}`)
      }
      automation.start(cfg)

      // 不做遗留 clone 临时目录的启动清扫——见 scaffold.ts 顶部 CLONE_TMP_PREFIX 注释：
      // 这类残骸点号开头、scanner 本就忽略、界面上看不见，出现条件也苛刻，不值得为它
      // 维护一整套跨进程账本机制

      rescanAndWatch()
        .then((repos) => console.log(`[repo-radar] 启动扫描完成：${repos.length} 个仓库 / startup scan done: ${repos.length} repos`))
        .catch((err) => console.error(`[repo-radar] 启动扫描失败: ${err instanceof Error ? err.message : String(err)}`))
    },
    stop() {
      // 幂等：托盘退出、窗口关闭、系统关机可能同时到达
      return (stopped ??= (async () => {
        if (intervalTimer) clearInterval(intervalTimer)
        automation.stop()
        inboxEmitter.clear() // 之前只增不减：同一进程反复 start/stop 会让订阅者无界增长，退出后也不该再收晚到的回调
        await shutdown("backend.stop")
      })())
    },
  }
}

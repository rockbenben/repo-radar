import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { createNodeWebSocket } from "@hono/node-ws"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config"
import { DescCache } from "./desc-cache"
import { WsHub } from "./events"
import { runRepoAction } from "./git"
import { getGithubDescription, getGithubInbox, ghAvailable, githubRemoteUrl, githubSlug } from "./github"
import { InboxCache } from "./inbox-cache"
import { createApi, originAllowed } from "./routes"
import { evictRepoStats } from "./stats"
import { mapLimit, RepoStore } from "./store"
import type { RepoStatus } from "./types"
import { RepoWatcher } from "./watcher"

const PORT = 7420
const configFile = process.env.REPO_RADAR_CONFIG ?? join(homedir(), ".repo-radar", "config.json")

if (!existsSync(configFile)) {
  saveConfig(configFile, DEFAULT_CONFIG)
  console.log(`[repo-radar] 已生成默认配置：${configFile}`)
  console.log(`[repo-radar] 请编辑 roots（要扫描的根目录）后点击面板"重新扫描"`)
}

// GitHub 描述缓存放在 config 同目录；store 用它把 GitHub 描述覆盖到本地描述之上
const descCache = new DescCache(join(dirname(configFile), "github-desc.json"))

// GitHub「等我的」（PR/issue/CI）缓存：落盘到 config 同目录，重启即可秒显上次结果；按 origin url 校验、TTL 12 分钟
const inboxCache = new InboxCache(join(dirname(configFile), "github-inbox.json"))
const INBOX_REFRESH_MS = 12 * 60 * 1000 // 定时刷新间隔（与缓存 TTL 一致）

const store = new RepoStore(
  () => loadConfig(configFile),
  (id, url) => descCache.get(id, url),
  (id, url) => inboxCache.get(id, url),
)
const hub = new WsHub()

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
let inboxChain: Promise<void> = Promise.resolve()
let inboxQueued: Promise<void> | null = null // 已排队、尚未开跑的那一轮；开跑即清
let inboxForce = false // 手动刷新：下一轮忽略 TTL，强制重拉全部 GitHub 仓库
function enrichGithubInbox(): Promise<void> {
  if (inboxQueued) return inboxQueued
  const run = inboxChain.then(async () => {
    inboxQueued = null // 本轮开跑：之后的触发需另排一轮（本轮的目标集已定）
    const force = inboxForce
    inboxForce = false
    const targets = githubTargets((id, url) => force || inboxCache.isStale(id, url))
    if (targets.length === 0) return
    if (!(await ghAvailable())) return
    // 6 并发：每次 gh graphql 约 1.8s（spawn+联网），并发拉满可把整轮从 ~37s 压到 ~18s；只读 API，不会触发写限流
    await mapLimit(targets, 6, async (t) => {
      try {
        // 传上次缓存的 PR 数：search 被限流时沿用，避免计数在「不含自己/含总数」间震荡
        const inbox = await getGithubInbox(t.slug, inboxCache.get(t.id, t.url)?.prs)
        if (inbox === null) return // 拉不到（未登录/网络）：保留旧缓存，别把状态抹空
        inboxCache.set(t.id, t.url, inbox)
        const updated = store.redecorate(t.id)
        if (updated) hub.broadcast("repo:updated", { repo: updated })
      } catch {
        /* 单仓库失败不影响其它 */
      }
    })
  })
  inboxQueued = run
  inboxChain = run.catch(() => {}) // 链自身吞错，避免一轮异常把后续所有轮永久卡死
  return run
}

// 后台补全 GitHub 描述：同上走 promise 链 + 共乘；缓存 TTL 7 天，通常一轮即 no-op
let descChain: Promise<void> = Promise.resolve()
let descQueued: Promise<void> | null = null
function enrichDescriptions(): Promise<void> {
  if (descQueued) return descQueued
  const run = descChain.then(async () => {
    descQueued = null
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
  descQueued = run
  descChain = run.catch(() => {})
  return run
}

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

// 按当前 config.autoWatch 决定是否开启文件监听（默认关闭；扫描本身始终执行以填充看板）
async function applyWatch(enabled: boolean, repos?: RepoStatus[]): Promise<void> {
  if (enabled) {
    // 不监听「已排除」的仓库——它们从看板/统计/后台处理里都收起
    const list = (repos ?? store.list()).filter((r) => !r.archived).map((r) => ({ id: r.id, path: r.path }))
    await watcher.watch(list)
  } else {
    await watcher.close()
  }
}

async function doRescanAndWatch(): Promise<RepoStatus[]> {
  const repos = await store.refreshAll((scanned, total) => hub.broadcast("scan:progress", { scanned, total }))
  await applyWatch(loadConfig(configFile).autoWatch, repos)
  const ids = new Set(repos.map((r) => r.id)) // 剪掉已不存在仓库的缓存条目，避免落盘缓存无界增长
  descCache.prune(ids)
  inboxCache.prune(ids)
  void enrichDescriptions() // 后台补全 GitHub 描述，不阻塞扫描返回
  void enrichGithubInbox() // 后台补全 GitHub「等我的」（PR/issue/CI）
  return repos
}

let rescanInFlight: Promise<RepoStatus[]> | null = null
function rescanAndWatch(): Promise<RepoStatus[]> {
  if (rescanInFlight) return rescanInFlight
  rescanInFlight = doRescanAndWatch().finally(() => {
    rescanInFlight = null
  })
  return rescanInFlight
}

async function setWatch(enabled: boolean): Promise<void> {
  const cfg = loadConfig(configFile)
  cfg.autoWatch = enabled
  saveConfig(configFile, cfg)
  await applyWatch(enabled)
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
        await runRepoAction(r.path, "fetch")
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

let fetchTimer: ReturnType<typeof setInterval> | null = null
function applyAutoFetch(minutes: number): void {
  if (fetchTimer) {
    clearInterval(fetchTimer)
    fetchTimer = null
  }
  if (minutes > 0) fetchTimer = setInterval(() => void autoFetchAll(), minutes * 60_000)
}
async function setAutoFetch(minutes: number): Promise<void> {
  const cfg = loadConfig(configFile)
  cfg.autoFetchMinutes = minutes
  saveConfig(configFile, cfg)
  applyAutoFetch(minutes)
}

// 手动刷新 GitHub「等我的」：强制标记后跑一轮（跳过 TTL），跑完再返回
const refreshInbox = async (): Promise<void> => {
  inboxForce = true
  await enrichGithubInbox()
}

const app = createApi(store, configFile, { hub, rescan: rescanAndWatch, setWatch, setAutoFetch, refreshInbox })
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

const wsUpgrade = upgradeWebSocket(() => ({
  onOpen(_evt, ws) {
    hub.add(ws)
  },
  onClose(_evt, ws) {
    hub.remove(ws)
  },
}))
app.get("/ws", async (c, next) => {
  if (!originAllowed(c.req.header("origin"))) return c.text("forbidden", 403)
  return wsUpgrade(c, next)
})

app.use("/*", serveStatic({ root: "../web/dist" }))

const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, () => {
  console.log(`[repo-radar] http://localhost:${PORT}`)
})
injectWebSocket(server)

// GitHub「等我的」定时刷新：每 12 分钟补一轮（PR/issue/CI 会在不重扫的情况下变化）；到期项才实际 spawn gh
setInterval(() => void enrichGithubInbox(), INBOX_REFRESH_MS)

rescanAndWatch()
  .then((repos) => {
    const cfg = loadConfig(configFile)
    applyAutoFetch(cfg.autoFetchMinutes)
    const fetchNote = cfg.autoFetchMinutes > 0 ? `，定时拉取每 ${cfg.autoFetchMinutes} 分钟` : ""
    console.log(
      `[repo-radar] 启动扫描完成：${repos.length} 个仓库，文件监听${cfg.autoWatch ? "已开启" : "默认关闭（可在面板开启）"}${fetchNote}`,
    )
  })
  .catch((err) => {
    console.error(`[repo-radar] 启动扫描失败：${err instanceof Error ? err.message : String(err)}`)
  })

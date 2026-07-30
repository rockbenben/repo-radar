import { existsSync } from "node:fs"
import { basename, relative, sep } from "node:path"
import type { Config } from "./config"
import { checkHealth } from "./health"
import { composeStatus, getRepoCore, getRepoHeavy, repoId, rootCommit } from "./git"
import { gitFingerprint } from "./fingerprint"
import { mapLimit } from "./map-limit"
import type { RepoCache } from "./repo-cache"
import { normalizePath, type IdentityLedger } from "./repo-identity"
import { githubRemoteUrl } from "./github"
import { scan } from "./scanner"
import type { GithubInbox, RepoStatus } from "./types"

const CONCURRENCY = 8

/** refreshOne 的可选行为 */
export interface RefreshOptions {
  /**
   * 跳过 heavy 的指纹缓存，无条件重算。
   *
   * **应用自己刚往磁盘上写过东西的路径必须传它**（commit / branch -d / stash / switch /
   * discard / fetch / 批量动作 / 自定义命令）。指纹是一组 `.git` 下路径的 stat 快照，
   * 而这个集合永远不可能证明完备——`git branch -d` 曾经就整整一类操作都不在里面：用户点
   * 「清理已合并分支」→ git 真的删了 → 指纹没变 → 命中缓存 → 返回并广播的仍是那些已经不
   * 存在的分支，界面上像是什么都没发生，而且要一直错到某次无关的 commit/fetch 为止。
   * 补探针只能修掉已知的那几个洞，这个开关把「自己写完立刻读到旧数据」整类问题关掉。
   *
   * 只对文件监听触发的刷新和全量重扫留缓存——那两条路径的前提正是「绝大多数仓库没动过」，
   * 也是这套缓存唯一要省的开销。
   */
  skipCache?: boolean
}

/**
 * 「这条路径没了」写给用户看的那句话。**必须按仓库来源分文案**。
 *
 * 这个守卫最初只为 manualRepos 而写（scan() 不覆盖根目录之外的路径，认领没有「新出现的
 * 路径」可配对，救不回来，只能让用户自己去改配置），但**同一个守卫也会对扫描根下的仓库
 * 触发**：仓库被删/改名，或网络盘在 `scan()` 枚举与 `mapLimit` 处理之间抖动——并发 8 处理
 * 几百个仓库时这个窗口是秒级的。对这些仓库说「请在 manualRepos 中更新这条路径」是**无法
 * 执行的指示**：用户打开 config.json，manualRepos 里根本没有这条路径。
 *
 * 手动那条指向配置文件而不是「设置」面板：⚙ 设置里的「扫描来源管理」（RootsEditor）只编辑
 * config.roots，manualRepos 目前没有对应 UI（见 web/src/components/RootsEditor.tsx 顶部注释），
 * 唯一真实可行的路是直接改配置文件——指错地方等于没提示。
 *
 * 归一化后比较而不是裸 `includes`：Windows/macOS 上大小写与分隔符风格随手一改就对不上，
 * 比不上就退到「扫描根」文案，那对真正的 manualRepo 又成了另一句无法执行的指示。
 */
export function pathGoneMessage(path: string, cfg: Config): string {
  const key = normalizePath(path)
  const manual = cfg.manualRepos.some((m) => normalizePath(m) === key)
  return manual
    ? `repo path no longer exists: ${path} — 手动添加的仓库；若是改名或移动，请在配置文件的 manualRepos 中更新这条路径`
    : `repo path no longer exists: ${path} — 扫描根下的仓库；可能已被删除或改名，也可能是所在磁盘/网络盘暂时不可用。下一轮全量扫描会自动更正这张卡片`
}

export function deriveGroup(repoPath: string, roots: string[]): string {
  for (const root of roots) {
    const rel = relative(root, repoPath)
    if (rel === "") return "(root)"
    if (!rel.startsWith("..") && !rel.includes(":")) {
      const parts = rel.split(sep)
      return parts.length > 1 ? parts[0] : "(root)"
    }
  }
  return "(manual)"
}

export class RepoStore {
  private repos = new Map<string, RepoStatus>()
  private inFlight: Promise<RepoStatus[]> | null = null
  // 全量扫描进行中被 refreshOne 刷新过的仓库（id → 新状态）：收尾合并时以这些为准，
  // 防止整份快照把更新的状态打回扫描时的旧值
  private freshened = new Map<string, RepoStatus>()
  // 每个仓库的本地描述（getRepoStatus 得来，未被 GitHub 覆盖前）；GitHub 描述被清空时据此回退，
  // 避免 redecorate 复用已覆盖对象导致旧描述残留
  private baseDesc = new Map<string, string | null>()

  constructor(
    private readonly getConfig: () => Config,
    // 可选：返回某仓库缓存的 GitHub 描述（非空且 origin url 一致才覆盖本地描述）；后台补全写缓存后再 redecorate 生效
    private readonly getGithubDesc?: (id: string, url: string | undefined) => string | null,
    // 可选：返回某仓库缓存的 GitHub「等我的」（PR/issue/CI）；同样按 origin url 校验，后台轮询写缓存后 redecorate 生效
    private readonly getGithubInbox?: (id: string, url: string | undefined) => GithubInbox | null,
    // 可选：heavy 字段的指纹缓存。不传时完全退化成「每轮全价刷新」（旧行为），
    // 测试与嵌入式用法据此免去落盘依赖
    private readonly cache?: RepoCache,
    // 可选：身份账本。不传时 id 仍按路径算（改造前行为），改名会丢失用户数据
    private readonly identity?: IdentityLedger,
  ) {}

  refreshAll(onProgress?: (scanned: number, total: number) => void): Promise<RepoStatus[]> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.doRefreshAll(onProgress).finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /**
   * 一个仓库的完整刷新，但 heavy 那 6 个 git 进程按 `.git` 指纹跳过。
   *
   * 顺序很关键：先跑 core 拿到 oid，再算指纹。oid 是 status 顺带给的（不额外 spawn），
   * 而它能识别出「mtime 因触碰而变、内容其实没变」以及反过来的情况。
   */
  private async refreshRepo(path: string, id: string, cfg: Config, skipCache = false): Promise<RepoStatus> {
    // 路径整个不在了。existsSync 是同步 stat，比起接下来必然要 spawn 的 git 进程可忽略不计，
    // 不会在正常路径（存在）上引入额外开销。绝不能让卡片静默消失——用户会以为自己删过它。
    if (!existsSync(path)) throw new Error(pathGoneMessage(path, cfg))
    const core = await getRepoCore(path)
    // 账本里根提交还是空的仓库，在它**有了提交**的这一刻补算一次判据②。触发条件必须便宜，
    // 而这里正好有现成的信号：core.oid 是上面那次 status 顺带给的（不额外 spawn），空仓库时
    // 它是 null——空仓库一分钱都不付，补算成功之后也永不再进。放在指纹缓存的命中判断**之前**：
    // 身份账本和 heavy 字段是两回事，缓存命中的轮次同样要能补上。见 backfillRootCommit：
    // 不补的话，经「+ 新建」创建的项目终身没有判据②（创建完立刻重扫，那一刻零提交）
    if (core.oid !== null) await this.identity?.backfillRootCommit(id, path, rootCommit)
    const fp = gitFingerprint(path, core.oid)
    // skipCache 只跳过**读**，仍然照常写回：刚算出来的这份是最新的，下一轮重扫理应命中它
    const cached = skipCache ? null : (this.cache?.get(id, fp) ?? null)
    if (cached) return composeStatus(path, id, core, cached)
    const { heavy, degraded } = await getRepoHeavy(path, core)
    // 降级结果本轮照常用，但**绝不落盘**。写进去就等于把一次瞬时失败（spawn 失败、杀软锁、
    // 网络盘上 30 秒超时）永久固化：指纹是 `.git` 的 stat 快照，仓库不动它就不变，
    // 此后每一轮都命中这条坏条目，点重扫、重启都不管用（坏条目在磁盘上，还有 30 天年龄护栏）。
    // 详见 RepoHeavyResult 的注释
    if (fp !== null && !degraded) this.cache?.set(id, fp, heavy)
    return composeStatus(path, id, core, heavy)
  }

  private async doRefreshAll(onProgress?: (scanned: number, total: number) => void): Promise<RepoStatus[]> {
    this.freshened.clear() // 上一轮若中途抛错可能有残留，本轮只认本轮的
    const cfg = this.getConfig()
    const paths = [...new Set([...scan(cfg.roots, cfg.excludes), ...cfg.manualRepos])]
    // 先报一次 0/总数：解析 id 这一步在现有用户首次升级时要为每个仓库算一次根提交
    // （见 IdentityLedger.resolve 的播种段），已经限并发到 8，但仍在真正开扫之前。
    // 不先报的话，界面上是一条连总数都没有的空进度条，看起来就是卡死
    onProgress?.(0, paths.length)
    // 路径 → id。账本负责在仓库改名时把新路径认回老 id，从而让 config.json 里
    // 按 id 存的标签/收藏/归档/便签/分组一个字节都不用改
    const idByPath = this.identity
      ? await this.identity.resolve(paths, rootCommit)
      : new Map(paths.map((p) => [p, repoId(p)]))
    let scanned = 0
    const statuses = await mapLimit(paths, CONCURRENCY, async (p) => {
      let status: RepoStatus
      try {
        const fresh = await this.refreshRepo(p, idByPath.get(p) ?? repoId(p), cfg)
        this.baseDesc.set(fresh.id, fresh.description) // 记住本地描述，供 GitHub 描述回退
        status = this.decorate(fresh, cfg)
      } catch (err) {
        status = this.errorStatus(p, cfg, err, idByPath.get(p) ?? repoId(p))
      }
      scanned++
      onProgress?.(scanned, paths.length)
      return status
    })
    // 收尾前用「现在」的配置把所有状态重新装饰一遍：扫描期间用户可能改了收藏/标签/
    // 备注/归档（redecorate 已广播新状态），而上面的 statuses 是用开跑时的 cfg 快照装饰的——
    // 不重新装饰就整份装进去，会把用户刚打的 ⭐ 打回旧值，且要错到下一轮 redecorate 或
    // 兜底重扫（默认 30 分钟）才恢复。decorate 只查配置和缓存、不碰 git，全量重跑很便宜
    const cfgNow = this.getConfig()
    const next = new Map(statuses.map((s) => [s.id, this.decorate(s, cfgNow)]))
    // 全量扫描是逐仓库增量读的：仓库 X 扫完之后、整轮收尾之前，用户可能已经在 X 里
    // commit/push，refreshOne（文件监听触发）拿到的才是新状态。这里若直接用本轮快照
    // 整份覆盖，X 会被打回扫描时的旧状态，且 watcher 正处冷却期、没有补救事件——
    // 看板凭空「回退」，错误状态能停到下一轮兜底重扫。凡是扫描期间被 refreshOne
    // 刷过的仓库，一律以 refreshOne 的结果为准（仓库已被本轮移除的除外）。
    // 注入时同样要过一遍 cfgNow：这批对象是 refreshOne 用它自己那一刻的配置装饰的，
    // 整份灌回去等于在这条路上把上面那道重装饰防护绕开——配置变化并不总伴随 redecorate
    // （PUT /api/config 只落盘 + applyConfig，不碰任何仓库状态），那些仓库的分组/标签
    // 会停在旧值直到下一轮兜底重扫
    for (const [id, s] of this.freshened) if (next.has(id)) next.set(id, this.decorate(s, cfgNow))
    this.freshened.clear()
    this.repos = next
    // 剪掉本轮扫描已不存在的仓库，避免 baseDesc 随仓库增删/根目录变更无界增长
    for (const id of this.baseDesc.keys()) if (!this.repos.has(id)) this.baseDesc.delete(id)
    return this.list()
  }

  async refreshOne(id: string, opts: RefreshOptions = {}): Promise<RepoStatus | undefined> {
    const existing = this.repos.get(id)
    if (!existing) return undefined
    const cfg = this.getConfig()
    let next: RepoStatus
    try {
      const fresh = await this.refreshRepo(existing.path, id, cfg, opts.skipCache ?? false)
      this.baseDesc.set(fresh.id, fresh.description) // 记住本地描述，供 GitHub 描述回退
      // 装饰必须用**现在**的配置，不能用第一个 await 之前读的那份 cfg。这次刷新可能跑的是
      // 完整 7 个 git 进程的全价路径（批量 pull/自定义命令的收尾、定时后台 fetch 每仓库还要先
      // 真联网），一批下来是秒级的窗口，用户完全来得及在这期间打 ⭐/加标签/点「排除」——
      // PATCH meta 已经落盘并广播过新值了。用旧快照装饰出的新状态会覆盖 this.repos 再广播回去：
      // ⭐ 闪一下就没了、刚打的标签消失、刚排除的仓库又回到看板，磁盘上是新值、界面上是旧值，
      // 且要错到下一轮 redecorate 或兜底重扫（默认 30 分钟）才恢复。这还会升级成真丢数据——
      // 前端加标签是拿**当前显示的**数组算全量再 PUT 回去，用户看着标签空了再加一个，
      // config.json 里原来那个就被永久删掉。doRefreshAll 的收尾早为完全相同的危险做过这道
      // 防护（见上面的 cfgNow），refreshOne 也必须有。getConfig 只是一次 readFileSync
      next = this.decorate(fresh, this.getConfig())
    } catch (err) {
      // 必须带上 id：改名后的仓库用的是账本认回的老 id，按路径重算会得出另一个 id，
      // 于是这条状态的 id 与它在 repos 里的键对不上，装饰时也读不到用户的标签/归档。
      // 配置同样取现在的：出错的仓库照样带着用户的 ⭐/标签/归档显示在看板上，
      // 这条路径把它们打回旧值和成功路径一样有害
      next = this.errorStatus(existing.path, this.getConfig(), err, id)
    }
    if (!this.repos.has(id)) return undefined // 全量扫描已移除该仓库，勿复活
    this.repos.set(id, next)
    if (this.inFlight) this.freshened.set(id, next) // 全量扫描进行中：记下来，收尾合并时以这份为准
    return next
  }

  list(): RepoStatus[] {
    return [...this.repos.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): RepoStatus | undefined {
    return this.repos.get(id)
  }

  redecorate(id: string): RepoStatus | undefined {
    const existing = this.repos.get(id)
    if (!existing) return undefined
    const next = this.decorate(existing, this.getConfig())
    this.repos.set(id, next)
    return next
  }

  private decorate(status: RepoStatus, cfg: Config): RepoStatus {
    status.group = cfg.groupOverrides[status.id] ?? deriveGroup(status.path, cfg.roots)
    status.tags = cfg.tags[status.id] ?? []
    status.favorite = cfg.favorites.includes(status.id)
    status.archived = cfg.archived.includes(status.id)
    status.note = cfg.notes[status.id] ?? null
    status.lastOpened = cfg.lastOpened[status.id] ?? null
    // GitHub 描述优先于本地；缓存为空则回退到记住的本地描述（本地描述本身可能就是 null）。
    // 不能用 `?? status.description` 兜底——decorate 会原地改写 status.description，redecorate 复用旧对象时
    // 那就是上一轮已覆盖的 GitHub 描述，导致「GitHub 上清空后本地仍残留旧描述」。故用 baseDesc.has 取本地值。
    // 传当前 origin url，让缓存自行校验 origin 是否还一致（换了远程就别用旧描述）
    const ghUrl = githubRemoteUrl(status.remotes) // 主机名精确匹配 + origin 优先，与后台补全/前端跳转同一挑选逻辑
    status.githubInbox = this.getGithubInbox?.(status.id, ghUrl) ?? null
    const gd = this.getGithubDesc?.(status.id, ghUrl)
    if (status.error === null) {
      const local = this.baseDesc.has(status.id) ? (this.baseDesc.get(status.id) ?? null) : status.description
      status.description = gd ?? local
    }
    status.health = checkHealth(status, cfg)
    return status
  }

  // id 必填，**刻意不给按路径算的默认值**：一个刚改完名又恰好 git 读失败的仓库，按路径重算
  // 会得出另一个 id，于是这条状态的 id 与它在 repos 里的键对不上，装饰时也读不到用户的
  // 标签/归档。两个调用点都已显式传账本认领后的那个 id；留着默认值只会让未来的第三个调用点
  // 静默把这个 bug 重新引进来，而它不报错、只表现为「改过名的仓库一出错就丢标签」
  private errorStatus(path: string, cfg: Config, err: unknown, id: string): RepoStatus {
    return this.decorate(
      {
        id,
        path,
        name: basename(path),
        displayName: null,
        description: null,
        language: null,
        group: "",
        tags: [],
        favorite: false,
        archived: false,
        note: null,
        lastOpened: null,
        mergedBranches: [],
        branch: null,
        dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        ahead: -1,
        behind: -1,
        upstream: null,
        stashCount: 0,
        stashOldest: null,
        release: null,
        remotes: [],
        lastCommit: null,
        health: [],
        githubInbox: null,
        error: err instanceof Error ? err.message : String(err),
        scannedAt: new Date().toISOString(),
      },
      cfg,
    )
  }
}

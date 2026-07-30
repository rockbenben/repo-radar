import { statSync } from "node:fs"
import { join } from "node:path"
import { repoId } from "./git"
import { JsonStore } from "./json-store"
import { mapLimit } from "./map-limit"

/** 播种根提交时的并发上限，与 store 扫描仓库的并发保持一致（都是 spawn git，受同一批
 *  资源约束）。不要放开成无上限：首次升级时一次 spawn 几百个 git 进程会把机器打满 */
const SEED_CONCURRENCY = 8

/**
 * 仓库身份账本。解决的问题：repoId 是路径的 sha1（git.ts:77），因此仓库改个名就等于
 * 换了个仓库——标签、收藏、归档、便签、分组、前端已消掉的队列项全部对不上，且旧条目
 * 永远留在 config.json 里。
 *
 * 做法上有一个关键选择：**不迁移数据，而是让改名后的仓库继续用老 id**。
 * repoId(path) 的算法一个字不改，改的只是「什么时候调用它」——只在首次发现该仓库时铸造。
 * 于是 config.json、前端 localStorage、两个 GitHub 缓存全都不需要动一个字节，
 * 也就不存在迁移写错的可能。现有用户首次升级时账本为空，每个仓库都走铸造路径，
 * 拿到的正是 repoId(当前路径)，与他们 config.json 里已有的 id 完全一致。
 */
export interface IdentityEntry {
  path: string
  /** dev/ino 存字符串而不是 number：Windows 文件 ID 常常超过 2^53，转 double 会静默串号。
   *  这是要落到用户磁盘的 schema，字段类型必须一次定对——详见 statDotGit 的注释 */
  dev: string
  ino: string
  rootCommit: string | null
  seenAt: string // ISO 8601，prune 的年龄护栏用
  /** 本条目最后一次被扫到的「代」：每轮 resolve 给所有活条目盖上「账本里最大代 + 1」。
   *  认领只认「上一代还盖过章、这一代路径没了」的条目。理由：判据②按根提交匹配且**不能
   *  比较 dev**（跨卷移动时 dev 本来就变了），于是同一 upstream 的两个 clone 分处 lost/found
   *  两侧时会互相认领；不加约束这个窗口就是 prune 的 30 天年龄护栏。压到一轮之后，
   *  硬盘拔了两轮以上的仓库回来时退化成丢数据——安全侧（认错身份是产生错误数据，更严重）。
   *  代必须**持久化在条目里**：用内存计数器会让「关掉应用 → 改名 → 重新打开」这个主用例
   *  坏掉，而那正是改名最常发生的时机 */
  gen: number
}

export interface ClaimCandidate {
  dev: string
  ino: string
  rootCommit: string | null
}

const isIdentityEntry = (v: unknown): v is IdentityEntry =>
  typeof v === "object" && v !== null &&
  typeof (v as IdentityEntry).path === "string" &&
  typeof (v as IdentityEntry).dev === "string" &&
  typeof (v as IdentityEntry).ino === "string" &&
  // rootCommit 是认领判据②，必须逐条校验类型：类型错的值（被改坏的账本、老版本字段）
  // 会被当成合法判据参与匹配，而判据一旦失真就是认错身份。缺字段允许（老条目没有它）
  ((v as IdentityEntry).rootCommit === undefined || (v as IdentityEntry).rootCommit === null || typeof (v as IdentityEntry).rootCommit === "string") &&
  typeof (v as IdentityEntry).seenAt === "string"

/** 条目的代。刻意**不**进 isIdentityEntry：代只是认领的护栏，坏值（老条目没这个字段、
 *  被改坏成字符串、JSON 把 NaN 写成了 null）当 0 就是「很老的一代，永远不可认领」——
 *  安全侧。把它升格成丢弃条件则相反：为一个护栏字段丢掉整条身份，用户的标签全没，
 *  正是本模块要消灭的后果 */
const genOf = (e: IdentityEntry): number => (Number.isInteger(e.gen) ? e.gen : 0)

/**
 * 「这条账本条目属于**上一轮**」——认领与搬家判定共用的同轮次窗口。
 *
 * `currentGen > 1` 不是多余的：坏值当 0 的安全性论证在「**所有**条目的 gen 都非法」时恰好
 * 反转。那时 maxGen = 0 ⇒ currentGen = 1 ⇒ genOf(e) === 0 === currentGen - 1，于是每一条
 * 陈旧条目都在同一轮里变成可认领，把这个窗口本来要关掉的跨 clone 认错身份的口子重新打开。
 * 而「所有 gen 都非法」不是假想：从加 gen 之前的版本升上来的账本正好长这样。
 */
const isPrevGen = (e: IdentityEntry, currentGen: number): boolean => currentGen > 1 && genOf(e) === currentGen - 1

/**
 * 路径键的归一化。**口径必须与本机文件系统的大小写语义一致**，win32 与 darwin（APFS/HFS+
 * 默认大小写不敏感）都折大小写，Linux 保持敏感。
 *
 * 折少了会怎样：macOS 上 `scan()` 给出 `/Users/me/code/tool`、`manualRepos` 里写的是
 * `/Users/me/Code/tool`（同一个目录），`new Set` 按精确字符串去重所以两条都活着，
 * 归一化不折大小写就把它们当成两个仓库；而铸造用的 `repoId` 是**无条件小写**的
 * （git.ts:78），两边算出同一个 id，第二条撞上铸造的碰撞守卫拿到合成 id
 * `repoId("…#2")`——同一个仓库两张卡片，第二张的 id 在用户 config.json 里根本不存在，
 * 标签/收藏/归档/便签全不显示，账本里还留一条永久的假记录。
 *
 * 折多了同样是错：Linux 上 `/home/Repo` 与 `/home/repo` 是两个真实不同的目录，折到一起
 * 会让它们在账本里互相顶替。（`repoId` 无条件小写因此在 Linux 上本就会把这两个目录撞成
 * 同一个 id，由铸造的碰撞守卫兜住——那是**另一个**已知遗留项。绝不能为了对齐而去改
 * `repoId`：它的算法是「账本为空时 id === repoId(当前路径)」这条零迁移地基。）
 */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, "/")
  const caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin"
  return caseInsensitiveFs ? slashed.toLowerCase() : slashed
}

/**
 * 判据①的键：dev + ino。
 * ino 为 "0" = 文件系统不提供稳定 id（FAT32 / exFAT / 部分网络共享），拿它参与匹配会让
 * 所有仓库互相「相等」，把身份认串——必须整体作废该判据。空串、非字符串同理：
 * 用一个哨兵值让两个无关仓库「相等」，是本模块最危险的一类输入。
 */
const inoKey = (c: ClaimCandidate): string | null => {
  if (typeof c.dev !== "string" || typeof c.ino !== "string") return null
  if (c.dev === "" || c.ino === "" || c.ino === "0") return null
  return `${c.dev}:${c.ino}`
}

/**
 * 判据②的键：根提交 hash。空串是 ino==="0" 的同类陷阱——rootCommitOf 在空仓库 / git
 * 读失败时很容易返回 ""，被改坏或老版本写的账本条目里也可能是 ""。
 */
const rootKey = (c: ClaimCandidate): string | null =>
  typeof c.rootCommit === "string" && c.rootCommit !== "" ? c.rootCommit : null

/** 只出现一次的判据值才可用于认领。出现多次说明无法区分，宁可不认 */
function uniqueByKey<V>(items: Iterable<[string, V]>, keyOf: (v: V) => string | null): Map<string, string> {
  const seen = new Map<string, string | null>() // 判据值 → 唯一持有者；null = 已重复，作废
  for (const [owner, v] of items) {
    const k = keyOf(v)
    if (k === null) continue
    seen.set(k, seen.has(k) ? null : owner)
  }
  const out = new Map<string, string>()
  for (const [k, owner] of seen) if (owner !== null) out.set(k, owner)
  return out
}

/**
 * 认领：把「消失的 id」与「新出现的路径」配对。返回 `新路径 → 被认领的老 id`。
 *
 * 两轮判据，都要求**一一对应**：
 *  ① dev + ino——同卷改名/移动必中，零成本（stat 本来就要做）
 *  ② 根提交 hash——跨卷移动、从备份恢复、以及 ino 不可用的文件系统
 *
 * 认错身份产生的是**错误数据**（A 的标签跑到 B 头上），比不认（退回改造前的丢数据行为）
 * 严重得多，所以每一步都取保守侧：判据值重复即全部放弃，已被①配对的两边都退出②。
 *
 * **判据②的已知限制**：一一对应**挡不住**同一 upstream 的多个 clone。它只在两个 clone
 * 落在匹配的同一侧时才起作用；若 clone C1 在线（是已知路径，根本不进候选池）、C2 在拔掉的
 * 移动硬盘上（→ lost）、用户又新 clone 出 C3（→ found），两侧就各自唯一，而判据②**不比较
 * dev**，于是 C3 认领 C2 的 id。这个窗口由调用方（resolve 的同轮次约束，见 IdentityEntry.gen）
 * 从 30 天压到一轮：C2 要在「刚消失的那一轮」恰好撞上 C3 出现才会认错。
 */
export function matchClaims(
  lost: Map<string, ClaimCandidate>,
  found: Map<string, ClaimCandidate>,
): Map<string, string> {
  const claims = new Map<string, string>()
  if (lost.size === 0 || found.size === 0) return claims

  const remainingLost = new Map(lost)
  const remainingFound = new Map(found)

  const round = (keyOf: (c: ClaimCandidate) => string | null): void => {
    const lostByKey = uniqueByKey(remainingLost, keyOf)
    const foundByKey = uniqueByKey(remainingFound, keyOf)
    for (const [k, lostId] of lostByKey) {
      const foundPath = foundByKey.get(k)
      if (foundPath === undefined) continue
      claims.set(foundPath, lostId)
      // 轮间扣除：①配对成功的两边都退出，否则②会拿另一个 lost 覆盖掉①的正确结论
      remainingLost.delete(lostId)
      remainingFound.delete(foundPath)
    }
  }

  round(inoKey)
  round(rootKey)
  return claims
}

export class IdentityLedger {
  private store: JsonStore<IdentityEntry>
  private byPath = new Map<string, string>() // 归一化路径 → id

  constructor(file: string, onCorrupt?: (err: unknown) => void, onWriteError?: (err: unknown) => void) {
    this.store = new JsonStore({ file, isValid: isIdentityEntry, debounceMs: 1000, onCorrupt, onWriteError })
    this.reindex()
  }

  private reindex(): void {
    this.byPath.clear()
    for (const [id, e] of this.store.entries()) this.byPath.set(normalizePath(e.path), id)
  }

  /** 默认的 stat 实现：`.git` 的 dev+ino。测试可注入替身 */
  private static statDotGit(path: string): { dev: string; ino: string } | null {
    try {
      // bigint:true + 存字符串，而不是 Number(s.ino)：Windows 文件 ID 是
      // (sequence << 48) | mftRecord，本机实测 29 个 .git 里 14 个超过 2^53、7 个转 double
      // 后已与精确值不符。1e17 量级 double 的 ULP 是 16，于是 sequence 相同、MFT 记录相差
      // 8 以内的两个 .git（背靠背 clone 出来的仓库很常见）会舍入成同一个数，凑出一个
      // 「干净的一一对应」错误认领——最难查的那种错误数据。字符串比较无损。
      const s = statSync(join(path, ".git"), { bigint: true })
      return { dev: String(s.dev), ino: String(s.ino) }
    } catch {
      return null
    }
  }

  /**
   * 默认的存在性实现：账本里记的这条路径现在还在磁盘上吗。测试可注入替身。
   *
   * 刻意**不用** `existsSync`，也**不用** statDotGit 的成败来代替：只有 ENOENT 才算
   * 「不在了」，EACCES / EPERM / EBUSY（杀软锁住、网络盘鉴权失败、目录被独占）一律当
   * 「还在」。判反的代价是不对称的——把一个还在磁盘上的仓库判成「没了」，它的账本条目
   * 就进了认领候选池，同一轮里任何一个新 clone 都可能按根提交把它的 id（连同标签、收藏、
   * **归档**）整个认走，属于产生错误数据；判成「还在」最多是这一轮不认领，退回丢数据。
   * `throwIfNoEntry: false` 正好把这两类分开：ENOENT 返回 undefined，其它错误照样抛。
   */
  private static pathExists(path: string): boolean {
    try {
      return statSync(path, { throwIfNoEntry: false }) !== undefined
    } catch {
      return true // 非 ENOENT：无从判断，按「还在」处理（保守侧 = 不可认领）
    }
  }

  /**
   * 把本轮扫描到的路径解析成 id。返回的 Map 对 `paths` 里的**每一个**路径都有条目
   * （含被去重折掉的其它拼写），调用方可以直接 `get(p)!`。
   *
   * git 进程的代价：每个**新发现**的仓库一生一次（铸造时播种根提交，见下面的铸造段），
   * 已知路径零进程。判据②的认领轮次复用这一次计算，不额外加价。
   */
  async resolve(
    paths: string[],
    rootCommitOf: (path: string) => Promise<string | null>,
    statOf: (path: string) => { dev: string; ino: string } | null = IdentityLedger.statDotGit,
    existsOf: (path: string) => boolean = IdentityLedger.pathExists,
  ): Promise<Map<string, string>> {
    // 先按归一化路径去重。同一仓库以两种拼写（大小写/分隔符）出现在同一轮时，两条会算出
    // 同一个 repoId，后一条被下面的撞车守卫改成合成 id，又在 reindex 时**赢下**那个共享的
    // 归一化键——用户 config.json 里那个真 id 就成了孤儿，标签全丢。去重同时把这条隐含
    // 前置条件从公开契约里消掉（调用方不必保证 paths 已去重）。
    //
    // 这个集合叫 seenKeys 而不是 livePaths：它回答的是「本轮列表里出现过吗」，**不是**
    // 「这个仓库还活着吗」。曾经拿它当过后者的答案，代价是两个身份 bug——判据见下面
    // stillOnDisk 的注释。别再把它接回「live」的判定里
    const seenKeys = new Set<string>()
    const uniquePaths: string[] = []
    const repOfKey = new Map<string, string>() // 归一化键 → 代表路径，收尾补全映射时用
    for (const p of paths) {
      const key = normalizePath(p)
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      repOfKey.set(key, p)
      uniquePaths.push(p)
    }

    // 快照一份：下面的回写会改 store，而代与 lost 候选都必须按本轮开始时的账本算
    const before = this.store.entries()
    // 当前代 = 账本里最大代 + 1；账本为空时为 1
    let maxGen = 0
    for (const [, e] of before) maxGen = Math.max(maxGen, genOf(e))
    const currentGen = maxGen + 1

    // 每条活路径只 stat 一次，判据①、搬家判定、回写共用这一份——比原先「认领时 stat 一遍、
    // 回写时再 stat 一遍」还少一次 syscall
    const stats = new Map<string, { dev: string; ino: string } | null>()
    for (const p of uniquePaths) stats.set(p, statOf(p))
    /** 某条活路径**当前**的判据①键；stat 失败或 ino 不可用（"0"）时为 null */
    const liveKey = (p: string): string | null => {
      const s = stats.get(p) ?? null
      return s === null ? null : inoKey({ dev: s.dev, ino: s.ino, rootCommit: null })
    }

    const out = new Map<string, string>()
    let unknown: string[] = []
    const pathHit: [string, string][] = []
    for (const p of uniquePaths) {
      const known = this.byPath.get(normalizePath(p))
      if (known === undefined) unknown.push(p)
      else pathHit.push([p, known])
    }

    // 路径命中（上面这一步）有且只有一个例外：账本里记的 (dev,ino) 与现在对不上，**并且**
    // 本轮恰好有一个未知路径正带着那个老 (dev,ino)——那说明仓库搬到那个未知路径去了，
    // 这条路径上现在坐着的是别人。不认这个信号的话，「A 改名成 B + 同一轮里原路径 A 上又
    // 出现一个无关仓库」会让新仓库连人带标签继承 A 的身份（byPath 在任何候选逻辑之前就
    // 命中，那条账本条目的 path 还是 live 的，根本进不了 lostIds，认领机器压根没被调用），
    // 而真正的 B 铸新 id 什么都不剩，全程无报错——是「产生错误数据」，比丢数据严重。
    //
    // 「删掉重新 clone 回原路径」不会命中这个例外：那时 ino 同样变了，但**没有任何未知路径
    // 带着老 ino**，路径命中照样赢（Task 5 定的行为，不能回归）。
    const unknownByKey = uniqueByKey(unknown.map((p) => [p, p] as [string, string]), liveKey)
    // 老键在已知这一侧也必须唯一：两条已知路径记着同一个 (dev,ino) 就分不清是谁搬走了，宁可不动
    const hitByOldKey = uniqueByKey(pathHit.map(([p, id]) => [p, this.store.get(id)!] as [string, IdentityEntry]), inoKey)
    const movedAway: string[] = []
    for (const [p, id] of pathHit) {
      const e = this.store.get(id)!
      const oldKey = inoKey(e) // null = 账本里那条的 ino 不可用（"0"/空），判据①对它整体作废
      const target = oldKey === null ? undefined : unknownByKey.get(oldKey)
      const moved =
        oldKey !== null &&
        target !== undefined && // 本轮恰好有一个未知路径带着这个老 (dev,ino)
        hitByOldKey.get(oldKey) === p &&
        liveKey(p) !== null && // 现在 stat 不出来 / ino 不可用：无从判断，别动
        liveKey(p) !== oldKey && // 记的与现在对不上
        // 与认领同一个窗口：ino 会被文件系统回收，隔了轮次的「相等」不可信（见 IdentityEntry.gen）
        isPrevGen(e, currentGen)
      if (moved) {
        out.set(target!, id) // 身份跟着 (dev,ino) 走
        movedAway.push(p)
      } else {
        out.set(p, id) // 路径命中，照旧
      }
    }
    if (movedAway.length > 0) {
      // 搬家的目标路径身份已定，别再进认领池；反过来，被腾出来的那条路径按未知处理——
      // 它可能是从别处搬来的（会被对应的 lost 认领），否则铸一个全新 id
      unknown = unknown.filter((p) => !out.has(p)).concat(movedAway)
    }

    /**
     * 「账本里记的这条路径，现在磁盘上还在吗」——「live 还是 lost」的唯一判据。
     *
     * 关键是**不能**拿「本轮扫描列表里有没有这条路径」当答案，两个方向都会错：
     *  · 在列表里 ≠ 还在磁盘上。`store.ts` 无条件把 `cfg.manualRepos` 并进 paths（有意为之：
     *    失效的手动仓库必须留一张「路径已失效」的卡片，不能静默消失）。拿列表当答案，
     *    这条记录就永远算 live、永远进不了候选池——用户把 `D:\side\myapp` 移进扫描根，
     *    dev+ino 明明完全匹配，却因为候选池里根本没有它而铸出一个全新的无标签 id。
     *  · 不在列表里 ≠ 已经没了。`scanner.ts` 按**目录名**过滤，用户往 `excludes` 里加一个
     *    名字，那个仓库就从 paths 里消失了、磁盘上还在；一次 `readdirSync` 的 EACCES 同理。
     *    拿列表当答案，这条记录当场变成可认领，同一轮里新 clone 一个同 upstream 的仓库，
     *    判据②（根提交，**不比较 dev**）就会把它的 id 连同标签/收藏/**归档**整个认走。
     */
    const stillOnDisk = (p: string): boolean => {
      // 本轮 statOf 成功的路径必然还在（打的就是它下面的 .git），省掉一次 syscall。
      // 只有这一条捷径成立——它证明的是磁盘状态，不是配置内容
      const rep = repOfKey.get(normalizePath(p))
      if (rep !== undefined && (stats.get(rep) ?? null) !== null) return true
      return existsOf(p)
    }

    // 可认领的 lost：上一代还被盖过章、这一代路径在磁盘上没了 —— 不是「30 天内消失过的都算」。
    // 为什么必须收到一轮，见 IdentityEntry.gen
    const lostIds: string[] = []
    for (const [id, e] of before) {
      if (isPrevGen(e, currentGen) && !stillOnDisk(e.path)) lostIds.push(id)
    }

    const computedRoot = new Map<string, string | null>() // 本轮为认领算出的根提交，回写账本时复用

    if (unknown.length > 0 && lostIds.length > 0) {
      // 先只用 dev+ino 认一轮；能全认完就完全不必算根提交
      const lostCands = new Map<string, ClaimCandidate>()
      for (const id of lostIds) {
        const e = this.store.get(id)!
        lostCands.set(id, { dev: e.dev, ino: e.ino, rootCommit: null })
      }
      const foundCands = new Map<string, ClaimCandidate>()
      for (const p of unknown) {
        const s = stats.get(p) ?? null
        foundCands.set(p, { dev: s?.dev ?? "0", ino: s?.ino ?? "0", rootCommit: null })
      }
      let claims = matchClaims(lostCands, foundCands)

      // 还有认不下的，才付根提交的代价（每边各一个 git 进程）
      if (claims.size < Math.min(unknown.length, lostIds.length)) {
        for (const [id, c] of lostCands) c.rootCommit = this.store.get(id)?.rootCommit ?? null
        // lost 一侧一个可用根提交都没有时，found 一侧再怎么算也**必然**配不上——那一批
        // git 进程是确定无收益的（铸造播种之后这种账本只剩「判据②开工前写下的老条目」）
        if ([...lostCands.values()].some((c) => rootKey(c) !== null)) {
          for (const p of unknown) {
            if (claims.has(p)) continue
            const rc = await rootCommitOf(p)
            computedRoot.set(p, rc) // 算都算了就存下来，零额外 git 进程
            foundCands.get(p)!.rootCommit = rc
          }
          claims = matchClaims(lostCands, foundCands)
        }
      }

      // 认领可能抢走一条**路径命中**的记录：那条路径在 paths 里、byPath 也认得它，但它
      // 在磁盘上已经不存在了（失效的 manualRepo 就是这个形状）。同一个 id 决不能同时挂在
      // 两条路径上——回写账本时两条会互相覆盖，`doRefreshAll` 收尾的 `new Map(按 id 建)`
      // 还会让其中一个仓库从看板上凭空消失。让认领赢：它对应的是磁盘上真实存在的那个仓库，
      // 用户的标签理应跟着仓库走；被抢走的死路径退回未知，去下面铸一个全新 id——它本来
      // 就只是一张「路径已失效」的错误卡片，不该再顶着别人的身份
      const claimedIds = new Set(claims.values())
      for (const [p, id] of [...out]) {
        if (!claimedIds.has(id)) continue
        out.delete(p)
        unknown.push(p) // 已经过了认领轮次，只会走到铸造——不存在的路径绝不能反过来去认领谁
      }

      for (const [p, id] of claims) out.set(p, id)
    }

    // 认领不到的新路径：按路径铸造。这条路径也正是现有用户首次升级时全体走的路径。
    // 铸造时必须同时避开**本轮已分配**和**账本里已存在**的 id：仓库 A 改名成 B 后 B 用着
    // repoId(A)，用户此时又在原路径 A 新建一个无关仓库——无论 B 是否还在本轮扫描范围内
    // （被删了、移动硬盘拔了、没扫到），repoId(A) 都是别人的 id，铸给 A 就是让 A 继承
    // B 的标签/归档，属于「产生错误数据」。
    // 跳过账本里已存在的 id 可证明安全：p 是未知路径，若 store 里存在 repoId(p) 这一条，
    // 它的 path 归一化后必然 ≠ normalizePath(p)（否则 byPath 早就命中、根本走不到这里）。
    // 而账本为空时一条都不会跳过，「铸造结果 === repoId(path)」这条地基纹丝不动
    const used = new Set(out.values())
    const minted: string[] = []
    for (const p of unknown) {
      if (out.has(p)) continue
      let id = repoId(p)
      for (let n = 2; used.has(id) || this.store.get(id) !== undefined; n++) id = repoId(`${p}#${n}`)
      used.add(id)
      out.set(p, id)
      if (!computedRoot.has(p)) minted.push(p)
    }

    // 判据②的播种，只能在铸造这一刻做：认领发生时旧路径已经不存在了，那时**算不出**它的
    // 根提交。不播种的话 lost 一侧的 rootCommit 恒为 null，上面那道闸恒假，判据②就是
    // 一段永远跑不到的死代码，跨卷移动/从备份恢复/ino 不可用的文件系统全部认不回来。
    // 认领轮次已经算过的不重复付钱（minted 只收 computedRoot 里没有的）。
    //
    // 必须限并发而不是逐个 await：现有用户首次升级时**所有**仓库都是新铸造的，而
    // `git rev-list --max-parents=0 HEAD` 是 O(历史长度)（runGit 的上限是 30 秒），
    // 串行起来就是几百上千毫秒 × 仓库数的一段死等——而且它发生在 store 开始报扫描进度
    // 之前，界面上是一条一动不动的进度条。上限取 8，与 store 扫描仓库的并发一致
    await mapLimit(minted, SEED_CONCURRENCY, async (p) => {
      computedRoot.set(p, await rootCommitOf(p))
    })

    // 回写账本：路径、判据、seenAt、代一律刷新
    for (const [p, id] of out) {
      const s = stats.get(p) ?? null
      const prev = this.store.get(id)
      this.store.set(id, {
        path: p,
        // stat 瞬时失败（杀软锁住 .git、硬盘刚休眠）时保留上一轮的值，不要清成 "0"——
        // 清零会废掉判据①，而它是目前唯一零成本的判据
        dev: s?.dev ?? prev?.dev ?? "0",
        ino: s?.ino ?? prev?.ino ?? "0",
        rootCommit: computedRoot.get(p) ?? prev?.rootCommit ?? null,
        seenAt: new Date().toISOString(),
        // 只有本轮**真的扫到**的才盖章；没扫到的条目留在上一代，下一轮就出了认领窗口。
        // 「路径在 paths 里」不等于「扫到了」：磁盘上已经不存在的条目（失效的 manualRepo）
        // 一样不盖章。盖了会怎样：这条记录永远满足「上一代盖过章 + 路径不在磁盘上」，
        // 于是**永久**留在认领候选池里——半年后用户新 clone 一个同 upstream 的仓库，
        // 判据②当场把它的标签/收藏/归档认走；ino 被文件系统回收后判据①也会误中。
        // 同轮次窗口本来就是为了把这个口子压到一轮，这里破例等于没加过它
        gen: s !== null || stillOnDisk(p) ? currentGen : (prev?.gen ?? 0),
      })
    }
    this.reindex()

    // 补全映射：去重折掉的其它拼写（D:\p\a vs D:/p/a、不同大小写）也要能取到 id。
    // 少了它，调用方一句 ids.get(p)! 就是 undefined，整条仓库数据被存到 "undefined" 键下。
    // 放在回写之后：账本里每个 id 只该留代表路径那一条，别让别名把 path 覆来覆去
    for (const p of paths) {
      if (out.has(p)) continue
      const rep = repOfKey.get(normalizePath(p))
      const id = rep === undefined ? undefined : out.get(rep)
      if (id !== undefined) out.set(p, id)
    }
    return out
  }

  /**
   * 补算判据②：铸造那一刻算不出根提交（rootCommit 为 null）的条目，等仓库**长出第一个提交**
   * 之后补一次。调用方必须先确认「这个仓库现在真的有提交」，见下面的成本段。
   *
   * 为什么非补不可：`POST /api/new-project` 创建完仓库**立刻**触发重扫（routes.ts 里
   * createProject 之后那句 rescanFresh），而 createProject 只做 `git init` + 写 README、
   * 不提交——那一刻仓库必然零提交，播种只能写下 null。此后这条路径每轮都走「路径命中」，
   * 根本不进 `computedRoot`，回写又是 `computedRoot.get(p) ?? prev?.rootCommit ?? null`，
   * 于是**经产品自己那个「+ 新建」按钮创建的每一个项目**，账本里的根提交终身为 null
   *（用户自己在扫描根里 `git init` 同理：watcher 2 秒内就触发结构重扫）。
   * 「dev+ino 本来就够用」这条辩护在 `ino === "0"` 的文件系统上不成立——inoKey 对它**整体
   * 作废判据①**，exFAT / FAT32 / 部分 SMB 共享上的这类仓库两条判据都没有，一次普通改名
   *（账本的旗舰用例）就丢标签/收藏/归档/便签。
   *
   * 成本刻意压成「每个仓库一辈子最多一次额外的 git 进程」，两道闸各挡一半：
   *  · 空仓库一次都不付——调用方拿 `core.oid`（`git status --porcelain=v2 --branch` 顺带
   *    给的，不额外 spawn）判断有没有提交，没有就根本不调这里；
   *  · 算不出唯一根提交时写**空串**而不是留 null。空串在 rootKey 里与 null 同样作废，
   *    但它是「已经算过」的记号：留 null 的话，多根提交的仓库（`merge --allow-unrelated-
   *    histories` 之后就是）会在**每一次** refreshOne（文件监听触发，最快每分钟一次）重跑
   *    `git rev-list --max-parents=0 HEAD`，而那是 O(历史长度) 的命令。代价是一次瞬时失败
   *    会让这个仓库的判据②永久不可用——那恰好是修改前的现状，不比现状更差
   */
  async backfillRootCommit(id: string, path: string, rootCommitOf: (path: string) => Promise<string | null>): Promise<void> {
    const entry = this.store.get(id)
    // `?? null` 把老版本写的「缺字段」条目一并算进来：它们的判据②同样是空的，同样该补
    if (entry === undefined || (entry.rootCommit ?? null) !== null) return
    const rc = await rootCommitOf(path)
    // 重读一遍再写：这次 await 期间可能刚跑完一轮 resolve，把这条改写了（认领、搬家、代刷新）。
    // 拿 await 之前那份 entry 整个覆盖回去，会把那一轮的结论连同 path/dev/ino/gen 一起打回旧值
    const now = this.store.get(id)
    if (now === undefined || (now.rootCommit ?? null) !== null) return
    this.store.set(id, { ...now, rootCommit: rc ?? "" })
  }

  /** 某个 id 的账本条目（只读查看：上次见到的路径、判据值、代） */
  get(id: string): IdentityEntry | undefined {
    return this.store.get(id)
  }

  /** 年龄护栏及其理由在 JsonStore.pruneStale 里。对账本而言它尤其要命：条目一剪，
   *  那批仓库回来时会被当成全新仓库，标签/收藏/归档全丢——正是本轮要消灭的行为 */
  prune(keepIds: Set<string>, maxAgeMs = 30 * 86_400_000): void {
    this.store.pruneStale(keepIds, (e) => e.seenAt, maxAgeMs)
    this.reindex()
  }

  flush(): void {
    this.store.flush()
  }
}

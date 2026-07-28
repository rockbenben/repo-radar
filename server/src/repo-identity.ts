import { statSync } from "node:fs"
import { join } from "node:path"
import { repoId } from "./git"
import { JsonStore } from "./json-store"

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
  dev: number
  ino: number
  rootCommit: string | null
  seenAt: string // ISO 8601，prune 的年龄护栏用
}

export interface ClaimCandidate {
  dev: number
  ino: number
  rootCommit: string | null
}

const isIdentityEntry = (v: unknown): v is IdentityEntry =>
  typeof v === "object" && v !== null &&
  typeof (v as IdentityEntry).path === "string" &&
  typeof (v as IdentityEntry).dev === "number" &&
  typeof (v as IdentityEntry).ino === "number" &&
  // rootCommit 是认领判据②，必须逐条校验类型：类型错的值（被改坏的账本、老版本字段）
  // 会被当成合法判据参与匹配，而判据一旦失真就是认错身份。缺字段允许（老条目没有它）
  ((v as IdentityEntry).rootCommit === undefined || (v as IdentityEntry).rootCommit === null || typeof (v as IdentityEntry).rootCommit === "string") &&
  typeof (v as IdentityEntry).seenAt === "string"

/** 路径键的归一化。Windows 路径大小写不敏感，且同一目录可能以不同大小写出现，
 *  不归一化会让「D:\Repo」和「d:\repo」在账本里变成两个仓库 */
export function normalizePath(p: string): string {
  const slashed = p.replace(/\\/g, "/")
  return process.platform === "win32" ? slashed.toLowerCase() : slashed
}

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
 * 一一对应这条约束同时挡掉了「同一仓库的多个 clone 根提交相同」的撞车风险。
 * 认错身份产生的是**错误数据**（A 的标签跑到 B 头上），比不认（退回改造前的丢数据行为）
 * 严重得多，所以每一步都取保守侧。
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
      remainingLost.delete(lostId)
      remainingFound.delete(foundPath)
    }
  }

  // ino 为 0 = 文件系统不提供稳定 id（FAT32 / exFAT / 部分网络共享）。
  // 拿 0 参与匹配会让所有仓库互相「相等」，把身份认串——必须整体作废该判据
  round((c) => (c.ino === 0 ? null : `${c.dev}:${c.ino}`))
  // 空串是 ino===0 的同类陷阱：rootCommitOf 在空仓库 / git 读失败时很容易返回 ""，
  // 被改坏或老版本写的账本条目里也可能是 ""。一个哨兵值让两个无关仓库「相等」，
  // 同样必须作废。typeof 兜住的是账本里混进来的非字符串值
  round((c) => (typeof c.rootCommit === "string" && c.rootCommit !== "" ? c.rootCommit : null))
  return claims
}

export class IdentityLedger {
  private store: JsonStore<IdentityEntry>
  private byPath = new Map<string, string>() // 归一化路径 → id

  constructor(file: string) {
    this.store = new JsonStore({ file, isValid: isIdentityEntry, debounceMs: 1000 })
    this.reindex()
  }

  private reindex(): void {
    this.byPath.clear()
    for (const [id, e] of this.store.entries()) this.byPath.set(normalizePath(e.path), id)
  }

  /** 默认的 stat 实现：`.git` 的 dev+ino。测试可注入替身 */
  private static statDotGit(path: string): { dev: number; ino: number } | null {
    try {
      const s = statSync(join(path, ".git"))
      return { dev: Number(s.dev), ino: Number(s.ino) }
    } catch {
      return null
    }
  }

  /**
   * 把本轮扫描到的路径解析成 id。
   *
   * rootCommitOf 只会在**确实有仓库消失**时被调用（先按 dev+ino 认一遍，还有剩才算），
   * 所以日常这里是零 git 进程。
   */
  async resolve(
    paths: string[],
    rootCommitOf: (path: string) => Promise<string | null>,
    statOf: (path: string) => { dev: number; ino: number } | null = IdentityLedger.statDotGit,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const unknown: string[] = []
    const livePaths = new Set(paths.map(normalizePath))

    for (const p of paths) {
      const known = this.byPath.get(normalizePath(p))
      if (known !== undefined) out.set(p, known)
      else unknown.push(p)
    }

    // 账本里记着、但本轮扫描已经不在的 id —— 认领的候选来源
    const lostIds: string[] = []
    for (const [id, e] of this.store.entries()) {
      if (!livePaths.has(normalizePath(e.path))) lostIds.push(id)
    }

    if (unknown.length > 0 && lostIds.length > 0) {
      const foundStats = new Map<string, { dev: number; ino: number } | null>()
      for (const p of unknown) foundStats.set(p, statOf(p))

      // 先只用 dev+ino 认一轮；能全认完就完全不必算根提交
      const lostCands = new Map<string, ClaimCandidate>()
      for (const id of lostIds) {
        const e = this.store.get(id)!
        lostCands.set(id, { dev: e.dev, ino: e.ino, rootCommit: null })
      }
      const foundCands = new Map<string, ClaimCandidate>()
      for (const p of unknown) {
        const s = foundStats.get(p) ?? null
        foundCands.set(p, { dev: s?.dev ?? 0, ino: s?.ino ?? 0, rootCommit: null })
      }
      let claims = matchClaims(lostCands, foundCands)

      // 还有认不下的，才付根提交的代价（每边各一个 git 进程）
      if (claims.size < Math.min(unknown.length, lostIds.length)) {
        for (const [id, c] of lostCands) c.rootCommit = this.store.get(id)?.rootCommit ?? null
        for (const p of unknown) {
          if (claims.has(p)) continue
          foundCands.get(p)!.rootCommit = await rootCommitOf(p)
        }
        claims = matchClaims(lostCands, foundCands)
      }

      for (const [p, id] of claims) out.set(p, id)
    }

    // 认领不到的新路径：按路径铸造。这条路径也正是现有用户首次升级时全体走的路径。
    // 铸造时要避开本轮已被其它路径占用的 id：仓库 A 改名成 B 后 B 继续用着 repoId(A)，
    // 用户此时又在原路径 A 新建一个无关仓库，repoId(A) 就与 B 正在用的 id 相撞——
    // 两条活路径共用一个 id 会让 A 直接继承 B 的标签/归档，属于「产生错误数据」。
    // 账本为空时 out 也是空的，撞不上，铸造结果仍然精确等于 repoId(path)
    const used = new Set(out.values())
    for (const p of unknown) {
      if (out.has(p)) continue
      let id = repoId(p)
      for (let n = 2; used.has(id); n++) id = repoId(`${p}#${n}`)
      used.add(id)
      out.set(p, id)
    }

    // 回写账本：路径、判据、seenAt 一律刷新
    for (const [p, id] of out) {
      const s = statOf(p)
      const prev = this.store.get(id)
      this.store.set(id, {
        path: p,
        dev: s?.dev ?? 0,
        ino: s?.ino ?? 0,
        rootCommit: prev?.rootCommit ?? null,
        seenAt: new Date().toISOString(),
      })
    }
    this.reindex()
    return out
  }

  /** 记下某个仓库的根提交（算过一次就存着，之后不必重算） */
  setRootCommit(id: string, rootCommit: string | null): void {
    const e = this.store.get(id)
    if (e) this.store.set(id, { ...e, rootCommit })
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

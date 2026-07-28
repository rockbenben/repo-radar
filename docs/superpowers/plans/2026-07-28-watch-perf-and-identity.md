# 监听与重扫重构 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把文件监听从「每仓库数十个目录句柄、每 30 分钟拆建一次」改成「每个 scan root 一个递归句柄、只在 roots 变化时重建」，把全量重扫从「无差别 467 个 git 进程」改成「按 `.git` 指纹跳过没动过的仓库」，并让仓库 id 与文件系统路径解耦，使改名后用户数据不再丢失。

**Architecture:** 四个杠杆按依赖顺序落地。先抽出四个落盘 Map 的共用底座，再做「指纹」这条链（`branch.oid` 解析 → 指纹计算 → `getRepoStatus` 拆分 → 缓存接入），再做「身份」这条链（账本 + 认领算法 → store 接入），最后重写 watcher 并解耦 automation/backend。每个任务独立可测、可提交、可单独回退。

**Tech Stack:** Node ≥ 20（ESM）、TypeScript strict、vitest、Hono、chokidar 5（仅保留给 Linux 策略）、`node:fs.watch` 递归（win32/darwin）。所有 git 调用经 `runGit`（`spawn`，零原生依赖）。

**规格：** `docs/superpowers/specs/2026-07-28-watch-perf-design.md`

## Global Constraints

- 目标平台 win32 / darwin / linux 三者都必须能跑；平台相关行为一律通过可注入的策略实现，禁止用 `process.platform` 直接分叉到不可测的代码里。
- 不新增任何运行时依赖。`chokidar ^5.0.0` 保留，仅 `PerRepoStrategy` 使用。
- 服务端全部 ESM（`server/package.json` 的 `"type": "module"`），import 路径不带扩展名，沿用现有写法。
- 注释用中文，写「为什么」而不是「是什么」——与现有 `watcher.ts` / `store.ts` / `config.ts` 的风格一致。凡是修 bug 换来的约束，必须把「不这么写会怎样」写进注释。
- 测试命令：`npm test -w server`（vitest）。单文件：`npm test -w server -- tests/<file>`——注意 `-w` 只对 npm 有效，写成 `npx vitest run tests/<file> -w server` 会被 vitest 当成 `--watch` 而**永远挂住**。类型检查：`npm run typecheck -w server`。
- 现有 `~/.repo-radar/config.json` 必须零破坏、零迁移。任何任务都不得改变 `repoId(path)` 的算法（`sha1(路径转正斜杠转小写).slice(0,12)`）。
- commit message 只写变更内容本身，**不得带任何 AI 署名行**（`Co-Authored-By`、`Generated with` 等一律禁止）。
- 落盘缓存/账本的 `prune` 一律带**年龄护栏**（默认 30 天），沿用 `desc-cache.ts:73` 的既有理由：网络盘根目录瞬时掉线会让一整批仓库在某轮扫描里消失，立即剪会把它们的落盘数据永久抹掉。
- **测试里绝不要拿 `dirname(makeRepo())` 当 scan root。** `makeRepo` 建在 `tmpdir()` 下，它的 `dirname` 就是 `tmpdir()` 本身；拿它当 root，整套测试并行跑时会把其它测试的临时仓库全部扫进来，既慢又互相干扰。要么用 `manualRepos: [repo]`，要么用 `mkdtempSync` 建一个专属父目录再在里面 `git init`。

---

## 文件结构

| 文件 | 职责 | 状态 |
| --- | --- | --- |
| `server/src/json-store.ts` | 落盘 `Map<string, T>` 的共用底座：load / get / set / delete / 防抖落盘 / flush / 坏文件容错 | 新建 |
| `server/src/fingerprint.ts` | `.git` 指纹计算，纯函数 + `statSync` | 新建 |
| `server/src/repo-cache.ts` | 指纹 → heavy 结果的落盘缓存 | 新建 |
| `server/src/repo-identity.ts` | 身份账本 + 认领算法（`matchClaims` 为纯函数） | 新建 |
| `server/src/watch-filter.ts` | `IGNORED_DIRS` / `shouldIgnorePath` / `watcherErrorIsNoise` / `samePath`，从 `watcher.ts` 原样搬出，拆掉 watcher ↔ strategy 的循环依赖 | 新建 |
| `server/src/watch-strategy.ts` | `RecursiveRootStrategy` / `PerRepoStrategy` 两个监听策略 | 新建 |
| `server/src/watcher.ts` | 归属映射 + 防抖/冷却/串行链，监听机制委托给策略 | 重写 |
| `server/src/git.ts` | 拆出 `getRepoCore` / `getRepoHeavy`；`parseStatus` 增解析 `branch.oid` | 修改 |
| `server/src/store.ts` | 用账本解析 id、用指纹缓存跳过 heavy | 修改 |
| `server/src/automation.ts` | `applyRepos` 新方法；`watchLimit` 收窄为逐仓库策略专用 | 修改 |
| `server/src/backend.ts` | 重扫后只 `setRepos`；结构变化/溢出触发重扫 | 修改 |
| `server/src/desc-cache.ts` / `inbox-cache.ts` | 迁移到 `json-store` 底座 | 修改 |

---

### Task 1: `json-store.ts` 共用底座，并迁移两个现有缓存

**Files:**
- Create: `server/src/json-store.ts`
- Create: `server/tests/json-store.test.ts`
- Modify: `server/src/desc-cache.ts`（整体重写为基于底座）
- Modify: `server/src/inbox-cache.ts`（整体重写为基于底座）

**Interfaces:**
- Produces: `class JsonStore<T>`，构造参数 `{ file: string; isValid: (v: unknown) => v is T; debounceMs?: number }`；方法 `get(key): T | undefined`、`set(key, value): void`、`delete(key): boolean`、`entries(): [string, T][]`、`pruneStale(keepIds: Set<string>, timestampOf: (v: T) => string, maxAgeMs?: number): void`、`flush(): void`。Task 4、5 直接复用。

**`pruneStale` 必须在底座里，不能让四个使用者各写一遍。** 四份逐字相同的剪枝循环（含那条 30 天年龄护栏和解释它为什么存在的注释）正是本任务要消灭的东西；各写各的迟早走样，而走样的那一份会静默地把某个缓存剪成空的。四个使用者的差别只有「时间戳字段叫什么」（`fetchedAt` / `seenAt`），用一个取值函数就够了。
- Consumes: 无。

**为什么先做这个**：本轮要新增 `repo-cache.json` 与 `repo-identity.json`，加上已有的 `github-desc.json`、`github-inbox.json` 就是四个逐行雷同的文件（`desc-cache.ts` 86 行、`inbox-cache.ts` 99 行）。先抽底座再往上盖，能立刻用两个现成的使用者验证底座 API 够不够用——如果 `DescCache` 的「每次 set 立即落盘」和 `InboxCache` 的「防抖 1 秒 + flush」不能用同一套表达，现在就会暴露。

- [ ] **Step 1: 写失败测试**

创建 `server/tests/json-store.test.ts`：

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { JsonStore } from "../src/json-store"

interface Entry { v: number; at?: string }
const isEntry = (x: unknown): x is Entry =>
  typeof x === "object" && x !== null && typeof (x as Entry).v === "number"

const dirs: string[] = []
function tmpFile(name = "store.json"): string {
  const d = mkdtempSync(join(tmpdir(), "rr-json-"))
  dirs.push(d)
  return join(d, name)
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("JsonStore", () => {
  it("debounceMs 0：set 立即落盘，新实例能读回来", () => {
    const file = tmpFile()
    const a = new JsonStore<Entry>({ file, isValid: isEntry })
    a.set("k", { v: 1 })
    expect(new JsonStore<Entry>({ file, isValid: isEntry }).get("k")).toEqual({ v: 1 })
  })

  it("目录不存在时自动创建", () => {
    const file = join(tmpFile(), "nested", "deep.json")
    new JsonStore<Entry>({ file, isValid: isEntry }).set("k", { v: 1 })
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ k: { v: 1 } })
  })

  it("debounceMs > 0：set 不立即落盘，flush 后才写", async () => {
    const file = tmpFile()
    const s = new JsonStore<Entry>({ file, isValid: isEntry, debounceMs: 1000 })
    s.set("k", { v: 1 })
    expect(new JsonStore<Entry>({ file, isValid: isEntry }).get("k")).toBeUndefined()
    s.flush()
    expect(new JsonStore<Entry>({ file, isValid: isEntry }).get("k")).toEqual({ v: 1 })
  })

  it("防抖窗口过去后自动落盘，无需 flush", async () => {
    const file = tmpFile()
    const s = new JsonStore<Entry>({ file, isValid: isEntry, debounceMs: 50 })
    s.set("k", { v: 1 })
    await new Promise((r) => setTimeout(r, 200))
    expect(new JsonStore<Entry>({ file, isValid: isEntry }).get("k")).toEqual({ v: 1 })
  })

  // 坏文件不该让程序起不来——缓存只是加速，宁可当空
  it("文件是非法 JSON → 当作空，不抛", () => {
    const file = tmpFile()
    writeFileSync(file, "{not json")
    const s = new JsonStore<Entry>({ file, isValid: isEntry })
    expect(s.entries()).toEqual([])
  })

  // 逐条校验而不是整份丢弃：老版本写入的部分字段变化时，好条目应当留下
  it("非法条目被逐条丢弃，合法条目保留", () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ good: { v: 1 }, bad: { v: "x" }, alsoBad: null }))
    const s = new JsonStore<Entry>({ file, isValid: isEntry })
    expect(s.entries()).toEqual([["good", { v: 1 }]])
  })

  it("delete 也会安排落盘", () => {
    const file = tmpFile()
    const s = new JsonStore<Entry>({ file, isValid: isEntry })
    s.set("k", { v: 1 })
    expect(s.delete("k")).toBe(true)
    expect(s.delete("k")).toBe(false)
    expect(new JsonStore<Entry>({ file, isValid: isEntry }).entries()).toEqual([])
  })

  it("pruneStale：不在保留集合、且已过年龄护栏的条目被剪掉", () => {
    const s = new JsonStore<Entry>({ file: tmpFile(), isValid: isEntry })
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
    s.set("keep-in-set", { v: 1, at: old })
    s.set("keep-young", { v: 2, at: new Date().toISOString() })
    s.set("drop", { v: 3, at: old })
    s.pruneStale(new Set(["keep-in-set"]), (e) => e.at ?? "")
    expect(s.entries().map(([k]) => k).sort()).toEqual(["keep-in-set", "keep-young"])
  })

  // 年龄护栏：网络盘根目录瞬时掉线会让一整批仓库在某轮扫描里消失，
  // 立即剪会把它们的落盘数据永久抹掉
  it("pruneStale：刚写入的条目即使不在保留集合里也不剪", () => {
    const s = new JsonStore<Entry>({ file: tmpFile(), isValid: isEntry })
    s.set("gone", { v: 1, at: new Date().toISOString() })
    s.pruneStale(new Set(), (e) => e.at ?? "")
    expect(s.entries().length).toBe(1)
  })

  // 时间戳损坏不能让条目永久赖着不走：NaN 一律视为已过期
  it("pruneStale：时间戳非法的条目按已过期处理", () => {
    const s = new JsonStore<Entry>({ file: tmpFile(), isValid: isEntry })
    s.set("bad", { v: 1, at: "not-a-date" })
    s.pruneStale(new Set(), (e) => e.at ?? "")
    expect(s.entries()).toEqual([])
  })

  it("没有待写内容时 flush 不写盘（不产生文件）", () => {
    const file = tmpFile()
    const s = new JsonStore<Entry>({ file, isValid: isEntry, debounceMs: 1000 })
    s.flush()
    expect(() => readFileSync(file, "utf8")).toThrow()
  })

  // 写盘失败静默：缓存只是加速，不能因为磁盘满/只读就让功能挂掉
  it("写盘失败不抛出", () => {
    const s = new JsonStore<Entry>({ file: join("\0invalid", "x.json"), isValid: isEntry })
    expect(() => s.set("k", { v: 1 })).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w server -- tests/json-store.test.ts`
Expected: FAIL — `Failed to resolve import "../src/json-store"`

- [ ] **Step 3: 实现 `json-store.ts`**

创建 `server/src/json-store.ts`：

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface JsonStoreOptions<T> {
  file: string
  /** 逐条校验：坏条目单独丢弃而不是整份作废——老版本写入的部分字段变化时，好条目应当留下 */
  isValid: (v: unknown) => v is T
  /** 落盘防抖毫秒数；0（默认）= 每次 set/delete 立即写。
   *  轮询类使用者（一轮连着 set 几十次）给个 1000，避免频繁写盘 */
  debounceMs?: number
}

/**
 * 落盘 Map 的共用底座。github-desc / github-inbox / repo-cache / repo-identity 四个文件
 * 形状完全相同（load 时逐条校验、写盘失败静默、坏文件当空），各写一遍必然逐渐走样。
 *
 * 落盘失败一律静默：这四个文件都是「丢了最多是慢一轮或退化成旧行为」的性质，
 * 让磁盘满/只读把整个应用带崩是不划算的。真正需要知道文件坏了的场景由调用方记日志。
 */
export class JsonStore<T> {
  private map = new Map<string, T>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private readonly file: string
  private readonly debounceMs: number

  constructor(opts: JsonStoreOptions<T>) {
    this.file = opts.file
    this.debounceMs = opts.debounceMs ?? 0
    this.load(opts.isValid)
  }

  private load(isValid: (v: unknown) => v is T): void {
    try {
      if (!existsSync(this.file)) return
      const obj = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>
      for (const [k, v] of Object.entries(obj)) if (isValid(v)) this.map.set(k, v)
    } catch {
      /* 坏文件忽略，当作空 */
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2), "utf8")
      this.dirty = false
    } catch {
      /* 写盘失败静默 */
    }
  }

  private schedule(): void {
    this.dirty = true
    if (this.debounceMs === 0) {
      this.write()
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.write()
    }, this.debounceMs)
  }

  get(key: string): T | undefined {
    return this.map.get(key)
  }

  set(key: string, value: T): void {
    this.map.set(key, value)
    this.schedule()
  }

  delete(key: string): boolean {
    if (!this.map.delete(key)) return false
    this.schedule()
    return true
  }

  entries(): [string, T][] {
    return [...this.map]
  }

  /**
   * 扫描后剪枝：剪掉「不在 keepIds 里、且已超过 maxAgeMs 没被刷新」的条目，防无界增长。
   *
   * 年龄护栏不是可选的。网络盘根目录瞬时掉线会让一整批仓库在某轮扫描里消失，
   * 立即剪会把它们的落盘数据永久抹掉——对身份账本尤其致命：条目一剪，那批仓库回来时
   * 会被当成全新仓库，标签/收藏/归档全丢，正是本轮要消灭的行为。真删掉的仓库不再刷新，
   * 30 天后自然过筛。
   *
   * timestampOf 让各使用者指定自己的时间戳字段（fetchedAt / seenAt）。非法时间戳按已过期
   * 处理——否则 NaN 比较恒为 false，坏条目会永久赖着不走。
   */
  pruneStale(keepIds: Set<string>, timestampOf: (v: T) => string, maxAgeMs = 30 * 86_400_000): void {
    const now = Date.now()
    let changed = false
    for (const [key, v] of this.map) {
      if (keepIds.has(key)) continue
      const at = new Date(timestampOf(v)).getTime()
      if (Number.isNaN(at) || now - at > maxAgeMs) {
        this.map.delete(key)
        changed = true
      }
    }
    // 一轮剪枝只安排一次落盘。逐条走公开的 delete() 会让 debounceMs === 0 的使用者
    // （DescCache）每删一条就把整个 map 同步 stringify + writeFileSync 一遍——剪掉 N 条
    // 就是 N 次全量写盘。而年龄护栏针对的恰恰是「一整批仓库同时消失」的网络盘场景，
    // 那时最不该做的就是一串同步写。改造前的两个缓存用 changed 标志批量成一次，别丢掉
    if (changed) this.schedule()
  }

  /** 立刻把待写内容落盘。退出路径专用——防抖窗口内硬退会丢掉最后一批写入 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.dirty) this.write()
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w server -- tests/json-store.test.ts`
Expected: PASS（9 项全绿）

- [ ] **Step 5: 把 `desc-cache.ts` 迁到底座上**

重写 `server/src/desc-cache.ts`，保持对外 API（`get` / `isStale` / `set` / `prune`）逐字不变：

```ts
import { JsonStore } from "./json-store"

// GitHub 仓库描述缓存：键为 repoId，落盘到 config 同目录的 github-desc.json。
// 描述极少变，命中缓存就不再联网；超过 TTL 或 origin 变了才重拉。
export interface DescEntry {
  description: string | null // null = 确认过 GitHub 没有描述（也缓存，避免反复空拉）
  url: string // 拉取时的 origin url，变了说明换了远程，需重拉
  fetchedAt: string // ISO 8601
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天后视为过期，允许刷新

const isDescEntry = (v: unknown): v is DescEntry =>
  typeof v === "object" && v !== null &&
  typeof (v as DescEntry).url === "string" && typeof (v as DescEntry).fetchedAt === "string"

export class DescCache {
  private store: JsonStore<DescEntry>

  constructor(file: string) {
    this.store = new JsonStore({ file, isValid: isDescEntry })
  }

  /**
   * 供 store 覆盖用：非空且 origin url 与当前一致的 GitHub 描述才返回，否则 null（回退本地描述）。
   * 带 url 校验是关键——换了 origin 后旧描述属于另一个仓库，缓存尚未刷新前不能拿旧的顶上去。
   */
  get(id: string, url: string | undefined): string | null {
    const e = this.store.get(id)
    if (!e || !e.description) return null
    if (url === undefined || e.url !== url) return null
    return e.description
  }

  /** 是否需要（重新）拉取：无缓存、origin 变了、或已过期。 */
  isStale(id: string, url: string): boolean {
    const e = this.store.get(id)
    if (!e) return true
    if (e.url !== url) return true
    const at = new Date(e.fetchedAt).getTime()
    if (Number.isNaN(at)) return true // 时间戳损坏视为过期（否则 NaN>TTL 恒为 false，永不刷新）
    return Date.now() - at > TTL_MS
  }

  set(id: string, url: string, description: string | null): void {
    this.store.set(id, { description, url, fetchedAt: new Date().toISOString() })
  }

  /** 扫描后调用。剪枝逻辑连同那条 30 天年龄护栏及其理由都在 JsonStore.pruneStale 里，
   *  这里只负责指出本缓存的时间戳字段——四个缓存各写一遍迟早走样 */
  prune(keepIds: Set<string>, maxAgeMs = 30 * 86_400_000): void {
    this.store.pruneStale(keepIds, (e) => e.fetchedAt, maxAgeMs)
  }
}
```

- [ ] **Step 6: 把 `inbox-cache.ts` 迁到底座上**

重写 `server/src/inbox-cache.ts`。它的防抖落盘与 `flush()` 现在由底座提供（`debounceMs: 1000`），对外 API 保持不变：

```ts
import { JsonStore } from "./json-store"
import type { GithubInbox } from "./types"

// GitHub「等我的」（PR/issue/CI）缓存：键为 repoId，落盘到 config 同目录的 github-inbox.json。
// 落盘后重启即可秒显上次结果（get 不看 TTL，只校验 origin url），后台再按 TTL 刷新过期项（isStale）。
interface InboxEntry {
  inbox: GithubInbox
  url: string // 拉取时的 origin url，变了说明换了远程，缓存失效
  fetchedAt: string // ISO 8601
}

const TTL_MS = 12 * 60 * 1000 // 12 分钟（PR/issue/CI 变得比描述频繁）

const isInboxEntry = (v: unknown): v is InboxEntry =>
  typeof v === "object" && v !== null && !!(v as InboxEntry).inbox &&
  typeof (v as InboxEntry).url === "string" && typeof (v as InboxEntry).fetchedAt === "string"

export class InboxCache {
  private store: JsonStore<InboxEntry>

  constructor(file: string) {
    // 防抖 1s：一整轮轮询会连着 set 几十次，攒起来写一次
    this.store = new JsonStore({ file, isValid: isInboxEntry, debounceMs: 1000 })
  }

  /** 立刻把待写的内容落盘。退出路径专用：防抖窗口是 1 秒，硬退会把最后一轮拉取结果丢掉 */
  flush(): void {
    this.store.flush()
  }

  /** origin url 一致才返回缓存（换了远程即失效）；不看 TTL——过期与否由 isStale 决定是否后台重拉。 */
  get(id: string, url: string | undefined): GithubInbox | null {
    const e = this.store.get(id)
    return e && url !== undefined && e.url === url ? e.inbox : null
  }

  /** 是否需要（重新）拉取：无缓存、origin 变了、或已过期。 */
  isStale(id: string, url: string): boolean {
    const e = this.store.get(id)
    if (!e || e.url !== url) return true
    const at = new Date(e.fetchedAt).getTime()
    if (Number.isNaN(at)) return true
    return Date.now() - at > TTL_MS
  }

  set(id: string, url: string, inbox: GithubInbox): void {
    this.store.set(id, { inbox, url, fetchedAt: new Date().toISOString() })
  }

  /** 扫描后调用。剪枝逻辑连同那条 30 天年龄护栏及其理由都在 JsonStore.pruneStale 里，
   *  这里只负责指出本缓存的时间戳字段——四个缓存各写一遍迟早走样 */
  prune(keepIds: Set<string>, maxAgeMs = 30 * 86_400_000): void {
    this.store.pruneStale(keepIds, (e) => e.fetchedAt, maxAgeMs)
  }
}
```

- [ ] **Step 7: 运行全部服务端测试与类型检查**

Run: `npm run typecheck -w server && npm test -w server`
Expected: PASS。特别关注 `tests/desc-cache.test.ts`、`tests/inbox-cache.test.ts`、`tests/inbox-events.test.ts`、`tests/shutdown.test.ts` —— 它们验证的对外行为一条都不该变。

- [ ] **Step 8: 提交**

```bash
git add server/src/json-store.ts server/tests/json-store.test.ts server/src/desc-cache.ts server/src/inbox-cache.ts
git commit -m "refactor(server): 抽出落盘 Map 的共用底座 json-store"
```

---

### Task 2: 指纹的两样原料——`branch.oid` 解析与 `gitFingerprint`

**Files:**
- Modify: `server/src/git.ts:94-100`（`ParsedStatus` 增字段）、`server/src/git.ts:101-130`（`parseStatus` 增解析分支）
- Create: `server/src/fingerprint.ts`
- Create: `server/tests/fingerprint.test.ts`
- Modify: `server/tests/parse.test.ts`（追加 oid 用例）

**Interfaces:**
- Consumes: 无。
- Produces:
  - `ParsedStatus.oid: string | null`
  - `gitFingerprint(repoPath: string, oid: string | null): string | null` —— 返回 `null` 表示**不可缓存**，调用方必须当作永远未命中。

**关键点**：`git status --porcelain=v2 --branch` 一直在输出 `# branch.oid <sha>`，`parseStatus` 只是没解析它。拿它当指纹的一部分是白拿的，不增加任何 git 调用。

`.git` 不是目录时（worktree / submodule 的 `.git` 是个文件）六个 stat 全部失败，指纹会退化成一个恒定值 —— 那会让这类仓库**永远命中缓存、heavy 永不刷新**。所以这种情况必须返回 `null` 而不是恒定字符串。

- [ ] **Step 1: 写失败测试**

创建 `server/tests/fingerprint.test.ts`：

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitFingerprint } from "../src/fingerprint"
import { cleanupFixtures, git, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

describe("gitFingerprint", () => {
  it("同一仓库、无改动 → 指纹稳定", () => {
    const repo = makeRepo()
    expect(gitFingerprint(repo, "abc")).toBe(gitFingerprint(repo, "abc"))
  })

  it("oid 变化 → 指纹变化", () => {
    const repo = makeRepo()
    expect(gitFingerprint(repo, "abc")).not.toBe(gitFingerprint(repo, "def"))
  })

  it("提交后指纹变化（HEAD/index/logs 至少一项动了）", () => {
    const repo = makeRepo()
    const before = gitFingerprint(repo, "same-oid")
    writeFileSync(join(repo, "x.txt"), "x")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "c")
    // 故意传同一个 oid：证明即使 oid 没告诉我们变化，stat 也能发现
    expect(gitFingerprint(repo, "same-oid")).not.toBe(before)
  })

  it("stash 后指纹变化", () => {
    const repo = makeRepo()
    const before = gitFingerprint(repo, "o")
    writeFileSync(join(repo, "f0.txt"), "changed")
    git(repo, "stash")
    expect(gitFingerprint(repo, "o")).not.toBe(before)
  })

  // .git 是文件（worktree / submodule）时六个 stat 全失败。若返回恒定字符串，
  // 这类仓库会永远命中缓存、heavy 永不刷新——必须显式表达「不可缓存」
  it(".git 不是目录 → 返回 null（不可缓存）", () => {
    const fake = makeRepo()
    rmSync(join(fake, ".git"), { recursive: true, force: true })
    writeFileSync(join(fake, ".git"), "gitdir: /somewhere/else")
    expect(gitFingerprint(fake, "o")).toBeNull()
  })

  it("路径根本不存在 → 返回 null", () => {
    expect(gitFingerprint(join("Z:", "no", "such", "repo"), "o")).toBeNull()
  })

  it("空仓库（oid 为 null）也能算出指纹", () => {
    const repo = makeRepo({ commits: 0 })
    expect(gitFingerprint(repo, null)).not.toBeNull()
  })

  it("FETCH_HEAD 从无到有 → 指纹变化", () => {
    const repo = makeRepo()
    const before = gitFingerprint(repo, "o")
    mkdirSync(join(repo, ".git"), { recursive: true })
    writeFileSync(join(repo, ".git", "FETCH_HEAD"), "deadbeef\n")
    expect(gitFingerprint(repo, "o")).not.toBe(before)
  })
})
```

在 `server/tests/parse.test.ts` 末尾追加：

```ts
describe("parseStatus — branch.oid", () => {
  it("解析出 HEAD 的 oid", () => {
    const out = [
      "# branch.oid 1234567890abcdef1234567890abcdef12345678",
      "# branch.head main",
      "# branch.ab +0 -0",
    ].join("\n")
    expect(parseStatus(out).oid).toBe("1234567890abcdef1234567890abcdef12345678")
  })

  it("空仓库的 (initial) 按缺失处理", () => {
    expect(parseStatus("# branch.oid (initial)\n# branch.head main").oid).toBeNull()
  })

  it("没有 branch.oid 行时为 null", () => {
    expect(parseStatus("# branch.head main").oid).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w server -- tests/fingerprint.test.ts tests/parse.test.ts`
Expected: FAIL —— `fingerprint` 模块不存在；`parseStatus(...).oid` 是 `undefined` 而非 `null`

- [ ] **Step 3: 给 `parseStatus` 加 oid**

修改 `server/src/git.ts`，`ParsedStatus` 接口加一个字段：

```ts
export interface ParsedStatus {
  branch: string | null
  ahead: number
  behind: number
  dirty: DirtyCounts
  // HEAD 的 commit oid。git 一直在 `--branch` 的输出里给这一行，以前没解析。
  // 指纹要用它判断「这个仓库自上轮以来有没有新提交」——白拿，不增加任何 git 调用。
  // 空仓库输出 `# branch.oid (initial)`，按 null 处理
  oid: string | null
}
```

在 `parseStatus` 里，`let branch` 之后加 `let oid: string | null = null`，并在 `if (line.startsWith("# branch.head "))` 之前插入一个分支：

```ts
    if (line.startsWith("# branch.oid ")) {
      const v = line.slice("# branch.oid ".length).trim()
      oid = v === "(initial)" ? null : v
    } else if (line.startsWith("# branch.head ")) {
```

并把返回值里加上 `oid`。

- [ ] **Step 4: 实现 `fingerprint.ts`**

创建 `server/src/fingerprint.ts`：

```ts
import { statSync } from "node:fs"
import { join } from "node:path"

/**
 * `.git` 下用于判断「这个仓库自上轮扫描以来动过没有」的一小组路径。
 * 选它们的依据是「哪些操作会改变 heavy 那六个 git 命令的结果」：
 * - HEAD：切分支
 * - index：add / commit / checkout
 * - packed-refs：gc / pack-refs / fetch
 * - FETCH_HEAD：fetch
 * - refs/stash：stash push / pop
 * - logs/HEAD：任何 ref 更新（commit、checkout、merge、reset、fetch）都会追加
 */
const PROBES = ["HEAD", "index", "packed-refs", "FETCH_HEAD", join("refs", "stash"), join("logs", "HEAD")]

/**
 * `.git` 指纹。用于**跳过缓存**，不承担正确性兜底：漏判的后果上界是
 * tag/stash/remote/最近提交等「重」字段最多旧一轮（默认 30 分钟），
 * 而分支、工作区脏计数、ahead/behind 走的是每次都执行的 core，任何时候都是实时的。
 *
 * 返回 null = **不可缓存**，调用方必须当作永远未命中。这不是错误路径：
 * worktree / submodule 的 `.git` 是文件而非目录，六个 probe 全部 stat 失败。
 * 若此时返回一个恒定字符串，这类仓库会永远命中缓存、heavy 永不刷新——
 * 那是个只在少数用户身上出现、且完全没有报错的静默失效。
 */
export function gitFingerprint(repoPath: string, oid: string | null): string | null {
  const gitDir = join(repoPath, ".git")
  try {
    if (!statSync(gitDir).isDirectory()) return null
  } catch {
    return null // 仓库不存在 / 无权限：交给完整路径去报真正的错
  }
  const parts = [oid ?? "-"]
  for (const rel of PROBES) {
    try {
      const s = statSync(join(gitDir, rel))
      parts.push(`${s.mtimeMs}:${s.size}`)
    } catch {
      parts.push("-") // 不存在是常态（FETCH_HEAD / refs/stash），从无到有本身就是变化信号
    }
  }
  return parts.join("|")
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w server -- tests/fingerprint.test.ts tests/parse.test.ts`
Expected: PASS

- [ ] **Step 6: 全量测试 + 类型检查**

Run: `npm run typecheck -w server && npm test -w server`
Expected: PASS（`ParsedStatus` 加字段是向后兼容的，现有断言不受影响）

- [ ] **Step 7: 提交**

```bash
git add server/src/git.ts server/src/fingerprint.ts server/tests/fingerprint.test.ts server/tests/parse.test.ts
git commit -m "feat(server): 解析 branch.oid 并新增 .git 指纹计算"
```

---

### Task 3: 拆分 `getRepoStatus` 为 `getRepoCore` / `getRepoHeavy`

**Files:**
- Modify: `server/src/git.ts:541-612`
- Create: `server/tests/repo-core-heavy.test.ts`

**Interfaces:**
- Consumes: `ParsedStatus.oid`（Task 2）
- Produces:
  - `interface RepoCore { branch: string | null; dirty: DirtyCounts; ahead: number; behind: number; oid: string | null }`
  - `interface RepoHeavy { stashCount: number; stashOldest: string | null; release: { tag: string; ahead: number; tagDate: string } | null; remotes: RemoteInfo[]; lastCommit: CommitInfo | null; mergedBranches: string[]; displayName: string | null; description: string | null; language: string | null }`
  - `getRepoCore(path: string): Promise<RepoCore>` —— 1 个 git 进程
  - `getRepoHeavy(path: string, branch: string | null): Promise<RepoHeavy>` —— 至多 6 个 git 进程
  - `composeStatus(path: string, id: string, core: RepoCore, heavy: RepoHeavy): RepoStatus`
  - `getRepoStatus(path: string, id?: string): Promise<RepoStatus>` —— 保留，内部由上面三者组合

**为什么保留 `getRepoStatus`**：`routes.ts`、`scaffold.ts`、以及 `tests/git.test.ts` 等多处在用它。保留成薄包装能让本任务零破坏，缓存接入放到下一个任务。

- [ ] **Step 1: 写失败测试**

创建 `server/tests/repo-core-heavy.test.ts`：

```ts
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { composeStatus, getRepoCore, getRepoHeavy, getRepoStatus, repoId } from "../src/git"
import { cleanupFixtures, git, makeRepo, makeRepoWithUpstream } from "./fixtures"

afterAll(cleanupFixtures)

describe("getRepoCore", () => {
  it("给出分支、脏计数与 oid", async () => {
    const repo = makeRepo({ dirty: true })
    const core = await getRepoCore(repo)
    expect(core.branch).toBe("main")
    expect(core.dirty.untracked).toBe(1)
    expect(core.oid).toMatch(/^[0-9a-f]{40}$/)
  })

  it("有 upstream 时给出 ahead/behind", async () => {
    const core = await getRepoCore(makeRepoWithUpstream())
    expect(core.ahead).toBe(1)
    expect(core.behind).toBe(0)
  })

  it("空仓库：oid 为 null，不抛", async () => {
    const core = await getRepoCore(makeRepo({ commits: 0 }))
    expect(core.oid).toBeNull()
  })
})

describe("getRepoHeavy", () => {
  it("给出 stash / 最近提交 / 语言", async () => {
    const repo = makeRepo({ stash: true })
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo" }))
    const heavy = await getRepoHeavy(repo, "main")
    expect(heavy.stashCount).toBe(1)
    expect(heavy.lastCommit?.message).toBe("c0")
    expect(heavy.displayName).toBe("demo")
  })

  it("mergedBranches 排除当前分支与主干", async () => {
    const repo = makeRepo()
    git(repo, "branch", "feature-done")
    const heavy = await getRepoHeavy(repo, "main")
    expect(heavy.mergedBranches).toEqual(["feature-done"])
  })

  it("从未打过 tag 时 release 为 null", async () => {
    expect((await getRepoHeavy(makeRepo(), "main")).release).toBeNull()
  })
})

// 拆分不得改变对外结果：这是本任务唯一真正重要的断言
describe("composeStatus 与 getRepoStatus 等价", () => {
  it("手工组合的结果与 getRepoStatus 一致", async () => {
    const repo = makeRepo({ dirty: true, stash: true })
    const viaStatus = await getRepoStatus(repo)
    const core = await getRepoCore(repo)
    const heavy = await getRepoHeavy(repo, core.branch)
    const composed = composeStatus(repo, repoId(repo), core, heavy)
    // scannedAt 是各自的当前时刻，比对前对齐
    expect({ ...composed, scannedAt: "" }).toEqual({ ...viaStatus, scannedAt: "" })
  })

  it("getRepoStatus 可以接受外部传入的 id", async () => {
    const repo = makeRepo()
    expect((await getRepoStatus(repo, "forced-id")).id).toBe("forced-id")
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w server -- tests/repo-core-heavy.test.ts`
Expected: FAIL —— `getRepoCore`、`getRepoHeavy`、`composeStatus` 未导出

- [ ] **Step 3: 拆分实现**

把 `server/src/git.ts:541-612` 的 `getRepoStatus` 整段替换为：

```ts
/** status 一条命令就能得到的部分。永远执行——工作区脏状态必须实算，不能缓存 */
export interface RepoCore {
  branch: string | null
  dirty: DirtyCounts
  ahead: number
  behind: number
  oid: string | null
}

/** 需要额外 6 个 git 进程（外加读 package.json/README、探测语言标志文件）的部分。
 *  这些结果只会因 `.git` 里的变化而变，因此可以按指纹缓存 */
export interface RepoHeavy {
  stashCount: number
  stashOldest: string | null
  release: { tag: string; ahead: number; tagDate: string } | null
  remotes: RemoteInfo[]
  lastCommit: CommitInfo | null
  mergedBranches: string[]
  displayName: string | null
  description: string | null
  language: string | null
}

/** 1 个 git 进程。status 失败（非 git 目录、git 缺失）直接抛出，由调用方决定如何降级。
 *  --no-optional-locks：读状态时不刷新/写 .git/index，避免触发文件监听的自反馈 */
export async function getRepoCore(path: string): Promise<RepoCore> {
  const status = await runGit(path, ["--no-optional-locks", "status", "--porcelain=v2", "--branch"])
  const parsed = parseStatus(status.stdout)
  return { branch: parsed.branch, dirty: parsed.dirty, ahead: parsed.ahead, behind: parsed.behind, oid: parsed.oid }
}

/** 至多 6 个 git 进程，全部并发。branch 由 core 传入，用于剔除 mergedBranches 里的当前分支 */
export async function getRepoHeavy(path: string, branch: string | null): Promise<RepoHeavy> {
  const [stashInfo, release, remotes, lastCommit, mergedRaw] = await Promise.all([
    // stash 条数 + 最老一条的时间（list 新→旧，最老在末行）——「搁了多久」提醒用
    runGit(path, ["stash", "list", "--format=%cI"])
      .then((r) => {
        const lines = splitLines(r)
        return { count: lines.length, oldest: lines.length > 0 ? lines[lines.length - 1] : null }
      })
      .catch(() => ({ count: 0, oldest: null as string | null })),
    // 发版雷达：按「创建时间」取全库最新 tag（annotated 记打 tag 的时间、lightweight 记提交时间）。
    // 不用 describe——它只找 HEAD 可达的最近 tag，会漏掉未合并分支上刚发的版、日期也会错拿提交时间。
    // 计数用 HEAD --not --tags（HEAD 上不被任何 tag 覆盖的提交）：即便最新 tag 不是 HEAD 的祖先
    // （比如在老维护分支上补发 v1.0.1），也不会把 merge-base 以来的所有提交都算成「未发版」。
    (async () => {
      try {
        const r = await runGit(path, ["for-each-ref", "refs/tags", "--sort=-creatordate", "--count=1", "--format=%(refname:short)%00%(creatordate:iso-strict)"])
        const [tag, tagDate] = r.stdout.trim().split("\0")
        if (!tag) return null
        const aheadR = await runGit(path, ["rev-list", "--count", "HEAD", "--not", "--tags"])
        return { tag, ahead: Number(aheadR.stdout.trim()) || 0, tagDate: tagDate ?? "" }
      } catch {
        return null
      }
    })(),
    runGit(path, ["remote", "-v"]).then((r) => parseRemotes(r.stdout)).catch(() => []),
    runGit(path, ["log", "-1", "--format=%H%x00%s%x00%an%x00%aI"])
      .then((r) => parseLastCommit(r.stdout))
      .catch(() => null), // 空仓库无 HEAD 时 git log 非零退出
    // --format 必须在 --merged 之前：否则 git 会把 --format=… 当成 --merged 的 commit 参数而报错
    runGit(path, ["branch", "--format=%(refname:short)", "--merged"])
      .then((r) => r.stdout.split("\n").map((s) => s.trim()).filter(Boolean))
      .catch(() => []),
  ])
  const meta = readRepoMeta(path, remotes)
  return {
    stashCount: stashInfo.count,
    stashOldest: stashInfo.oldest,
    release,
    remotes,
    lastCommit,
    // 可安全清理的已合并分支：排除当前分支与主干（main/master）
    mergedBranches: mergedRaw.filter((b) => b !== branch && b !== "main" && b !== "master"),
    displayName: meta.displayName,
    description: meta.description,
    language: detectLanguage(path),
  }
}

/** 把 core + heavy 拼成看板用的完整状态。装饰字段（tags/favorite/…）留给 RepoStore.decorate */
export function composeStatus(path: string, id: string, core: RepoCore, heavy: RepoHeavy): RepoStatus {
  return {
    id,
    path,
    name: basename(path),
    displayName: heavy.displayName,
    description: heavy.description,
    language: heavy.language,
    group: "",
    tags: [],
    favorite: false,
    archived: false,
    note: null,
    lastOpened: null,
    mergedBranches: heavy.mergedBranches,
    branch: core.branch,
    dirty: core.dirty,
    ahead: core.ahead,
    behind: core.behind,
    stashCount: heavy.stashCount,
    stashOldest: heavy.stashOldest,
    release: heavy.release,
    remotes: heavy.remotes,
    lastCommit: heavy.lastCommit,
    health: [],
    githubInbox: null,
    error: null,
    scannedAt: new Date().toISOString(),
  }
}

/** 完整刷新（core + heavy）。id 可由调用方指定——身份账本认领后，仓库沿用老 id 而不是按新路径重算 */
export async function getRepoStatus(path: string, id: string = repoId(path)): Promise<RepoStatus> {
  const core = await getRepoCore(path)
  const heavy = await getRepoHeavy(path, core.branch)
  return composeStatus(path, id, core, heavy)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w server -- tests/repo-core-heavy.test.ts`
Expected: PASS

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `npm run typecheck -w server && npm test -w server`
Expected: PASS。`tests/git.test.ts` / `tests/store.test.ts` / `tests/routes.test.ts` 全绿即证明拆分等价。

- [ ] **Step 6: 提交**

```bash
git add server/src/git.ts server/tests/repo-core-heavy.test.ts
git commit -m "refactor(git): 拆分 getRepoStatus 为 core 与 heavy 两段"
```

---

### Task 4: `repo-cache.ts` 并接入 `RepoStore`

**Files:**
- Create: `server/src/repo-cache.ts`
- Create: `server/tests/repo-cache.test.ts`
- Modify: `server/src/store.ts:62-115`（`doRefreshAll` 与 `refreshOne`）
- Modify: `server/src/backend.ts:229-231`（prune 加入新缓存）

**Interfaces:**
- Consumes: `JsonStore`（Task 1）、`gitFingerprint`（Task 2）、`getRepoCore` / `getRepoHeavy` / `composeStatus`（Task 3）
- Produces:
  - `class RepoCache`，方法 `get(id: string, fingerprint: string | null): RepoHeavy | null`、`set(id: string, fingerprint: string, heavy: RepoHeavy): void`、`prune(keepIds: Set<string>, maxAgeMs?: number): void`、`flush(): void`
  - `RepoStore` 构造参数新增可选第 4 参 `cache?: RepoCache`

- [ ] **Step 1: 写失败测试**

创建 `server/tests/repo-cache.test.ts`：

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { RepoCache } from "../src/repo-cache"
import type { RepoHeavy } from "../src/git"

const dirs: string[] = []
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), "rr-cache-"))
  dirs.push(d)
  return join(d, "repo-cache.json")
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const heavy: RepoHeavy = {
  stashCount: 2, stashOldest: "2026-01-01T00:00:00Z", release: null, remotes: [],
  lastCommit: null, mergedBranches: [], displayName: "x", description: null, language: "TypeScript",
}

describe("RepoCache", () => {
  it("指纹相同 → 命中", () => {
    const c = new RepoCache(tmpFile())
    c.set("id1", "fp-a", heavy)
    expect(c.get("id1", "fp-a")).toEqual(heavy)
  })

  it("指纹不同 → 未命中", () => {
    const c = new RepoCache(tmpFile())
    c.set("id1", "fp-a", heavy)
    expect(c.get("id1", "fp-b")).toBeNull()
  })

  // gitFingerprint 对 worktree/submodule 返回 null，表示「不可缓存」
  it("指纹为 null → 永远未命中", () => {
    const c = new RepoCache(tmpFile())
    c.set("id1", "fp-a", heavy)
    expect(c.get("id1", null)).toBeNull()
  })

  it("落盘后新实例能读回", () => {
    const file = tmpFile()
    new RepoCache(file).set("id1", "fp-a", heavy)
    expect(new RepoCache(file).get("id1", "fp-a")).toEqual(heavy)
  })

  it("坏文件当作空缓存，不抛", () => {
    const file = tmpFile()
    writeFileSync(file, "}}}not json")
    expect(new RepoCache(file).get("id1", "fp-a")).toBeNull()
  })

  // 年龄护栏：网络盘瞬时掉线会让一整批仓库在某轮扫描里消失，立即剪会永久抹掉它们的缓存
  it("prune 保留仍在扫描里的条目", () => {
    const c = new RepoCache(tmpFile())
    c.set("keep", "fp", heavy)
    c.set("drop", "fp", heavy)
    c.prune(new Set(["keep"]), 0) // maxAgeMs=0：立刻过筛，测剪枝本身
    expect(c.get("keep", "fp")).toEqual(heavy)
    expect(c.get("drop", "fp")).toBeNull()
  })

  it("prune 的年龄护栏：刚写入的条目即使不在扫描里也不剪", () => {
    const c = new RepoCache(tmpFile())
    c.set("gone", "fp", heavy)
    c.prune(new Set(), 30 * 86_400_000)
    expect(c.get("gone", "fp")).toEqual(heavy)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w server -- tests/repo-cache.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/repo-cache"`

- [ ] **Step 3: 实现 `repo-cache.ts`**

```ts
import type { RepoHeavy } from "./git"
import { JsonStore } from "./json-store"

// 「重」字段（stash / tag / remote / 最近提交 / 已合并分支 / 语言 / 描述）的落盘缓存，
// 键为 repoId，落盘到 config 同目录的 repo-cache.json。
// 存在的意义：一轮全量重扫本来要为每个仓库 spawn 6.4 个 git 进程（实测 73 个仓库 7151ms），
// 而绝大多数仓库两轮之间根本没动过。按 .git 指纹命中缓存后只剩 status 一个进程（实测 1301ms）。
interface CacheEntry {
  fingerprint: string
  heavy: RepoHeavy
  seenAt: string // ISO 8601，prune 的年龄护栏用
}

const isCacheEntry = (v: unknown): v is CacheEntry =>
  typeof v === "object" && v !== null &&
  typeof (v as CacheEntry).fingerprint === "string" &&
  typeof (v as CacheEntry).seenAt === "string" &&
  !!(v as CacheEntry).heavy

export class RepoCache {
  private store: JsonStore<CacheEntry>

  constructor(file: string) {
    // 防抖 1s：一轮全量扫描会连着 set 几十上百次
    this.store = new JsonStore({ file, isValid: isCacheEntry, debounceMs: 1000 })
  }

  /**
   * 指纹完全相等才命中。fingerprint 为 null（worktree/submodule 等 .git 非目录的情况）
   * 一律未命中——见 fingerprint.ts 里为什么不能给这类仓库一个恒定指纹。
   */
  get(id: string, fingerprint: string | null): RepoHeavy | null {
    if (fingerprint === null) return null
    const e = this.store.get(id)
    return e && e.fingerprint === fingerprint ? e.heavy : null
  }

  set(id: string, fingerprint: string, heavy: RepoHeavy): void {
    this.store.set(id, { fingerprint, heavy, seenAt: new Date().toISOString() })
  }

  /** 扫描后调用。年龄护栏及其理由在 JsonStore.pruneStale 里，这里只指定时间戳字段 */
  prune(keepIds: Set<string>, maxAgeMs = 30 * 86_400_000): void {
    this.store.pruneStale(keepIds, (e) => e.seenAt, maxAgeMs)
  }

  flush(): void {
    this.store.flush()
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w server -- tests/repo-cache.test.ts`
Expected: PASS

- [ ] **Step 5: 写 store 接入的失败测试**

创建 `server/tests/store-cache.test.ts`：

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { RepoCache } from "../src/repo-cache"
import { RepoStore } from "../src/store"
import { DEFAULT_CONFIG } from "../src/config"
import * as git from "../src/git"
import { cleanupFixtures, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

const dirs: string[] = []
function cacheFile(): string {
  const d = mkdtempSync(join(tmpdir(), "rr-sc-"))
  dirs.push(d)
  return join(d, "repo-cache.json")
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("RepoStore 指纹缓存", () => {
  it("第二轮重扫在仓库没动时不再调用 getRepoHeavy", async () => {
    const repo = makeRepo()
    const cfg = { ...DEFAULT_CONFIG, roots: [dirname(repo)] }
    const cache = new RepoCache(cacheFile())
    const spy = vi.spyOn(git, "getRepoHeavy")

    const store = new RepoStore(() => cfg, undefined, undefined, cache)
    await store.refreshAll()
    const afterFirst = spy.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    await store.refreshAll()
    expect(spy.mock.calls.length).toBe(afterFirst) // 一次都没再调用
    spy.mockRestore()
  })

  it("仓库动过之后重新调用 getRepoHeavy", async () => {
    const repo = makeRepo()
    const cfg = { ...DEFAULT_CONFIG, roots: [dirname(repo)] }
    const store = new RepoStore(() => cfg, undefined, undefined, new RepoCache(cacheFile()))
    await store.refreshAll()

    const spy = vi.spyOn(git, "getRepoHeavy")
    writeFileSync(join(repo, "x.txt"), "x")
    const { execFileSync } = await import("node:child_process")
    execFileSync("git", ["add", "-A"], { cwd: repo })
    execFileSync("git", ["commit", "-m", "c"], { cwd: repo })

    await store.refreshAll()
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    spy.mockRestore()
  })

  // 缓存命中时看板上的字段必须与全价刷新完全一致，否则缓存就是在制造错误数据
  it("命中缓存的结果与全价刷新一致", async () => {
    const repo = makeRepo({ stash: true })
    const cfg = { ...DEFAULT_CONFIG, roots: [dirname(repo)] }
    const cache = new RepoCache(cacheFile())
    const store = new RepoStore(() => cfg, undefined, undefined, cache)
    const first = (await store.refreshAll())[0]
    const second = (await store.refreshAll())[0]
    expect({ ...second, scannedAt: "" }).toEqual({ ...first, scannedAt: "" })
  })

  // 不传 cache 时必须完全退化成改造前的行为（每轮都全价刷新）
  it("未提供缓存时每轮都调用 getRepoHeavy", async () => {
    const repo = makeRepo()
    const cfg = { ...DEFAULT_CONFIG, roots: [dirname(repo)] }
    const store = new RepoStore(() => cfg)
    await store.refreshAll()
    const spy = vi.spyOn(git, "getRepoHeavy")
    await store.refreshAll()
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    spy.mockRestore()
  })
})
```

- [ ] **Step 6: 运行确认失败**

Run: `npm test -w server -- tests/store-cache.test.ts`
Expected: FAIL —— `RepoStore` 尚不接受第 4 个构造参数，且第二轮仍会调用 `getRepoHeavy`

- [ ] **Step 7: 改 `store.ts` 接入缓存**

在 `server/src/store.ts` 顶部 import 中加入：

```ts
import { composeStatus, getRepoCore, getRepoHeavy, getRepoStatus, repoId } from "./git"
import { gitFingerprint } from "./fingerprint"
import type { RepoCache } from "./repo-cache"
```

`RepoStore` 构造函数追加第 4 个可选参数：

```ts
    // 可选：heavy 字段的指纹缓存。不传时完全退化成「每轮全价刷新」（旧行为），
    // 测试与嵌入式用法据此免去落盘依赖
    private readonly cache?: RepoCache,
```

新增一个私有方法，`doRefreshAll` 与 `refreshOne` 共用：

```ts
  /**
   * 一个仓库的完整刷新，但 heavy 那 6 个 git 进程按 `.git` 指纹跳过。
   *
   * 顺序很关键：先跑 core 拿到 oid，再算指纹。oid 是 status 顺带给的（不额外 spawn），
   * 而它能识别出「mtime 因触碰而变、内容其实没变」以及反过来的情况。
   */
  private async refreshRepo(path: string, id: string): Promise<RepoStatus> {
    const core = await getRepoCore(path)
    const fp = gitFingerprint(path, core.oid)
    const cached = this.cache?.get(id, fp) ?? null
    if (cached) return composeStatus(path, id, core, cached)
    const heavy = await getRepoHeavy(path, core.branch)
    if (fp !== null) this.cache?.set(id, fp, heavy)
    return composeStatus(path, id, core, heavy)
  }
```

在 `doRefreshAll` 里，把

```ts
        const fresh = await getRepoStatus(p)
```

替换为

```ts
        const fresh = await this.refreshRepo(p, repoId(p))
```

在 `refreshOne` 里，把

```ts
      const fresh = await getRepoStatus(existing.path)
```

替换为

```ts
      const fresh = await this.refreshRepo(existing.path, id)
```

注意 `refreshOne` 现在用**传入的 id** 而不是按路径重算——这是 Task 5/6 让 id 与路径解耦的前置条件。

- [ ] **Step 8: 在 `backend.ts` 里建缓存并接入 prune**

`server/src/backend.ts` 中，在 `descCache` / `inboxCache` 的创建处旁边加：

```ts
  const repoCache = new RepoCache(join(dirname(configFile), "repo-cache.json"))
```

把 `RepoStore` 的构造调用补上第 4 个参数 `repoCache`，并在 `doRescanAndWatch` 的 prune 处（`backend.ts:229-231`）加一行：

```ts
    descCache.prune(ids)
    inboxCache.prune(ids)
    repoCache.prune(ids)
```

在退出路径（`shutdown.ts` 调用 `inboxCache.flush()` 的同一处）加上 `repoCache.flush()` —— 防抖窗口是 1 秒，硬退会丢掉最后一轮的缓存写入，下次启动白白付一轮全价。

- [ ] **Step 9: 运行测试确认通过**

Run: `npm test -w server -- tests/store-cache.test.ts tests/store.test.ts tests/store-freshen.test.ts tests/backend.test.ts`
Expected: PASS

- [ ] **Step 10: 全量测试 + 类型检查**

Run: `npm run typecheck -w server && npm test -w server`
Expected: PASS

- [ ] **Step 11: 提交**

```bash
git add server/src/repo-cache.ts server/tests/repo-cache.test.ts server/tests/store-cache.test.ts server/src/store.ts server/src/backend.ts
git commit -m "perf(server): 按 .git 指纹缓存重字段，全量重扫只跑 status"
```

---

### Task 5: 身份账本与认领算法

**Files:**
- Create: `server/src/repo-identity.ts`
- Create: `server/tests/repo-identity.test.ts`

**Interfaces:**
- Consumes: `JsonStore`（Task 1）、`repoId`（`git.ts`）
- Produces:
  - `interface IdentityEntry { path: string; dev: number; ino: number; rootCommit: string | null; seenAt: string }`
  - `interface ClaimCandidate { dev: number; ino: number; rootCommit: string | null }`
  - `matchClaims(lost: Map<string, ClaimCandidate>, found: Map<string, ClaimCandidate>): Map<string, string>` —— 纯函数，返回「新路径 → 被认领的老 id」
  - `class IdentityLedger`，方法 `resolve(paths: string[], rootCommitOf: (path: string) => Promise<string | null>, statOf?: (path: string) => { dev: number; ino: number } | null): Promise<Map<string, string>>`、`prune(keepIds, maxAgeMs?)`、`flush()`
  - `normalizePath(p: string): string` —— Windows 大小写不敏感的路径键归一化

**本任务只做算法与账本，不接 store。** 认领的每一步都取保守侧——这是本轮唯一会**产生错误数据**（把 A 的标签认到 B 头上）而非仅仅丢失数据的地方。

- [ ] **Step 1: 写失败测试**

创建 `server/tests/repo-identity.test.ts`：

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { IdentityLedger, matchClaims, normalizePath, type ClaimCandidate } from "../src/repo-identity"
import { repoId } from "../src/git"

const dirs: string[] = []
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), "rr-id-"))
  dirs.push(d)
  return join(d, "repo-identity.json")
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const cand = (dev: number, ino: number, rootCommit: string | null = null): ClaimCandidate => ({ dev, ino, rootCommit })
const noRootCommit = async () => null

describe("matchClaims", () => {
  it("dev+ino 一一对应 → 认领", () => {
    const lost = new Map([["oldId", cand(1, 100)]])
    const found = new Map([["D:/new-name", cand(1, 100)]])
    expect(matchClaims(lost, found)).toEqual(new Map([["D:/new-name", "oldId"]]))
  })

  it("dev 不同（跨卷）→ ino 判据不匹配，退到根提交", () => {
    const lost = new Map([["oldId", cand(1, 100, "rootA")]])
    const found = new Map([["E:/moved", cand(2, 100, "rootA")]])
    expect(matchClaims(lost, found)).toEqual(new Map([["E:/moved", "oldId"]]))
  })

  // FAT32/exFAT/部分网络盘上 Node 拿不到稳定文件 id，stat().ino 全是 0。
  // 拿 0 参与匹配会让所有仓库互相「相等」，把身份认串——这是最危险的一条
  it("ino 为 0 → 该判据整体作废，不得互相认领", () => {
    const lost = new Map([["a", cand(1, 0)], ["b", cand(1, 0)]])
    const found = new Map([["D:/x", cand(1, 0)], ["D:/y", cand(1, 0)]])
    expect(matchClaims(lost, found)).toEqual(new Map())
  })

  it("ino 为 0 但有根提交 → 按根提交认领", () => {
    const lost = new Map([["a", cand(1, 0, "rootA")]])
    const found = new Map([["D:/x", cand(1, 0, "rootA")]])
    expect(matchClaims(lost, found)).toEqual(new Map([["D:/x", "a"]]))
  })

  // 宁可不认，也不要认错：认错产生的是错误数据，不认只是退回现状
  it("同一判据值出现多于一次 → 全部放弃，不猜", () => {
    const lost = new Map([["a", cand(1, 100)], ["b", cand(1, 100)]])
    const found = new Map([["D:/x", cand(1, 100)], ["D:/y", cand(1, 100)]])
    expect(matchClaims(lost, found)).toEqual(new Map())
  })

  it("多个仓库同时改名，各自 ino 不同 → 全部正确认领，不串", () => {
    const lost = new Map([["a", cand(1, 100)], ["b", cand(1, 200)]])
    const found = new Map([["D:/y", cand(1, 200)], ["D:/x", cand(1, 100)]])
    expect(matchClaims(lost, found)).toEqual(new Map([["D:/x", "a"], ["D:/y", "b"]]))
  })

  it("根提交为 null 的一方不参与根提交匹配", () => {
    const lost = new Map([["a", cand(1, 100, null)]])
    const found = new Map([["D:/x", cand(2, 300, null)]])
    expect(matchClaims(lost, found)).toEqual(new Map())
  })

  it("ino 已配对的不再参与根提交匹配", () => {
    const lost = new Map([["a", cand(1, 100, "shared")], ["b", cand(1, 999, "shared")]])
    const found = new Map([["D:/x", cand(1, 100, "shared")]])
    // a 靠 ino 被认领；b 与 D:/x 不该再因为 rootCommit 相同而二次配对
    expect(matchClaims(lost, found)).toEqual(new Map([["D:/x", "a"]]))
  })

  it("没有丢失的 id → 空结果", () => {
    expect(matchClaims(new Map(), new Map([["D:/x", cand(1, 1)]]))).toEqual(new Map())
  })
})

describe("normalizePath", () => {
  it("统一分隔符与大小写", () => {
    expect(normalizePath("D:\\Repo\\A")).toBe(normalizePath("d:/repo/a"))
  })
})

describe("IdentityLedger", () => {
  it("首次见到的路径按 repoId(path) 铸造 —— 与现有 config.json 里的 id 完全一致", async () => {
    const led = new IdentityLedger(tmpFile())
    const p = join("D:", "projects", "demo")
    const ids = await led.resolve([p], noRootCommit, () => ({ dev: 1, ino: 10 }))
    expect(ids.get(p)).toBe(repoId(p))
  })

  it("已知路径复用账本里的 id", async () => {
    const file = tmpFile()
    const p = join("D:", "projects", "demo")
    const first = await new IdentityLedger(file).resolve([p], noRootCommit, () => ({ dev: 1, ino: 10 }))
    const second = await new IdentityLedger(file).resolve([p], noRootCommit, () => ({ dev: 1, ino: 10 }))
    expect(second.get(p)).toBe(first.get(p))
  })

  it("改名后沿用老 id（这是整个杠杆 4 的目的）", async () => {
    const file = tmpFile()
    const oldP = join("D:", "projects", "demo")
    const newP = join("D:", "projects", "demo-renamed")
    const led = new IdentityLedger(file)
    const before = (await led.resolve([oldP], noRootCommit, () => ({ dev: 1, ino: 42 }))).get(oldP)
    const after = (await led.resolve([newP], noRootCommit, () => ({ dev: 1, ino: 42 }))).get(newP)
    expect(after).toBe(before)
  })

  it("复制出一份副本（原仓库还在）→ 副本铸造新 id", async () => {
    const led = new IdentityLedger(tmpFile())
    const a = join("D:", "p", "a")
    const b = join("D:", "p", "b")
    await led.resolve([a], noRootCommit, () => ({ dev: 1, ino: 1 }))
    const ids = await led.resolve([a, b], noRootCommit, (p) => ({ dev: 1, ino: p === a ? 1 : 2 }))
    expect(ids.get(b)).toBe(repoId(b))
    expect(ids.get(b)).not.toBe(ids.get(a))
  })

  // 路径命中即同一仓库，不再比对 ino。理由：「删掉重新 clone 同一个仓库到原路径」很常见
  // （ino 会变），若因此作废身份，用户的标签/收藏/归档会莫名消失；而「删掉后在同一路径
  // 新建一个无关仓库」罕见得多。路径命中就用老 id，也符合「这个文件夹就是我那个项目」的直觉
  it("同一路径上 ino 变了（重新 clone / 从备份恢复）→ 仍是同一仓库，身份不变", async () => {
    const file = tmpFile()
    const p = join("D:", "p", "same-name")
    const led = new IdentityLedger(file)
    const before = (await led.resolve([p], noRootCommit, () => ({ dev: 1, ino: 1 }))).get(p)
    // 路径没变但 ino 变了：这条路径在账本里已知，直接命中——根本不进认领流程
    const after = (await led.resolve([p], noRootCommit, () => ({ dev: 1, ino: 2 }))).get(p)
    expect(after).toBe(before)
  })

  it("stat 失败（仓库不可读）不影响其它仓库的解析", async () => {
    const led = new IdentityLedger(tmpFile())
    const a = join("D:", "p", "a")
    const ids = await led.resolve([a], noRootCommit, () => null)
    expect(ids.get(a)).toBe(repoId(a))
  })

  it("prune 带年龄护栏：刚见过的条目不剪", async () => {
    const file = tmpFile()
    const led = new IdentityLedger(file)
    const p = join("D:", "p", "a")
    const id = (await led.resolve([p], noRootCommit, () => ({ dev: 1, ino: 1 }))).get(p)!
    led.prune(new Set())
    expect((await led.resolve([p], noRootCommit, () => ({ dev: 1, ino: 1 }))).get(p)).toBe(id)
  })

  it("账本损坏 → 当空账本，按路径重新铸造（退化成改造前行为）", async () => {
    const file = tmpFile()
    const { writeFileSync } = await import("node:fs")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "{{{broken")
    const p = join("D:", "p", "a")
    expect((await new IdentityLedger(file).resolve([p], noRootCommit, () => ({ dev: 1, ino: 1 }))).get(p)).toBe(repoId(p))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -w server -- tests/repo-identity.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/repo-identity"`

- [ ] **Step 3: 实现 `repo-identity.ts`**

```ts
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
  round((c) => c.rootCommit)
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

    // 认领不到的新路径：按路径铸造。这条路径也正是现有用户首次升级时全体走的路径
    for (const p of unknown) if (!out.has(p)) out.set(p, repoId(p))

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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w server -- tests/repo-identity.test.ts`
Expected: PASS（20 项全绿）

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `npm run typecheck -w server && npm test -w server`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/src/repo-identity.ts server/tests/repo-identity.test.ts
git commit -m "feat(server): 新增仓库身份账本与认领算法"
```

---

### Task 6: `RepoStore` 用账本解析 id

**Files:**
- Modify: `server/src/store.ts:62-97`（`doRefreshAll`）
- Modify: `server/src/git.ts`（新增 `rootCommit` 辅助函数）
- Modify: `server/src/backend.ts`（创建账本、prune、flush）
- Create: `server/tests/store-identity.test.ts`

**Interfaces:**
- Consumes: `IdentityLedger`（Task 5）、`refreshRepo`（Task 4）
- Produces: `rootCommit(path: string): Promise<string | null>`（`git.ts`）；`RepoStore` 构造参数新增可选第 5 参 `identity?: IdentityLedger`；`IdentityEntry` 增 `gen: number` 字段

#### 上一个任务交接过来的三条硬约束（评审确认，必须在本任务处理）

**A. 判据②必须由本任务播种，否则它 100% 不存在。**
Task 5 的 `resolve` 有一个稳定死锁：只有当某个 **lost** 候选已经带着非空 `rootCommit` 时才会去算 **found** 侧的根提交，而根提交又只在算过之后才写回账本。账本初始全是 `null` ⇒ 闸门恒假 ⇒ 永不计算 ⇒ 永远是 `null`。

修法：**铸造一个新 id 时，同时算一次根提交并写进账本**（`rootCommitOf(p)`，即 `git.ts` 的 `rootCommit`）。代价是每个**新发现**的仓库一生一次一个 git 进程——全新安装首轮 73 个仓库约多 1～2 秒，之后为零。这是判据②唯一可行的播种时机：认领发生时旧路径已经不存在，那时**算不出**它的根提交。

**B. 同轮次约束（用户拍板）：只允许认领「上一轮还活着、这一轮没了」的 id。**

背景：判据②按根提交匹配且**不能比较 `dev`**（跨卷移动时 `dev` 本来就变了，比了判据②就失去意义）。于是「C1 在线 + C2 在拔掉的移动硬盘上 + 用户把同一 upstream clone 到 C3」会让 C3 认领 C2 的身份——一一对应挡不住，因为两个 clone 分处匹配的两侧。不加约束的话这个窗口是整整 30 天（`prune` 的年龄护栏）。

做法：`IdentityEntry` 增 `gen: number`。

```ts
// 当前代 = 账本里最大代 + 1；账本为空时为 1
const currentGen = Math.max(0, ...[...this.store.entries()].map(([, e]) => e.gen ?? 0)) + 1
// 可认领的 lost：上一代还被盖过章、这一代路径没了。不是「30 天内消失过的都算」
const lostIds = [...].filter(([id, e]) => e.gen === currentGen - 1 && !livePaths.has(normalizePath(e.path)))
// 收尾：本轮所有活条目盖上 currentGen
```

代必须**持久化**（就存在条目里，别用内存计数器）——否则「关掉应用 → 改名 → 重新打开」这个主用例会坏掉，而那正是改名最常发生的时机。

自检这两条：① 全新安装（账本为空）→ 没有任何 lost，不影响「铸造结果 === `repoId(path)`」的零迁移地基；② 关掉应用改名再打开 → 上一轮盖的是 gen N，重开首轮 currentGen = N+1，`e.gen === N` 成立 → 可认领 ✓。硬盘拔掉两轮以上的仓库不再可认领，退化成丢数据（安全侧）。

`prune` 的 30 天年龄护栏**照旧不变**，它管的是存储回收，跟可认领性是两件事。

**C. `resolve` 返回的 Map 对 `paths` 不是全函数，本任务必须补全。**
Task 5 加了按 `normalizePath` 去重，但只有代表路径进了结果——同一路径的其它拼写（`D:\p\a` vs `D:/p/a`，或不同大小写）在返回的 Map 里**根本没有条目**。调用方写 `ids.get(p)!` 会拿到 `undefined`，数据被存到 `"undefined"` 键下。

修法：去重时记住 `归一化键 → 代表路径`，解析完再把每个重复拼写指回代表路径的 id。`resolve` 的文档注释目前写着「调用方不必保证 paths 已去重」，补完之后这句话才成立。

- [ ] **Step 1: 写失败测试**

创建 `server/tests/store-identity.test.ts`：

```ts
import { execFileSync } from "node:child_process"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, type Config } from "../src/config"
import { repoId } from "../src/git"
import { IdentityLedger } from "../src/repo-identity"
import { RepoStore } from "../src/store"

const dirs: string[] = []
function isolatedDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

const ledgerFile = () => join(isolatedDir("rr-sid-"), "repo-identity.json")

/**
 * 在一个**专属**父目录里建一个仓库，返回 [父目录, 仓库路径]。
 *
 * 绝对不要用 `dirname(makeRepo())` 当 scan root——`makeRepo` 建在 `tmpdir()` 下，
 * 它的 dirname 就是 `tmpdir()` 本身。拿它当 root，整套测试并行跑时会把**其它测试的
 * 临时仓库全部扫进来**：既慢又互相干扰，任何针对数量或内容的断言都会随机挂掉。
 */
function repoInOwnRoot(name = "demo"): [string, string] {
  const parent = isolatedDir("rr-root-")
  const repo = join(parent, name)
  execFileSync("git", ["init", "-b", "main", repo])
  execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: repo })
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo })
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo })
  writeFileSync(join(repo, "a.txt"), "1")
  execFileSync("git", ["add", "-A"], { cwd: repo })
  execFileSync("git", ["commit", "-m", "c0"], { cwd: repo })
  return [parent, repo]
}

describe("RepoStore + 身份账本", () => {
  // 现有用户升级时账本为空。这一条挂了就意味着所有人的标签/收藏/归档在升级瞬间全丢
  it("账本为空时，id 与 repoId(路径) 完全一致（向后兼容）", async () => {
    const [parent, repo] = repoInOwnRoot()
    const cfg: Config = { ...DEFAULT_CONFIG, roots: [parent] }
    const store = new RepoStore(() => cfg, undefined, undefined, undefined, new IdentityLedger(ledgerFile()))
    const list = await store.refreshAll()
    expect(list.find((r) => r.path === repo)?.id).toBe(repoId(repo))
  })

  it("改名后 id 不变，标签/收藏/归档/便签全部保留", async () => {
    const [parent, repo] = repoInOwnRoot()
    const cfg: Config = { ...DEFAULT_CONFIG, roots: [parent] }
    const store = new RepoStore(() => cfg, undefined, undefined, undefined, new IdentityLedger(ledgerFile()))

    const before = (await store.refreshAll()).find((r) => r.path === repo)!
    // 用户给它打上标签、收藏、归档、便签
    cfg.tags[before.id] = ["app"]
    cfg.favorites.push(before.id)
    cfg.archived.push(before.id)
    cfg.notes[before.id] = "记一笔"

    const renamed = join(parent, "demo-renamed")
    renameSync(repo, renamed)

    const after = (await store.refreshAll()).find((r) => r.path === renamed)!
    expect(after.id).toBe(before.id)
    expect(after.tags).toEqual(["app"])
    expect(after.favorite).toBe(true)
    expect(after.archived).toBe(true)
    expect(after.note).toBe("记一笔")
  })

  // 不传账本时必须完全退化成改造前的行为，便于回退与嵌入式用法
  it("未提供账本时按路径算 id（旧行为）", async () => {
    const [parent, repo] = repoInOwnRoot()
    const cfg: Config = { ...DEFAULT_CONFIG, roots: [parent] }
    const list = await new RepoStore(() => cfg).refreshAll()
    expect(list.find((r) => r.path === repo)?.id).toBe(repoId(repo))
  })

  it("新增一个仓库不影响已有仓库的 id", async () => {
    const [parent, a] = repoInOwnRoot("a")
    const cfg: Config = { ...DEFAULT_CONFIG, roots: [parent] }
    const store = new RepoStore(() => cfg, undefined, undefined, undefined, new IdentityLedger(ledgerFile()))
    const idA = (await store.refreshAll()).find((r) => r.path === a)!.id
    execFileSync("git", ["init", "-b", "main", join(parent, "b")])
    expect((await store.refreshAll()).find((r) => r.path === a)!.id).toBe(idA)
  })
})
```

- [ ] **Step 1b: 给交接的三条约束各写失败测试**

追加到 `server/tests/repo-identity.test.ts`（它们测的是账本本身，不是 store）：

```ts
describe("判据②的播种与同轮次约束", () => {
  // 约束 A：不在铸造时算根提交，判据②就是一段永远跑不到的死代码
  it("铸造新 id 时把根提交写进账本", async () => {
    const led = new IdentityLedger(tmpFile())
    const p = join("D:", "p", "fresh")
    await led.resolve([p], async () => "rootXYZ", () => st(1, 10))
    expect(led.get((await led.resolve([p], async () => null, () => st(1, 10))).get(p)!)?.rootCommit).toBe("rootXYZ")
  })

  // 约束 A 的收益：播种之后，跨卷移动（dev 变了、ino 也变了）才认得出来
  it("播种过根提交后，跨卷移动仍能认领", async () => {
    const file = tmpFile()
    const oldP = join("D:", "p", "movable")
    const newP = join("E:", "elsewhere", "movable")
    const led = new IdentityLedger(file)
    const before = (await led.resolve([oldP], async () => "rootMOVE", () => st(1, 10))).get(oldP)
    const after = (await led.resolve([newP], async () => "rootMOVE", () => st(2, 99))).get(newP)
    expect(after).toBe(before)
  })

  // 约束 B：上一轮还活着、这一轮没了的才可认领
  it("上一轮消失的可以认领（关掉应用改名再打开）", async () => {
    const file = tmpFile()
    const oldP = join("D:", "p", "a")
    const newP = join("D:", "p", "a-renamed")
    const led = new IdentityLedger(file)
    const before = (await led.resolve([oldP], async () => null, () => st(1, 42))).get(oldP)
    // 新实例 = 重启；代必须是持久化的，否则这条会挂
    const after = (await new IdentityLedger(file).resolve([newP], async () => null, () => st(1, 42))).get(newP)
    expect(after).toBe(before)
  })

  it("连续两轮没扫到的仓库不再可认领（硬盘拔了很久）", async () => {
    const file = tmpFile()
    const gone = join("D:", "p", "on-usb")
    const other = join("D:", "p", "other")
    const led = new IdentityLedger(file)
    const goneId = (await led.resolve([gone, other], async () => null, (p) => st(1, p === gone ? 42 : 7))).get(gone)
    await led.resolve([other], async () => null, () => st(1, 7)) // 第 1 轮不见
    await led.resolve([other], async () => null, () => st(1, 7)) // 第 2 轮仍不见 → 过期
    const back = join("D:", "p", "came-back")
    const newId = (await led.resolve([other, back], async () => null, (p) => st(1, p === back ? 42 : 7))).get(back)
    expect(newId).not.toBe(goneId) // 隔了太久，不认
  })

  // 约束 C：返回的 Map 对每个输入路径都要有条目
  it("重复拼写的路径都能取到同一个 id", async () => {
    const led = new IdentityLedger(tmpFile())
    const a = join("D:", "p", "dup")
    const b = a.replace(/\\/g, "/")
    const ids = await led.resolve([a, b], async () => null, () => st(1, 5))
    expect(ids.get(a)).toBeDefined()
    expect(ids.get(b)).toBe(ids.get(a)) // 而不是 undefined
  })
})
```

（`tmpFile()`、`st()`、`cand()` 沿用该文件已有的辅助函数；`st(dev, ino)` 返回 `{ dev: String(dev), ino: String(ino) }`——Task 5 已把 schema 改成字符串。）

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w server -- tests/store-identity.test.ts tests/repo-identity.test.ts`
Expected: FAIL —— `RepoStore` 尚不接受第 5 个构造参数；改名后 id 会变；上面五条新用例全红（根提交没播种、没有 gen 字段、重复拼写取不到 id）

- [ ] **Step 3: 在 `git.ts` 加根提交辅助函数**

在 `server/src/git.ts` 的 `repoId` 附近追加：

```ts
/**
 * 仓库的根提交 hash（第一个没有父提交的 commit）。跨卷移动、从备份恢复、以及
 * `stat().ino` 不可用的文件系统上，这是识别「同一个仓库换了路径」的唯一判据。
 *
 * 只在身份认领时按需调用，日常扫描不跑。空仓库、多根提交、或命令失败一律返回 null，
 * 由认领逻辑当作「此判据不可用」处理（宁可不认，也不要认错）。
 */
export async function rootCommit(path: string): Promise<string | null> {
  try {
    const r = await runGit(path, ["rev-list", "--max-parents=0", "HEAD"])
    const lines = splitLines(r)
    return lines.length === 1 ? lines[0] : null // 多个根提交无法唯一标识，弃用
  } catch {
    return null
  }
}
```

- [ ] **Step 4: 改 `store.ts` 用账本解析 id**

在 import 中加入：

```ts
import { composeStatus, getRepoCore, getRepoHeavy, repoId, rootCommit } from "./git"
import type { IdentityLedger } from "./repo-identity"
```

构造函数追加第 5 个可选参数：

```ts
    // 可选：身份账本。不传时 id 仍按路径算（改造前行为），改名会丢失用户数据
    private readonly identity?: IdentityLedger,
```

把 `doRefreshAll` 里这一段：

```ts
    const paths = [...new Set([...scan(cfg.roots, cfg.excludes), ...cfg.manualRepos])]
```

改为：

```ts
    const paths = [...new Set([...scan(cfg.roots, cfg.excludes), ...cfg.manualRepos])]
    // 路径 → id。账本负责在仓库改名时把新路径认回老 id，从而让 config.json 里
    // 按 id 存的标签/收藏/归档/便签/分组一个字节都不用改
    const idByPath = this.identity
      ? await this.identity.resolve(paths, rootCommit)
      : new Map(paths.map((p) => [p, repoId(p)]))
```

并把 `mapLimit` 回调里的

```ts
        const fresh = await this.refreshRepo(p, repoId(p))
```

改为

```ts
        const fresh = await this.refreshRepo(p, idByPath.get(p) ?? repoId(p))
```

同时把 `errorStatus` 的调用改成带 id：

```ts
        status = this.errorStatus(p, cfg, err, idByPath.get(p) ?? repoId(p))
```

并把 `errorStatus` 的签名改为：

```ts
  private errorStatus(path: string, cfg: Config, err: unknown, id: string = repoId(path)): RepoStatus {
```

把它内部的 `id: repoId(path)` 改成 `id,`。

- [ ] **Step 5: 在 `backend.ts` 里接上账本**

创建账本（紧挨 `repoCache` 的创建处）：

```ts
  const identity = new IdentityLedger(join(dirname(configFile), "repo-identity.json"))
```

`RepoStore` 构造补第 5 个参数 `identity`；`doRescanAndWatch` 的 prune 段加 `identity.prune(ids)`；退出路径的 flush 段加 `identity.flush()`。

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test -w server -- tests/store-identity.test.ts`
Expected: PASS

- [ ] **Step 7: 全量测试 + 类型检查**

Run: `npm run typecheck -w server && npm test -w server`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add server/src/store.ts server/src/git.ts server/src/backend.ts server/tests/store-identity.test.ts
git commit -m "feat(server): 仓库 id 与路径解耦，改名不再丢失标签与归档"
```

---

### Task 7: 监听策略化——`watch-strategy.ts` 与 `watcher.ts` 重写

**Files:**
- Create: `server/src/watch-strategy.ts`
- Modify: `server/src/watcher.ts`（保留 `shouldIgnorePath` / `watcherErrorIsNoise` 与防抖/冷却/串行链，替换监听机制与归属逻辑）
- Create: `server/tests/watch-strategy.test.ts`
- Modify: `server/tests/watcher.test.ts`（现有用例改用新 API）

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface WatchedRepo { id: string; path: string }`
  - `interface StrategyHandlers { onEvent(absPath: string): void; onOverflow(reason: string): void; onError(err: NodeJS.ErrnoException, targets: readonly string[]): void }`
  - `interface WatchStrategy { start(roots: readonly string[], repos: readonly WatchedRepo[], h: StrategyHandlers): Promise<string[]>; stop(): Promise<void> }`
  - `class RecursiveRootStrategy implements WatchStrategy`
  - `class PerRepoStrategy implements WatchStrategy`
  - `defaultStrategy(): WatchStrategy` —— 按 `process.platform` 选，win32/darwin 用递归、其余用逐仓库
  - `RepoWatcher` 新 API：`setRoots(roots: string[], repos: WatchedRepo[]): Promise<void>`、`setRepos(repos: WatchedRepo[]): void`、`close(): Promise<void>`、`watchedRoots(): string[]`
  - `RepoWatcher` 构造签名：`new RepoWatcher(onRepoChanged, onStructureChanged, debounceMs?, cooldownMs?, strategy?)`

**核心收益**：实测 73 个仓库下，`PerRepoStrategy` 要挂 2311 个目录句柄、建立时 2238 次 readdir + 32780 次 stat；`RecursiveRootStrategy` 是 1 个句柄、0 次 readdir、2ms。

- [ ] **Step 1: 写策略的失败测试**

创建 `server/tests/watch-strategy.test.ts`：

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { PerRepoStrategy, RecursiveRootStrategy, defaultStrategy } from "../src/watch-strategy"
import { cleanupFixtures, makeRepo } from "./fixtures"

afterAll(cleanupFixtures)

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "rr-root-"))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve() }
      else if (Date.now() - start > timeoutMs) { clearInterval(timer); reject(new Error("waitFor timeout")) }
    }, 50)
  })
}

const noopHandlers = (events: string[]) => ({
  onEvent: (p: string) => events.push(p),
  onOverflow: () => {},
  onError: () => {},
})

describe("RecursiveRootStrategy", () => {
  it.runIf(process.platform === "win32" || process.platform === "darwin")(
    "监听 root，收到 root 底下深层文件的事件（绝对路径）",
    async () => {
      const root = tmpRoot()
      mkdirSync(join(root, "a", "b"), { recursive: true })
      const events: string[] = []
      const s = new RecursiveRootStrategy()
      const ok = await s.start([root], [], noopHandlers(events))
      expect(ok).toEqual([root])
      await new Promise((r) => setTimeout(r, 200))
      writeFileSync(join(root, "a", "b", "deep.txt"), "x")
      await waitFor(() => events.some((p) => p.endsWith("deep.txt")))
      expect(events.every((p) => p.startsWith(root))).toBe(true)
      await s.stop()
    },
  )

  it.runIf(process.platform === "win32" || process.platform === "darwin")(
    "root 不存在 → 不在返回的成功列表里，且不抛",
    async () => {
      const s = new RecursiveRootStrategy()
      const ok = await s.start([join(tmpRoot(), "no-such-dir")], [], noopHandlers([]))
      expect(ok).toEqual([])
      await s.stop()
    },
  )

  it.runIf(process.platform === "win32" || process.platform === "darwin")(
    "stop 之后不再有事件",
    async () => {
      const root = tmpRoot()
      const events: string[] = []
      const s = new RecursiveRootStrategy()
      await s.start([root], [], noopHandlers(events))
      await new Promise((r) => setTimeout(r, 200))
      await s.stop()
      writeFileSync(join(root, "after.txt"), "x")
      await new Promise((r) => setTimeout(r, 400))
      expect(events).toEqual([])
    },
  )
})

describe("PerRepoStrategy", () => {
  it("监听仓库，收到工作区改动事件", async () => {
    const repo = makeRepo()
    const events: string[] = []
    const s = new PerRepoStrategy()
    await s.start([], [{ id: "R", path: repo }], noopHandlers(events))
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(repo, "w.txt"), "x")
    await waitFor(() => events.length > 0)
    await s.stop()
  })

  it("stop 之后不再有事件", async () => {
    const repo = makeRepo()
    const events: string[] = []
    const s = new PerRepoStrategy()
    await s.start([], [{ id: "R", path: repo }], noopHandlers(events))
    await new Promise((r) => setTimeout(r, 300))
    await s.stop()
    writeFileSync(join(repo, "after.txt"), "x")
    await new Promise((r) => setTimeout(r, 600))
    expect(events).toEqual([])
  })
})

describe("defaultStrategy", () => {
  it("win32/darwin 用递归策略，其余用逐仓库策略", () => {
    const s = defaultStrategy()
    const expectRecursive = process.platform === "win32" || process.platform === "darwin"
    expect(s instanceof RecursiveRootStrategy).toBe(expectRecursive)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w server -- tests/watch-strategy.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `watch-strategy.ts`**

```ts
import { watch as chokidarWatch, type FSWatcher } from "chokidar"
import { realpathSync, watch as fsWatch, type FSWatcher as NodeWatcher } from "node:fs"
import { join, resolve } from "node:path"
import { shouldIgnorePath } from "./watch-filter"

export interface WatchedRepo {
  id: string
  path: string
}

export interface StrategyHandlers {
  /** 事件路径一律给绝对路径，归属判断由 RepoWatcher 统一做 */
  onEvent(absPath: string): void
  /** 内核缓冲区溢出等「事件已经丢了」的信号。调用方应当触发一轮全量重扫补票 */
  onOverflow(reason: string): void
  onError(err: NodeJS.ErrnoException, targets: readonly string[]): void
}

export interface WatchStrategy {
  /** 建立监听，返回**实际成功建立监听**的路径列表（coverage 要如实反映，不能装作全覆盖） */
  start(roots: readonly string[], repos: readonly WatchedRepo[], h: StrategyHandlers): Promise<string[]>
  stop(): Promise<void>
}

/**
 * win32 / darwin：每个 scan root 一个 `fs.watch(root, { recursive: true })`。
 *
 * Windows 的 ReadDirectoryChangesW 子树模式与 macOS 的 FSEvents 都是内核级递归，
 * 一个句柄覆盖整棵树，建立时不需要遍历目录。实测 73 个仓库：逐仓库方案要挂 2311 个
 * 目录句柄、建立时 2238 次 readdir + 32780 次 stat；这里是 1 个句柄、2ms。
 *
 * 代价是内核不再帮我们过滤 node_modules —— 构建期这些事件会送到 JS 里做字符串判断。
 * 实测后台构建约 100 事件/秒，量级上无关紧要。真正要防的是缓冲区溢出丢事件，
 * 由 onOverflow + 兜底重扫覆盖。
 */
export class RecursiveRootStrategy implements WatchStrategy {
  private watchers: NodeWatcher[] = []

  async start(roots: readonly string[], repos: readonly WatchedRepo[], h: StrategyHandlers): Promise<string[]> {
    const ok: string[] = []
    // roots 之外的 manualRepos 也要各挂一个（数量本就很少）
    const targets = [...new Set([...roots, ...repos.map((r) => r.path).filter((p) => !roots.some((root) => isUnder(p, root)))])]
    for (const target of targets) {
      try {
        // Windows 8.3 短名路径会触发 libuv fs-event 的断言崩溃（整个进程 abort、无法 try/catch），
        // 且事件路径的形式必须与归属映射里的一致——监听前统一解析成规范长名
        const real = realpathSync.native(target)
        const w = fsWatch(real, { recursive: true }, (_event, name) => {
          // name 为 null = 内核缓冲区溢出，这一批事件已经丢了，必须靠重扫补票
          if (name === null) {
            h.onOverflow(`recursive watch overflow at ${real}`)
            return
          }
          h.onEvent(join(real, name.toString()))
        })
        w.on("error", (err) => {
          const e = err as NodeJS.ErrnoException
          // 溢出在部分平台走 error 通道
          if (e.code === "EPERM" || e.code === "ENOENT") h.onOverflow(`recursive watch lost at ${real}: ${e.code}`)
          h.onError(e, targets)
        })
        this.watchers.push(w)
        ok.push(target)
      } catch (err) {
        // 单个 root 挂不上不该拖垮其它 root。它不在返回列表里 → coverage 会如实变低
        h.onError(err as NodeJS.ErrnoException, targets)
      }
    }
    return ok
  }

  async stop(): Promise<void> {
    for (const w of this.watchers.splice(0)) w.close()
  }
}

/**
 * linux：保留改造前的逐仓库方案。
 *
 * 不换成递归的原因：Node 在 Linux 上的 `recursive: true` 是**用户态实现**——它自己递归遍历
 * 并为每个目录加 inotify watch，且不接受 ignore 列表，于是每个 node_modules 都会被挂上，
 * 比现状更糟并可能撞上 fs.inotify.max_user_watches。Linux 上目录也不会被句柄锁住，
 * 逐仓库方案本来就工作良好。
 */
export class PerRepoStrategy implements WatchStrategy {
  private watcher: FSWatcher | null = null

  async start(_roots: readonly string[], repos: readonly WatchedRepo[], h: StrategyHandlers): Promise<string[]> {
    const resolved = repos.map((r) => {
      try {
        return { ...r, path: realpathSync.native(r.path) }
      } catch {
        return r
      }
    })
    const targets = resolved.flatMap((r) => [
      join(r.path, ".git", "HEAD"),
      join(r.path, ".git", "index"),
      join(r.path, ".git", "refs"),
      r.path,
    ])
    if (targets.length === 0) return []
    const roots = resolved.map((r) => r.path)
    this.watcher = chokidarWatch(targets, {
      ignoreInitial: true,
      depth: 2,
      ignored: (p) => shouldIgnorePath(p, roots),
    })
    this.watcher.on("all", (_event, file) => h.onEvent(file))
    this.watcher.on("error", (err) => h.onError(err as NodeJS.ErrnoException, targets))
    return resolved.map((r) => r.path)
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
  }
}

/** 前缀必须停在分隔符上：裸 startsWith 会让 `D:\repo` 认领 `D:\repo-other` */
function isUnder(p: string, root: string): boolean {
  const a = resolve(p)
  const b = resolve(root)
  return a === b || (a.startsWith(b) && /[\\/]/.test(a[b.length] ?? ""))
}

export function defaultStrategy(): WatchStrategy {
  return process.platform === "win32" || process.platform === "darwin"
    ? new RecursiveRootStrategy()
    : new PerRepoStrategy()
}
```

- [ ] **Step 4: 运行策略测试确认通过**

Run: `npm test -w server -- tests/watch-strategy.test.ts`
Expected: PASS

- [ ] **Step 5: 写 `RepoWatcher` 新 API 的失败测试**

在 `server/tests/watcher.test.ts` 顶部把 import 改成：

```ts
import { RepoWatcher, shouldIgnorePath, watcherErrorIsNoise } from "../src/watcher"
import { PerRepoStrategy } from "../src/watch-strategy"
```

把现有 7 个 `RepoWatcher` 用例里的构造与调用改成新 API —— 逐仓库策略显式注入，保证这批用例在三个平台上行为一致：

```ts
    const watcher = new RepoWatcher((id) => fired.push(id), () => {}, 200, 2000, new PerRepoStrategy())
    await watcher.setRoots([], [{ id: "A", path: repoA }, { id: "B", path: repoB }])
```

（`watcher.watch(list)` → `watcher.setRoots([], list)`；其余断言一律不动。）

在文件末尾追加归属映射与结构变化的新用例：

```ts
describe("RepoWatcher — 归属映射", () => {
  it("setRepos 不重建监听（零 syscall）", async () => {
    const repo = makeRepo()
    let starts = 0
    const fake = {
      async start() { starts++; return [] },
      async stop() {},
    }
    const w = new RepoWatcher(() => {}, () => {}, 50, 100, fake)
    await w.setRoots([], [{ id: "A", path: repo }])
    expect(starts).toBe(1)
    w.setRepos([{ id: "A", path: repo }, { id: "B", path: repo + "-x" }])
    w.setRepos([])
    expect(starts).toBe(1) // 仓库列表变了三次，监听一次都没重建
    await w.close()
  })

  it("嵌套仓库按最深路径归属", async () => {
    const outer = join("D:", "work", "outer")
    const inner = join(outer, "vendor", "inner")
    const fired: string[] = []
    const fake = { async start() { return [] }, async stop() {} }
    const w = new RepoWatcher((id) => fired.push(id), () => {}, 10, 0, fake)
    await w.setRoots([], [{ id: "OUTER", path: outer }, { id: "INNER", path: inner }])
    w.handleEventForTest(join(inner, "src", "a.ts"))
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toEqual(["INNER"])
    await w.close()
  })

  // 裸 startsWith 会让 D:\repo 认领 D:\repo-other 的事件，那个仓库的刷新会记到别人头上
  it("前缀必须停在分隔符上", async () => {
    const repo = join("D:", "work", "repo")
    const fired: string[] = []
    const fake = { async start() { return [] }, async stop() {} }
    const w = new RepoWatcher((id) => fired.push(id), () => {}, 10, 0, fake)
    await w.setRoots([], [{ id: "R", path: repo }])
    w.handleEventForTest(join("D:", "work", "repo-other", "a.ts"))
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toEqual([])
    await w.close()
  })

  it("落在已知仓库之外的事件 → 报告结构变化", async () => {
    const repo = join("D:", "work", "repo")
    const structural: number[] = []
    const fake = { async start() { return [] }, async stop() {} }
    const w = new RepoWatcher(() => {}, () => structural.push(1), 10, 0, fake)
    await w.setRoots([join("D:", "work")], [{ id: "R", path: repo }])
    w.handleEventForTest(join("D:", "work", "brand-new-project", ".git"))
    expect(structural.length).toBe(1)
    await w.close()
  })

  it("被忽略目录里的事件既不刷新也不报结构变化", async () => {
    const repo = join("D:", "work", "repo")
    const fired: string[] = []
    const structural: number[] = []
    const fake = { async start() { return [] }, async stop() {} }
    const w = new RepoWatcher((id) => fired.push(id), () => structural.push(1), 10, 0, fake)
    await w.setRoots([join("D:", "work")], [{ id: "R", path: repo }])
    w.handleEventForTest(join(repo, "node_modules", "x", "index.js"))
    await new Promise((r) => setTimeout(r, 60))
    expect(fired).toEqual([])
    expect(structural).toEqual([])
    await w.close()
  })
})
```

- [ ] **Step 6: 运行确认失败**

Run: `npm test -w server -- tests/watcher.test.ts`
Expected: FAIL —— `setRoots` / `setRepos` / `handleEventForTest` 不存在

- [ ] **Step 7: 重写 `watcher.ts`**

**先拆过滤函数，再改 `RepoWatcher`。** 把 `IGNORED_DIRS`、`shouldIgnorePath`、`watcherErrorIsNoise`、`samePath` 四段**连注释逐字**移到新文件 `server/src/watch-filter.ts`——`watch-strategy.ts` 要用 `shouldIgnorePath`，而 `watcher.ts` 要用 `defaultStrategy`，不拆出来就是循环依赖。然后在 `watcher.ts` 顶部加一行再导出，保持现有测试的 import 路径不变：

```ts
export { shouldIgnorePath, watcherErrorIsNoise } from "./watch-filter"
```

`watch-strategy.ts` 里的 `import { shouldIgnorePath } from "./watcher"` 相应改成 `from "./watch-filter"`。

然后把 `RepoWatcher` 换成：

```ts
import { resolve } from "node:path"
import { defaultStrategy, type WatchedRepo, type WatchStrategy } from "./watch-strategy"

export type { WatchedRepo }

/** 路径键归一化：Windows 大小写不敏感，且同一目录可能以不同大小写回报 */
function pathKey(p: string): string {
  const r = resolve(p)
  return process.platform === "win32" ? r.toLowerCase() : r
}

/**
 * 文件监听：仓库有变化时通知刷新。两段窗口，任何真实变更都不会被丢弃：
 * - 非冷却期：防抖 debounceMs，合并连发事件后触发一次
 * - 冷却期内（触发后 cooldownMs）：真实变更延迟到冷却结束统一补一次（合并，不丢弃）
 *
 * 不再需要 echo 窗口来抑制自反馈——getRepoStatus 用 `git --no-optional-locks status`
 * 读状态，不会写 .git/index，因此刷新本身不产生文件事件，也就不会自我循环。
 *
 * 「监听什么」与「有哪些仓库」是分开的：setRoots 才建立监听（罕见），setRepos 只更新
 * 归属映射（纯 JS、零 syscall）。改造前每轮兜底重扫都要把几千个句柄拆了重建，
 * 那是实测里最贵的一笔开销。
 */
export class RepoWatcher {
  private repos: WatchedRepo[] = []
  private byKey = new Map<string, string>() // 归一化仓库路径 → id
  private roots: string[] = []
  private okRoots: string[] = []
  private started = false
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private cooldownUntil = new Map<string, number>()
  // start()/stop() 的串行链。两者交错时（定时重扫撞上 PUT /api/config 的重装），
  // 后到者会在先到者刚赋完引用之后把它置空——那个实例从此没人能关，一直发事件：
  // 关掉自动扫描后看板还在刷新，句柄攒到 EMFILE。
  // await 点两侧的「读-改-写」没有原子性可言，唯一稳的办法是让这两个操作排队
  private ops: Promise<void> = Promise.resolve()

  constructor(
    private readonly onRepoChanged: (repoId: string) => void,
    /** 目录结构变化（新仓库出现 / 老仓库消失或改名 / 监听溢出）。调用方应防抖后触发一轮重扫 */
    private readonly onStructureChanged: (reason: string) => void,
    private readonly debounceMs = 500,
    private readonly cooldownMs = 60_000,
    private readonly strategy: WatchStrategy = defaultStrategy(),
  ) {}

  private serialize(op: () => Promise<void>): Promise<void> {
    const run = this.ops.then(op)
    this.ops = run.catch(() => {}) // 一次失败不能把链卡死
    return run
  }

  /** 建立/重建监听。只在 roots 或 manualRepos 真的变化时调用 */
  setRoots(roots: string[], repos: WatchedRepo[]): Promise<void> {
    return this.serialize(async () => {
      await this.strategy.stop()
      this.roots = roots
      this.indexRepos(repos)
      this.okRoots = await this.strategy.start(roots, repos, {
        onEvent: (p) => this.handle(p),
        onOverflow: (reason) => this.onStructureChanged(reason),
        onError: (err, targets) => {
          if (watcherErrorIsNoise(err, targets)) return
          console.error(`[repo-radar] 监听器错误：${err.message}`)
        },
      })
      this.started = true
    })
  }

  /** 仓库列表变化：纯 JS 改映射表，不碰任何句柄。定时器一律留着——它们只是 setTimeout
   *  句柄，跟监听实例无关；整轮丢弃会把「已经收下、还没触发」的变更连同定时器一起吞掉 */
  setRepos(repos: WatchedRepo[]): void {
    this.indexRepos(repos)
    this.forgetExcept(new Set(repos.map((r) => r.id)))
  }

  private indexRepos(repos: WatchedRepo[]): void {
    // 最长前缀优先，嵌套仓库归属到最深的那个
    this.repos = [...repos].sort((a, b) => b.path.length - a.path.length)
    this.byKey = new Map(this.repos.map((r) => [pathKey(r.path), r.id]))
  }

  /** 实际被监听覆盖的仓库数——某个 root 挂不上时必须如实变低，不能装作全覆盖 */
  coveredRepoCount(): number {
    if (!this.started) return 0
    return this.repos.filter((r) => this.okRoots.some((root) => pathKey(r.path).startsWith(pathKey(root)) || pathKey(r.path) === pathKey(root))).length
  }

  watchedRoots(): string[] {
    return [...this.okRoots]
  }

  /** 测试专用入口：绕过真实文件系统直接投喂一个事件路径 */
  handleEventForTest(absPath: string): void {
    this.handle(absPath)
  }

  private handle(file: string): void {
    const repo = this.findRepo(file)
    if (!repo) {
      // 事件落在所有已知仓库之外：可能是新克隆的仓库、被改名的仓库、或刚删掉的仓库。
      // 改造前这类变化要等最长 30 分钟的兜底重扫才被发现
      if (!shouldIgnorePath(file, this.roots)) this.onStructureChanged(`unowned path: ${file}`)
      return
    }
    if (shouldIgnorePath(file, [repo.path])) return
    const now = Date.now()
    const cooldownEnd = this.cooldownUntil.get(repo.id) ?? 0
    if (now < cooldownEnd) {
      // 冷却期内的变更：延迟到冷却结束统一补一次（不丢弃）
      if (!this.pendingTimers.has(repo.id)) {
        this.pendingTimers.set(
          repo.id,
          setTimeout(() => {
            this.pendingTimers.delete(repo.id)
            this.fire(repo.id)
          }, cooldownEnd - now),
        )
      }
      return
    }
    clearTimeout(this.debounceTimers.get(repo.id))
    this.debounceTimers.set(
      repo.id,
      setTimeout(() => {
        this.debounceTimers.delete(repo.id)
        this.fire(repo.id)
      }, this.debounceMs),
    )
  }

  /**
   * 事件路径 → 所属仓库。逐段向上查表，O(≤路径深度) 次哈希查找。
   * 改造前是对仓库数组做 startsWith 线性扫描——递归监听的事件量大得多，这条热路径必须便宜。
   */
  private findRepo(file: string): WatchedRepo | undefined {
    let cur = resolve(file)
    for (;;) {
      const id = this.byKey.get(pathKey(cur))
      if (id !== undefined) return this.repos.find((r) => r.id === id)
      const parent = resolve(cur, "..")
      if (parent === cur) return undefined
      cur = parent
    }
  }

  private fire(repoId: string): void {
    this.cooldownUntil.set(repoId, Date.now() + this.cooldownMs)
    this.onRepoChanged(repoId)
  }

  /** 彻底停止：定时器一并丢弃。用于用户关掉自动扫描和进程退出——这两种情况下
   *  「还没触发的刷新」本来就不该再发生，与 setRoots 里的重建是两回事 */
  close(): Promise<void> {
    return this.serialize(async () => {
      for (const t of this.debounceTimers.values()) clearTimeout(t)
      for (const t of this.pendingTimers.values()) clearTimeout(t)
      this.debounceTimers.clear()
      this.pendingTimers.clear()
      this.cooldownUntil.clear()
      this.okRoots = []
      this.started = false
      await this.strategy.stop()
    })
  }

  /** 丢掉已不在监听列表里的仓库的定时器/冷却记录（仓库被删或被排除后不再需要，
   *  留着既会对着不存在的仓库触发刷新，也会让这几个 Map 只增不减） */
  private forgetExcept(keep: Set<string>): void {
    for (const [id, t] of this.debounceTimers) {
      if (keep.has(id)) continue
      clearTimeout(t)
      this.debounceTimers.delete(id)
    }
    for (const [id, t] of this.pendingTimers) {
      if (keep.has(id)) continue
      clearTimeout(t)
      this.pendingTimers.delete(id)
    }
    for (const id of [...this.cooldownUntil.keys()]) if (!keep.has(id)) this.cooldownUntil.delete(id)
  }
}
```

- [ ] **Step 8: 运行 watcher 测试确认通过**

Run: `npm test -w server -- tests/watcher.test.ts tests/watch-strategy.test.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add server/src/watch-strategy.ts server/src/watch-filter.ts server/src/watcher.ts server/tests/watch-strategy.test.ts server/tests/watcher.test.ts
git commit -m "perf(watcher): 监听改为按平台选策略，win/mac 每个 root 一个递归句柄"
```

---

### Task 8: `automation` / `backend` 解耦——重扫不再重建监听

**Files:**
- Modify: `server/src/automation.ts:29-44`（接口）、`:108-132`（`applyWatch`）
- Modify: `server/src/backend.ts:226-244`（`doRescanAndWatch`）、`:200-215`（watcher 创建处）
- Modify: `server/tests/automation.test.ts`

**Interfaces:**
- Consumes: `RepoWatcher.setRoots` / `setRepos` / `coveredRepoCount`（Task 7）
- Produces: `Automation.applyRepos(repos: RepoStatus[]): void`；`Automation.applyWatch(enabled, repos?)` 语义收窄为「按开关装/拆」

#### 上一个任务交接过来的三条（前两条是硬要求）

**A. 结构变化触发的那一轮重扫，收尾必须走能重建监听的路径，不能只走 `applyRepos`。**

上一个任务把「监听目标本身失守」的判定从「按错误码白名单」改成了「**不看错误码**，只看出事的路径是不是监听目标本身」——因为 Node 的 `fs.watch` 在 emit `error` **之前**就把句柄关了，所以 EMFILE、EIO、FSEvents 失败之后那棵树同样是死的，不只是 EPERM/ENOENT。

于是现在 `onOverflow` 收到的信号里包含「这棵树已经死了」这一类，而**重建监听是唯一能救回它的动作**。本任务的主旨恰恰是「重扫不再重建监听」，两者直接冲突：若把结构变化也收窄成只调 `applyRepos`，等于把这些信号收下又扔掉——那个 root 下的所有仓库会在进程余下的生命周期里静默冻结，而周期兜底重扫是用户可以关掉的（`autoScanMinutes = 0` 是受支持的配置）。

做法：把「普通重扫」与「结构变化/溢出触发的重扫」分开。前者收尾调 `applyRepos`（纯 JS，本任务的性能收益所在）；后者收尾调 `applyWatch`（重建监听）。结构变化本来就已经防抖 2 秒且下游有队列去重，重建的频率不会失控。

**B. `coverage()` 必须改成取自 watcher 的真实覆盖数。**
`coveredRepoCount()` / `watchedRoots()` 目前**没有生产调用方**，`automation.coverage()` 仍返回 `chosen.length`——也就是「本该监听的数量」而不是「实际挂上的数量」。某个 root 挂不上时界面照旧显示全覆盖，这正是规格里明令禁止的「装作还在监听」。

**C.（Minor，可延后）** 位于 scan root 之下、但被 `excludes` 排除的仓库若持续写入，会每 2 秒触发一轮重扫。需要一段「重扫后冷却」，但要避免与本任务自己的防抖语义打架。若本轮不做，记进账本交给最终评审分诊。

- [ ] **Step 1: 写失败测试**

在 `server/tests/automation.test.ts` 末尾追加：

```ts
describe("重扫不重建监听", () => {
  it("applyRepos 只更新映射表，不调用 setRoots", async () => {
    let setRootsCalls = 0
    let setReposCalls = 0
    const watcher = {
      setRoots: async () => { setRootsCalls++ },
      setRepos: () => { setReposCalls++ },
      close: async () => {},
      coveredRepoCount: () => 2,
      watchedRoots: () => ["/root"],
    } as unknown as RepoWatcher

    const auto = createAutomation({
      configFile: writeTempConfig({ autoWatch: true, roots: ["/root"] }),
      watcher,
      listRepos: () => [],
      rescan: async () => [],
      fetchAll: async () => {},
      log: () => {},
    })

    await auto.applyWatch(true, [])
    expect(setRootsCalls).toBe(1)

    auto.applyRepos([])
    auto.applyRepos([])
    expect(setRootsCalls).toBe(1) // 重扫了两轮，监听一次都没重建
    expect(setReposCalls).toBe(2)
  })

  it("coverage 取自 watcher 的真实覆盖数，root 挂不上时如实变低", async () => {
    const watcher = {
      setRoots: async () => {},
      setRepos: () => {},
      close: async () => {},
      coveredRepoCount: () => 20, // 73 个仓库里只有 20 个被覆盖
      watchedRoots: () => [],
    } as unknown as RepoWatcher

    const auto = createAutomation({
      configFile: writeTempConfig({ autoWatch: true, roots: ["/a", "/b"] }),
      watcher,
      listRepos: () => Array.from({ length: 73 }, (_, i) => ({ id: String(i), archived: false }) as RepoStatus),
      rescan: async () => [],
      fetchAll: async () => {},
      log: () => {},
    })
    await auto.applyWatch(true)
    expect(auto.coverage()).toEqual({ watched: 20, total: 73 })
  })
})
```

（`writeTempConfig` 若在该文件中尚不存在，按文件里现有的临时配置写法补一个同名小helper：`mkdtempSync` 建目录、`saveConfig` 写入 `mergeConfig(DEFAULT_CONFIG, patch)`、返回文件路径。）

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w server -- tests/automation.test.ts`
Expected: FAIL —— `applyRepos` 不存在

- [ ] **Step 3: 改 `automation.ts`**

`Automation` 接口加一个方法：

```ts
  /** 重扫后调用：只更新监听器的「路径 → id」映射，不碰任何句柄。
   *  改造前这里走的是整套 applyWatch（拆掉几千个句柄再重建），实测是最贵的一笔周期性开销 */
  applyRepos(repos: RepoStatus[]): void
```

`applyWatch` 改为：

```ts
  async function applyWatch(enabled: boolean, repos?: RepoStatus[]): Promise<void> {
    const all = (repos ?? listRepos()).filter((r) => !r.archived)
    if (!enabled) {
      lastTotal = all.length
      await watcher.close()
      return
    }
    const cfg = loadConfig(configFile)
    // watchLimit 只对逐仓库策略有意义（Linux）：那里每个仓库要挂几十个 inotify watch，
    // 需要一个用量阀门。递归策略下一个 root 一个句柄，截断没有任何意义，也就不做
    const chosen = usesPerRepoWatching() && cfg.watchLimit > 0 && all.length > cfg.watchLimit
      ? [...all].sort(byWatchPriority).slice(0, cfg.watchLimit)
      : all
    lastTotal = all.length
    if (chosen.length < all.length) {
      const scanMin = cfg.autoScanMinutes
      log(
        `[repo-radar] 仓库数 ${all.length} 超过监听上限 ${cfg.watchLimit}，只监听收藏和最近提交的 ${chosen.length} 个` +
          (scanMin > 0
            ? `，其余靠每 ${scanMin} 分钟的兜底重扫刷新 / watching ${chosen.length} of ${all.length} repos; the rest refresh via the ${scanMin}-min periodic rescan`
            : `。兜底重扫当前是关的：其余仓库不会自动刷新，请开启兜底重扫或调高监听上限 / watching ${chosen.length} of ${all.length} repos; periodic rescan is OFF, the rest will NOT refresh automatically`),
      )
    }
    await watcher.setRoots(cfg.roots, chosen.map((r) => ({ id: r.id, path: r.path })))
  }

  function applyRepos(repos: RepoStatus[]): void {
    const all = repos.filter((r) => !r.archived)
    lastTotal = all.length
    watcher.setRepos(all.map((r) => ({ id: r.id, path: r.path })))
  }
```

顶部加 `let lastTotal = 0`，并把 `coverage()` 改为直接问 watcher：

```ts
    coverage: () => ({ watched: watcher.coveredRepoCount(), total: lastTotal }),
```

`usesPerRepoWatching()` 由 `watch-strategy.ts` 导出：

```ts
export function usesPerRepoWatching(): boolean {
  return !(process.platform === "win32" || process.platform === "darwin")
}
```

在 `applyConfig(next, prev)` 里，把「roots 或 manualRepos 变了」作为唯一需要 `applyWatch` 的条件（沿用它既有的逐字段比对模式）；其余字段变化不再重建监听。

- [ ] **Step 4: 改 `backend.ts`**

`doRescanAndWatch` 中把

```ts
    await automation.applyWatch(loadConfig(configFile).autoWatch, repos)
```

改为

```ts
    // 只更新映射表。监听的建立/重建交给 roots 变化时的 applyWatch —— 改造前这里每 30 分钟
    // 把几千个目录句柄拆了重建一次（实测 73 个仓库 = 2311 个句柄、32780 次 stat）
    automation.applyRepos(repos)
```

watcher 的创建处加上第二个回调，把结构变化接到重扫上（2 秒防抖，连续改名多个仓库只触发一轮）：

```ts
  let structureTimer: ReturnType<typeof setTimeout> | null = null
  const watcher = new RepoWatcher(
    (repoId) => { /* 现有的 refreshOne + 广播逻辑，原样保留 */ },
    (reason) => {
      // 新仓库出现 / 老仓库改名或消失 / 监听缓冲区溢出。防抖 2 秒——改一批名字会连发一串事件，
      // 而重扫本身经过指纹缓存后只要约 1.3 秒，没必要为每条事件各跑一轮
      if (structureTimer) return
      structureTimer = setTimeout(() => {
        structureTimer = null
        console.log(`[repo-radar] 目录结构变化，触发重扫：${reason}`)
        void rescanAndWatch(true).catch((err) =>
          console.error(`[repo-radar] 结构变化触发的重扫失败：${err instanceof Error ? err.message : String(err)}`),
        )
      }, 2000)
    },
  )
```

在 `stop()` 里 `clearTimeout(structureTimer)`。用 `rescanAndWatch(true)`（force）是因为磁盘刚变过，进行中的那一轮可能在变化写盘前就扫过了目标父目录。

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -w server -- tests/automation.test.ts tests/backend.test.ts`
Expected: PASS

- [ ] **Step 6: 全量测试 + 类型检查**

Run: `npm run typecheck -w server && npm test -w server`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add server/src/automation.ts server/src/backend.ts server/src/watch-strategy.ts server/tests/automation.test.ts
git commit -m "perf(server): 重扫只更新监听映射表，不再周期性重建句柄"
```

---

### Task 9: `manualRepos` 路径失效如实提示

**Files:**
- Modify: `server/src/store.ts`（`doRefreshAll` 中对失效的 manualRepos 生成错误状态）
- Modify: `server/tests/store.test.ts`（追加用例）

**Interfaces:**
- Consumes: `errorStatus`（Task 6 已加 id 参数）
- Produces: 无新导出

**为什么单独一条**：`manualRepos` 存的是绝对路径（`config.ts:7`），改名后 `scan()` 不覆盖它、路径也失效，于是这个仓库**直接从看板消失且没有任何提示**。认领救不了它（没有「新出现的路径」可配对，见规格的非目标），但静默消失是必须修掉的。

- [ ] **Step 1: 写失败测试**

在 `server/tests/store.test.ts` 追加：

```ts
describe("manualRepos 路径失效", () => {
  it("路径不存在的 manualRepo 仍出现在列表里，并带错误说明", async () => {
    const gone = join(tmpdir(), "rr-definitely-not-here-" + Date.now())
    const cfg: Config = { ...DEFAULT_CONFIG, roots: [], manualRepos: [gone] }
    const list = await new RepoStore(() => cfg).refreshAll()
    const entry = list.find((r) => r.path === gone)
    expect(entry).toBeDefined()
    expect(entry!.error).toContain(gone)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -w server -- tests/store.test.ts`
Expected: FAIL —— 目前 `getRepoCore` 抛出的是 git 的 spawn 错误，消息里不含路径，用户无从判断是「路径没了」还是「git 挂了」

- [ ] **Step 3: 实现**

在 `store.ts` 的 `refreshRepo` 之前加一道存在性检查，并在 `doRefreshAll` 的 catch 里用它区分错误：

```ts
  private async refreshRepo(path: string, id: string): Promise<RepoStatus> {
    // 路径整个不在了：多半是 manualRepos 里的仓库被改名或移动了。scan() 不覆盖根目录之外的
    // 路径，认领也就没有「新出现的路径」可配对——救不回来，但绝不能让卡片静默消失，
    // 用户会以为自己删过它。给一条能照着操作的错误
    if (!existsSync(path)) {
      throw new Error(`repo path no longer exists: ${path} — 若是改名或移动，请在设置里重新添加`)
    }
    const core = await getRepoCore(path)
    ...
  }
```

在 `store.ts` 顶部 import 里补 `existsSync`：

```ts
import { existsSync } from "node:fs"
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -w server -- tests/store.test.ts`
Expected: PASS

- [ ] **Step 5: 全量测试**

Run: `npm run typecheck -w server && npm test -w server`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/src/store.ts server/tests/store.test.ts
git commit -m "fix(store): manualRepos 路径失效时如实提示而非静默消失"
```

---

### Task 10: 端到端验证与 README 更新

**Files:**
- Modify: `README.md`（"Stay fresh" 段、`Configuration` 表的 `watchLimit` 行）
- Modify: `docs/i18n/README.zh-Hans.md`（同步中文版对应段落）
- Create: `server/tests/perf-smoke.test.ts`

**Interfaces:** 无新导出。

**为什么要有这条**：README 现在承诺「past the watch limit (200 repos by default...) favorites and recently committed repos are watched first」和「watching N of M」，在 win/mac 上已经不再是事实。文档说的和程序做的不一致，是比没文档更糟的状态。

- [ ] **Step 1: 写端到端冒烟测试**

创建 `server/tests/perf-smoke.test.ts`：

```ts
import { execFileSync } from "node:child_process"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG, type Config } from "../src/config"
import * as git from "../src/git"
import { RepoCache } from "../src/repo-cache"
import { IdentityLedger } from "../src/repo-identity"
import { RepoStore } from "../src/store"

const dirs: string[] = []
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function makeRepos(parent: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = join(parent, `repo-${i}`)
    execFileSync("git", ["init", "-b", "main", d])
    execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: d })
    execFileSync("git", ["config", "user.name", "t"], { cwd: d })
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: d })
    writeFileSync(join(d, "a.txt"), "1")
    execFileSync("git", ["add", "-A"], { cwd: d })
    execFileSync("git", ["commit", "-m", "c0"], { cwd: d })
    return d
  })
}

describe("端到端：缓存 + 身份", () => {
  it("10 个仓库第二轮重扫的 heavy 调用降为 0，且改名后身份保留", async () => {
    const parent = tmpDir("rr-e2e-")
    const repos = makeRepos(parent, 10)
    const store = new RepoStore(
      () => cfg,
      undefined,
      undefined,
      new RepoCache(join(tmpDir("rr-e2ec-"), "c.json")),
      new IdentityLedger(join(tmpDir("rr-e2ei-"), "i.json")),
    )
    const cfg: Config = { ...DEFAULT_CONFIG, roots: [parent] }

    const first = await store.refreshAll()
    expect(first.length).toBe(10)

    const spy = vi.spyOn(git, "getRepoHeavy")
    await store.refreshAll()
    expect(spy.mock.calls.length).toBe(0) // 一个 heavy 都没跑
    spy.mockRestore()

    // 给第 0 个打标签，然后改名
    const target = first.find((r) => r.path === repos[0])!
    cfg.tags[target.id] = ["e2e"]
    const renamed = join(parent, "repo-0-renamed")
    renameSync(repos[0], renamed)

    const after = await store.refreshAll()
    const moved = after.find((r) => r.path === renamed)!
    expect(moved.id).toBe(target.id)
    expect(moved.tags).toEqual(["e2e"])
  })
})
```

- [ ] **Step 2: 运行确认通过**

Run: `npm test -w server -- tests/perf-smoke.test.ts`
Expected: PASS

- [ ] **Step 3: 更新 README 的 "Stay fresh" 段**

把 `README.md` 里这一句：

> **Stay fresh** — file-watch auto-scan is on by default (local only, no network; `node_modules` and build-output directories like `dist` / `obj` / `target` are skipped), backed by a 30-minute fallback rescan for events the watcher misses and a "last scanned" readout in the toolbar; past the watch limit (200 repos by default, adjustable up to no limit) favorites and recently committed repos are watched first and the rest ride the rescan, with the settings panel showing the live "watching N of M" coverage.

替换为：

> **Stay fresh** — file-watch auto-scan is on by default (local only, no network). On Windows and macOS one recursive watch per scan directory covers every repo under it, so adding, deleting or renaming a repo shows up within seconds; on Linux repos are watched individually and `watchLimit` (200 by default, 0 = no limit) caps how many, with favorites and recently committed repos taking priority. A 30-minute fallback rescan catches whatever the watcher misses, the toolbar shows "last scanned", and the settings panel shows live "watching N of M" coverage. Renaming or moving a repo keeps its tags, star, archive state and notes — repo-radar tracks identity, not just the path.

- [ ] **Step 4: 更新 README 配置表的 `watchLimit` 行**

把表格中这一行：

> | `autoWatch` / `autoScanMinutes` / `watchLimit` / `autoFetchMinutes` / `notifications` | background behavior — `autoWatch` on, `autoScanMinutes` 30 and `watchLimit` 200 by default (0 = no limit); the other two off |

替换为：

> | `autoWatch` / `autoScanMinutes` / `watchLimit` / `autoFetchMinutes` / `notifications` | background behavior — `autoWatch` on and `autoScanMinutes` 30 by default; the other two off. `watchLimit` (200, 0 = no limit) only applies on Linux, where repos are watched individually; Windows and macOS use one recursive watch per scan directory and always cover every repo |

- [ ] **Step 5: 同步 `docs/i18n/README.zh-Hans.md`**

在中文版里找到对应的「保持新鲜」与配置表两处，按 Step 3 / Step 4 的同一口径改写。其余 16 个语种本轮不动——它们是从英文版翻译来的，等这一批改动稳定后统一重翻，避免翻译与实现来回打架。

- [ ] **Step 6: 全量测试 + 类型检查 + 构建**

Run: `npm run typecheck -w server && npm test && npm run build`
Expected: 全部 PASS。`npm test` 会跑 server + web + desktop 三套。

- [ ] **Step 7: 提交**

```bash
git add README.md docs/i18n/README.zh-Hans.md server/tests/perf-smoke.test.ts
git commit -m "docs: 更新监听行为与 watchLimit 的平台差异说明"
```

---

## 自检记录

**规格覆盖**：规格的每一节都有对应任务——杠杆 1 → Task 7、8；杠杆 2 → Task 2、3、4；杠杆 3 → Task 8；杠杆 4 → Task 5、6；`json-store` 重构 → Task 1；`manualRepos` 提示 → Task 9；README 平台差异 → Task 10。规格「错误处理」表的 9 行分别落在：溢出 → Task 8 Step 4；root 失效 → Task 7 Step 3 + Task 8 Step 3（coverage）；`fs.watch` 抛出 → Task 7 Step 3；指纹 stat 失败 → Task 2 Step 4（返回 null）；两个文件损坏 → Task 1 Step 3（底座统一容错）+ Task 4/5 的用例；`ino===0` → Task 5 Step 3；多对多 → Task 5 Step 3；`manualRepos` 失效 → Task 9。

**与规格的两处偏离**（实施中发现，均取更保守的一侧）：
1. 规格说缓存「每轮全量重扫后按当前仓库 id 集合剪枝」。实施改为沿用 `desc-cache.ts:73` 既有的**30 天年龄护栏**——理由是现成的：网络盘根目录瞬时掉线会让一整批仓库在某轮扫描里消失，立即剪会把它们的落盘数据永久抹掉。对身份账本尤其致命：账本条目被剪掉后，那批仓库回来时会被当成全新仓库，正是本轮要消灭的行为。因此 `IdentityEntry` 与 `CacheEntry` 都带 `seenAt`。
2. 规格未提 `.git` 为文件（worktree / submodule）的情况。此时六个 probe 全部 stat 失败，若返回恒定指纹会让这类仓库**永远命中缓存、heavy 永不刷新**且毫无报错。实施改为 `gitFingerprint` 返回 `null` 表示「不可缓存」。

**类型一致性**：`RepoCore` / `RepoHeavy`（Task 3 定义）在 Task 4 的 `refreshRepo`、`RepoCache.get/set`、Task 10 的冒烟测试中签名一致。`WatchedRepo` 在 `watch-strategy.ts` 定义、`watcher.ts` 再导出，两边同一个类型。`ClaimCandidate` / `IdentityEntry` 只在 Task 5 内部与其测试中使用。`gitFingerprint` 的 `string | null` 返回值在 `RepoCache.get` 的入参类型上对齐。

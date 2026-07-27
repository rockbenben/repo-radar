import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Config, DEFAULT_CONFIG, loadConfig, MAX_INTERVAL_MINUTES, mergeConfig, saveConfig, validateConfigPatch } from "../src/config"

const dir = mkdtempSync(join(tmpdir(), "rr-config-"))
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

describe("config", () => {
  it("returns defaults when file does not exist", () => {
    const cfg = loadConfig(join(dir, "missing.json"))
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(cfg).not.toBe(DEFAULT_CONFIG) // 必须是副本，防止调用方改坏默认值
  })

  it("round-trips save and load", () => {
    const file = join(dir, "sub", "config.json") // 父目录不存在，save 要自动创建
    const cfg = loadConfig(file)
    cfg.roots = ["D:\\Projects"]
    saveConfig(file, cfg)
    expect(loadConfig(file).roots).toEqual(["D:\\Projects"])
    expect(JSON.parse(readFileSync(file, "utf8")).excludes).toEqual(DEFAULT_CONFIG.excludes)
  })

  it("merges partial file over defaults", () => {
    const file = join(dir, "partial.json")
    saveConfig(file, { ...DEFAULT_CONFIG, roots: ["X:\\a"] })
    const cfg = loadConfig(file)
    expect(cfg.roots).toEqual(["X:\\a"])
    expect(cfg.health.staleDays).toBe(90)
  })
})

describe("mergeConfig", () => {
  it("deep-merges health and open, shallow-merges the rest", () => {
    const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), {
      roots: ["X:\\a"],
      health: { staleDays: 30 } as never,
    })
    expect(merged.roots).toEqual(["X:\\a"])
    expect(merged.health.staleDays).toBe(30)
    expect(merged.health.disabledRules).toEqual([]) // 深合并保留
    expect(merged.open.editor).toBe(DEFAULT_CONFIG.open.editor)
  })
})

describe("validateConfigPatch", () => {
  it("accepts a valid partial patch", () => {
    expect(validateConfigPatch({ roots: ["D:\\x"], tags: { abc: ["web"] } })).toBeNull()
  })
  it("rejects non-object bodies", () => {
    expect(validateConfigPatch([1, 2])).toMatch(/object/)
    expect(validateConfigPatch(null)).toMatch(/object/)
  })
  it("rejects wrong-typed fields", () => {
    expect(validateConfigPatch({ tags: null })).toMatch(/tags/)
    expect(validateConfigPatch({ manualRepos: "D:\\x" })).toMatch(/manualRepos/)
    expect(validateConfigPatch({ health: { staleDays: "90" } })).toMatch(/staleDays/)
    expect(validateConfigPatch({ open: { editor: 5 } })).toMatch(/open/)
    expect(validateConfigPatch({ groupOverrides: { a: 1 } })).toMatch(/groupOverrides/)
  })
  it("accepts valid archived and notes fields", () => {
    expect(validateConfigPatch({ archived: ["x"], notes: { a: "hi" } })).toBeNull()
  })
  it("rejects wrong-typed archived and notes fields", () => {
    expect(validateConfigPatch({ archived: "x" })).toMatch(/archived/)
    expect(validateConfigPatch({ notes: { a: 1 } })).toMatch(/notes/)
  })
})

describe("loadConfig deep merge", () => {
  it("keeps disabledRules when file has partial health", () => {
    const file = join(dir, "deep.json")
    writeFileSync(file, JSON.stringify({ health: { staleDays: 30 } }))
    const cfg = loadConfig(file)
    expect(cfg.health.staleDays).toBe(30)
    expect(cfg.health.disabledRules).toEqual([])
  })
})

// 自动扫描是纯本地的文件监听：不走网络、不弹通知，关着只会让看板显示过期状态——
// 默认开启才是「打开就是对的」。相对地，定时拉取会发网络请求，保持默认关闭。
describe("autoWatch 字段", () => {
  it("默认开启——纯本地、无打扰，关着反而让看板过期", () => {
    expect(DEFAULT_CONFIG.autoWatch).toBe(true)
  })

  // 不做「历史默认值 → 新默认值」的迁移：saveConfig 整份落盘，盘上的 false 分不清是
  // 历史默认还是用户主动关的，宁可让新默认值只对全新安装生效，也不重开用户明确关掉的
  // 行为——升级前就因为监听有害（网络盘/OneDrive/EMFILE）关掉它的人首当其冲
  it("盘上已有 autoWatch: false 时原样保留，不被新默认值覆盖", () => {
    const file = join(dir, "existing-autowatch.json")
    writeFileSync(file, JSON.stringify({ roots: ["X:\\a"], autoWatch: false }))
    expect(loadConfig(file).autoWatch).toBe(false)
    expect(loadConfig(file).roots).toEqual(["X:\\a"])
  })

  it("定时拉取仍默认关闭——它会发网络请求，必须由用户主动打开", () => {
    expect(DEFAULT_CONFIG.autoFetchMinutes).toBe(0)
  })
})

// 文件监听不是万无一失的：网络盘 / WSL / 云同步目录收不全 inotify 事件，机器休眠期间的
// 改动更是完全没有事件。兜底重扫默认开着，「自动扫描默认开启」才真的兑现得了。
describe("autoScanMinutes 字段（兜底全量重扫）", () => {
  it("默认 30 分钟——文件监听漏掉的改动由它补上", () => {
    expect(DEFAULT_CONFIG.autoScanMinutes).toBe(30)
  })

  it("老配置文件没有这个字段时按默认值合并", () => {
    const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), { roots: ["/a"] } as Partial<Config>)
    expect(merged.autoScanMinutes).toBe(30)
  })

  it("校验：非负数字，0 表示关闭", () => {
    expect(validateConfigPatch({ autoScanMinutes: 0 })).toBeNull()
    expect(validateConfigPatch({ autoScanMinutes: 60 })).toBeNull()
    expect(validateConfigPatch({ autoScanMinutes: -1 })).toBe("autoScanMinutes must be a non-negative number")
    expect(validateConfigPatch({ autoScanMinutes: "30" })).toBe("autoScanMinutes must be a non-negative number")
  })

  // `{"autoScanMinutes": 1e999}` 是合法 JSON，JSON.parse 给出 Infinity。放它过去的话
  // JSON.stringify 落盘时写成 null，此后 `null > 0` 恒假 —— 功能永久静默关闭，
  // 而配置文件里留着一个声明为 number 的 null
  it("校验：Infinity 必须被拒，否则落盘会变成 null", () => {
    expect(validateConfigPatch({ autoScanMinutes: Number.POSITIVE_INFINITY })).toBe(
      "autoScanMinutes must be a non-negative number",
    )
    expect(validateConfigPatch({ autoFetchMinutes: Number.POSITIVE_INFINITY })).toBe(
      "autoFetchMinutes must be a non-negative number",
    )
    expect(JSON.stringify({ n: Number.POSITIVE_INFINITY })).toBe('{"n":null}') // 上面那句话的依据
  })

  // setInterval 的延迟是 32 位有符号毫秒，溢出会被 Node 钳成 1ms：
  // 「30 天扫一次」当场变成「一刻不停地扫」，git 进程连轴转
  it("校验：超过上限必须被拒，避免 setInterval 溢出成 1ms", () => {
    expect(validateConfigPatch({ autoScanMinutes: MAX_INTERVAL_MINUTES })).toBeNull()
    expect(validateConfigPatch({ autoScanMinutes: MAX_INTERVAL_MINUTES + 1 })).toBe(
      `autoScanMinutes must be at most ${MAX_INTERVAL_MINUTES}`,
    )
    expect(validateConfigPatch({ autoFetchMinutes: 43200 })).toBe(`autoFetchMinutes must be at most ${MAX_INTERVAL_MINUTES}`)
    expect(MAX_INTERVAL_MINUTES * 60_000).toBeLessThanOrEqual(2 ** 31 - 1) // 上限本身必须在溢出线内
    // 上限必须顶到溢出线，不能收得更紧：旧版本接受任何有限非负值，收紧到比如 7 天会把
    // 以前完全合法的「两周 fetch 一次」（20160）变成 400，破坏既有客户端和配置
    expect(validateConfigPatch({ autoFetchMinutes: 20160 })).toBeNull()
  })

  // 0.001 过得了「非负有限数」，装表却是 60ms 的全量扫描死循环——必须整数
  it("校验：小数必须被拒，防止亚分钟间隔", () => {
    expect(validateConfigPatch({ autoScanMinutes: 0.001 })).toBe("autoScanMinutes must be an integer")
    expect(validateConfigPatch({ autoFetchMinutes: 15.5 })).toBe("autoFetchMinutes must be an integer")
  })

  // 旧版校验松（接受小数、无上限），或手改/损坏写入了 null、越界值——这些已经在用户
  // 盘上。读进来不归一化的话，PUT /api/config 的整份 round-trip 会被一个用户根本没碰的
  // 老字段卡成 400，任何无关设置（roots、通知）都存不了
  it("loadConfig 把老配置里的越界数值归一化成合法值", () => {
    const file = join(dir, "legacy-values.json")
    writeFileSync(
      file,
      JSON.stringify({ autoFetchMinutes: 2.5, autoScanMinutes: 100000, watchLimit: null }),
    )
    const cfg = loadConfig(file)
    expect(cfg.autoFetchMinutes).toBe(2) // 小数 → 取整
    expect(cfg.autoScanMinutes).toBe(MAX_INTERVAL_MINUTES) // 超上限 → 钳到上限
    expect(cfg.watchLimit).toBe(DEFAULT_CONFIG.watchLimit) // null（损坏）→ 回默认值
    // 归一化后的值必须能原样通过 PUT 校验——这正是归一化存在的目的
    expect(validateConfigPatch({ autoFetchMinutes: cfg.autoFetchMinutes, autoScanMinutes: cfg.autoScanMinutes, watchLimit: cfg.watchLimit })).toBeNull()
  })
})

describe("notifications 字段", () => {
  it("默认关闭——通知是打扰，必须由用户主动打开", () => {
    expect(DEFAULT_CONFIG.notifications).toBe(false)
  })

  it("旧配置文件没有这个字段时按默认值合并", () => {
    const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), { roots: ["/a"] } as Partial<Config>)
    expect(merged.notifications).toBe(false)
  })

  it("校验：必须是布尔", () => {
    expect(validateConfigPatch({ notifications: true })).toBeNull()
    expect(validateConfigPatch({ notifications: "yes" })).toBe("notifications must be a boolean")
  })
})

// 缺陷 4：legacyAutostartMigrated 曾被错误地放进这份用户可见、可通过 PUT /api/config 修改的
// 配置——它是纯粹的桌面端一次性迁移状态（SEA 时代自启意图是否已经迁移过），用户在自己的
// config.json 里看到一个看不懂的内部字段，还能通过公开 API 把它改坏，进而干扰
// desktop/src/autostart.ts 的迁移判定。已挪到 desktop/src/autostart-state.ts 管理的桌面端
// 专属状态文件，这里只负责确认它已经从用户配置的 schema 里彻底移除，且老配置文件里可能
// 残留的这个字段会被静默剔除（与 openMode 走同一套 DROPPED_FIELDS 机制），不再声明、不再校验。
describe("legacyAutostartMigrated 已移除出用户配置（缺陷 4：挪到桌面端专属状态文件）", () => {
  it("默认配置里不再有这个字段", () => {
    expect("legacyAutostartMigrated" in DEFAULT_CONFIG).toBe(false)
  })

  // 老配置文件（升级前写入过）里可能还留着这个字段，加载时不该报错，也不该把它带进新配置
  it("老配置文件里的 legacyAutostartMigrated 被静默忽略", () => {
    const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), {
      legacyAutostartMigrated: true,
    } as unknown as Partial<Config>)
    expect("legacyAutostartMigrated" in merged).toBe(false)
  })

  it("不再校验它——写进 PUT /api/config 的 patch 也只是被忽略，而不是报错或生效", () => {
    expect(validateConfigPatch({ legacyAutostartMigrated: true })).toBeNull()
    expect(validateConfigPatch({ legacyAutostartMigrated: "not-a-boolean" })).toBeNull()
  })
})

describe("openMode 已移除", () => {
  it("默认配置里不再有这个字段", () => {
    expect("openMode" in DEFAULT_CONFIG).toBe(false)
  })

  // 老配置文件里可能还留着这个字段，加载时不该报错，也不该把它带进新配置
  it("老配置文件里的 openMode 被静默忽略", () => {
    const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), { openMode: "browser" } as unknown as Partial<Config>)
    expect("openMode" in merged).toBe(false)
  })

  it("不再校验它——写进 patch 也只是被忽略，而不是报错", () => {
    expect(validateConfigPatch({ openMode: "nonsense" })).toBeNull()
  })
})

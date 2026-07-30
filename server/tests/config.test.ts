import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
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

/**
 * config.json 装的是**全部用户数据**（tags/favorites/archived/notes/roots/groupOverrides/
 * lastOpened），而写它的路径有四条，其中 lastOpened 每点一次「在编辑器打开」就写一次。
 * 落盘与读取这两端的失效后果都是「用户数据全没了」，不是「慢一轮」。
 */
describe("config.json 的抗损坏", () => {
  it("saveConfig 用 tmp + rename 原子替换，不存在截断窗口", () => {
    const file = join(dir, "atomic", "config.json")
    saveConfig(file, { ...DEFAULT_CONFIG, roots: ["A:\\1"] })
    const first = statSync(file).ino
    saveConfig(file, { ...DEFAULT_CONFIG, roots: ["A:\\2"] })
    // rename 原子替换必然换一个新的文件身份；裸 writeFileSync 是「先截断再写同一个文件」，
    // ino 不变——而那个截断窗口正是断电时把全部用户数据变成半截 JSON 的地方
    expect(statSync(file).ino).not.toBe(first)
    expect(existsSync(`${file}.tmp`)).toBe(false) // 临时文件不留痕
    expect(loadConfig(file).roots).toEqual(["A:\\2"])
  })

  it("配置损坏时保住坏文件、按默认值继续，且后续写入不会盖掉它", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const file = join(dir, "corrupt", "config.json")
    saveConfig(file, { ...DEFAULT_CONFIG, favorites: ["keep-me"], tags: { r1: ["重要"] } })
    const truncated = readFileSync(file, "utf8").slice(0, 40) // 断电落在截断窗口里留下的半截 JSON
    writeFileSync(file, truncated)

    // 不抛：抛的话 RepoStore.getConfig 每轮都抛，看板永久 500
    const cfg = loadConfig(file)
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(err).toHaveBeenCalled() // 打包之后日志是唯一的诊断面，静默恢复等于零诊断
    const backups = readdirSync(dirname(file)).filter((f) => f.startsWith("config.json.corrupt-"))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dirname(file), backups[0]), "utf8")).toBe(truncated)

    // 「坏了当空」的致命之处在这一步：下一次 saveConfig（点一次「在编辑器打开」就会发生）
    // 会把默认配置整份写回去。备份必须原封不动，用户的标签/收藏才还有救回来的机会
    saveConfig(file, cfg)
    expect(readdirSync(dirname(file)).filter((f) => f.startsWith("config.json.corrupt-"))).toEqual(backups)
    expect(readFileSync(join(dirname(file), backups[0]), "utf8")).toBe(truncated)
    err.mockRestore()
  })

  /**
   * 「读不出来」不等于「文件坏了」。任何非 ENOENT 的读失败——EACCES / EPERM / EBUSY / EIO /
   * EMFILE，杀软或备份进程短暂占住，REPO_RADAR_CONFIG 指向网络盘 / OneDrive 时的瞬时抖动——
   * 都必须原样抛出。当成损坏处理的话：一份**字节完好**的 config.json 被改名成
   * config.json.corrupt-<时间戳>，返回默认配置，下一次 saveConfig（点一次「在编辑器打开」写
   * lastOpened 就触发）把默认值整份落盘，用户的标签/收藏/归档/便签就此没了；日志还说「解析
   * 失败」，把人引去检查一份语法完全正确的 JSON。
   * 上一版依赖的前提「读不出来 ⇒ 也挪不动 ⇒ 自然走那条响亮的 500」是假的：Windows 上只拒
   * FILE_READ_DATA 时 DELETE 权限仍在，rename 照常成功；POSIX 上 rename 只看父目录的 w+x，
   * 从不看文件自身的读权限。
   *
   * EACCES 在两条 CI 腿上都造不稳（容器里常以 root 跑，Windows 要 icacls），这里用
   * 「readFileSync 会抛的另一种非 ENOENT 错误」代替——钉住的是 catch 分支的取舍本身，
   * 与 automation.test.ts 用 statSync 的另一种错误钉 pathGone 是同一手法
   */
  it("非 ENOENT 的读失败原样抛出，字节完好的配置一个字节都不许被挪走", () => {
    const file = join(dir, "unreadable", "config.json")
    mkdirSync(file, { recursive: true }) // 占住这个路径：readFileSync 得到 EISDIR，不是 ENOENT
    writeFileSync(join(file, "sentinel"), "still here")

    expect(() => loadConfig(file)).toThrow() // 而不是「悄悄隔离掉再返回默认值」
    expect(readFileSync(join(file, "sentinel"), "utf8")).toBe("still here")
    expect(readdirSync(dirname(file))).toEqual(["config.json"]) // 没有多出任何 .corrupt- 备份
  })

  // 反向：真正的解析失败仍要 quarantine（上面那条用例），而「文件不存在」仍要静静返回默认值
  // ——这条路径原先靠 existsSync 预判，现在由 readFileSync 的 ENOENT 接手。existsSync 不能留：
  // 它内部吞掉一切错误，EACCES 同样返回 false，「不存在」与「读不了」又会被合成同一个答案
  it("父目录都不存在时仍然静静返回默认值（ENOENT 是唯一不抛的读失败）", () => {
    expect(loadConfig(join(dir, "no-such-dir", "config.json"))).toEqual(DEFAULT_CONFIG)
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

// 文件监听默认**关闭**。它不走网络也不弹通知，但常驻成本与收益不成比例：几个项目同时在跑
// 构建时，递归监听看得见 scan root 下的一切写入，内核缓冲区持续溢出（实测 74 个仓库、每
// 62 秒一次，永不停），每次溢出都要补一轮全量重扫。而这个工具的用途是「看一眼各仓库什么
// 状态」，秒级实时不值那笔开销——默认走兜底定时重扫 + 手动重扫，需要实时的人自己打开。
describe("autoWatch 字段", () => {
  it("默认关闭——常驻监听的开销与「看一眼状态」这个用途不成比例", () => {
    expect(DEFAULT_CONFIG.autoWatch).toBe(false)
  })

  // 不做「历史默认值 → 新默认值」的迁移：saveConfig 整份落盘，盘上的值分不清是历史默认还是
  // 用户主动设的，宁可让新默认值只对全新安装生效，也不擅自改掉用户明确选过的行为。
  // 这里钉的是 true 那一侧：老配置文件里几乎都写着 true（旧版默认值就落盘了），
  // 若被新默认值盖掉，升级后所有老用户的实时刷新会一起消失，而界面上只是「卡片不动」
  it("盘上已有 autoWatch: true 时原样保留，不被新默认值覆盖", () => {
    const file = join(dir, "existing-autowatch.json")
    writeFileSync(file, JSON.stringify({ roots: ["X:\\a"], autoWatch: true }))
    expect(loadConfig(file).autoWatch).toBe(true)
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

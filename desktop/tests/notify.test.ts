import { describe, expect, it } from "vitest"
import { summarizeInboxChanges } from "../src/notify"
import type { InboxChange } from "../../server/src/backend"

const inbox = (prs: number, issues: number, ciFailed = false, ciSha = "abc", byViewer = true) => ({ prs, issues, ciFailed, ciSha, byViewer })
const change = (name: string, before: ReturnType<typeof inbox> | null, after: ReturnType<typeof inbox>): InboxChange => ({
  repoId: name,
  name,
  before,
  after,
})

describe("summarizeInboxChanges — 该不该弹", () => {
  it("空输入 → 不弹", () => {
    expect(summarizeInboxChanges([])).toBeNull()
  })

  // 全新安装/换远程后首次拿到缓存：此时「所有 PR」都是新的，全弹一遍就是灾难
  it("首次拿到某仓库的 inbox（before 为 null）→ 不弹", () => {
    expect(summarizeInboxChanges([change("foo", null, inbox(5, 3, true))])).toBeNull()
  })

  it("计数没变 → 不弹", () => {
    expect(summarizeInboxChanges([change("foo", inbox(2, 1), inbox(2, 1))])).toBeNull()
  })

  // PR 被合并、issue 被关掉是好事，不该打扰
  it("计数下降 → 不弹", () => {
    expect(summarizeInboxChanges([change("foo", inbox(3, 2), inbox(1, 0))])).toBeNull()
  })

  it("CI 一直是失败状态 → 不弹（只在「由通过变失败」时提醒一次）", () => {
    expect(summarizeInboxChanges([change("foo", inbox(0, 0, true), inbox(0, 0, true))])).toBeNull()
  })

  it("CI 由失败恢复为通过 → 不弹", () => {
    expect(summarizeInboxChanges([change("foo", inbox(0, 0, true), inbox(0, 0, false))])).toBeNull()
  })
})

describe("summarizeInboxChanges — 文案", () => {
  it("单仓库 PR 增加：标题是仓库名，正文只有符号与计数（主进程读不到用户语言）", () => {
    const r = summarizeInboxChanges([change("my-app", inbox(1, 0), inbox(3, 0))])!
    expect(r.title).toBe("my-app")
    expect(r.body).toBe("PR +2")
  })

  it("同一仓库多类变化用 · 连接，顺序固定 PR → Issue → CI", () => {
    const r = summarizeInboxChanges([change("my-app", inbox(1, 1, false), inbox(2, 3, true))])!
    expect(r.body).toBe("PR +1 · Issue +2 · CI ✗")
  })

  it("只有 CI 由通过变失败", () => {
    const r = summarizeInboxChanges([change("my-app", inbox(0, 0, false), inbox(0, 0, true))])!
    expect(r.title).toBe("my-app")
    expect(r.body).toBe("CI ✗")
  })

  it("多仓库：标题为 repo-radar，正文逐个列出", () => {
    const r = summarizeInboxChanges([
      change("a", inbox(0, 0), inbox(1, 0)),
      change("b", inbox(0, 0, false), inbox(0, 0, true)),
    ])!
    expect(r.title).toBe("repo-radar")
    expect(r.body).toBe("a: PR +1 · b: CI ✗")
  })

  // changes 的顺序是并发拉取完成的顺序，每轮都可能不同——输入故意乱序，断言截断后是排序过的确定结果
  it("超过 3 个仓库时按仓库名排序后截断，保证结果确定（不依赖并发完成顺序）", () => {
    const r = summarizeInboxChanges(
      ["e", "c", "a", "d", "b"].map((n) => change(n, inbox(0, 0), inbox(1, 0))),
    )!
    expect(r.body).toBe("a: PR +1 · b: PR +1 · c: PR +1 · +2")
  })

  it("没有变化的仓库不进入文案（只弹真正有新增的那些）", () => {
    const r = summarizeInboxChanges([
      change("changed", inbox(0, 0), inbox(1, 0)),
      change("unchanged", inbox(2, 2), inbox(2, 2)),
    ])!
    expect(r.title).toBe("changed") // 只有一个有新增 → 走单仓库文案
    expect(r.body).toBe("PR +1")
  })

  it("同一仓库计数有升有降：只报升的（PR +2 但 issue −1 → 只报 PR +2）", () => {
    const r = summarizeInboxChanges([
      change("my-app", inbox(0, 3), inbox(2, 2)),
    ])!
    expect(r.body).toBe("PR +2")
  })

  it("恰好 3 个仓库：不出现 +N", () => {
    const r = summarizeInboxChanges(
      ["a", "b", "c"].map((n) => change(n, inbox(0, 0), inbox(1, 0))),
    )!
    expect(r.body).toBe("a: PR +1 · b: PR +1 · c: PR +1")
  })

  it("恰好 4 个仓库：3 个 + +1", () => {
    const r = summarizeInboxChanges(
      ["a", "b", "c", "d"].map((n) => change(n, inbox(0, 0), inbox(1, 0))),
    )!
    expect(r.body).toBe("a: PR +1 · b: PR +1 · c: PR +1 · +1")
  })
})

describe("summarizeInboxChanges — CI 通知（ciSha 变化）", () => {
  it("ciFailed 两侧都为 true 且 ciSha 不同 → 通知（新提交上的新失败）", () => {
    const r = summarizeInboxChanges([
      change("my-app", inbox(0, 0, true, "abc"), inbox(0, 0, true, "def")),
    ])!
    expect(r.title).toBe("my-app")
    expect(r.body).toBe("CI ✗")
  })

  it("ciFailed 两侧都为 true 且 ciSha 相同 → 不通知（同一提交上一直失败）", () => {
    expect(summarizeInboxChanges([
      change("my-app", inbox(0, 0, true, "abc"), inbox(0, 0, true, "abc")),
    ])).toBeNull()
  })

  it("ciFailed 两侧都为 true 但 before.ciSha 为 undefined（旧缓存） → 不通知", () => {
    const before = { prs: 0, issues: 0, ciFailed: true }
    const after = { prs: 0, issues: 0, ciFailed: true, ciSha: "abc" }
    const r = summarizeInboxChanges([{ repoId: "my-app", name: "my-app", before, after } as InboxChange])
    expect(r).toBeNull()
  })

  it("ciFailed 两侧都为 true 但 after.ciSha 为 null → 不通知", () => {
    const after = { prs: 0, issues: 0, ciFailed: true, ciSha: null }
    const r = summarizeInboxChanges([
      change("my-app", inbox(0, 0, true, "abc"), after as unknown as ReturnType<typeof inbox>),
    ])
    expect(r).toBeNull()
  })
})

describe("summarizeInboxChanges — 口径标记 byViewer（Important 2：重启后 me 解析失败误弹回归用例）", () => {
  it("口径相同（两侧都是 byViewer:true）→ 正常按计数差弹", () => {
    const r = summarizeInboxChanges([change("my-app", inbox(1, 0, false, "abc", true), inbox(3, 0, false, "abc", true))])!
    expect(r.body).toBe("PR +2")
  })

  it("口径不同（byViewer 由 true 变 false，典型为重启后 viewer 查询失败）→ 跳过计数差，不弹", () => {
    expect(summarizeInboxChanges([change("my-app", inbox(1, 0, false, "abc", true), inbox(3, 0, false, "abc", false))])).toBeNull()
  })

  it("口径不同但 CI 由通过变失败 → CI 判定不受口径影响，只报 CI 不报计数", () => {
    const r = summarizeInboxChanges([change("my-app", inbox(1, 0, false, "abc", true), inbox(3, 0, true, "def", false))])!
    expect(r.body).toBe("CI ✗")
  })

  it("旧缓存无 byViewer 字段（undefined）vs 本轮 true → 视为口径不同，不弹计数（升级后第一轮更安全的代价）", () => {
    const before = { prs: 1, issues: 0, ciFailed: false, ciSha: "abc" } // 无 byViewer 字段，模拟老缓存
    const after = { prs: 3, issues: 0, ciFailed: false, ciSha: "abc", byViewer: true }
    const r = summarizeInboxChanges([{ repoId: "my-app", name: "my-app", before, after } as InboxChange])
    expect(r).toBeNull()
  })
})

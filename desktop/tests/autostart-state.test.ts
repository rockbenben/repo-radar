import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_MIGRATION_STATE, loadMigrationState, saveMigrationState } from "../src/autostart-state"

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "rr-autostart-state-"))
  dirs.push(d)
  return join(d, "autostart-state.json")
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

// 缺陷 4：这个状态挪出了 server 端用户配置，改存桌面端专属的小文件——这里验证它独立
// 存在、能正常往返，且（区别于 window-state.ts 的 loadState）文件损坏时不能悄悄当默认值处理。
describe("loadMigrationState / saveMigrationState", () => {
  it("往返：保存后能原样读回", () => {
    const f = tmp()
    saveMigrationState(f, { legacyAutostartMigrated: true })
    expect(loadMigrationState(f)).toEqual({ ok: true, state: { legacyAutostartMigrated: true } })
  })

  it("文件不存在（全新安装）→ 默认值 legacyAutostartMigrated: false，且是 ok:true", () => {
    expect(loadMigrationState(join(tmpdir(), "rr-autostart-state-missing", "x.json"))).toEqual({
      ok: true,
      state: { ...DEFAULT_MIGRATION_STATE },
    })
  })

  // 与 window-state.ts 的 loadState 刻意不同：那里损坏就默认值（窗口位置丢了是小事）；
  // 这里损坏必须让调用方知道——贸然当"未迁移"处理，会让 cleanupLegacyEntries 在状态不确定的
  // 情况下继续删除遗留条目（缺陷 1 的根源）
  it("文件存在但 JSON 损坏（比如上次硬杀导致截断）→ ok:false，带上错误信息，不当默认值处理", () => {
    const f = tmp()
    writeFileSync(f, "{ 坏掉的 JSON")
    const result = loadMigrationState(f)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })

  it("字段不是布尔值（比如被手改成字符串）→ 强制按 false 处理，不原样透传非法值", () => {
    const f = tmp()
    writeFileSync(f, JSON.stringify({ legacyAutostartMigrated: "yes" }))
    expect(loadMigrationState(f)).toEqual({ ok: true, state: { legacyAutostartMigrated: false } })
  })

  // 与 window-state.ts 的 saveState 刻意不同：那里写盘失败自己吞掉异常（窗口位置丢了是小事，
  // 不能拦住退出）；这里必须让异常冒出去——调用方 cleanupLegacyEntries 需要能捕获到它，
  // 记一行日志说明"标记没能落盘，下次启动可能会重复触发迁移"（缺陷 1 的第 4 点要求），
  // 如果这里悄悄吞掉，那条日志永远不会有机会被记下
  it("写盘失败会抛出（父目录被一个同名文件占住），不像 window-state 那样自己吞掉", () => {
    const f = tmp()
    const blocked = join(dirname(f), "blocked")
    writeFileSync(blocked, "x")
    expect(() => saveMigrationState(join(blocked, "s.json"), { legacyAutostartMigrated: true })).toThrow()
  })

  it("保存前会自动创建不存在的父目录", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-autostart-state-"))
    dirs.push(dir)
    const f = join(dir, "sub", "autostart-state.json")
    saveMigrationState(f, { legacyAutostartMigrated: true })
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ legacyAutostartMigrated: true })
  })
})

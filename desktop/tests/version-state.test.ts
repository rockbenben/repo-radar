import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadLastVersion, saveLastVersion } from "../src/version-state"

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "rr-version-state-"))
  dirs.push(d)
  return join(d, "version-state.json")
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

// 升级后清一次 HTTP 缓存的依据：这里验证版本号能往返，且（区别于 autostart-state）
// 缺失/损坏都按「版本未知」返回 null——调用方据此判定「与当前版本不同」、清一次缓存即可，无害。
describe("loadLastVersion / saveLastVersion", () => {
  it("往返：保存后能原样读回", () => {
    const f = tmp()
    saveLastVersion(f, "1.0.1")
    expect(loadLastVersion(f)).toBe("1.0.1")
  })

  it("文件不存在（全新安装）→ null，调用方按「版本未知」处理", () => {
    expect(loadLastVersion(join(tmpdir(), "rr-version-state-missing", "x.json"))).toBeNull()
  })

  // 与 autostart-state 刻意不同：那里损坏必须 ok:false（有不可逆风险）；这里损坏最坏只是多清
  // 一次缓存，无害，因此和「不存在」一样返回 null，不需要让调用方区分。
  it("文件存在但 JSON 损坏（比如上次硬杀导致截断）→ null，不抛出", () => {
    const f = tmp()
    writeFileSync(f, "{ 坏掉的 JSON")
    expect(loadLastVersion(f)).toBeNull()
  })

  it("version 字段不是字符串（被手改坏）→ null", () => {
    const f = tmp()
    writeFileSync(f, JSON.stringify({ version: 101 }))
    expect(loadLastVersion(f)).toBeNull()
  })

  it("保存前会自动创建不存在的父目录", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-version-state-"))
    dirs.push(dir)
    const f = join(dir, "sub", "version-state.json")
    saveLastVersion(f, "1.0.1")
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ version: "1.0.1" })
  })

  it("写盘失败会抛出（父目录被同名文件占住）", () => {
    const f = tmp()
    const blocked = join(dirname(f), "blocked")
    writeFileSync(blocked, "x")
    expect(() => saveLastVersion(join(blocked, "s.json"), "1.0.1")).toThrow()
  })
})

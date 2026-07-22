import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_STATE, loadState, sanitizeState, saveState } from "../src/window-state"

const SCREEN = [{ x: 0, y: 0, width: 1920, height: 1080 }]
const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "rr-winstate-"))
  dirs.push(d)
  return join(d, "window-state.json")
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

describe("sanitizeState", () => {
  it("完好的状态原样返回", () => {
    const s = { x: 100, y: 100, width: 1000, height: 700, maximized: false }
    expect(sanitizeState(s, SCREEN)).toEqual(s)
  })

  // 外接屏拔掉后，上次保存的坐标可能整个落在不存在的显示器上
  it("落在所有显示器之外的位置 → 丢弃坐标，由系统居中", () => {
    const s = sanitizeState({ x: 3000, y: 200, width: 1000, height: 700, maximized: false }, SCREEN)
    expect(s.x).toBeUndefined()
    expect(s.y).toBeUndefined()
    expect(s.width).toBe(1000)
  })

  it("只要有一部分可见就保留（允许窗口部分探出屏幕）", () => {
    const s = sanitizeState({ x: 1800, y: 1000, width: 1000, height: 700, maximized: false }, SCREEN)
    expect(s.x).toBe(1800)
  })

  it("尺寸过小/非法 → 用默认值（避免恢复出一个点不中的窗口）", () => {
    expect(sanitizeState({ width: 10, height: 10, maximized: false }, SCREEN).width).toBe(DEFAULT_STATE.width)
    expect(sanitizeState({ width: "big", height: null, maximized: false }, SCREEN)).toEqual(DEFAULT_STATE)
  })

  it("完全不是对象 → 默认值", () => {
    expect(sanitizeState(null, SCREEN)).toEqual(DEFAULT_STATE)
    expect(sanitizeState("nope", SCREEN)).toEqual(DEFAULT_STATE)
  })
})

describe("loadState / saveState", () => {
  it("往返", () => {
    const f = tmp()
    saveState(f, { x: 50, y: 60, width: 1100, height: 800, maximized: true })
    expect(loadState(f, SCREEN)).toEqual({ x: 50, y: 60, width: 1100, height: 800, maximized: true })
  })

  it("文件不存在或损坏 → 默认值，不抛", () => {
    expect(loadState(join(tmpdir(), "rr-nope", "x.json"), SCREEN)).toEqual(DEFAULT_STATE)
    const f = tmp()
    writeFileSync(f, "{ 坏掉的 JSON")
    expect(loadState(f, SCREEN)).toEqual(DEFAULT_STATE)
  })

  it("写盘失败不抛（窗口位置丢了是小事，不能拦住退出）", () => {
    const f = tmp()
    // 把「父目录」的位置先占成一个普通文件，mkdirSync 必然失败——确定性地触发写盘失败路径
    const blocked = join(dirname(f), "blocked")
    writeFileSync(blocked, "x")
    expect(() => saveState(join(blocked, "s.json"), DEFAULT_STATE)).not.toThrow()
  })
})

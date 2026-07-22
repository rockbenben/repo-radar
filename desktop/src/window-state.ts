import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * 窗口尺寸/位置的记忆。显示器信息由调用方传入（纯函数好测，也避免在测试里拉起 Electron 的 screen 模块）。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export const DEFAULT_STATE: WindowState = { width: 1280, height: 860, maximized: false }

// 导出给 window.ts 复用：BrowserWindow 的 minWidth/minHeight 必须与这里的下限一致，
// 否则会出现「恢复出的窗口比声明的最小尺寸还小」——曾经两处各写一份 900/600 字面量，改一处忘另一处就分叉
export const MIN_WIDTH = 900
export const MIN_HEIGHT = 600

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** 窗口与某个显示器有交集就算「看得见」——允许部分探出屏幕，那是用户自己拖的 */
function visibleOn(state: WindowState, displays: Rect[]): boolean {
  if (!isNum(state.x) || !isNum(state.y)) return false
  return displays.some(
    (d) => state.x! < d.x + d.width && state.x! + state.width > d.x && state.y! < d.y + d.height && state.y! + state.height > d.y,
  )
}

export function sanitizeState(saved: unknown, displays: Rect[]): WindowState {
  if (typeof saved !== "object" || saved === null) return { ...DEFAULT_STATE }
  const s = saved as Record<string, unknown>
  const width = isNum(s.width) && s.width >= MIN_WIDTH ? s.width : DEFAULT_STATE.width
  const height = isNum(s.height) && s.height >= MIN_HEIGHT ? s.height : DEFAULT_STATE.height
  const state: WindowState = { width, height, maximized: s.maximized === true }
  if (isNum(s.x) && isNum(s.y)) {
    state.x = s.x
    state.y = s.y
  }
  // 外接屏被拔掉后，上次的坐标可能整个落在不存在的区域——丢掉坐标让系统居中，
  // 否则窗口会「打开了但看不见」，用户只会以为应用没起来
  if (!visibleOn(state, displays)) {
    delete state.x
    delete state.y
  }
  return state
}

export function loadState(file: string, displays: Rect[]): WindowState {
  try {
    return sanitizeState(JSON.parse(readFileSync(file, "utf8")), displays)
  } catch {
    return { ...DEFAULT_STATE } // 不存在/损坏都按默认
  }
}

export function saveState(file: string, state: WindowState): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state, null, 2), "utf8")
  } catch {
    /* 窗口位置丢了是小事，绝不能因此拦住退出 */
  }
}

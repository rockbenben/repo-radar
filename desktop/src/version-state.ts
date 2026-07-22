import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * 记录「上一次运行的版本号」，供 main.ts 在升级后清一次 HTTP 缓存用。
 *
 * 背景：窗口通过 http://127.0.0.1:{port} 加载后端从 asar 里服务的前端。前端资源带内容
 * 哈希（immutable 长缓存本是对的），但入口 index.html 一旦被 Electron 的 HTTP 缓存留住，
 * 升级后它仍会指向旧哈希，于是整套旧界面被端上来——重装应用不清 userData 里的这份缓存，
 * 正是「装了新版却还是旧界面」的隐患。检测到版本变化就 session.clearCache() 一次即可根治。
 *
 * 与 autostart-state 刻意不同：那里读不出来（缺失/损坏）有不可逆风险，必须 ok/error 区分；
 * 这里读不出来最坏后果只是「多清一次缓存」——顶多一次多余的资源重新拉取，完全无害，
 * 因此缺失与损坏统一按「版本未知」返回 null，让调用方按「与当前版本不同」处理、清一次缓存。
 */
export function loadLastVersion(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }
    return typeof raw.version === "string" ? raw.version : null
  } catch {
    return null
  }
}

export function saveLastVersion(file: string, version: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ version }, null, 2), "utf8")
}

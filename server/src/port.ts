/**
 * 服务端口。默认 7420，可用 `REPO_RADAR_PORT` 覆盖——与 `REPO_RADAR_CONFIG` 配对才完整：
 * 端口即单实例锁，端口写死的话「换一份配置档案再开一个」永远起不来（第二个进程只会附着到第一个）。
 *
 * 单独成模块，是因为 routes.ts 的同源白名单也得按它推导，而 routes 不能反过来 import index（循环依赖）。
 */

export const DEFAULT_PORT = 7420

/**
 * 解析端口号。非法值一律退回默认并告警——不静默接受的原因：
 * 端口 0 会让系统随机分配，界面 URL、单实例探测、同源白名单三者当场全废，
 * 而那是一个「看起来启动成功了」的失败，比直接用默认端口难查得多。
 */
export function resolvePort(raw: string | undefined, warn: (msg: string) => void = console.warn): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    warn(`[repo-radar] REPO_RADAR_PORT=${raw} 不是 1–65535 的整数，改用 ${DEFAULT_PORT} / not a valid port, using ${DEFAULT_PORT}`)
    return DEFAULT_PORT
  }
  return n
}

export const PORT = resolvePort(process.env.REPO_RADAR_PORT)

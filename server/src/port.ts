/**
 * 服务端口。可用 `REPO_RADAR_PORT` 覆盖——与 `REPO_RADAR_CONFIG` 配对才完整：
 * 端口即单实例锁，端口写死的话「换一份配置档案再开一个」永远起不来（第二个进程只会附着到第一个）。
 *
 * 单独成模块，是因为 routes.ts 的同源白名单也得按它推导，而 routes 不能反过来 import index（循环依赖）。
 */

/**
 * 默认端口选在 15001–49151 这段，是为了绕开操作系统的**动态端口范围**——落在动态范围里的端口
 * 随时可能被系统成段预留走，bind 直接 EACCES，且区间随重启漂移（详见下面 isPortUnavailable）。
 * 两种 Windows 配置的动态范围各不相同，而这一段在两者之外都安全：
 *   - 出厂默认：49152–65535
 *   - 装了 Hyper-V / WSL2 之后：1024–15000（`netsh int ipv4 show dynamicport tcp` 可查）
 * 后者正是上一版默认端口 7420 翻车的原因（被 WinNAT 圈进 7420–7519），而它同时也覆盖了
 * 3000/5000/5173/8080 这些常用开发端口——「换个常用端口」解决不了问题，必须跳出这个区间。
 *
 * 17420 = 旧的 7420 前面加个 1，方便老用户记忆迁移；同时避开 17500（Dropbox LanSync）。
 */
export const DEFAULT_PORT = 17420

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

/**
 * 用户是否**显式指定**了一个有效端口。这决定了绑不上时能不能悄悄换一个：
 * 显式指定的端口是对外承诺（书签、反向代理上游、脚本里写死的 URL），擅自换掉等于让那些
 * 东西全部 ECONNREFUSED，而用户在界面上看不出任何异常——只有日志里一行提示，打包后的
 * GUI 用户根本不会看到。默认端口没有这层承诺，绑不上时自愈才是对的。
 *
 * 无效值（`REPO_RADAR_PORT=abc`）会被 resolvePort 退回默认端口并告警，那等同于「没指定」。
 * 判定复用 resolvePort，避免两处各写一遍合法性规则、日后改一处漏一处。
 */
export function isExplicitPort(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === "") return false
  return resolvePort(raw, () => {}) === Number(raw.trim())
}

export const PORT_IS_EXPLICIT = isExplicitPort(process.env.REPO_RADAR_PORT)

/**
 * 绑定失败里「换个端口就能好」的两类：
 * - EADDRINUSE：端口被别的程序占着
 * - EACCES：端口被系统保留。Windows 上 Hyper-V/WSL2/Docker 的 WinNAT 会成段预留高位端口
 *   （`netsh interface ipv4 show excludedportrange protocol=tcp` 能看到），落在区间里的端口
 *   bind 直接 EACCES，跟权限无关、提权也没用。要命的是这些区间随重启/服务启停漂移——
 *   旧默认端口 7420 就是这么翻的车：今天能绑，明天被圈进 7420–7519 就起不来，用户视角是
 *   「昨天还好好的」。DEFAULT_PORT 挪出动态范围后这条路径主要留给 REPO_RADAR_PORT 自定义端口
 *   （用户很可能填一个 3000/8080 这类落在动态范围里的值）和真被别人占用的情况。
 *
 * 其余错误（EADDRNOTAVAIL、EMFILE…）换端口既解决不了，还会把真正的故障掩盖成一次成功启动。
 */
export function isPortUnavailable(err: NodeJS.ErrnoException): boolean {
  return err.code === "EADDRINUSE" || err.code === "EACCES"
}

/**
 * 回退端口阶梯——DEFAULT_PORT 已经躲开了动态端口范围，这里是第二道防线：端口被别的程序
 * 真占着、或用户把 REPO_RADAR_PORT 设成了动态范围里的值时，仍然要能起来。
 *
 * 步长取 1000 而不是 +1：系统的预留是成段的（实测 WinNAT 一次占掉 7120–7619 共 500 个端口），
 * 逐个 +1 会在同一段里空转到底。默认端口的阶梯是 17420→18420→19420→20420，整条都还在
 * 15001–49151 这个安全窗口内。末位固定是 0——交给系统分配一个可用端口，保证「总能起来」
 * 这条底线（用户自定义了一个动态范围里的端口时，兜底的就是它）。0 只作兜底、不作首选：
 * resolvePort 拒绝端口 0 的理由依然成立（URL 每次都变），只是「随机端口」比「起不来」强得多。
 */
export function portCandidates(base: number): number[] {
  const ladder = [base, base + 1000, base + 2000, base + 3000].filter((p) => p >= 1 && p <= 65535)
  return [...new Set([...ladder, 0])]
}

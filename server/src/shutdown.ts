/**
 * 优雅退出。启动这半边（抢锁、自愈、弹界面）本来做得很完整，退出这半边原先是空的：
 * 没有任何 SIGINT/SIGTERM 处理，/api/shutdown 也只是 `setTimeout(process.exit, 200)`。
 * 而这个进程恰恰是被信号管理的——PM2 stop 发 SIGINT，systemd/launchd 发 SIGTERM，
 * Windows 注销/关窗发 SIGHUP——硬死会把正在跑的 git 写操作从中间切断，留下 .git/index.lock。
 *
 * 步骤顺序是有讲究的，每一步都为了解决前一步留下的问题：
 *   1. 停止监听   —— 不再接新请求，但**保留已有连接**：/api/shutdown 的响应还没送出去呢
 *   2. 排空仓库操作 —— 唯一会造成真实损害的一步（index.lock），也是唯一需要等的一步
 *   3. 排空重扫链 —— 必须排在关文件监听**之前**，见 drainRescans
 *   4. 关文件监听 —— 停掉 chokidar 的句柄与待触发定时器
 *   5. 刷缓存     —— inbox 缓存有 1 秒防抖，硬退必丢最后一轮
 *   6. 断开连接   —— 到这里才动 WebSocket：UI 的长连接会一直挂着，先断就没法保证第 1 步的承诺
 */

export interface ShutdownSteps {
  stopListening: () => Promise<void> | void
  drainOps: () => Promise<boolean>
  pendingOps: () => number
  /**
   * 等在飞的重扫跑完（超时返回 false）。**必须在 closeWatcher 之前**：重扫的收尾会走
   * applyWatch → watcher.setRoots，那是「重新建立监听」的动作。反过来的话，一轮在飞的重扫会
   * 在监听关掉之后又把句柄建回来，而这批句柄再没有任何人会去关——Windows 上递归 fs.watch
   * 一直握着 scan root 的目录句柄，那个目录在进程退出前谁也删不掉（EPERM）。
   * 上面的 drainOps 覆盖不到它：那把排空的是每仓库的 git 操作锁，重扫链不走那把锁。
   */
  drainRescans: () => Promise<boolean>
  closeWatcher: () => Promise<void>
  flushCaches: () => void
  closeConnections: () => void
  log?: (msg: string) => void
}

export type Shutdown = (reason: string) => Promise<void>

/**
 * 组装退出流程。**幂等**：重复调用返回同一个 promise——
 * 「Ctrl-C 没反应就再按一次」是本能动作，第二次不能把还在收尾的第一次打断。
 * 每一步都单独兜错：任何一步抛出都不能让后面的步骤（尤其是刷缓存）跑不到。
 */
export function createShutdown(steps: ShutdownSteps): Shutdown {
  const log = steps.log ?? (() => {})
  let running: Promise<void> | null = null

  const attempt = async (fn: () => unknown, what: string): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      log(`[repo-radar] 退出步骤 ${what} 失败（继续退出）/ ${what} failed, continuing: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const run = async (reason: string): Promise<void> => {
    log(`[repo-radar] 正在退出（${reason}）/ shutting down (${reason})`)
    await attempt(() => steps.stopListening(), "stopListening")

    const n = steps.pendingOps()
    if (n > 0) log(`[repo-radar] 等待 ${n} 个仓库操作收尾 / waiting for ${n} repo operation(s)`)
    const drained = await steps.drainOps().catch(() => false)
    if (!drained) {
      // 等不到也得走（卡死的 git 子进程不能让退出永远挂着），但必须说出来：
      // 用户下次撞上 index.lock 时，这行日志是唯一能解释原因的东西
      log(`[repo-radar] 仓库操作未在超时内结束，强制退出——可能残留 .git/index.lock / forced exit; a stale .git/index.lock is possible`)
    }

    // 关监听之前先把重扫链等干净（见 ShutdownSteps.drainRescans）。这一步换到 closeWatcher
    // 之后、或者干脆省掉，退出后 scan root 就会被一个没人认领的监听句柄锁住
    if (!(await steps.drainRescans().catch(() => false))) {
      // 同样等不到也得走（卡死的一轮不能让托盘退出/关机永远挂着），但要说出来：
      // 它是「退出之后目录仍被占用/句柄没关干净」唯一能解释原因的那行日志
      log(`[repo-radar] 重扫未在超时内结束，强制关闭监听——可能有一轮重扫在关闭之后又重建了监听句柄 / rescan drain timed out`)
    }

    await attempt(() => steps.closeWatcher(), "closeWatcher")
    await attempt(() => steps.flushCaches(), "flushCaches")
    await attempt(() => steps.closeConnections(), "closeConnections")
  }

  return (reason: string) => (running ??= run(reason))
}

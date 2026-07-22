/**
 * 唯一的退出出口。托盘菜单、/api/shutdown、系统关机、（后续的）更新安装全部走这里——
 * 退出路径只有一条，才不会有哪条忘了收尾。收尾内容见 server 的 shutdown 编排：
 * 停止监听 → 排空 git 写操作 → 关 watcher → flush 缓存。
 */
export function createQuit(deps: {
  stopBackend: () => Promise<void>
  beforeExit: () => void // 销毁托盘、放行窗口关闭
  exit: (code: number) => void
}): (code?: number) => Promise<void> {
  let running: Promise<void> | null = null
  // code 默认 0（正常退出）；main.ts 里 whenReady 链末尾的 .catch（backend.start() 成功之后
  // 才可能抛出的异常，比如打包时图标缺失导致 new Tray() 抛出）传 1，表示这是一次失败退出——
  // 但收尾步骤（停后端、排空 git 写操作、flush 缓存）跟正常退出完全一样，不能因为是失败就跳过，
  // 所以这里只让退出码可配置，收尾逻辑本身不变
  return (code = 0) =>
    (running ??= (async () => {
      try {
        await deps.stopBackend()
      } catch (err) {
        // 收尾失败也必须退出：卡在半路不退，比丢一点缓存严重得多
        console.error(`[repo-radar] 后端收尾失败: ${err instanceof Error ? err.message : String(err)}`)
      }
      deps.beforeExit()
      deps.exit(code)
    })())
}

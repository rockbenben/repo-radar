const chains = new Map<string, Promise<unknown>>()

// 未完成的仓库操作计数 + 归零时的唤醒队列。存在的理由只有一个：退出时要等它们跑完。
// git 写操作（commit/push/stash…）被从中间切断会在 .git 里留下 index.lock，用户下次操作直接
// 撞上 `fatal: Unable to create '.git/index.lock'`，还得自己去删——这是进程硬死唯一会造成的真实损害
let pending = 0
let idleWaiters: (() => void)[] = []

function release(): void {
  pending--
  if (pending > 0) return
  const waiters = idleWaiters
  idleWaiters = []
  for (const w of waiters) w()
}

/** 同一仓库的操作串行执行；不同仓库互不阻塞。前序失败不影响后续。 */
export function withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  pending++
  const prev = chains.get(repoId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  chains.set(repoId, settled)
  void settled.then(release)
  return next
}

/**
 * 把一整段「会反复取仓库锁」的工作算作一笔待办，直到它整体结束。
 *
 * 逐次 withRepoLock 挡不住退出：一轮批量是「取锁跑 git → **放锁** → refreshOne（7 个 git
 * 进程、几百毫秒）→ 再取下一把锁」，两次取锁之间 pending 会归零。几个 worker 同时落在这段
 * 空窗里时 drainRepoLocks 当场答「已排空」，退出流程一步不停地走完，而这轮批量随即又给下一个
 * 仓库起 git——被硬切在 merge 中途就留下 index.lock。这条比超时强退更糟：那条至少留了一行
 * 可归因的日志，这条连「等待 N 个仓库操作收尾」都不会打。
 */
export function trackPending<T>(work: () => Promise<T>): Promise<T> {
  pending++
  const done = work()
  void done.then(release, release)
  return done
}

/** 尚未跑完的仓库操作数（退出日志用：要让用户知道自己在等什么） */
export function pendingRepoOps(): number {
  return pending
}

/**
 * 等所有仓库操作跑完。返回是否等到了——超时返回 false，由调用方决定「等不到也得走」。
 * 不做无限等待：卡死的 git 子进程（比如 push 卡在认证提示上）不能让退出永远挂着。
 */
export function drainRepoLocks(timeoutMs: number): Promise<boolean> {
  if (pending === 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    idleWaiters.push(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

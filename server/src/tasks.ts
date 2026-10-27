import { runCommand } from "./exec"
import { type RepoAction, runRepoAction } from "./git"
import { mapLimit } from "./map-limit"
import { trackPending, withRepoLock } from "./queue"
import type { BatchProgress, BatchResultItem, RepoStatus } from "./types"

export interface BatchDeps {
  getRepo(id: string): RepoStatus | undefined
  refreshOne(id: string): Promise<RepoStatus | undefined>
  broadcast(type: string, payload: unknown): void
}

const BATCH_CONCURRENCY = 4
// taskId 带每次启动的随机前缀：前端把「已完成任务」按 taskId 缓存着兜竞态，
// 服务重启后 counter 归零，纯 `batch-N` 会撞上重启前同号任务的缓存结果——新任务瞬间"完成"且显示旧结果
const RUN_ID = Math.random().toString(36).slice(2, 8)
let counter = 0

/**
 * 起一批 git 动作。
 *
 * scope="single"：单仓库动作（详情面板里的 拉取/更新/推送 走的是同一个任务机制，
 * 弹窗要靠它的回执兑现 ✓/✗）。标记出来是为了让前端知道「这不是用户发起的批量」——
 * 顶栏那条「批量…完成」的横幅只该出现在真批量上。
 */
export function startBatch(action: RepoAction, repoIds: string[], deps: BatchDeps, scope: "batch" | "single" = "batch"): string {
  const taskId = `batch-${RUN_ID}-${++counter}`
  const results: BatchResultItem[] = []
  const total = repoIds.length

  const progress = (current: string | null, finished: boolean): void => {
    const payload: BatchProgress = { taskId, action, done: results.length, total, current, results: [...results], finished, scope }
    deps.broadcast("batch:progress", payload)
  }

  progress(null, false)
  // 整批算一笔待办（见 trackPending）：finished 广播也包在里面，退出排空要等到前端收到收摊信号
  void trackPending(() => mapLimit(repoIds, BATCH_CONCURRENCY, async (id) => {
    let repo: RepoStatus | undefined
    let pushed = false
    try {
      repo = deps.getRepo(id)
      if (!repo) {
        results.push({ repoId: id, name: id, ok: false, message: "repo not found" })
        pushed = true
        progress(null, false)
        return
      }
      progress(repo.name, false)
      const result = await withRepoLock(id, () => runRepoAction(repo!.path, action))
      results.push({ repoId: id, name: repo.name, ...result })
      pushed = true
      const updated = await deps.refreshOne(id)
      if (updated) deps.broadcast("repo:updated", { repo: updated })
      progress(null, false)
    } catch (err) {
      if (!pushed) results.push({ repoId: id, name: repo?.name ?? id, ok: false, message: String(err) })
      progress(null, false)
    }
  }).then(() => progress(null, true), () => progress(null, true)))

  return taskId
}

/**
 * 在一组仓库里批量执行同一条 shell 命令。复用 batch:progress 通道，results 携带每仓库输出。
 * dryRun=true 只列出将影响哪些仓库、不执行（破坏性操作前的预演护栏）。
 */
export function startExec(command: string, repoIds: string[], deps: BatchDeps, dryRun: boolean): string {
  const taskId = `exec-${RUN_ID}-${++counter}`
  const results: BatchResultItem[] = []
  const total = repoIds.length
  // action 就是命令原文：横幅与输出面板标题都用它。**不在这里拼「预演: 」**——
  // 服务端一拼中文，非中文界面里就会漏出中文（实测英文界面显示
  // “Batch 预演: echo hello … done: 1 ok”）。预演这件事用 payload 的 dryRun 标记传，
  // 前端按当前语言加前缀。
  const action = command

  const progress = (current: string | null, finished: boolean): void => {
    const payload: BatchProgress = { taskId, action, done: results.length, total, current, results: [...results], finished, scope: "batch", dryRun }
    deps.broadcast("batch:progress", payload)
  }

  progress(null, false)

  if (dryRun) {
    for (const id of repoIds) {
      const repo = deps.getRepo(id)
      results.push({
        repoId: id,
        name: repo?.name ?? id,
        ok: Boolean(repo),
        // 错误码而不是中文句子：文案由前端按界面语言翻译（见 web/src/lib/errText.ts）
        message: repo ? "willExecute" : "repo not found",
        output: repo ? repo.path : undefined,
      })
    }
    progress(null, true)
    return taskId
  }

  void trackPending(() => mapLimit(repoIds, BATCH_CONCURRENCY, async (id) => {
    const repo = deps.getRepo(id)
    if (!repo) {
      results.push({ repoId: id, name: id, ok: false, message: "repo not found" })
      progress(null, false)
      return
    }
    progress(repo.name, false)
    try {
      const res = await withRepoLock(id, () => runCommand(repo.path, command))
      // message 只放**错误码**（成功时留空）：退出码由 code 字段带着，前端按界面语言渲染
      // （实测过去这里拼的是中文「退出码 N」，非中文界面里会漏中文）
      results.push({ repoId: id, name: repo.name, ok: res.ok, message: res.message, output: res.output, code: res.code })
    } catch (err) {
      results.push({ repoId: id, name: repo.name, ok: false, message: String(err) })
    }
    // 刷新单独包一层 try，与 startBatch 里「refreshOne 在 try 内」同一形状。它落在 try 之外的话
    // 一旦抛出（loadConfig 现在会为非 ENOENT 的读失败抛，见 config.ts），这个 worker 就 reject，
    // 而 mapLimit 内部是 Promise.all —— 一 reject 立刻整体 reject，下面的
    // `.then(_, () => progress(null, true))` 会在其余 worker 还在跑时就广播 finished:true：
    // 前端当场收摊，后面跑完的仓库输出再也不显示，而命令其实还在一个个执行。
    // 命令自己的结果已经进 results 了，刷新失败只影响这张卡片的新鲜度，不该吞掉整批的进度
    try {
      const updated = await deps.refreshOne(id) // 命令可能改动了工作区，刷新状态
      if (updated) deps.broadcast("repo:updated", { repo: updated })
    } catch {
      // 下一轮重扫会把这张卡片刷新回来
    }
    progress(null, false)
  }).then(() => progress(null, true), () => progress(null, true)))

  return taskId
}

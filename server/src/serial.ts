/**
 * 串行队列：把同类后台任务排成一条链，前一轮结束后一轮才开跑。
 *
 * 两种入队语义，按「重复触发该不该各跑一遍」来选：
 * - share：已有「排队但还没开跑」的一轮就直接共乘它。适合结果只取决于开跑那一刻的状态、
 *   跑两遍纯属浪费的任务（全量重扫、GitHub 补全）——重复点「重扫」不该排两次全量扫描。
 * - chain：每次都在链尾排新的一轮。适合每次调用参数不同、少跑一次就等于丢指令的任务
 *   （watch(A) 之后 watch(B) 共乘的话，B 那份列表永远不会生效）。
 *
 * 无论哪种，链自身都必须吞掉错误：链保存的是「上一轮何时结束」，一轮失败若把 rejection
 * 留在链上，后续每一轮都会跟着 reject——整个队列从此永久卡死。调用方拿到的 promise
 * 仍然会正常 reject，错误不会被藏起来。
 */
export interface SerialQueue<T> {
  share(task: () => Promise<T>): Promise<T>
  chain(task: () => Promise<T>): Promise<T>
  /** 已排队、还没开跑、且可被共乘的那一轮（只有 share 排的算）；开跑即变回 null。
   *  调用方需要在共乘之外再加条件时用（如重扫要先比对扫描目标是否变了） */
  readonly queued: Promise<T> | null
}

export function createSerialQueue<T>(): SerialQueue<T> {
  let tail: Promise<unknown> = Promise.resolve()
  let queued: Promise<T> | null = null

  /** 排到链尾。shareable 决定这一轮是否登记为「可被共乘」——只有 share 排的轮次才登记：
   *  chain 排的轮次任务各不相同，被后来的 share 骑上去等于「我的任务永远不跑，还拿了
   *  别人的返回值」，是会静默出错的那种混用 */
  const push = (task: () => Promise<T>, shareable: boolean): Promise<T> => {
    const run = tail.then(() => {
      // 本轮开跑：目标集/参数已经定死，之后的触发必须另排一轮，不能再共乘这一轮
      if (queued === run) queued = null
      return task()
    })
    if (shareable) queued = run
    tail = run.catch(() => {})
    return run
  }

  return {
    share: (task) => queued ?? push(task, true),
    chain: (task) => push(task, false),
    get queued() {
      return queued
    },
  }
}

/**
 * 限并发的 map：起 min(limit, n) 个工人轮流领任务，结果按原下标回填。
 *
 * 单独成模块而不是留在 store.ts：它是个跟 RepoStore 毫无关系的通用工具，却被
 * routes/stats/tasks/worklog/backend/repo-identity 六处引用。留在 store.ts 里，
 * repo-identity 想用它就得反向依赖 store，而 store 又要引 repo-identity——今天
 * 那条回边是 `import type`（运行时被完全擦除，不成环），但那是个只差一个词就会破的
 * 保证：谁把它改成值导入，就会得到一个只在模块初始化时才炸的循环依赖。
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

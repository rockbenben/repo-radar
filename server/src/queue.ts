const chains = new Map<string, Promise<unknown>>()

/** 同一仓库的操作串行执行；不同仓库互不阻塞。前序失败不影响后续。 */
export function withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(repoId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(repoId, next.then(() => undefined, () => undefined))
  return next
}

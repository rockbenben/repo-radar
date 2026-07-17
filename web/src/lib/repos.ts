import type { RepoStatus } from "../types"

export function mergeRepo(repos: RepoStatus[], repo: RepoStatus): RepoStatus[] {
  const index = repos.findIndex((r) => r.id === repo.id)
  if (index === -1) return [...repos, repo]
  const next = [...repos]
  next[index] = repo
  return next
}

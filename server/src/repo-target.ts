import { stat } from "node:fs/promises"
import { readWorktree } from "./git"
import { trackPending, withRepoLock } from "./queue"
import type { RepoStatus } from "./types"
import { readWorktreeMarker, worktreeMarkers } from "./worktree-marker"

export class RepoTargetError extends Error {}

async function resolveRepoTarget(path: string) {
  try {
    const { root, commonDir, gitDir } = await readWorktree(path)
    const shared = await stat(commonDir, { bigint: true })
    const marker = readWorktreeMarker(root)
    if (marker === undefined) throw new Error("Git worktree marker is unavailable")
    const lockKey = shared.ino === 0n ? `git:${commonDir}` : `git:${shared.dev}:${shared.ino}`
    return { root, gitDir, lockKey, marker }
  } catch {
    throw new RepoTargetError("Git worktree root is invalid or unavailable")
  }
}

export function withRepoTarget<T>(repo: RepoStatus, run: (path: string, gitDir: string) => Promise<T>): Promise<T> {
  return trackPending(async () => {
    const observed = worktreeMarkers.get(repo)
    if (observed === undefined) throw new RepoTargetError("Git worktree root is invalid or unavailable")
    const before = await resolveRepoTarget(repo.path)
    if (before.marker !== observed) {
      throw new RepoTargetError("Git worktree changed since it was scanned. Rescan and review the repository before retrying.")
    }
    return withRepoLock(before.lockKey, async () => {
      const current = await resolveRepoTarget(repo.path)
      if (
        before.root !== current.root || before.gitDir !== current.gitDir || before.lockKey !== current.lockKey ||
        current.marker !== observed
      ) {
        throw new RepoTargetError("Git worktree changed while the operation was queued")
      }
      return run(current.root, current.gitDir)
    })
  })
}

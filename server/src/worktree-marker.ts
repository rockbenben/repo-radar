import { readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import type { RepoStatus } from "./types"

// Bind the in-memory scan result to the worktree observed on disk. Repo IDs
// instead identify persisted labels and preferences, and can survive a re-clone.
export const worktreeMarkers = new WeakMap<RepoStatus, string>()

export function readWorktreeMarker(path: string): string | undefined {
  try {
    const dotGit = join(path, ".git")
    const marker = statSync(dotGit, { bigint: true })
    const key = `${marker.dev}:${marker.ino}:${marker.birthtimeNs}`
    if (marker.isDirectory()) return key
    if (!marker.isFile() || marker.size > 1_048_576n) return undefined

    const pointer = readFileSync(dotGit, "utf8").replace(/[\r\n]+$/, "")
    if (!pointer.startsWith("gitdir: ")) return undefined
    const gitDir = statSync(resolve(path, pointer.slice(8)), { bigint: true })
    return `${key}:${gitDir.dev}:${gitDir.ino}:${gitDir.birthtimeNs}:${pointer}`
  } catch {
    return undefined
  }
}

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { RepoStatus } from "./types"

export interface ManifestEntry {
  name: string
  path: string
  remote: string | null // origin（或首个）远程 URL
  group: string
  tags: string[]
}

export interface Manifest {
  version: number
  exportedAt: string
  repos: ManifestEntry[]
}

/** 从当前仓库列表生成可版本控制/分享的清单（记录路径与远程，便于备份、换机、环境重建）。 */
export function buildManifest(repos: RepoStatus[], now: string): Manifest {
  return {
    version: 1,
    exportedAt: now,
    repos: repos.map((r) => ({
      name: r.name,
      path: r.path,
      remote: r.remotes.find((x) => x.name === "origin")?.url ?? r.remotes[0]?.url ?? null,
      group: r.group,
      tags: r.tags,
    })),
  }
}

export interface ImportSummary {
  added: number // 新并入 manualRepos 的本机已存在仓库数
  alreadyTracked: number // 清单里已在 manualRepos 的数量
  missing: ManifestEntry[] // 本机不存在的条目（供用户按远程手动克隆）
}

/** 校验任意输入是否为形状合法的清单。 */
export function isManifest(v: unknown): v is Manifest {
  if (typeof v !== "object" || v === null) return false
  const m = v as Record<string, unknown>
  if (!Array.isArray(m.repos)) return false
  return m.repos.every((e) => typeof e === "object" && e !== null && typeof (e as { path?: unknown }).path === "string")
}

/**
 * 把清单里「本机已存在且是 git 仓库」的路径并入 manualRepos；不存在的作为 missing 返回。
 * 不从清单自动克隆到任意路径（避免被构造的清单驱动写盘）；缺失项由用户经克隆对话框自行处理。
 */
export function importManifest(manifest: Manifest, manualRepos: string[]): { manualRepos: string[]; summary: ImportSummary } {
  const seen = new Set(manualRepos.map((p) => p.toLowerCase()))
  const next = [...manualRepos]
  let added = 0
  let alreadyTracked = 0
  const missing: ManifestEntry[] = []
  for (const e of manifest.repos) {
    const entry: ManifestEntry = {
      name: typeof e.name === "string" ? e.name : e.path,
      path: e.path,
      remote: typeof e.remote === "string" ? e.remote : null,
      group: typeof e.group === "string" ? e.group : "",
      tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : [],
    }
    if (existsSync(join(entry.path, ".git"))) {
      if (seen.has(entry.path.toLowerCase())) alreadyTracked++
      else {
        next.push(entry.path)
        seen.add(entry.path.toLowerCase())
        added++
      }
    } else {
      missing.push(entry)
    }
  }
  return { manualRepos: next, summary: { added, alreadyTracked, missing } }
}

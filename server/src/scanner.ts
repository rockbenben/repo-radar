import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

const MAX_DEPTH = 6

export function scan(roots: string[], excludes: string[]): string[] {
  const found: string[] = []
  const excludeSet = new Set(excludes)

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH) return
    if (existsSync(join(dir, ".git"))) {
      found.push(dir)
      return // 不深入仓库内部，忽略嵌套仓库
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 无权限或已消失，静默跳过
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") || excludeSet.has(entry.name)) continue
      walk(join(dir, entry.name), depth + 1)
    }
  }

  for (const root of roots) walk(root, 0)
  return found
}

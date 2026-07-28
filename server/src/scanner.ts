import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** 从每个 root 往下最多走几层找仓库。导出给 watch-filter：递归监听下「一条未归属的事件
 *  路径值不值得当成目录结构变化」要按同一个深度判断，两处各写一个常量迟早对不上 */
export const MAX_DEPTH = 6

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

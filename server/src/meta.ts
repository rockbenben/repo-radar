import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { RemoteInfo } from "./types"

export interface RepoMeta {
  displayName: string | null
  description: string | null
}

function readPackageJson(path: string): Record<string, unknown> | null {
  const file = join(path, "package.json")
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function nameFromRemote(remotes: RemoteInfo[]): string | null {
  const origin = remotes.find((r) => r.name === "origin") ?? remotes[0]
  if (!origin) return null
  const last = origin.url.replace(/[/\\]+$/, "").split(/[/\\:]/).pop()
  if (!last) return null
  const name = last.replace(/\.git$/, "").trim()
  return name === "" ? null : name
}

/** 把一行 markdown 清成可读纯文本：去图片/徽章、链接留文字、去强调符/行内代码/HTML 标签。 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // 图片 / 徽章
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接 → 文字
    .replace(/<!--[\s\S]*?-->/g, "") // HTML 注释
    .replace(/<[^>]+>/g, "") // HTML 标签
    .replace(/`([^`]+)`/g, "$1") // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, "$1") // 加粗 **
    .replace(/__([^_]+)__/g, "$1") // 加粗 __
    .replace(/\*([^*]+)\*/g, "$1") // 斜体 *
    .replace(/~~([^~]+)~~/g, "$1") // 删除线
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[·|]\s*)+/, "") // 去掉徽章/空链接留下的悬空分隔符
    .replace(/(?:\s*[·|])+$/, "")
    .trim()
}

export function descriptionFromReadme(path: string): string | null {
  for (const candidate of ["README.md", "readme.md", "README.zh-CN.md"]) {
    const file = join(path, candidate)
    if (!existsSync(file)) continue
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const rawLine of text.split("\n").slice(0, 50)) {
      const line = rawLine.trim()
      if (line === "") continue
      if (line.startsWith("#") || line.startsWith(">") || line.startsWith("---") || line.startsWith("|")) continue
      const clean = stripMarkdown(line)
      if (clean === "") continue // 整行只是徽章/图片/HTML，跳过
      return clean.length > 200 ? clean.slice(0, 200) : clean
    }
  }
  return null
}

export function readRepoMeta(path: string, remotes: RemoteInfo[]): RepoMeta {
  const pkg = readPackageJson(path)
  const pkgName = typeof pkg?.name === "string" && pkg.name.trim() !== "" ? pkg.name.trim() : null
  const pkgDesc = typeof pkg?.description === "string" && pkg.description.trim() !== "" ? pkg.description.trim() : null
  return {
    displayName: pkgName ?? nameFromRemote(remotes),
    description: pkgDesc ?? descriptionFromReadme(path),
  }
}

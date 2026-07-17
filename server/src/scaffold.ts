import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve, sep } from "node:path"
import { GitError, runGit } from "./git"

export interface ScaffoldResult {
  ok: boolean
  path?: string
  error?: string
}

const NAME_RE = /^[\w.-]+$/

function underRoot(parent: string, roots: string[]): boolean {
  const p = resolve(parent).toLowerCase()
  return roots.some((r) => {
    const root = resolve(r).toLowerCase()
    return p === root || p.startsWith(root + sep)
  })
}

/** 新建一个空项目：mkdir + git init + 一个 README。父目录必须在已配置的扫描根之内。 */
export async function createProject(parent: string, name: string, roots: string[]): Promise<ScaffoldResult> {
  if (!NAME_RE.test(name)) return { ok: false, error: "名称只能包含字母、数字、下划线、连字符、点" }
  if (!isAbsolute(parent) || !existsSync(parent)) return { ok: false, error: "父目录不存在" }
  if (!underRoot(parent, roots)) return { ok: false, error: "父目录必须在已配置的扫描根目录之内" }
  const target = join(parent, name)
  if (existsSync(target)) return { ok: false, error: "目标目录已存在" }
  try {
    mkdirSync(target)
    await runGit(target, ["init", "-b", "main"])
    writeFileSync(join(target, "README.md"), `# ${name}\n`)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 从远程 URL 克隆到父目录（须在扫描根之内）。 */
export async function cloneRepo(url: string, parent: string, roots: string[]): Promise<ScaffoldResult> {
  const u = url.trim()
  if (u === "" || u.startsWith("-")) return { ok: false, error: "URL 非法" }
  if (!isAbsolute(parent) || !existsSync(parent)) return { ok: false, error: "父目录不存在" }
  if (!underRoot(parent, roots)) return { ok: false, error: "父目录必须在已配置的扫描根目录之内" }
  const name = u.replace(/\.git$/, "").replace(/[/\\]+$/, "").split(/[/\\:]/).pop() ?? ""
  if (name !== "" && existsSync(join(parent, name))) return { ok: false, error: "目标目录已存在" }
  try {
    await runGit(parent, ["clone", "--", u], 300_000) // 网络操作，超时 5 分钟
    return { ok: true, path: name !== "" ? join(parent, name) : parent }
  } catch (err) {
    const msg =
      err instanceof GitError && err.stderr.trim() !== ""
        ? err.stderr.trim().split("\n").pop()!
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, error: msg }
  }
}

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
    // 先整段切好：跨行 HTML 块要靠**向后找结束标记**才跳得干净，逐行迭代拿不到后面的行。
    // 只跳过起始那一行是不够的——`<!--\n  auto-generated\n-->` 的第二行 `auto-generated`、
    // `<img\n  src="logo.png"\n/>` 的第二行 `src="logo.png"` 单看都是「闭合且非空」的普通文本，
    // 照样会成为卡片描述与详情面板标题，还会进搜索 haystack。状态只留在本函数里——
    // 不把 stripMarkdown 改成跨行匹配：它的契约是「清一行」，改成有状态的会波及别的调用点。
    const lines = text.split("\n", 50).map((l) => l.trim())
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === "") continue
      if (line.startsWith("#") || line.startsWith(">") || line.startsWith("---") || line.startsWith("|")) continue
      const clean = stripMarkdown(line)
      if (clean === "") continue // 整行只是徽章/图片/HTML（含单行内闭合的 `<div …>`），跳过
      // 走到这里还以 `<` 开头，说明 stripMarkdown 的两条 HTML 规则都没匹配上——它们都要求
      // **闭合**（`<!--…-->` 要 `-->`、`<…>` 要 `>`），而跨行的起始标记两条都不满足
      if (line.startsWith("<") && clean.startsWith("<")) {
        // 像标签/注释起始才整块跳；`<3 是心形` 这种不像的只跳本行（沿用既有行为）
        const end = clean.startsWith("<!--") ? "-->" : /^<[a-zA-Z/]/.test(clean) ? ">" : null
        const close = end === null ? -1 : lines.findIndex((l, j) => j > i && l.includes(end))
        // 窗口内压根没有结束标记时**不**跳块：那说明这不是一个能界定范围的块，
        // 硬跳会把整份 README 吃掉、描述直接变回 null，比留一行噪声更糟
        if (close !== -1) i = close // 结束标记所在行本身也属于这个块
        continue
      }
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

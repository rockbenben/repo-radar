import type { RemoteInfo } from "../types"

/** 从 origin（或第一个）remote 解析出可点开的 web 地址与主机名；无远程 → null */
export function remoteWeb(remotes: RemoteInfo[]): { host: string; url: string; label: string } | null {
  const origin = remotes.find((r) => r.name === "origin") ?? remotes[0]
  if (!origin) return null
  let u = origin.url.trim()
  // scp 形式 git@github.com:user/repo.git → https://github.com/user/repo
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(u)
  if (scp) u = `https://${scp[1]}/${scp[2]}`
  // ssh:// 与 git:// 形式 → https（服务端 githubSlug 认这些形式，web 端不认会导致队列跳转失灵、点了只能开详情）
  const ssh = /^(?:ssh|git):\/\/(?:[^@/\s]+@)?(.+)$/i.exec(u)
  if (ssh) u = `https://${ssh[1]}`
  u = u.replace(/\.git$/, "").replace(/\/+$/, "")
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    const label = `${parsed.host}${parsed.pathname}`.replace(/^\/+|\/+$/g, "")
    return { host: parsed.host, url: `https://${parsed.host}${parsed.pathname}`, label }
  } catch {
    return null // 本地 bare 路径等非 http 远程：不提供跳转
  }
}

/** 主机名恰为 github.com 的远程（不做子串匹配——corp-github.com 不算）。与服务端 githubRemoteUrl 同一判定 */
export function isGithubUrl(url: string): boolean {
  const host = remoteWeb([{ name: "x", url }])?.host.toLowerCase()
  return host === "github.com" || host === "www.github.com"
}

const MAIN_BRANCHES = new Set(["main", "master"])
/** 当前不在主分支（且非游离 HEAD）时为 true——提示"你还开着功能分支" */
// stash 描述里 "WIP on <branch>: " / "On <branch>: " 前缀与旁边分支徽标重复，去掉更清爽
export function cleanStashMessage(m: string): string {
  return m.replace(/^(?:WIP on|On) [^:]+:\s*/, "") || m
}

export function isSideBranch(branch: string | null): boolean {
  return branch !== null && !MAIN_BRANCHES.has(branch)
}

/** 距上次提交的天数；null lastCommit → null */
export function daysSince(iso: string | null, now = Date.now()): number | null {
  if (iso === null) return null
  return Math.floor((now - new Date(iso).getTime()) / 86_400_000)
}

// 语言/技术栈的标识色（近 GitHub 语言色）
const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Astro: "#ff5d01",
  Python: "#3572a5",
  Rust: "#dea584",
  Go: "#00add8",
  Shell: "#89e051",
  PowerShell: "#5391fe",
  "C#": "#178600",
  Dart: "#00b4ab",
  Ruby: "#701516",
  Java: "#b07219",
  PHP: "#4f5d95",
}
export function langColor(language: string | null): string {
  return (language && LANG_COLORS[language]) || "#8a8a97"
}

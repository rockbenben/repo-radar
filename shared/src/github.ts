import type { RemoteInfo } from "./types"

/** GitHub remotes in HTTP, SSH and scp form. */
export function githubSlug(url: string): string | null {
  const match = url.trim().match(/^(?:(?:https?|git|ssh):\/\/)?(?:[^@/\s]+@)?([\w.-]+)[:/]([a-z0-9-]+)\/([a-z0-9_.-]+?)(?:\.git)?\/?$/i)
  if (!match) return null
  const host = match[1].toLowerCase()
  if (host !== "github.com" && host !== "www.github.com") return null
  return `${match[2]}/${match[3]}`
}

/** Prefer GitHub origin, otherwise the first GitHub remote. */
export function githubRemoteUrl(remotes: RemoteInfo[]): string | undefined {
  const github = remotes.filter((remote) => githubSlug(remote.url) !== null)
  return (github.find((remote) => remote.name === "origin") ?? github[0])?.url
}

type GithubInboxKind = "pr" | "issue" | "ci"

export function isGithubInboxKind(kind: string): kind is GithubInboxKind {
  return kind === "pr" || kind === "issue" || kind === "ci"
}

export function githubInboxUrl(slug: string, kind: GithubInboxKind, target?: number | string | null): string {
  const repo = `https://github.com/${slug.split("/").map(encodeURIComponent).join("/")}`
  const number = typeof target === "number" && Number.isSafeInteger(target) && target > 0 ? target : null
  switch (kind) {
    case "pr":
      return repo + (number ? `/pull/${number}` : "/pulls")
    case "issue":
      return repo + (number ? `/issues/${number}` : "/issues")
    case "ci":
      return repo + (typeof target === "string" && /^[0-9a-f]{40}$/i.test(target) ? `/commit/${target}/checks` : "/actions")
  }
}

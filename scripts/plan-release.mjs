import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim()

export function nextVersion(base, messages, reserved) {
  let bump = 0
  for (const message of messages) {
    const [subject] = message.split("\n")
    if (/^[\w-]+(?:\([^)]+\))?!: /.test(subject) || /^BREAKING[ -]CHANGE: /m.test(message)) bump = 3
    else if (/^feat(?:\([^)]+\))?: /.test(subject)) bump = Math.max(bump, 2)
    else if (/^(fix|perf)(?:\([^)]+\))?: /.test(subject)) bump = Math.max(bump, 1)
  }
  if (!bump) return ""
  const parts = base.slice(1).split(".").map(Number)
  const index = 3 - bump
  parts[index]++
  parts.fill(0, index + 1)
  while (reserved.has(`v${parts.join(".")}`)) parts[2]++
  return parts.join(".")
}

export function planRelease(releases, expected) {
  const published = new Set(releases.filter(r => !r.draft && !r.prerelease).map(r => r.tag_name).filter(t => stableTag.test(t)))
  const tags = git("tag", "--sort=-version:refname").split("\n")
  const base = tags.find(t => published.has(t))
  if ([...published].some(t => !tags.includes(t))) throw new Error("Published release tag missing from checkout")
  const head = git("rev-parse", "HEAD")
  if (expected && published.has(`v${expected}`) && git("rev-list", "-1", `v${expected}`) === head) {
    return "published"
  }

  const baseCommit = base && git("rev-list", "-1", base)
  const common = base && git("merge-base", base, head)
  let version = ""
  if (base && common !== baseCommit) {
    if (common !== head) throw new Error(`Release history diverged from ${base}`)
    // A later run has already released a descendant of this commit.
  } else {
    const history = git("log", "--format=%B%x00", base ? `${base}..${head}` : head)
    const reserved = new Set(tags)
    for (const release of releases) {
      const tag = release.tag_name
      if (release.draft && release.target_commitish === head && stableTag.test(tag) &&
          (!reserved.has(tag) || git("rev-list", "-1", tag) === head)) {
        reserved.delete(tag)
      } else {
        reserved.add(tag)
      }
    }
    version = nextVersion(base ?? "v0.0.0", history.split("\0").map(m => m.trim()), reserved)
  }
  if (expected && expected !== version) throw new Error(`Stale release plan for ${expected}, current candidate: ${version || "none"}`)
  return version
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const rows = execFileSync("gh", ["api", "--paginate",
    `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`,
    "--jq", ".[] | {tag_name, draft, prerelease, target_commitish} | @json"], { encoding: "utf8" })
  const releases = rows.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  console.log(planRelease(releases, process.argv[2]))
}

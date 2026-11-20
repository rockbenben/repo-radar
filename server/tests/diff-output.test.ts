import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeEach, expect, it, vi } from "vitest"
import { getRepoDiff, GitError, stashDiff } from "../src/git"
import { cleanupFixtures, git, makeRepo } from "./fixtures"

const probe = vi.hoisted(() => ({ failPreview: false, streamedChars: 0 }))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return {
    ...actual,
    spawn: (command: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      const child = actual.spawn(command, args, options)
      const isPreview = args.includes("diff") || (args.includes("stash") && args.includes("show") && args.includes("-p"))
      if (isPreview) {
        child.stdout?.on("data", (chunk: string | Buffer) => {
          probe.streamedChars += chunk.length
        })
        if (probe.failPreview) {
          // 模拟 Git 在产出整个补丁后退出失败，检查错误对象也只保留有界输出。
          const emit = child.emit
          vi.spyOn(child, "emit").mockImplementation((event: string | symbol, ...values: unknown[]) =>
            Reflect.apply(emit, child, [event, ...(event === "close" && values[0] === 0 ? [1, values[1]] : values)]),
          )
        }
      }
      return child
    },
  }
})

const LIMIT = 20_000
const SUFFIX = "\n… (diff 已截断)"
const TAIL = "PATCH-TAIL"

beforeEach(() => {
  probe.failPreview = false
  probe.streamedChars = 0
})
afterAll(cleanupFixtures)

it.each(["worktree", "stash"])("bounds the retained output of a large %s diff without changing its preview", async (kind) => {
  const repo = makeRepo()
  writeFileSync(join(repo, "f0.txt"), `预览开头\n${"git preview line\n".repeat(32_000)}${TAIL}\n`)
  let read = async () => (await getRepoDiff(repo)).diff
  if (kind === "stash") {
    git(repo, "stash", "push", "-m", "large preview")
    const sha = git(repo, "rev-parse", "refs/stash").trim()
    read = async () => (await stashDiff(repo, sha)) ?? ""
  }

  const diff = await read()
  expect(diff).toContain("+预览开头")
  expect(diff).toHaveLength(LIMIT + SUFFIX.length)
  expect(diff.endsWith(SUFFIX)).toBe(true)
  expect(diff).not.toContain(TAIL)
  expect(probe.streamedChars).toBeGreaterThan(LIMIT * 10)

  probe.failPreview = true
  const err = await read().catch((reason: unknown) => reason)
  expect(err).toBeInstanceOf(GitError)
  expect((err as GitError).stdout).toContain("+预览开头")
  expect((err as GitError).stdout.length).toBeLessThanOrEqual(LIMIT)
})

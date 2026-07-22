import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"
import { runCommand } from "../src/exec"

describe("runCommand", () => {
  it("captures stdout and a zero exit code on success", async () => {
    const r = await runCommand(tmpdir(), "echo repo-radar-hello")
    expect(r.ok).toBe(true)
    expect(r.code).toBe(0)
    expect(r.output).toContain("repo-radar-hello")
  })

  it("reports a non-zero exit code as failure", async () => {
    const r = await runCommand(tmpdir(), "exit 3")
    expect(r.ok).toBe(false)
    expect(r.code).toBe(3)
  })

  it("runs in the given cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-exec-"))
    try {
      const r = await runCommand(dir, 'node -e "process.stdout.write(process.cwd())"')
      expect(r.ok).toBe(true)
      // 子进程 process.cwd() 返回真实工作目录（可能因 realpath/短长名/大小写而与传入值不同），
      // 只断言其中含我们刚建的临时目录的唯一 basename——平台中立，不假设 tmpdir 里含 "Temp"/"tmp"
      expect(r.output).toContain(basename(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

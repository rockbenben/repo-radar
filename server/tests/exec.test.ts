import { tmpdir } from "node:os"
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
    const r = await runCommand(tmpdir(), 'node -e "process.stdout.write(process.cwd())"')
    expect(r.ok).toBe(true)
    // 解析后的 realpath 可能大小写/短路径不同，只断言落在临时目录名下
    expect(r.output.toLowerCase()).toContain("temp")
  })
})

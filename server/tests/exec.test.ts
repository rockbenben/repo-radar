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

  // 超时必须**如实收工**，不能永不 settle。
  // shell:true 下真正的命令是 shell 的子进程，child.kill() 只结束 shell，孙进程继承着同一对
  // stdio 管道活下来——管道不关，'close' 就永远不来（'exit' 会来）。而 runCommand 只在 'close'
  // 里 resolve，于是 promise 永不 settle。调用方 tasks.ts 是 withRepoLock(id, () => runCommand(...))：
  // 该仓库的锁链从此永久阻塞，之后所有 git 操作（commit/push/fetch）全排在一个不会完成的
  // promise 后面，批量任务也永远不会 finished，退出时 drainRepoLocks 每次都等满 10 秒。
  it("超时后一定会 settle，即使孙进程还活着占着管道", async () => {
    const r = await Promise.race([
      runCommand(tmpdir(), 'node -e "setTimeout(()=>{},30000)"', 800),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("runCommand 超时后未 settle")), 12_000)),
    ])
    expect(r.ok).toBe(false)
    expect(r.output).toContain("超时")
  }, 20_000)

  it("正常结束的命令不受宽限期影响，仍按 close 的退出码返回", async () => {
    const r = await runCommand(tmpdir(), "echo done-fast", 30_000)
    expect(r.ok).toBe(true)
    expect(r.code).toBe(0)
    expect(r.output).toContain("done-fast")
    expect(r.output).not.toContain("超时")
  })
})

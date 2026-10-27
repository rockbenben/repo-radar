import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// release.yml 的 run: 块只在打 tag 时执行，ci.yml 的三平台门禁不解析 workflow。
// 缺一个 fi 的发布脚本能一路绿到发版——这里把每个 block scalar 抽出来做 bash -n。
// 不引 actionlint：只查 shell 语法，零依赖、零第三方 action。
const dir = resolve(process.argv[2] ?? ".github/workflows")
const files = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
let failures = 0
// bash 跑不起来时**不是**workflow 写错了：Windows 上 PATH 里的 bash 常是 WSL 启动器
// （WSL 没装/没开时它自己就失败），也可能是压根没装。这两种都会被 spawnSync 记成
// 「非零退出 + 一段看不懂的 stderr」——直接报成「shell syntax error」会把人带偏
// （实测本机每个块都被误报，workflow 本身却是好的）。
// 因此先把「bash 能不能用」验出来：不能就整轮跳过，并以独立的退出码说明「没查成」。
let bashBroken = null

const probe = spawnSync("bash", ["--version"], { encoding: "utf8" })
if (probe.error || probe.status !== 0) {
  // 只留第一行：WSL 启动器的报错是多行的（还有 <3> 前缀），整段塞进提示里没法读
  bashBroken = probe.error?.message ?? (probe.stderr ?? "").trim().split("\n")[0] ?? "未知原因"
}

for (const file of files) {
  if (bashBroken !== null) break
  const lines = readFileSync(join(dir, file), "utf8").split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)run:\s*\|[-+]?\s*$/)
    if (!match) continue
    const runIndent = match[1].length
    let blockIndent = null
    const body = []
    let j = i + 1
    for (; j < lines.length; j++) {
      const line = lines[j]
      if (line.trim() === "") {
        body.push("")
        continue
      }
      const indent = line.match(/^\s*/)[0].length
      if (indent <= runIndent) break
      if (blockIndent === null) blockIndent = indent
      body.push(line.slice(Math.min(blockIndent, indent)))
    }
    const script = `${body.join("\n")}\n`
    const tmp = join(tmpdir(), `rr-workflow-${process.pid}-${i}.sh`)
    writeFileSync(tmp, script, "utf8")
    const result = spawnSync("bash", ["-n", tmp], { encoding: "utf8" })
    rmSync(tmp, { force: true })
    if (result.error || result.status === null) {
      // bash 在探测时能用、这里却起不来（WSL 启动器这类会时好时坏）：当「跑不了」处理
      bashBroken = result.error?.message ?? "bash 启动失败"
      break
    }
    if (result.status !== 0) {
      failures++
      console.error(`\n${file}:${i + 1} shell syntax error`)
      console.error((result.stderr ?? "").trim())
      console.error(script)
    }
    i = j - 1
  }
}

if (bashBroken !== null) {
  console.error(`\n跳过 workflow shell 检查：这台机器上 bash 不可用（${bashBroken}）`)
  console.error("这不是 workflow 的语法错误。装一个可用的 bash 再查：Windows 上可用 Git 自带的")
  console.error("C:\\Program Files\\Git\\bin\\bash.exe，或在 WSL/容器里跑本脚本。")
  // 退出码 2 = 「没查成」，与 1（「查出语法错误」）区分开；CI 里两者都算失败，
  // 免得这一关在 runner 上悄悄变成空跑。
  process.exit(2)
}

if (failures > 0) {
  console.error(`\n${failures} workflow shell block(s) failed`)
  process.exit(1)
}
console.log(`workflow shell blocks OK (${files.length} files)`)

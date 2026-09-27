#!/usr/bin/env node
// 扫描并发基准：复刻 store.ts 全量扫描的冷路径（getRepoCore → gitFingerprint → getRepoHeavy），
// 在一批合成仓库上测不同 mapLimit 并发的墙钟，用来校准 server/src/store.ts 的 CONCURRENCY。
//
// 为什么在 node 层测而不是启动应用去测：托盘应用有单实例锁、端口会漂移、启动扫描和手动重扫
// 混在同一份日志里，进程级 A/B 的计时基本必然被污染。这里只测那条真正花时间的路径。
//
// 用法：
//   npm run bench                                       # 300 个仓库（50 个脏），c8 vs c16
//   node scripts/bench-scan.mjs --repos=60 --rounds=1   # 快跑一遍
//   node scripts/bench-scan.mjs --levels=8,16,32 --keep
import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server")

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback
const REPOS = Number(arg("repos", 300))
const LEVELS = arg("levels", "8,16").split(",").map(Number)
const ROUNDS = Number(arg("rounds", 2))
const KEEP = process.argv.includes("--keep")

/** 工作池：只用来并发建 fixture，不参与计时 */
async function pool(items, limit, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  })
  await Promise.all(workers)
}

const git = (cwd, args) => {
  const r = spawnSync("git", args, { cwd, stdio: "ignore" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败于 ${cwd}`)
}

/**
 * 建 N 个仓库，其中 1/6 是脏的（一处改动 + 一个未跟踪文件）。
 * 比例照真实工作区：绝大多数仓库当下无事，少数在改。
 */
async function makeFixture(dir) {
  mkdirSync(dir, { recursive: true })
  const identity = ["-c", "user.email=bench@local", "-c", "user.name=bench"]
  await pool(
    Array.from({ length: REPOS }, (_, i) => i),
    16,
    (i) => {
      const repo = join(dir, `r${i}`)
      mkdirSync(repo, { recursive: true })
      writeFileSync(join(repo, "a.js"), `export const n = ${i}\n`)
      git(repo, ["init", "-q", "."])
      git(repo, ["add", "."])
      git(repo, [...identity, "commit", "-qm", "init"])
      if (i % 6 === 0) {
        writeFileSync(join(repo, "a.js"), `export const n = ${i}\n// 待提交的改动\n`)
        writeFileSync(join(repo, "b.js"), "未跟踪\n")
      }
    },
  )
  return readdirSync(dir).length
}

/**
 * 被测入口。写成字符串是因为它要 import server/src 下的 .ts；交给 esbuild 打包后，
 * 跑的就是应用那份实现本身，而不是一份会随时间漂移的复刻。
 * esbuild 声明在 root devDependencies（就是为了让这个脚本能直接 import 它）。
 */
const ENTRY = `
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { gitFingerprint } from "./src/fingerprint"
import { getRepoCore, getRepoHeavy } from "./src/git"
import { mapLimit } from "./src/map-limit"

const dir = process.argv[2]
const paths = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(dir, e.name))

async function pass(concurrency) {
  const t0 = Date.now()
  await mapLimit(paths, concurrency, async (p) => {
    const core = await getRepoCore(p)
    const fp = gitFingerprint(p, core.oid)
    const { heavy, degraded } = await getRepoHeavy(p, core)
    // 指纹拿不到、heavy 降级或形状变了，说明应用侧签名已经动过：立刻炸，
    // 不要交出一个跑在假路径上的数字
    if (core.oid !== null && typeof core.oid !== "string") throw new Error("core.oid 形状变了")
    if (typeof fp !== "string") throw new Error("gitFingerprint 没给出指纹: " + p)
    if (!Array.isArray(heavy.remotes) || !Array.isArray(heavy.mergedBranches) ||
        !("stashCount" in heavy) || !("release" in heavy) || !("lastCommit" in heavy)) throw new Error("heavy 形状变了")
    if (degraded) throw new Error("heavy 降级: " + p)
  })
  return Date.now() - t0
}

const rounds = Number(process.argv[process.argv.length - 1])
const levels = process.argv.slice(3, process.argv.length - 1).map(Number)
const order = []
for (let r = 0; r < rounds; r++) order.push(...levels, ...levels.slice().reverse())
await pass(levels[0]) // 预热：首轮受文件系统冷缓存支配，丢掉
for (const c of order) console.log(JSON.stringify({ c, ms: await pass(c) }))
console.log(JSON.stringify({ repos: paths.length }))
`

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) / 1000
}

async function main() {
  const work = join(tmpdir(), "repo-radar-bench")
  const repos = join(work, "repos")
  rmSync(work, { recursive: true, force: true })

  const t0 = Date.now()
  console.log(`建 ${REPOS} 个合成仓库于 ${repos}`)
  const made = await makeFixture(repos)
  console.log(`  ${made} 个就绪，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const { build } = await import("esbuild")
  const outfile = join(work, "bench.mjs")
  await build({
    stdin: { contents: ENTRY, resolveDir: SERVER, sourcefile: "bench-scan-entry.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm", // 入口里有顶层 await
    outfile,
  })

  const child = spawnSync(process.execPath, [outfile, repos, ...LEVELS, ROUNDS], { encoding: "utf8" })
  if (child.status !== 0) {
    console.error(child.stderr)
    rmSync(work, { recursive: true, force: true })
    process.exit(1)
  }

  const runs = new Map(LEVELS.map((c) => [c, []]))
  let measured = 0
  for (const line of child.stdout.split("\n").filter(Boolean)) {
    const obj = JSON.parse(line)
    if (obj.repos !== undefined) measured = obj.repos
    else runs.get(obj.c).push(obj.ms)
  }

  const base = median(runs.get(LEVELS[0]))
  console.log(`\n${measured} 个仓库 · ${ROUNDS} 组交替（正反顺序各测一遍，排除缓存 warming 的顺序效应）`)
  for (const c of LEVELS) {
    const med = median(runs.get(c))
    const each = runs.get(c).map((ms) => (ms / 1000).toFixed(1)).join("s / ")
    console.log(`  c=${String(c).padEnd(3)} 中位 ${med.toFixed(1)}s  (${each}s)  相对 c=${LEVELS[0]} ${(base / med).toFixed(2)}x`)
  }
  console.log(`\n判读：倍率在 0.95–1.05 之间就是噪声，不足以动 store.ts 的 CONCURRENCY。`)
  console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  if (KEEP) console.log(`仓库目录已保留：${repos}`)
  else rmSync(work, { recursive: true, force: true })
}

main()

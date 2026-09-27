// 疑似旧身份提示（方案 D）：仓库失联且自动认领窗口（账本的「代」）已关闭之后，同 origin
// URL 的仓库又以新路径出现时，系统不自动认领（判据②对多 clone 不可靠，见 repo-identity.ts），
// 而是在账本挂一条 suspect，卡片提示、由用户手动确认迁移。走真 git（bare + clone）。
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG, type Config } from "../src/config"
import { repoId } from "../src/git"
import { IdentityLedger } from "../src/repo-identity"
import { RepoStore } from "../src/store"
import { createApi } from "../src/routes"
import type { RepoStatus } from "../src/types"

const dirs: string[] = []
const ledgers: IdentityLedger[] = []
function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), name))
  dirs.push(d)
  return d
}
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd })
}
afterAll(() => {
  for (const led of ledgers.splice(0)) led.flush()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

/** 带一个提交 + tag 的 bare 仓库，充当共享 upstream */
function makeBare(): string {
  const work = tmp("rr-sbare-")
  git(work, "init", "-b", "main", "-q")
  git(work, "config", "user.email", "t@t.local")
  git(work, "config", "user.name", "t")
  writeFileSync(join(work, "a.txt"), "1")
  git(work, "add", "-A")
  git(work, "commit", "-qm", "c0")
  const bare = join(tmp("rr-sbare-"), "up.git")
  git(work, "clone", "--bare", "-q", ".", bare)
  return bare
}

function makeClone(parent: string, name: string, bare: string): string {
  const dest = join(parent, name)
  mkdirSync(dest, { recursive: true })
  git(dest, "clone", "-q", bare, ".")
  return dest
}

/** 无远程的陪跑仓库：它的存在让账本的「代」每轮推进，失联条目才会真正出窗 */
function makePlain(parent: string, name: string): string {
  const dest = join(parent, name)
  mkdirSync(dest, { recursive: true })
  git(dest, "init", "-b", "main", "-q")
  git(dest, "config", "user.email", "t@t.local")
  git(dest, "config", "user.name", "t")
  writeFileSync(join(dest, "f.txt"), "1")
  git(dest, "add", "-A")
  git(dest, "commit", "-qm", "c0")
  return dest
}

function harness(root: string): { store: RepoStore; ledger: IdentityLedger; cfg: Config } {
  const cfg: Config = { ...structuredClone(DEFAULT_CONFIG), roots: [root] }
  const ledger = new IdentityLedger(join(tmp("rr-sled-"), "repo-identity.json"))
  ledgers.push(ledger)
  return { store: new RepoStore(() => cfg, undefined, undefined, undefined, ledger), ledger, cfg }
}

const find = (list: RepoStatus[], path: string): RepoStatus | undefined => list.find((r) => r.path === path)

/** 造好「A 出窗 + B 新铸带 suspect」的局面，返回句柄 */
async function staged() {
  const root = tmp("rr-sroot-")
  const bare = makeBare()
  const cloneA = makeClone(root, "app", bare)
  makePlain(root, "sibling")
  const h = harness(root)
  await h.store.refreshAll()
  const idA = repoId(cloneA)
  rmSync(cloneA, { recursive: true, force: true })
  await h.store.refreshAll()
  const cloneB = makeClone(root, "app-copy", bare)
  await h.store.refreshAll()
  return { ...h, root, bare, cloneA, cloneB, idA }
}

describe("origin URL 记账", () => {
  it("克隆仓库扫描一轮后，账本条目带上它的 origin fetch 地址", async () => {
    const root = tmp("rr-sroot-")
    const bare = makeBare()
    const cloneA = makeClone(root, "app", bare)
    const { store, ledger } = harness(root)
    const list = await store.refreshAll()
    const a = find(list, cloneA)!
    expect(a.remotes[0]?.name).toBe("origin")
    expect(a.remotes[0]?.url).toBeTruthy()
    expect(ledger.get(a.id)?.url).toBe(a.remotes[0]?.url)
  })
})

describe("疑似旧身份检测（自动认领窗口已关闭之后）", () => {
  it("老身份出窗后同 origin 的新克隆 → 铸新 id 并挂 suspect 指向老条目；提示跨轮存活", async () => {
    const root = tmp("rr-sroot-")
    const bare = makeBare()
    const cloneA = makeClone(root, "app", bare)
    const sibling = makePlain(root, "sibling")
    const { store, ledger } = harness(root)

    await store.refreshAll() // 轮1：A 与 sibling 入账
    const idA = repoId(cloneA)
    expect(ledger.get(idA)).toBeDefined()

    rmSync(cloneA, { recursive: true, force: true })
    await store.refreshAll() // 轮2：A 没了；sibling 把代推进一步，A 停在这一代的前一格

    const cloneB = makeClone(root, "app-copy", bare) // 轮3 才出现：此时 A 的条目已出窗，自动认领够不着
    const list3 = await store.refreshAll()
    const b = find(list3, cloneB)!
    expect(b.id).toBe(repoId(cloneB)) // 确实没被自动认领——这是刻意保留的保守侧
    expect(b.suspect?.oldId).toBe(idA)
    expect(b.suspect?.oldPath).toBe(cloneA)
    expect(ledger.get(b.id)?.suspect?.oldId).toBe(idA) // 挂在账本上跨轮存活

    const list4 = await store.refreshAll() // 轮4：b 不再是新铸，提示仍应从账本读出
    expect(find(list4, cloneB)!.suspect?.oldId).toBe(idA)
    expect(find(list4, sibling)!.suspect).toBeNull() // 无辜仓库不带提示
  })

  it("同 origin 有两个失联条目 → 歧义，不提示", async () => {
    const root = tmp("rr-sroot-")
    const bare = makeBare()
    const cloneA = makeClone(root, "app1", bare)
    const cloneA2 = makeClone(root, "app2", bare)
    makePlain(root, "sibling")
    const { store } = harness(root)
    await store.refreshAll()
    rmSync(cloneA, { recursive: true, force: true })
    rmSync(cloneA2, { recursive: true, force: true })
    await store.refreshAll()
    const cloneB = makeClone(root, "app-copy", bare)
    const list = await store.refreshAll()
    expect(find(list, cloneB)!.suspect).toBeNull()
  })

  it("同 origin 还有活着的持有者（别的本地 clone 在盘上）→ 不提示", async () => {
    const root = tmp("rr-sroot-")
    const bare = makeBare()
    const cloneA = makeClone(root, "app", bare)
    const keepsake = makeClone(root, "keepsake", bare) // 同 upstream 的另一个 clone，一直在盘上
    const { store } = harness(root)
    await store.refreshAll()
    rmSync(cloneA, { recursive: true, force: true })
    await store.refreshAll()
    const cloneB = makeClone(root, "app-copy", bare)
    const list = await store.refreshAll()
    expect(find(list, cloneB)!.suspect).toBeNull()
    expect(find(list, keepsake)!.suspect).toBeNull()
  })
})

describe("rebind（用户确认迁移）与 dismiss", () => {
  it("确认迁移：老 id 复活并持有新路径，标签跟着走，新铸条目出账", async () => {
    const { store, ledger, cloneA, cloneB, idA } = await staged()
    const b = store.list().find((r) => r.path === cloneB)!
    expect(b.suspect?.oldId).toBe(idA)
    const r = store.rebindSuspect(b.id)
    expect(r).toEqual({ ok: true, oldId: idA })
    await store.refreshAll()
    const revived = store.get(idA)
    expect(revived?.path).toBe(cloneB)
    expect(revived?.suspect ?? null).toBeNull() // 迁移后提示消失
    expect(store.get(repoId(cloneB))).toBeUndefined() // 新铸条目连同卡片出账
    expect(ledger.get(repoId(cloneB))).toBeUndefined()
    expect(ledger.get(idA)?.path).toBe(cloneB)
  })

  it("挂账的 URL 与现实不符（远程换过）→ 拒绝", async () => {
    const { store, cloneB } = await staged()
    const b = store.list().find((r) => r.path === cloneB)!
    git(cloneB, "remote", "set-url", "origin", "https://elsewhere.example/x.git")
    await store.refreshAll() // 重读 remotes，url 记账更新，suspect 还在
    const b2 = store.list().find((r) => r.path === cloneB)!
    expect(b2.suspect?.oldId).toBeTruthy() // 老 suspect 仍挂在账上
    const r = store.rebindSuspect(b2.id)
    expect(r.ok).toBe(false)
  })

  it("被提示的新卡片已经有自己的用户数据 → 拒绝（不做静默合并）", async () => {
    const { store, cfg, cloneB } = await staged()
    const b = store.list().find((r) => r.path === cloneB)!
    cfg.tags[b.id] = ["mine"]
    const r = store.rebindSuspect(b.id)
    expect(r.ok).toBe(false)
    expect(store.get(b.id)?.suspect?.oldId).toBeTruthy() // 拒绝不动挂账
  })

  it("dismiss：提示摘掉，账本条目其它字段不动", async () => {
    const { store, ledger, cloneB, idA } = await staged()
    const b = store.list().find((r) => r.path === cloneB)!
    const updated = store.dismissSuspect(b.id)
    expect(updated?.suspect ?? null).toBeNull()
    expect(ledger.get(b.id)?.suspect).toBeUndefined()
    expect(ledger.get(b.id)?.path).toBe(cloneB)
    expect(ledger.get(idA)).toBeDefined() // 老条目还在（30 天护栏内），只是不再提示
  })
})

describe("HTTP 端点", () => {
  it("POST rebind → 200 且卡片变成老 id；重复调用 400；dismiss → 200 且提示摘掉", async () => {
    const { store, cloneB, idA } = await staged()
    const app = createApi(store, join(tmp("rr-scfg-"), "config.json"))
    const b = store.list().find((r) => r.path === cloneB)!
    const res = await app.request(`/api/repos/${b.id}/rebind`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { repo?: { id?: string } }
    expect(body.repo?.id).toBe(idA)
    const again = await app.request(`/api/repos/${idA}/rebind`, { method: "POST" })
    expect(again.status).toBe(400) // 挂账已随迁移摘掉，重复点不会二次搬迁

    const { store: s2, cloneB: b2path } = await staged()
    const app2 = createApi(s2, join(tmp("rr-scfg-"), "config.json"))
    const b2 = s2.list().find((r) => r.path === b2path)!
    expect(b2.suspect).toBeTruthy()
    const dis = await app2.request(`/api/repos/${b2.id}/suspect-dismiss`, { method: "POST" })
    expect(dis.status).toBe(200)
    const after = (await dis.json()) as { suspect?: unknown }
    expect(after.suspect ?? null).toBeNull()
  })
})

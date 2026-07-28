# 监听与重扫的性能重构

日期：2026-07-28
状态：待实施

## 背景

用户反馈开启文件监听后整机性能受到明显影响。实测证实了这个感受，但开销的位置和直觉不同：贵的不是「监听在跑」，而是**反复建立监听**和**无差别地重跑全部 git 命令**。

### 实测数据

环境：Windows 11，`roots = ["D:\\Backup\\Libraries\\Documents\\GitHub"]`，扫描到 73 个仓库。

| 项 | 实测值 |
| --- | --- |
| 常驻目录句柄（chokidar 挂载数） | 2311 |
| 建立监听的 readdir 次数 | 2238 |
| 建立监听 stat 的条目数 | 32780 |
| 纯遍历耗时（热缓存，不含 chokidar 自身开销与挂 watch 的 syscall） | 309ms |
| 一轮全量重扫 | 467 个 git 进程 / 7151ms |
| 平均每仓库 | 6.4 个 git 进程 / 98ms |
| 只跑 `status` 一个进程（并发 8） | 1301ms |
| 根目录级递归 `fs.watch` 建立耗时 | 2ms |
| 根目录级递归监听空闲 3 秒事件量 | 0 |

关键放大因素：`backend.ts:226-228` 在**每轮兜底重扫之后无条件调用 `applyWatch()`**，而 `watcher.ts:120` 的 `doWatch` 会先 `closeChokidar()` 再整套重建。默认 `autoScanMinutes = 30`，因此上表的「467 个进程 + 2311 个句柄的拆建」每 30 分钟完整发生一次。代码注释（`backend.ts:240`）本身就记录了「applyWatch 重建几百个监听要花好几秒」。

### 三个成本中心

1. **建立/重建监听**：2238 次 readdir + 32780 次 stat，每 30 分钟一次。
2. **全量重扫的 git 进程**：467 个 spawn，7151ms，每 30 分钟一次。Windows 上进程创建本身就昂贵，叠加杀软扫描后更甚。
3. **常驻句柄**：2311 个目录句柄的内存与内核资源占用。

## 目标

- 常驻目录句柄从 2311 降到 1（每个 scan root 一个）。
- 建立监听的成本从 32780 次 stat 降到 0，且不再随重扫周期性重建。
- 一轮全量重扫从 467 个 git 进程 / 7151ms 降到约 100 个进程 / 约 1300ms。
- 启动扫描（含开机自启）同样受益于持久化缓存，从 7151ms 降到约 1300ms。
- 不牺牲刷新的正确性：分支、工作区脏状态、ahead/behind 在任何时刻都是实时的。

## 非目标

- **仓库改名后身份（标签/收藏/归档/便签/已消队列项）的迁移**。这是一个真实且已确认的缺陷——`git.ts:77` 的 `repoId = sha1(小写路径)` 让路径成为主键，改名等于换仓库——但它与本轮的性能目标正交，单独一轮处理。本轮的杠杆 1 会让它变得容易做：递归监听直接送来 rename 事件，且指纹机制提供了识别「同一个仓库换了路径」所需的材料。
- 减少 `git status` 本身的开销（例如启用 fsmonitor / untracked cache）。
- 改变默认的 `autoScanMinutes = 30`。

## 设计

### 杠杆 1：监听层改为「策略 + 归属映射」

`server/src/watcher.ts` 重写，拆出两个可互换的策略：

| | `RecursiveRootStrategy`（win32 / darwin） | `PerRepoStrategy`（linux） |
| --- | --- | --- |
| 监听目标 | 每个 scan root 一个 `fs.watch(root, { recursive: true })` | 每仓库 4 个目标 + `depth: 2`（即现有实现，原样保留） |
| 句柄数 | 每个 root 一个 | 每仓库数十个 |
| 建立成本 | 0 syscall | 完整遍历 |

**为什么按平台分**：Windows 的 `ReadDirectoryChangesW` 子树模式和 macOS 的 FSEvents 都是内核级递归，一个句柄覆盖整棵树。而 Node 在 Linux 上的 `recursive: true` 是**用户态实现**——它自己递归遍历并为每个目录加 inotify watch，且不接受 ignore 列表，因此会为每一个 `node_modules` 子目录都加上 watch，比现状更糟，并可能撞上 `fs.inotify.max_user_watches`。Linux 上目录不会被锁定、逐仓库策略也工作良好，没有更换的理由。

策略选择必须可注入，否则两个策略中只有一个能在 CI 上被测到。

#### 对外接口

`RepoWatcher` 对外收敛为两个方法，核心是**把「监听什么」与「有哪些仓库」彻底解耦**：

```ts
/** 只在 roots 真的变化时重建监听（罕见）。递归策略下这是唯一会产生 syscall 的路径 */
setRoots(roots: string[]): Promise<void>

/** 仓库增删改名后更新「路径 → repoId」映射。纯 JS，零 syscall */
setRepos(repos: WatchedRepo[]): void
```

`close()` 语义不变。

不在 roots 之内的 `manualRepos`：递归策略下为每个 manual repo 单独开一个递归监听（一个句柄）。数量本就很少。

#### 事件归属

现有实现对每个事件做 `repos.find(r => file.startsWith(r.path))`——按仓库数线性扫描。递归监听的事件量更大，这条热路径必须便宜，改为：

1. **廉价预过滤**：直接在 root-relative 路径上按段判断 `node_modules`、`.git/objects` 等，命中即丢弃，不做任何进一步工作。
2. **祖先段查表**：从事件路径逐段向上，在 `Map<归一化仓库路径, repoId>` 里查找，命中即为所属仓库。深度上界是扫描深度 6，因此是 O(≤6) 次哈希查找而非 O(仓库数) 次 `startsWith`。
3. **仓库内 ignore**：拿到仓库根之后，用现有的 `shouldIgnorePath(p, [repoRoot])` 判断仓库内相对段。

Windows 路径大小写不敏感，映射表的键统一小写（沿用现有 `samePath` 的判断口径）。

#### 保留不动的部分

防抖 500ms、冷却 60s、`serialize()` 串行链、`forgetExcept()` 定时器清理——**逐行保留**。这些逻辑与监听机制无关，且现有注释记录的坑（两个 `watch()` 交错导致 chokidar 实例失去引用而无法关闭、整轮 `close()` 吞掉已收下未触发的变更）都是实际缺陷换来的。

### 杠杆 2：`.git` 指纹缓存

`getRepoStatus`（`git.ts:541`）拆成两个函数：

- **`getRepoCore(path)`——永远执行，1 个 git 进程。**
  `git --no-optional-locks status --porcelain=v2 --branch` 提供分支、脏计数、ahead/behind，以及它本来就免费输出的 `# branch.oid <sha>`。
  注意 `parseStatus`（`git.ts:101`）目前只解析 `# branch.head` 和 `# branch.ab`，`# branch.oid` 一直在输出里但被忽略——需要新增一行解析，不增加任何 git 调用。空仓库时该行是 `# branch.oid (initial)`，按缺失处理。
- **`getRepoHeavy(path)`——指纹未变则复用上轮结果。**
  `stash list`、`for-each-ref refs/tags`、`rev-list --count`、`remote -v`、`log -1`、`branch --merged`，外加 `readRepoMeta`（读 package.json / README）与 `detectLanguage`（探测标志文件）。

#### 指纹构成

`branch.oid`（由 core 免费提供）＋ 以下 6 个路径的 `mtimeMs` 与 `size`：

```
.git/HEAD          .git/index         .git/packed-refs
.git/FETCH_HEAD    .git/refs/stash    .git/logs/HEAD
```

不存在的文件计入指纹时记为固定的缺失标记（`FETCH_HEAD`、`refs/stash` 常态不存在，从无到有本身就是变化信号）。

6 次 `stat`（每次约 5µs）替代 6 次进程 spawn（每次约 15ms），相差三个数量级。

#### 正确性边界（必须明确）

**指纹只用于跳过缓存，不承担正确性兜底。** 万一指纹漏判，后果有明确上界：

- **永远实时**：分支、工作区脏计数、ahead/behind——它们来自每次都执行的 core。
- **最多旧一轮（默认 30 分钟）**：tag/release 计数、stash 计数与最老时间、remotes、最近提交、已合并分支、语言、描述。

此外，文件监听触发的 `refreshOne` 必然重算指纹并发现变化，因此「刚提交完看板不刷新」不会发生。缓存实际只在**周期性重扫那些无人改动的仓库**时命中。

#### 缓存存储

落盘到 `<config dir>/repo-cache.json`，与现有的 `github-desc.json`、`github-inbox.json` 同一模式（含 `prune(ids)` 剪枝，见 `backend.ts:229-231`）。

- 键：`repoId`；值：`{ fingerprint, heavy }`。
- 命中条件：`fingerprint` 完全相等。任何不等或读取失败一律视为未命中，走完整路径。
- 每轮全量重扫后按当前仓库 id 集合剪枝，避免无界增长。
- 缓存文件损坏/无法解析：当作空缓存，记日志，不影响启动。

落盘的收益是开机自启时的首轮扫描同样从 7151ms 降到约 1300ms。

### 杠杆 3：重扫不再重建监听

`backend.ts` 的 `doRescanAndWatch` 改为：

- 重扫结束后调用 `automation.applyRepos(repos)`（新方法）→ `watcher.setRepos(...)`，纯 JS，零 syscall。
- 只有 `roots` / `manualRepos` 真的变化时才调用 `watcher.setRoots(...)`。`applyConfig` 已经在做「逐字段与旧值比对，只重装真变了的」，沿用这个模式。
- 现有的 `applyWatch(enabled)` 保留，但职责收窄为「按 `autoWatch` 开关装/拆监听」；`autoWatch` 关闭时 `setRepos` 只更新映射表、不建立任何监听。

`automation.ts` 的 `byWatchPriority` 截断逻辑与 `watchLimit`：

- **配置字段保留**，但只在 `PerRepoStrategy`（Linux）下生效——那里仍需要一个 inotify 用量的阀门。
- 递归策略下 `coverage()` 如实返回 `{ watched: total, total }`。设置面板本来就显示实时 coverage，会自然变成 100%。
- README 中「watching N of M」与 `watchLimit` 的描述需要说明平台差异。

现有配置文件不受任何破坏。

## 数据流

```
fs.watch(root, {recursive:true})
        │ event(relPath)
        ▼
  廉价预过滤（node_modules / .git/objects）──丢弃
        │
        ▼
  祖先段查 Map<仓库路径, repoId>  ──未命中──丢弃
        │
        ▼
  shouldIgnorePath(仓库内相对段) ──命中──丢弃
        │
        ▼
  防抖 500ms ／ 冷却 60s（现有逻辑）
        │
        ▼
  store.refreshOne(id)
        │
        ├─ getRepoCore()  ← 永远执行，1 个 git 进程
        └─ 指纹变了？── 是 ──▶ getRepoHeavy()（6 个进程）＋写缓存
                       └─ 否 ──▶ 复用 repo-cache.json 里的 heavy
        │
        ▼
  hub.broadcast("repo:updated")
```

## 错误处理

递归监听最需要认真对待的失败模式是**丢事件**。打包后日志是唯一诊断面，以下情况必须留痕迹（沿用 `watcherErrorIsNoise` 既有的「出事的是监听目标本身就必须报」的分级原则）：

| 情况 | 处理 |
| --- | --- |
| Windows `ReadDirectoryChangesW` 缓冲区溢出（构建期爆发），Node 抛 `error` 或 `filename === null` | 记日志 + 立即触发该 root 的一轮重扫 |
| root 不存在 / 无权限 / 被改名（ENOENT、EPERM） | 记日志；该 root 下所有仓库失去监听，`coverage()` 必须如实反映，不能装作还在监听 |
| `fs.watch` 抛出（平台不支持递归等） | 记日志并回退到 `PerRepoStrategy`，功能不中断 |
| 指纹 `stat` 失败（仓库消失/无权限） | 一律视为「指纹已变」，走完整路径，由现有 `errorStatus` 处理 |
| `repo-cache.json` 损坏 | 当作空缓存，记日志，不影响启动 |

兜底重扫保持 `autoScanMinutes = 30` 不变。它的角色反而更纯粹了：专门补溢出丢掉的事件；而它自身的成本已从 7151ms 降到约 1300ms。

## 测试

`server/tests/watcher.test.ts` 现有的防抖/冷却/串行化用例保留（那些逻辑不变）。新增：

- **归属映射**：祖先段查表在嵌套仓库下取最深匹配；Windows 大小写不敏感；root 前缀必须停在分隔符上（`D:\repo` 不得认领 `D:\repo-other`——现有 `shouldIgnorePath` 的注释记录了这个坑）。
- **预过滤**：root-relative 路径上的 `node_modules` / `.git/objects` 判断，且不得因「仓库恰好放在名字含 node_modules 的目录下」而整个仓库被静默忽略。
- **溢出处理**：注入 `error` 事件与 `filename === null`，断言触发了重扫并记了日志。
- **策略可注入**：两个策略都能在任意平台上被构造和测试。
- **指纹**：命中/未命中时的 git 调用次数——用可计数的 fake spawn 断言「未命中 7 个、命中 1 个」。
- **指纹敏感度**：6 个路径各自变化时都判定为未命中；`branch.oid` 变化判定为未命中。
- **缓存剪枝**：仓库消失后 `repo-cache.json` 中对应条目被清除。
- **`setRepos` 零 syscall**：断言仓库列表变化不会重建监听（用策略上的调用计数）。

## 风险

- **构建期事件量上升**：递归监听下内核不再帮忙过滤 `node_modules` / `obj`。实测该机器上后台构建的 `obj/` churn 约 100 事件/秒，而处理成本是纯字符串判断，量级上无关紧要。真正的风险是缓冲区溢出导致丢事件，已由上面的错误处理与兜底重扫覆盖。
- **平台分叉**：两套策略意味着两条代码路径。通过可注入的策略选择保证两者都被测试覆盖。
- **指纹漏判**：后果上界已在「正确性边界」一节明确，且实时性最强的字段不依赖指纹。

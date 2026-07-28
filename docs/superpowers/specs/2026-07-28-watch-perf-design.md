# 监听与重扫的重构：性能，以及与路径解耦的仓库身份

日期：2026-07-28
状态：待实施

## 背景

用户反馈开启文件监听后整机性能受到明显影响。实测证实了这个感受，但开销的位置和直觉不同：贵的不是「监听在跑」，而是**反复建立监听**和**无差别地重跑全部 git 命令**。

同一批代码还带来第二个已确认的缺陷：仓库改名后标签、收藏、归档等用户数据全部丢失。两者的根因相同——**程序把文件系统路径同时当成了监听锚点和主键**——因此同轮处理（理由见「为什么身份问题必须与性能同轮」）。

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
- **仓库改名/移动后，标签、收藏、归档、便签、分组、已消队列项全部保留。**

### 为什么身份问题必须与性能同轮

杠杆 1 让仓库的增删改名从「最长 30 分钟后才被发现」变成「秒级」。由于 `git.ts:77` 的 `repoId = sha1(小写路径)` 让路径成为主键，改名即换仓库——这意味着**只做性能优化会让改名的破坏来得更快**（数据损失量不变，但从 30 分钟延迟变成秒级）。同时，杠杆 1 的目录结构事件与杠杆 2 的 `.git` 探测都是身份识别所需的材料，分两轮做要把同一批设计重想一遍。

用户配置实测已存在 1 条死条目（`lastOpened` 中的 `d1fd88bb29d4` 指向一个已不存在的仓库），证实这是已经在发生的数据损失，而非假想缺陷。

## 非目标

- 减少 `git status` 本身的开销（例如启用 fsmonitor / untracked cache）。
- 改变默认的 `autoScanMinutes = 30`。
- 为 `manualRepos` 的改名做自动认领（`scan()` 不覆盖根目录之外的路径，没有「新出现的路径」可配对）。本轮只把「静默消失」改成「如实提示路径已失效」。

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

### 杠杆 4：仓库身份与路径解耦

核心是一个翻转：**`repoId(path)` 的生成规则一个字不改，改的是什么时候调用它。**

- 现在：每次 `getRepoStatus`（`git.ts:585`）都用当前路径重算 → 路径变 = 换了个仓库。
- 改后：只在**首次发现**该仓库时铸造一次，之后由身份账本认领。

于是改名后这个仓库**继续使用原来的 id**。`config.json`（tags / favorites / archived / notes / groupOverrides / lastOpened）、前端的 `rr.dismissed`（`App.tsx:837`）、`github-desc.json`、`github-inbox.json` **全都不需要改动一个字节**，因为 id 从未变化。不需要写迁移代码，也不需要碰前端。

**向后兼容是白拿的**：现有用户首次升级时账本为空，每个仓库都走「铸造」路径，得到的正是 `repoId(当前路径)`——与他们 `config.json` 里已有的 id 完全一致。

#### 身份账本

`<config dir>/repo-identity.json`，`id → { path, dev, ino, rootCommit? }`。

#### 认领流程

只在需要时执行，平时零成本。每轮全量重扫结束时比对 id 集合：

- **没有 id 消失** → 什么都不做（99.9% 的情况）。
- **有 id 消失且有新路径出现** → 进入认领：
  1. 消失的 id 从账本取 `dev + ino`；新出现的路径 `stat(join(path, ".git"))` 取 `dev + ino`。
  2. 匹配成功 → 认领：该路径继续使用老 id，账本只更新 `path`。
  3. 匹配失败 → 对这两批分别执行 `git rev-list --max-parents=0 HEAD` 取根提交 hash，再匹配一次。覆盖跨卷移动、从备份恢复、以及 `ino` 不可用的文件系统。
  4. 仍然匹配失败 → 判定为真实的删除 + 新增。

认领要求**一一对应**：只有「1 个消失 ↔ 1 个新增」时才认领，多对多时宁可不猜。这条约束顺带挡掉了根提交 hash 在同一仓库的多个 clone 之间撞车的风险。

根提交 hash 只在有仓库消失时才计算，日常零开销；算出的值写入账本，之后无需重算（根提交只在 rebase 根提交这种极端操作后才变，届时会退化为「认领失败 = 删除 + 新增」，即现状行为）。

#### `ino === 0` 必须特判

FAT32 / exFAT / 部分网络共享上 Node 拿不到稳定的文件 id，`stat().ino` 返回 0。此时**该判据整体作废，直接走根提交 hash**。绝不能拿 0 参与匹配——那会让所有仓库互相「相等」，把身份认串，且这类错误一旦发生极难诊断。

实测环境（NTFS）：`dev = 496261533`，`ino` 为十七位整数，改名前后完全不变（探针实测 `19421773397938670` → 同值）。

#### 触发时机

- **全量重扫后**——可靠，覆盖所有平台，认领逻辑只有这一份实现。
- **递归监听的目录结构变化**（root 下目录新增/删除、`.git` 出现/消失）→ 防抖 2 秒 → 触发一轮重扫。这兑现了杠杆 1 承诺的「仓库增删改名秒级感知」，而重扫本身已降到约 1300ms。

Windows 的递归 `fs.watch` 把改名报成「删旧 + 增新」两个**无法配对**的 `rename` 事件，因此**不依赖事件配对来识别身份**，事件仅作为触发器。这样两个平台的认领行为完全一致。

#### `manualRepos` 路径失效

认领救不了它（见非目标）。本轮只要求：路径失效时在看板上如实标出「该手动添加的仓库路径已失效」，让用户重新指路，而不是卡片凭空消失。

### 顺带的重构：`json-store.ts`

本轮新增 `repo-cache.json` 与 `repo-identity.json`，加上已有的 `github-desc.json`、`github-inbox.json`，共四个形状完全相同的落盘 Map（`desc-cache.ts` 86 行、`inbox-cache.ts` 99 行逐行雷同）。抽出共用底座 `server/src/json-store.ts`：`load` / `get` / `set` / `prune` / 损坏容错。

两个新文件的**失效语义不同，因此不合并为一个文件**：

| 文件 | 损坏后果 |
| --- | --- |
| `repo-cache.json` | 当作空缓存，代价是一轮全量重算（约 7s） |
| `repo-identity.json` | 当作空账本，所有 id 按当前路径重新铸造 = 退化成改造前的行为。只有「账本损坏**且**同时发生改名」才损失数据 |

## 数据流

### 单仓库刷新（监听事件驱动）

```
fs.watch(root, {recursive:true})
        │ event(relPath)
        ▼
  廉价预过滤（node_modules / .git/objects）──丢弃
        │
        ▼
  祖先段查 Map<仓库路径, repoId>
        │
        ├─未命中，且事件路径的末段是 .git 或事件落在任何已知仓库之外
        │      ──▶ 防抖 2s ──▶ 触发一轮全量重扫（见下）
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
        └─ 指纹变了？── 是 ──▶ getRepoHeavy()（最多 6 个进程）＋写 repo-cache.json
                       └─ 否 ──▶ 复用 repo-cache.json 里的 heavy
        │
        ▼
  hub.broadcast("repo:updated")
```

### 全量重扫（定时兜底 / 结构变化触发 / 手动）

```
scan(roots, excludes) ＋ manualRepos
        │ 得到本轮路径集合
        ▼
  每条路径解析 id（账本载入时在内存里建一份 path → id 的反向索引，
  路径键按 Windows 大小写不敏感的口径归一化）
        │
        ├─ 反向索引命中 ──▶ 用账本里的 id
        └─ 未命中       ──▶ 暂记为「新路径」
        │
        ▼
  比对上轮 id 集合
        │
        ├─ 无 id 消失 ──▶ 新路径一律 repoId(path) 铸造新 id
        │
        └─ 有 id 消失 且 有新路径 ──▶ 认领
                 ① dev+ino 一一对应？──▶ 新路径沿用老 id，账本改 path
                 ② 否则比对根提交 hash，一一对应？──▶ 同上
                 ③ 都不成 ──▶ 老 id 判定为删除，新路径铸造新 id
        │
        ▼
  逐仓库 getRepoCore()（＋按指纹决定是否 getRepoHeavy()）
        │
        ▼
  prune(repo-cache / repo-identity / github-desc / github-inbox)
        │
        ▼
  watcher.setRepos(...)（纯 JS，零 syscall）＋ hub.broadcast("scan:done")
```

## 错误处理

递归监听最需要认真对待的失败模式是**丢事件**。打包后日志是唯一诊断面，以下情况必须留痕迹（沿用 `watcherErrorIsNoise` 既有的「出事的是监听目标本身就必须报」的分级原则）：

| 情况 | 处理 |
| --- | --- |
| Windows `ReadDirectoryChangesW` 缓冲区溢出（构建期爆发），Node 抛 `error` 或 `filename === null` | 记日志 + 立即触发一轮全量重扫（重扫是全局的，不按 root 切分） |
| root 不存在 / 无权限 / 被改名（ENOENT、EPERM） | 记日志；`coverage().watched` 只计入**监听确实建立成功的 root 之下**的仓库数，失效 root 下的仓库不计入——设置面板会如实显示「73 个中监听 20 个」，而不是装作全覆盖 |
| `fs.watch` 抛出（平台不支持递归等） | 记日志并回退到 `PerRepoStrategy`，功能不中断 |
| 指纹 `stat` 失败（仓库消失/无权限） | 一律视为「指纹已变」，走完整路径，由现有 `errorStatus` 处理 |
| `repo-cache.json` 损坏 | 当作空缓存，记日志，不影响启动 |
| `repo-identity.json` 损坏 | 当作空账本，记日志；所有 id 按当前路径重新铸造（退化为改造前行为，不额外损失数据） |
| `stat().ino === 0`（FAT32/exFAT/网络盘） | `dev+ino` 判据整体作废，直接走根提交 hash。**绝不能拿 0 参与匹配** |
| 认领时出现多对多（多个 id 消失且多个新路径出现，判据无法一一对应） | 不猜，全部按删除 + 新增处理，并记日志说明放弃认领的数量 |
| `manualRepos` 中的路径失效 | 在看板上如实标出「路径已失效」，不静默移除卡片 |

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

身份（杠杆 4）：

- **向后兼容**：账本为空 + 现有 `config.json` → 每个仓库拿到的 id 与 `repoId(当前路径)` 一致，tags/favorites/archived 全部对得上。这是最关键的一条，必须先写。
- **改名保留身份**：仓库改名后 id 不变，`decorate()` 取到的 tags/favorite/archived/note/group/lastOpened 与改名前完全相同。
- **`dev+ino` 认领**：模拟改名（同卷）→ 一一对应认领成功，账本 `path` 更新。
- **根提交 hash 兜底**：`ino` 置 0 或 `dev` 变化（模拟跨卷）→ 退到根提交 hash 仍认领成功。
- **`ino === 0` 不得认串**：多个仓库 `ino` 均为 0 时，绝不能因「0 === 0」互相认领。
- **一一对应约束**：2 个消失 + 2 个新增且判据无法唯一配对 → 全部按删除 + 新增处理，不猜。
- **复制而非移动**：`cp -r` 出一份副本（原仓库仍在）→ 老 id 不消失，副本铸造新 id。
- **删除后新建同名**：新 `.git` 的 `ino` 不同 → 铸造新 id，不得错误继承旧仓库的标签。
- **结构变化触发重扫**：目录新增/删除事件经 2 秒防抖后触发**一次**重扫（连续改名多个仓库不得触发多轮）。
- **账本损坏**：`repo-identity.json` 内容非法 → 当空账本继续启动，且记了日志。

## 风险

- **构建期事件量上升**：递归监听下内核不再帮忙过滤 `node_modules` / `obj`。实测该机器上后台构建的 `obj/` churn 约 100 事件/秒，而处理成本是纯字符串判断，量级上无关紧要。真正的风险是缓冲区溢出导致丢事件，已由上面的错误处理与兜底重扫覆盖。
- **平台分叉**：两套策略意味着两条代码路径。通过可注入的策略选择保证两者都被测试覆盖。
- **指纹漏判**：后果上界已在「正确性边界」一节明确，且实时性最强的字段不依赖指纹。
- **身份认错**（把 A 的标签/归档认到 B 头上）：这是本轮唯一会**产生错误数据**而非仅仅丢失数据的风险，因此认领的每一步都取保守侧——`ino === 0` 作废该判据、只认一一对应、多对多一律放弃。测试里对应三条专门用例。
- **改动面横跨四层**：watcher / store / config / 落盘账本。缓解手段是 id 保持不变这一设计选择——它把前端和 `config.json` 完全排除在改动面之外，实际只动服务端。

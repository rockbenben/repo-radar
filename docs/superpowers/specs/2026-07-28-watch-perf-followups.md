# 监听与重扫重构 · 遗留项

日期：2026-07-28
关联：[设计规格](2026-07-28-watch-perf-design.md) · [实施计划](../plans/2026-07-28-watch-perf-and-identity.md)

十个任务 + 一轮整分支修复已合并（`1ec22ea..77a1a38`，32 个 commit）。下面是经评审分诊、**明确决定延后**的项。每一条都记录了当时的判断依据，避免以后重新推导。

## 应当尽快处理

**1. `ENOSPC` / `EMFILE` 下 coverage 仍然偏乐观。**
`watch-strategy.ts` 的 `PerRepoStrategy.start` 返回的是「路径存在的」而非「chokidar 真正挂上的」——它从不 `await` chokidar 的 `ready`。inotify 耗尽时所有路径都存在，于是设置面板显示全覆盖而实际一个都没监听。冻结本身已由 60 秒自愈覆盖，所以这是**诊断面缺口**而非数据陈旧缺口。修法需要等 `ready` 并按每个 target 的成败过滤。

**2. `excludes` 水龙头只被限速、未关闭。**
位于 scan root 之下但被 `excludes` 排除的仓库若持续写入，会无限地每 60 秒触发一轮全量重扫 + 句柄重建。彻底关闭需要让 watcher 知道 `excludes` 集合（目前它只知道 `roots` 与已发现的仓库路径）。当前的冷却把成本钉在一个可接受的上限内，但这条水龙头一直开着。

**3. `watchDegraded` 在有一个死掉的 `manualRepo` 时会永久闩住。**
路径失效的 manual repo 会一直留在 store 里（这是 Task 9 有意为之——不能让卡片静默消失），于是 `coveredRepoCount()` 永远少于 `chosen.length`，每轮重扫都会触发一次注定失败的 `applyWatch` 重建。有界（每轮一次，≥30 分钟），但对有一个死 manual repo 的用户来说，等于部分恢复了本轮要消灭的开销。修法：把「已知失效」的仓库排除出降级判定的分母。

## 可以再等等

**4. `running` 在重扫永不 settle 时会闩住。**
若 `doRescanAndWatch` 永远不 resolve（例如 `watcher.serialize` 卡在一个挂死的 `chokidar.close()` 上），此后每个结构变化信号都落进 `pending` 且再无一轮被安排——结构自愈通道静默死掉。改造前同样会卡（强制触发排在同一个卡死的 `SerialQueue` 任务后面），所以不是回归；但冷却把「多个并行尝试」变成了「恰好一个在飞」，让这个单点更尖锐。

**5. 播种出 `null` 的根提交永不重算。**
空仓库、clone 中途、`.git` 被锁的仓库，其身份判据②（根提交）会终身失效，退化成只靠 `dev+ino`——后者在同卷改名下本就足够。朴素的重试会给每个这类仓库每轮加一个 git 进程，需要设计而非快修。

**6. 一个 ref 一个目录的命名空间可能触到 `REF_DIR_LIMIT = 256`。**
`refs/pull/<n>/head`、`refs/notes/<n>` 这类命名空间会让目录数与 ref 数同阶。触到上界的行为是安全的（返回 `null` = 不可缓存 = 全价刷新，正确但慢，不产生错误数据）。若真出现，正确方向是给这类仓库单独降级，而不是抬高上界。

**7. 目录 mtime 的精度下限。**
ext3 / HFS+ / 部分 SMB 的 1 秒时间戳精度下，同一秒内的外部 ref 变化仍可能被指纹漏掉。应用自身的写入已由 `skipCache` 覆盖。

**8. `JsonStore` 落盘无 `fsync`。**
临时文件 + `renameSync` 消除了截断窗口（进程崩溃安全），但断电仍可能在某些文件系统上丢掉最后一次写入。对「丢了最多慢一轮」的缓存可接受；对身份账本是可讨论的。

## 测试与文档

**9. `dirs.sort()` 的回归测试是假保险。**
`fingerprint.test.ts` 里那条「遍历顺序不得泄漏进指纹」的用例连续两次求值、中间不做任何变更，而 `readdirSync` 在未改动目录上的返回顺序本就稳定——评审把 `dirs.sort()` 删掉后该用例仍然通过。排序本身是必需且正确的（没有它，指纹会在内容未变时抖动，表现为**缓存永不命中、整套机制静默失效**），但如果有人因为「测试还是绿的」而删掉它，没有任何东西能拦住。真正的回归测试需要在两次求值之间强制制造不同的 readdir 顺序。

**10. 规格有两处已不描述实际行为。**
[设计规格](2026-07-28-watch-perf-design.md) 里「最多旧一轮（默认 30 分钟）」的正确性边界，以及结构变化「只写了防抖、没写速率上限」——两者都是设计缺口而不仅是实现缺口，现已分别由补齐探针集合和加入 60 秒冷却解决，但规格文本尚未同步。

**11. `watch-strategy.test.ts` 的两条断言在 Linux 上是空跑。**
`/tmp` 下没有软链，所以 realpath 相关的两条守卫实际只在 windows 那条 CI 腿上被真正钉住。

**12. 若干小项。**
`rel.startsWith("..")` 会误判名为 `..foo` 的文件；`targets` 按裸字符串去重，两个只差大小写/分隔符风格的 root 会挂两个句柄；`watcher.ts` 未归属分支仍用裸字符串匹配（与已修好的归属分支不对称）；`routes.ts` 的 `rescanFresh ?? rescan` 会让只注入 `rescan` 的宿主静默降级；`structure.stop()` 现在是永久的（今天无 start-after-stop 路径，但未来加了会得到一个静默死掉的通道）；`store-freshen.test.ts` 用全局 mock `existsSync` 恒真、改用真实临时目录会更窄；`manualRepos` 失效提示未写出配置文件的实际路径。

## 工作流评审（xhigh）之后新增的遗留项

**13. 廉价预过滤会吞掉「新仓库出现」这个确定信号。**
`RepoWatcher.handle` 在未归属分支上先跑 `shouldIgnorePath(file, this.roots)`，再跑 `isStructuralPath`。于是一个位于 `IGNORED_DIRS` 同名目录之下的新仓库（例如扫描根下有个叫 `build` 的普通目录，里面 clone 了仓库）——它的 `.git` 创建事件会被前者丢弃，尽管 `isStructuralPath` 自己的注释明确写着「末段是 `.git` 时任何深度都要报」。

影响面比初看要窄：一旦该仓库被某轮重扫发现并进入 `byKey`，`findOwner` 就能归属它，此后 `shouldIgnorePath` 只检查**仓库根以下**的段，刷新完全正常。所以真实后果是**发现延迟**——新仓库要等最长 30 分钟的兜底重扫才出现在看板上，而不是秒级；`autoScanMinutes = 0` 时则永不出现。不是静默冻结。

修法方向是让「末段是 `.git`」这个信号先于忽略过滤生效，但那是热路径上的行为变更，需要单独评估它会不会把构建期噪音重新放进来。

**（顺带记录一次被证伪的归因）** 工作流评审曾把这个症状归因于 `shouldIgnorePath` 的 root 探测对卷根（`D:\`、`/`）失配。实施者证明该归因不成立：卷根之上没有任何路径段，所以「匹配失败 → 退化成整条绝对路径」对卷根**不产生行为差异**，新旧实现都返回 `true`。结论对、归因错。root 探测改用 `isUnderPath` 之后修好的是**另一族**真实缺陷：扫描根带尾分隔符、分隔符风格不同、Windows 大小写不一致时整条匹配失败，导致该 root 下的仓库事件被全部丢弃。

**14. `applyRepos` 的补挂条件会被「路径已失效的 manualRepo」永久触发。**
覆盖不足的判定拿「磁盘上确实存在的仓库数」作分母，而失效的 manualRepo 会一直留在列表里（有意为之，好产出错误卡片），于是每轮重扫都会触发一次注定失败的 `applyWatch`。这与遗留项 3 的 `watchDegraded` 闩住是同一处根因，应当一并修。

**15. `remote -v` 的降级路径没有端到端用例。**
`getRepoHeavy` 的降级判定对 `remote -v` 是无条件的、没有分支，所以覆盖上是充分的；但实测无法用真实 git 让 `remote -v` 在 `status` 仍成功的前提下失败（缺 `url` 时它照样 rc=0），要补只能 mock `spawn`，那会把「真实 git 行为」这层保证换成一份手写假 spawn。判断为不划算，记录在案。

**16. `CACHE_VERSION` 的升版条件。**
本轮确认**不需要**升：`repo-cache.json` 从未随任何 release 出过门（`git merge-base --is-ancestor d4972c3 v1.2.0` 为否），且作者机器的 `~/.repo-radar/` 里不存在该文件，磁盘上不可能有被降级结果投毒的条目。**今后 `RepoHeavy` 的形状每变一次，`CACHE_VERSION` 必须 +1**（`repo-cache.ts` 顶部已钉住这条规则）。

## 计划本身的一处错

[实施计划](../plans/2026-07-28-watch-perf-and-identity.md) 的 Task 3 在论证「保留 `getRepoStatus` 作为薄包装」时，引用了 `routes.ts`、`scaffold.ts` 里的调用方——**那些调用方从不存在**。改造前它只被 `store.ts` 的两处调用，如今零生产调用方，仅由测试维持存活。要么删掉，要么显式标注为 test-only。

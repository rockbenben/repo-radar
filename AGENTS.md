# repo-radar

本地仓库雷达：Electron 托盘应用，监控本机全部 Git 仓库的未完成工作、PR、CI、stash。
monorepo（npm workspaces）：`server`（Hono 后端 + git 扫描）/ `web`（React + antd 前端）/ `desktop`（Electron 壳）。

## 工作记录导出（供其他项目读取）

- 在「设置 → 常规 → 自动导出工作记录」启用后，默认快照是 `%USERPROFILE%\.repo-radar\worklog.json`，包含最近 30 个本地自然日。每日归档位于快照同目录下的 `archive/YYYY/MM/YYYY-MM-DD.json`。
- 日、周、月回溯按所需日期读取归档中的 UTF-8 JSON，并汇总 `commits`。`since` 和 `until` 都是该归档日期。文件缺失表示记录尚不可用，存在且 `commits` 为空表示已导出且当天无提交。按个人筛选时，可用 `me.emails` 匹配 `commits[].authorEmail`。
- 快照与归档共用 `format: "repo-radar-worklog"` 和 `schemaVersion: 1`。读取快照时，可用 `exportedAt` 检查更新时间，并查看 `failed` 判断结果是否可能不完整。详见 [配置参考](docs/configuration.md#automatic-worklog-export)。

## Health Stack

- typecheck: `npm run typecheck -w server && npm run typecheck -w web && npm run typecheck -w desktop`
- lint: `npm run lint`（biome check，`npm run lint:fix` 做安全自动修复）；ci.yml / release.yml 都跑它
- test: `npm test`（含上面三项 typecheck + 三个 workspace 的 vitest）
  机器负载高时，server 的 `perf-smoke` / `suspect-move` 会假超时（30s 上限、git 子进程多）：
  **单独跑这两个文件判定**——绿=抖动，红=真回归，别把它当回归去追。
- workflows: `npm run check:workflows`（提前校验 release/ci 工作流中 shell 代码块的 bash 语法）
- release-config: `node scripts/check-release-config.mjs`（校验 `.github/desktop-version-targets.json` 与 `electron-builder.yml` NSIS 英文设置）
- deadcode: `npx knip`（未装为项目依赖；`knip.json` 声明 Windows 二进制 `reg` 并将 `desktop/src/preload.ts` 声明为 entry）
- bench: `npm run bench`（扫描并发基准）。**测扫描/并发性能只能走它**——起 Electron 做进程级 A/B
  会被单实例锁、端口漂移和启动扫描与手动重扫交错污染计时。

> **Windows 终端提示**：PowerShell 5.1 不支持 `&&` 串联；执行多命令时使用 `;` 或 `if ($?) { ... }` 分隔。

## Desktop 依赖与配置约定

- `desktop/package.json`（electron）、根 `package.json`（electron-builder、electron-updater）与 `.github/desktop-version-targets.json` 的主版本号保持严格对齐；发布工作流会在第一步断言。
- 平台策略偏离在 `.desktop-policy.json` 中统一记录（如 Windows 暂未配置 ARM64 runner、开源项目暂无商业代码签名证书、macOS 走手动更新等）。

## Lint 约定

- biome 只做检查不做格式化（`formatter.enabled: false`），CSS 文件不在检查范围。
- `useExhaustiveDependencies` 为 error。effect 依赖数组是手工校准的（稳定函数入依赖、
  驱动重试的 state 必须入依赖），刻意校准过的站点用**块级**豁免
  `biome-ignore-start/end`——单行 `biome-ignore` 对被报「多余依赖」的钩子不生效
  （豁免注释必须紧贴被报节点所在行的首 token，deps 数组挂在 `}, [...]` 行尾时贴不上）。
  **禁止对本规则跑 `--unsafe` 自动修复**——实测会把重试 state 改名成 `_x` 并从依赖里删除、
  把每轮新建的函数塞进依赖，静默破坏行为（detailDiffStale 测试曾当场抓出）。
- a11y 全量 error。设计决策记录：卡片名（`.rr-c-name`）是真 `<button>`、承担键盘路径，
  整卡可点只是鼠标便利；纯挡冒泡的容器（操作栏 / 预览浮层 / palette 按钮组）挂
  `role="presentation"` + 带理由豁免；palette 行按 WAI-ARIA combobox 模式
  （listbox/option + 输入框持焦、`aria-activedescendant` 指认选中行），
  不给每行挂 tabIndex——那会把「8 行 × 每行几个动作按钮」塞进 Tab 序列。

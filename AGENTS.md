# repo-radar

本地仓库雷达：Electron 托盘应用，监控本机全部 Git 仓库的未完成工作、PR、CI、stash。
monorepo（npm workspaces）：`server`（Hono 后端 + git 扫描）/ `web`（React + antd 前端）/ `desktop`（Electron 壳）。

## Health Stack

- typecheck: `npm run typecheck -w server && npm run typecheck -w web && npm run typecheck -w desktop`
- lint: `npm run lint`（biome check，`npm run lint:fix` 做安全自动修复）；ci.yml / release.yml 都跑它
- test: `npm test`（含上面三项 typecheck + 三个 workspace 的 vitest）
- deadcode: `npx knip`（未装为项目依赖；`knip.json` 只把 Windows 系统二进制 `reg` 记为已声明）
- bench: `npm run bench`（扫描并发基准）。**测扫描/并发性能只能走它**——起 Electron 做进程级 A/B
  会被单实例锁、端口漂移和启动扫描与手动重扫交错污染计时。

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

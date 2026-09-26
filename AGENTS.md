# repo-radar

本地仓库雷达：Electron 托盘应用，监控本机全部 Git 仓库的未完成工作、PR、CI、stash。
monorepo（npm workspaces）：`server`（Hono 后端 + git 扫描）/ `web`（React + antd 前端）/ `desktop`（Electron 壳）。

## Health Stack

- typecheck: `npm run typecheck -w server && npm run typecheck -w web && npm run typecheck -w desktop`
- lint: `npm run lint`（biome check，`npm run lint:fix` 做安全自动修复）
- test: `npm test`（含上面三项 typecheck + 三个 workspace 的 vitest）
- deadcode: `npx knip`（未装为项目依赖）

## Lint 约定

- biome 只做检查不做格式化（`formatter.enabled: false`），CSS 文件不在检查范围。
- 以下规则降为 warning，属已知技术债，改动相关文件时顺手清一条是一条：
  - `useExhaustiveDependencies`：effect 依赖数组是手工校准的（稳定函数入依赖、
    驱动重试的 state 必须入依赖）。**禁止对这条规则跑 `--unsafe` 自动修复**——
    实测会把重试 state 改名成 `_x` 并从依赖里删除、把每轮新建的函数塞进依赖，静默破坏行为。
  - `noStaticElementInteractions` / `useKeyWithClickEvents`：卡片整体可点选与内部按钮
    的键盘可达性需要单独一轮设计决策（嵌套交互元素、焦点样式），不随普通改动半修。

<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar —— 一个本地面板，替你盯着所有 Git 仓库，把需要你处理的挑出来" />
</p>

# repo-radar

> 365 开源计划 #027 · 一个本地面板，替你盯着所有 Git 仓库，告诉你其中哪些需要你出手。

[English](../../README.md) · **简体中文** · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

你的 Git 仓库多到光靠脑子已经记不过来。repo-radar 帮你盯着所有仓库，只把此刻需要你处理的那几个挑出来——其余的就别再挂心了。

它替你翻出那些你本来会忘记去查的东西：

- **你已经顾不过来的仓库** —— 你名下的每个仓库都在一屏之内，可搜索，点一下就能打开任何一个。
- **没做完的活** —— 未提交、未推送或搁进 stash 的改动，在你弄丢它们之前就标出来。
- **GitHub 在等你** —— 跨所有仓库的 open PR、issue 和变红的 CI，通过本机已登录的 `gh` 汇总而来。
- **正在长草的项目** —— 那些你太久没碰的，或是早该发版的。

需要动手的会作为一条队列升到看板顶部，按紧迫度排序，每个仓库只报一条——点一下就能直接处理。点 ✓ 消掉后，它会一直消失，直到确实有变化才回来；没有待办时显示「全部干净」。其余仓库随时搜一下就能找到。

## 安装

从 [Releases](https://github.com/rockbenben/repo-radar/releases) 下载对应平台的文件——无需 Node.js。应用未做代码签名，因此每个系统首次运行都会告警：

- **Windows** —— 运行 `repo-radar-<version>-x64-setup.exe`；在 SmartScreen 提示上点击 *更多信息 → 仍要运行*。
- **macOS** —— 打开 `repo-radar-<version>-arm64.dmg`，把应用拖进 Applications。首次请右键 → 打开；如果 macOS 说它已损坏，用 `xattr -cr /Applications/repo-radar.app` 清一次隔离标记。
- **Linux** —— `chmod +x repo-radar-<version>-x64.AppImage && ./repo-radar-<version>-x64.AppImage`。

或从源码运行：

```bash
npm install
npm start
```

首次启动时，点击 **添加扫描目录**（或 ⚙ 设置 → 扫描目录），指向存放你仓库的文件夹——无需 JSON、无需重启；保存的那一刻就重新扫描。如果你更想手动编辑，设置就在 `~/.repo-radar/config.json`。

## 看板

每个仓库一张卡片——健康度色带、分支、工作区细分、ahead/behind、上次提交、标签——每张卡片都带一键 **编辑器 / 终端 / 目录**。在这里你可以：

- **查找** —— 搜索，点击语言 / `#tag` / 告警灯来筛选，按目录或语言排序和分组；把任意筛选 + 排序 + 分组存成一个命名视图。⌘/Ctrl-K 打开启动器。
- **批量操作** —— 选中若干仓库来 fetch / pull（`--ff-only`）/ push，或在选中的仓库里并行执行一条 shell 命令（支持 dry-run 预演，并能查看每个仓库的输出）。单个仓库失败绝不会拖住其余的。
- **深入某个仓库** —— 详情面板给出完整的健康明细、切换 / 新建 / 丢弃分支、带实时 diff 的 **就地提交**、按需拉取的 GitHub PR 与 CI、最近提交、stash、12 周热力图，以及对已合并分支的安全一键清理。
- **保持最新** —— 可选的文件监听自动扫描和定时后台 fetch，两者默认都关闭。一个 **统计** tab（一年的提交热力图、最活跃/最不活跃）和一个 **工作记录** tab，可把某个日期范围复制成 Markdown 周报。
- **新建与迁移仓库** —— **＋新建** 会建议下一个编号项目、运行 `git init`、写一个 README 并把它纳入看板；清单导出 / 导入让你的配置在不同机器间迁移。

界面是 antd 6，采用深色仪表舱主题，本地化为 18 种语言（首次访问时自动匹配你的浏览器，阿拉伯语为 RTL）。

## 在后台安静运行

关闭窗口只会把 repo-radar 收进托盘，于是文件监听、定时 fetch 和 GitHub 提醒都继续运行——点托盘图标把看板唤回，或从托盘菜单里真正退出。（在 Linux 上，桌面托盘并不可靠，所以关闭就是退出；用 开机自启 让它常驻。）

在 ⚙ 设置里打开 **开机自启**，它就会随你的会话无界面启动——你不叫它就不冒窗口。可选的桌面通知只在有*新*条目进入你的队列时才触发，哪怕窗口关着。升级是刻意设计的手动方式（无自动更新）：用新安装包覆盖旧的即可。日志落在 `<config dir>/logs/repo-radar.log`。

## 配置

界面碰到的一切都保存在 `~/.repo-radar/config.json`——你很少需要打开它。重要的字段：

| 字段 | 作用 |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | 扫描哪里（向下 6 层内查找 `.git`）、跳过什么，以及在 roots 之外添加的仓库 |
| `health` | `{ staleDays, disabledRules }` —— 调整「长期未动」阈值或禁用单项检查 |
| `open` | 编辑器 / 终端 / 目录 按钮的命令模板（`{path}` = 仓库路径） |
| `autoWatch` / `autoFetchMinutes` / `notifications` | 后台行为——默认全部关闭 |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | 按仓库的组织信息 |

`REPO_RADAR_CONFIG` 和 `REPO_RADAR_PORT`（默认 7420）覆盖配置路径和端口——**两个都**设置就能跑第二份完全独立的实例。服务器只绑定 `127.0.0.1`，并对每个 API 和 WebSocket 请求校验 Origin 头。

## 开发

```bash
npm run dev     # vite + 带热更新的应用窗口
npm test        # server + web + desktop 测试套件与类型检查
npm run dist    # 构建安装包到 dist-electron/
```

技术栈：Electron 外壳 + Node + Hono（所有 git 都走 `spawn`，零原生依赖）+ Vite / React 19 / antd 6，配合 chokidar + WebSocket 实现实时更新。Hono 服务端跑在 Electron 主进程里，窗口通过 `127.0.0.1` 加载它，所以 UI 侧就是普通的 HTTP + WebSocket——和在浏览器里跑没有区别。

## 关于 365 开源计划

[365 开源计划](https://github.com/rockbenben/365opensource) 的第 **#027** 个项目——一个人 + AI，一年 300+ 个开源项目。[提交你的需求 →](https://365.aishort.top/)

## 许可

[MIT](../../LICENSE)

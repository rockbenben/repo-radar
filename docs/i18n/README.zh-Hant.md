<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar —— 一個本機面板，替你盯著所有 Git 儲存庫，把需要你處理的挑出來" />
</p>

# repo-radar

> 一個本機面板，替你盯著所有 Git 儲存庫，告訴你其中哪些需要你出手。

[![365 開源計畫 #027](https://img.shields.io/badge/365%20%E9%96%8B%E6%BA%90%E8%A8%88%E7%95%AB-%23027-1f6feb)](https://github.com/rockbenben/365opensource)

[English](../../README.md) · [简体中文](README.zh-Hans.md) · **繁體中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

你的 Git 儲存庫多到光靠腦子已經記不過來。repo-radar 幫你盯著所有儲存庫，只把此刻需要你處理的那幾個挑出來——其餘的就別再掛心了。

它替你翻出那些你本來會忘記去查的東西：

- **你已經顧不過來的儲存庫** —— 你名下的每個儲存庫都在一個畫面之內，可搜尋，點一下就能打開任何一個。
- **沒做完的活** —— 未提交、未推送或收進 stash 的變更，在你弄丟它們之前就標出來。
- **GitHub 在等你** —— 跨所有儲存庫的 open PR、issue 與變紅的 CI，透過本機已登入的 `gh` 彙整而來。
- **正在長草的專案** —— 那些你太久沒碰的，或是早該發版的。

需要動手的會以一條佇列升到看板頂部，依緊急程度排序，每個儲存庫只列一項——點一下就能直接處理。點 ✓ 忽略後，它會一直消失，直到確實有變化才回來；沒有待辦時顯示「全部清空」。其餘儲存庫隨時搜一下就能找到。

## 安裝

從 [Releases](https://github.com/rockbenben/repo-radar/releases) 下載對應平台的檔案——不需要 Node.js。應用程式未經程式碼簽章，因此每個系統首次執行都會告警：

- **Windows** —— 執行 `repo-radar-<version>-x64-setup.exe`；在 SmartScreen 提示上點擊 *其他資訊 → 仍要執行*。
- **macOS** —— 打開 `repo-radar-<version>-arm64.dmg`，把應用程式拖進 Applications。首次請右鍵 → 打開；若 macOS 說它已損毀，用 `xattr -cr /Applications/repo-radar.app` 清一次隔離標記。
- **Linux** —— `chmod +x repo-radar-<version>-x86_64.AppImage && ./repo-radar-<version>-x86_64.AppImage`。

或從原始碼執行：

```bash
npm install
npm start
```

第一次啟動時，點擊 **新增掃描目錄**（或 ⚙ 設定 → 掃描目錄），指向存放你儲存庫的資料夾——不必手改 JSON、也不用重啟；儲存的那一刻就重新掃描。如果你更想手動編輯，設定就在 `~/.repo-radar/config.json`。

## 看板

每個儲存庫一張卡片——健康狀態顏色、分支、工作區異動明細、ahead/behind、最後一次提交、標籤——每張卡片都帶一鍵 **編輯器 / 終端機 / 資料夾**。在這裡你可以：

- **尋找** —— 搜尋，點擊語言 / `#tag` / 提示燈來篩選，依資料夾或語言排序與分組；把任意篩選 + 排序 + 分組存成一個具名視圖。⌘/Ctrl-K 開啟啟動器。
- **批次操作** —— 選取若干儲存庫來 fetch / pull（`--ff-only`）/ push，或在選取的儲存庫裡平行執行一條 shell 指令（支援 dry-run 預演，並能查看各儲存庫的輸出）。單一儲存庫失敗絕不會拖住其餘的。
- **深入某個儲存庫** —— 詳情面板提供完整的健康明細、切換 / 建立 / 捨棄分支、附即時 diff 的 **就地提交**、依需求查詢的 GitHub PR 與 CI、最近提交、stash、12 週熱力圖，以及對已合併分支的安全一鍵清理。
- **保持最新** —— 可選的檔案監看自動掃描與排程背景 fetch，兩者預設皆關閉。一個 **統計** 分頁（長達一年的提交熱力圖、最活躍/最不活躍）與一個 **工作日誌** 分頁，可把某個日期範圍複製成 Markdown 週報。
- **建立與搬遷儲存庫** —— **+ New** 會建議下一個編號專案、執行 `git init`、寫一個 README 並將其納入看板；清單匯出 / 匯入讓你的設定在不同機器間搬遷。

介面是 antd 6，走深色儀表艙主題，在地化為 18 種語言（首次造訪時自動比對你的瀏覽器，阿拉伯文為 RTL）。

## 在背景安靜運作

關閉視窗只會把 repo-radar 收進系統匣，於是檔案監看、排程 fetch 與 GitHub 提示都繼續運作——點系統匣圖示把看板叫回，或從系統匣選單裡真正結束。（在 Linux 上，桌面系統匣並不可靠，所以關閉就是結束；用 開機自動啟動 讓它常駐。）

在 ⚙ 設定裡打開 **開機自動啟動**，它就會隨你的工作階段無介面啟動——你不叫它就不冒視窗。可選的桌面通知只在有*新*項目進入你的佇列時才觸發，即使視窗關著。升級是刻意設計的手動方式（無自動更新）：用新安裝檔覆蓋舊的即可。日誌落在 `<config dir>/logs/repo-radar.log`。

## 設定

介面碰到的一切都儲存在 `~/.repo-radar/config.json`——你很少需要打開它。重要的欄位：

| 欄位 | 作用 |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | 掃描哪裡（向下 6 層內尋找 `.git`）、跳過什麼，以及在 roots 之外加入的儲存庫 |
| `health` | `{ staleDays, disabledRules }` —— 調整「過期」門檻或停用個別檢查 |
| `open` | 編輯器 / 終端機 / 資料夾 按鈕的指令範本（`{path}` = 儲存庫路徑） |
| `autoWatch` / `autoFetchMinutes` / `notifications` | 背景行為——預設全部關閉 |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | 依儲存庫的組織資訊 |

`REPO_RADAR_CONFIG` 和 `REPO_RADAR_PORT`（預設 7420）覆寫設定路徑與連接埠——**兩個都**設定就能跑第二份完全獨立的實例。伺服器只綁定 `127.0.0.1`，並會對每個 API 與 WebSocket 請求驗證 Origin 標頭。

## 開發

```bash
npm run dev     # vite + 帶熱更新的應用視窗
npm test        # server + web + desktop 測試套件與型別檢查
npm run dist    # 建置安裝包到 dist-electron/
```

技術棧：Electron 外殼 + Node + Hono（所有 git 都走 `spawn`，零原生依賴）+ Vite / React 19 / antd 6，搭配 chokidar + WebSocket 提供即時更新。Hono 伺服器跑在 Electron 主行程裡，視窗透過 `127.0.0.1` 載入它，所以 UI 端就是純粹的 HTTP + WebSocket——和在瀏覽器裡跑沒有兩樣。

## 關於 365 開源計劃

[365 開源計劃](https://github.com/rockbenben/365opensource) 的第 **#027** 個專案——一人 + AI，一年 300+ 個開源專案。[提交你的點子 →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)
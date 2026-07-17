<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — a cross-repo action queue answering what needs you now" />
</p>

# repo-radar

> 365 開源計劃 #027 · 一個本機的 Git 儲存庫儀表板 —— 一個跨儲存庫的行動佇列，告訴你此刻最需要你處理的是什麼。

[English](../../README.md) · [简体中文](README.zh-Hans.md) · **繁體中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

一個本機的 Git 儲存庫儀表板，會掃描你機器上的每個 repo，並把最重要的一個畫面優先呈現給你：一個跨儲存庫的**行動佇列（action queue）**，直接告訴你*現在最需要你處理的是什麼*——點一下項目就能直接動手處理。介面以 antd 6 打造，走深邃的儀表艙（instrument-cockpit）風格。

## 快速開始

```bash
npm install
npm run build   # build the frontend
npm start       # http://localhost:7420
```

第一次啟動時會在 `~/.repo-radar/config.json` 建立預設設定檔。編輯 `roots` 加入你想掃描的目錄（例如 `D:\Projects` —— 在 JSON 中反斜線要跳脫成 `D:\\Projects`），然後在面板中點擊**重新掃描（Rescan）**。

## 需要你關注（首頁入口畫面）

看板最上方的**需要你關注（Needs you）**佇列是一個跨儲存庫的行動佇列：依緊急程度排序，每個 repo 只列出一項——只呈現最迫切的那一件事，而不是又一個「提交了多少次 commit」的虛榮儀表板。

- **等你處理**：他人開的 PR、他人開的 issue、預設分支上的紅色 CI（透過本機、已登入的 `gh` 在背景聚合，每 12 分鐘刷新一次，或手動點 ↻ 更新；你自己開的 PR/issue 會被視為進行中工作而排除在外）—— 點擊項目即可直接跳到對應的 GitHub 頁面
- **有遺失風險**：衝突（conflicts）／落後（behind）／未提交（uncommitted）／未推送（unpushed）——放著越久排名越高——未推送的工作可以一鍵推送，其餘則會開啟詳情面板
- **該發版卻遲遲未發**：有打標籤習慣的 repo，若自最新標籤以來已累積 ≥3 次提交卻沒有發版，會提醒你該出貨了（從不打標籤的 repo 則不會被打擾；最新標籤是依整個 repo 的建立時間挑選，與目前所在分支無關）
- **被遺忘的 stash**：閒置 ≥7 天沒人動的 stash —— 點擊可直接跳到 stash 收件匣
- **忽略（Dismiss）**：點 ✓ 可清除一個項目，直到有新狀況發生為止 —— 以計數為基礎的項目需要計數再增加，以變動為基礎的項目需要再有一次提交；忽略 stash 只是暫時延後（snooze），30 天後會再次浮現，確保真正被遺忘的 stash 不會永遠被靜音
- 展開可看到超過 10 項的全部內容；沒有剩餘項目時會顯示「全部清空」。可收合成頂部的一條細長橫幅

## 看板

- **卡片**：每個 repo 一張卡片（每列最多 4 張，高度相同）。左側邊框顏色代表健康狀態（綠色 = 平靜／琥珀色 = 需留意／紅色 = 警示）。顯示真實名稱、描述、語言、分支（非 main 時會標示）、工作區異動明細（`+staged ~modified`）、領先/落後（ahead/behind）、健康標籤、最後一次提交、遠端連結、標籤。卡片底部隨時有一鍵**編輯器／終端機／資料夾**按鈕
- **收藏列**：看板頂部有專屬的「★ 收藏」列 —— 點擊即可在編輯器中開啟
- **儀表叢集（Readout cluster）**：頂部工具列的 FLEET / CRIT / WARN / CLEAN 儀表；警示數 > 0 時會亮起
- **點擊即篩選**：點卡片上的語言或 `#tag` 即可直接帶入搜尋框
- **排序**：最近開啟／最近活動（依提交時間）／依名稱 —— 收藏項目永遠浮在最上方
- **提示燈（Attention lamps）**：頂部工具列上彙總各類問題的標籤（無遠端／detached HEAD／未推送／未提交／落後／有 stash）；點擊可篩選。「未推送」與「落後」各自都有一鍵「全部推送/拉取」
- **分組**：依資料夾／依語言／不分組（平鋪）
- **命令面板 ⌘/Ctrl-K**：一個啟動器 —— 輸入名稱、按 Enter 就能在編輯器中開啟（並附有終端機／資料夾／複製路徑／開啟遠端的行內按鈕）
- **標籤篩選**：頂部工具列可多選標籤（AND 條件 —— 必須同時具備所選的每個標籤）；點卡片上的 `#tag` 即可加入。篩選＋排序＋分組會一起儲存成一個命名的「視圖（view）」
- **行內預覽**：卡片上的「⋯」可彈出最近的提交紀錄，不必開啟詳情面板
- **自動掃描（預設關閉）**：頂部工具列有「manual ⟳ / auto ⟳」切換。開啟後，檔案監看器會自動刷新受影響的卡片（60 秒冷卻時間；冷卻期間的變動會合併處理，絕不會遺漏）。關閉時，狀態只在重新掃描（Rescan）時更新。首次啟動時看板仍會先執行一次掃描來填入內容
- **排程抓取（預設關閉）**：頂部工具列的「fetch: off / every 5–60 min」—— 會定期在背景抓取每個遠端，讓領先/落後資訊保持最新
- **18 種語言**：可在 ⚙ 設定中切換介面語言（簡體中文／繁體中文、英文、日文、韓文、西班牙文、法文、德文、葡萄牙文、俄文、義大利文、阿拉伯文、印地文、孟加拉文、泰文、土耳其文、越南文、印尼文）。第一次造訪且尚無儲存偏好時，介面會自動比對你瀏覽器的語言（若無匹配則預設為英文）；阿拉伯文會自動切換為由右至左（RTL）排版。相對時間會透過 `Intl` 原生在地化。Repo 名稱、描述與提交訊息永遠不會被翻譯

## 操作

- 卡片底部隨時顯示編輯器／終端機／資料夾／複製路徑按鈕；開啟其中之一會記錄「最後開啟」時間戳記，用於排序
- 抓取（Fetch）／拉取（pull，`--ff-only`）／推送（push）都以批次方式執行：選取多張卡片 → 從頂部工具列執行批次操作，或一鍵點擊整組「未推送」／「落後」提示燈。進度即時顯示；單一 repo 失敗不會中止其餘的操作
- **跨儲存庫執行指令**：選取卡片，在工具列輸入指令（例如 `npm install`），它會在每個選取 repo 的目錄中平行執行。「Dry run」可先預覽會影響哪些 repo；「view output」會在執行後顯示每個 repo 的結果
- **Stash 收件匣**：只要有任何 stash 存在，頂部工具列就會出現「stash inbox (N)」連結 —— 列出所有 repo 中所有被 stash 的變更，並提供逐項 diff、`apply` / `pop` / `drop`
- 選取多張卡片也能批次套用標籤
- **清單匯出／匯入**：從**+ new**匯出完整的 repo 清單（路徑＋遠端＋群組＋標籤），供備份或搬遷機器使用；匯入時會重新認領本機已存在的 repo，並列出尚未存在、需要 clone 的項目
- 開啟指令可依目標（editor / terminal / explorer）在 config.json 的 `open` 底下個別設定；`{path}` 會被替換成 repo 路徑
- **+ New**：會建議下一個序號（例如 `028-`）以及你現有編號專案的上層目錄，接著建立資料夾、執行 `git init`、寫入 README，並將其重新掃描進看板

## 健康檢查與統計

- 各項規則（衝突／無遠端／detached HEAD／未提交／未推送／未追蹤／落後／有 stash／過期）可透過 `health.disabledRules` 個別停用；`staleDays` 設定「過期」的門檻
- **可合併分支**：卡片會標示有多少本機分支已合併進 HEAD（不含目前分支與 main/master）；詳情面板提供一鍵 `git branch -d` 清理（只會刪除已合併的分支 —— 安全無虞）
- **GitHub（可選，透過本機、已登入的 `gh`）**：「需要你關注」佇列會在背景為每個 `github.com` 遠端聚合開放中的 PR／issue／預設分支 CI（有速率限制的輪詢、持久化到磁碟、重啟後即時可用）。詳情面板也可依需求查詢 PR 詳情與最新的 CI 執行結果；repo 描述會在可取得時從 GitHub 回填
- **統計（Stats）**分頁：長達一年的跨儲存庫提交熱力圖（僅限本機分支）、最近最活躍的 repo，以及閒置最久的 10 個 repo
- **工作日誌（Worklog）**分頁：選取日期範圍即可查看跨儲存庫的提交時間軸（可依作者篩選 —— 預設為自動偵測你的 git 身分並「只顯示我」），並可一鍵複製為 Markdown 週報
- 點擊卡片開啟詳情面板：完整的健康狀態明細、可合併分支、**切換／建立／捨棄本機分支**、**就地提交**（輸入訊息即可提交），並附上待處理變更的即時 diff、GitHub PR/CI、迷你 12 週熱力圖、最近提交紀錄、stash 與遠端資訊

## 整理 repo

- 為卡片打上 ★ 星號即可收藏（會浮到最上方）；在詳情面板中新增／移除標籤（會自動補全你曾用過的標籤）並變更其群組（「auto」會恢復依資料夾推導的分組）
- **筆記／待辦**：在詳情面板中記下「接下來要做什麼」—— 會顯示在卡片上
- **排除**：隱藏你不想看到的 repo；被排除的 repo 預設會從看板、提示、命令面板中隱藏。頂部工具列的「Excluded (N)」可讓你另外檢視／管理它們（可在詳情面板中取消排除）
- 變更會立即生效並寫入 config.json，不會觸發 Git 重新掃描

## 開發

```bash
npm run dev     # runs server(7420) + vite(5173) together, frontend proxies /api
npm test        # full server + web test suite + both typechecks
```

技術棧：Node + Hono（所有 git 存取都透過 `spawn`，零原生依賴）、Vite + React 19 + antd 6（透過 CSS 變數深度客製化）、chokidar + WebSocket 提供即時更新。

## 設定（config.json）

| 欄位 | 說明 |
| --- | --- |
| `roots` | 要掃描的根目錄；會遞迴尋找含有 `.git` 的目錄（深度 ≤ 6） |
| `excludes` | 要跳過的目錄名稱（預設包含 node_modules） |
| `manualRepos` | 手動加入、不在所設定 roots 之內的 repo 路徑 |
| `tags` / `favorites` / `groupOverrides` | 依 repo id 個別設定的標籤／收藏／群組覆寫 |
| `notes` / `archived` | 依 repo id 個別設定的筆記／封存旗標 |
| `health` | `{ staleDays, disabledRules }` |
| `open` | 一鍵開啟目標（editor / terminal / explorer）的指令範本 |

`REPO_RADAR_CONFIG` 環境變數可覆寫設定檔路徑。伺服器只監聽 `127.0.0.1`，並會在 API 與 WebSocket 上都驗證 Origin 標頭。

## 關於 365 開源計劃

本專案是 [365 開源計劃](https://github.com/rockbenben/365opensource) 的第 **#027** 個專案。

一人 + AI，一年打造 300+ 個開源專案。[提交你的點子 →](https://365.aishort.top/)

## 授權條款

[MIT](../../LICENSE)

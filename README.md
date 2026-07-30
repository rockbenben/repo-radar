<p align="center">
  <img src="web/public/og-image.png" width="820" alt="repo·radar — a local dashboard that watches all your Git repos and flags the ones that need you" />
</p>

# repo-radar

> A local dashboard that watches all your Git repos and shows you which ones need you.

**English** · [简体中文](docs/i18n/README.zh-Hans.md) · [繁體中文](docs/i18n/README.zh-Hant.md) · [日本語](docs/i18n/README.ja.md) · [한국어](docs/i18n/README.ko.md) · [Español](docs/i18n/README.es.md) · [Français](docs/i18n/README.fr.md) · [Deutsch](docs/i18n/README.de.md) · [Português](docs/i18n/README.pt.md) · [Русский](docs/i18n/README.ru.md) · [Italiano](docs/i18n/README.it.md) · [العربية](docs/i18n/README.ar.md) · [हिन्दी](docs/i18n/README.hi.md) · [বাংলা](docs/i18n/README.bn.md) · [ไทย](docs/i18n/README.th.md) · [Türkçe](docs/i18n/README.tr.md) · [Tiếng Việt](docs/i18n/README.vi.md) · [Bahasa Indonesia](docs/i18n/README.id.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![365 Open Source Plan #027](https://img.shields.io/badge/365%20Open%20Source%20Plan-%23027-1f6feb)](https://github.com/rockbenben/365opensource)

You have more Git repos than you can keep track of by hand. repo-radar keeps an eye on all of them and shows you the few that need you now — so the rest stay off your mind.

It surfaces what you'd otherwise forget to check:

- **Repos you've lost track of** — every repo you own on one screen, searchable, open any of them in a click.
- **Work left unfinished** — uncommitted, unpushed, or stashed changes, flagged before you lose them.
- **GitHub waiting on you** — open PRs, issues, and failing CI across every repo, gathered through your local, already-authenticated `gh`.
- **Projects going stale** — the ones you haven't touched in too long, or overdue to ship.

The ones that need action rise to the top of the board as a queue, ranked by urgency, one item per repo — click to act on it directly. Dismiss with ✓ and it stays gone until something actually changes; when nothing's waiting it reads "all clear." The rest of your repos are always a search away.

## Install

Grab your platform's file from [Releases](https://github.com/rockbenben/repo-radar/releases) — no Node.js needed. The app isn't code-signed, so each OS warns on first run:

- **Windows** — run `repo-radar-<version>-x64-setup.exe`; on the SmartScreen prompt click *More info → Run anyway*.
- **macOS** — open `repo-radar-<version>-arm64.dmg` and drag the app to Applications. Right-click → Open the first time; if macOS calls it damaged, clear the quarantine flag once with `xattr -cr /Applications/repo-radar.app`.
- **Linux** — `chmod +x repo-radar-<version>-x86_64.AppImage && ./repo-radar-<version>-x86_64.AppImage`.

Or run from source:

```bash
npm install
npm start
```

On first launch, click **Add scan directories** (or ⚙ Settings → Scan directories) and point it at the folders that hold your repos — no JSON, no restart; it rescans the moment you save. Settings live in `~/.repo-radar/config.json` if you'd rather hand-edit them.

## The board

One card per repo — health color, branch, working-tree breakdown, ahead/behind, last commit, tags — with one-click **editor / terminal / folder** on every card. From here you:

- **Find** — search, click a language / `#tag` / attention-lamp to filter, sort, and group by folder or language; save any filter + sort + group as a named view. ⌘/Ctrl-K opens a launcher.
- **Act in batches** — select repos to fetch / pull (`--ff-only`) / push, or run a shell command in parallel across them (with a dry-run preview and per-repo output). One repo failing never stops the rest.
- **Dig into a repo** — the detail panel gives a full health breakdown, switch / create branches, discard changes, **commit in place** with a live diff, GitHub PR & CI on demand, recent commits, stashes, a 12-week heatmap, and one-click cleanup of already-merged branches — offered only while you're on `main`/`master`, since that's the only position where "already merged" means merged into the trunk. Discarding changes reverts tracked files and removes untracked ones, but leaves submodule contents and untracked nested git repos alone; when something is left behind it tells you instead of reporting success.
- **Stay fresh** — the default refresh path is a 30-minute fallback rescan plus the toolbar's manual rescan. File-watch auto-scan is **off by default**, opt-in from the settings panel: it is local-only and never touches the network, but with several projects building at once the kernel notification buffer overflows constantly and every overflow costs a rescan — too high a standing price for a glance-at-what-changed tool. Turn it on and, on Windows and macOS, one recursive watch per scan directory covers every repo under it, so adding, deleting or renaming a repo shows up within seconds; on Linux repos are watched individually and `watchLimit` (200 by default, 0 = no limit) caps how many, with favorites and recently committed repos taking priority. Repeated overflows back off exponentially, up to 30 minutes apart, and no longer rebuild the watch handles — only a watch target that actually died does that. The fallback rescan catches whatever the watcher misses, the toolbar shows "last scanned", and the settings panel shows live "watching N of M" coverage. Renaming or moving a repo keeps its tags, star, archive state and notes — repo-radar tracks identity, not just the path. Identity is matched on the scan round right after the move, which leaves two gaps: a slow, cross-volume move that straddles two scan rounds, with another repo's add/remove or the periodic rescan landing in between; and a move whose destination isn't scanned on that next round — moving a repo out of your scan directories and only later adding its new home as a scan directory is the common way to hit it. Both fall back to path-based identity, so the repo comes back as a fresh card and its tags/star/archive/notes stay under the id it no longer has. Scheduled background fetch is opt-in. A **Stats** tab (year-long commit heatmap, most/least active) and a **Worklog** tab that copies a date range as a Markdown weekly report.
- **Start & move repos** — **+ New** suggests the next numbered project, runs `git init`, writes a README, and adopts it into the board; manifest export / import carries your setup between machines.

The UI is antd 6 in a dark instrument-cockpit theme, localized into 18 languages (auto-matched to your browser on first visit, RTL for Arabic).

## Runs quietly in the background

Closing the window drops repo-radar to the tray so the fallback rescan, file-watching (if you turned it on), scheduled fetches and GitHub alerts keep running — click the tray icon to bring the board back, or quit for real from the tray menu. (On Linux, where desktop trays aren't dependable, closing quits instead; use Launch at login to keep it resident.)

Quitting waits for git work already in flight — a batch pull, a stash drop, a scheduled fetch — for up to 10 seconds, so nothing gets cut mid-write and leaves a stale `.git/index.lock` behind. If that isn't enough time it exits anyway and says so in the log, which is the only place that explains an `index.lock` you find later.

Turn on **Launch at login** in ⚙ Settings and it starts headless with your session — no window until you ask for it. Optional desktop notifications fire only when something *new* reaches your queue, even with the window closed. Upgrades are manual by design (no auto-update): run the new installer over the old one. Logs land in `<config dir>/logs/repo-radar.log`.

## Configuration

Everything the UI touches is saved to `~/.repo-radar/config.json` — you rarely need to open it. The fields that matter:

| Field | What it does |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | where to scan (finds `.git` up to 6 deep, not following symlinks), what to skip, and repos added outside the roots — a `manualRepos` entry that gets renamed or moved isn't tracked by identity like a scanned repo is; the card errors until you update its path here, and if the move happened more than one scan round ago that update brings the card back but not its tags/star/archive/notes |
| `health` | `{ staleDays, disabledRules }` — tune the "stale" threshold or disable individual checks |
| `open` | command templates for the editor / terminal / folder buttons (`{path}` = the repo path) |
| `autoWatch` / `autoScanMinutes` / `watchLimit` / `autoFetchMinutes` / `notifications` | background behavior — only `autoScanMinutes` (30) is on by default; the other three, `autoWatch` included, are off. `watchLimit` (200, 0 = no limit) only applies on Linux, where repos are watched individually; Windows and macOS use one recursive watch per scan directory and always cover every repo |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | per-repo organization |

Two more files live next to `config.json`, both safe to delete — repo-radar just rebuilds them, at different costs. `repo-cache.json` remembers each repo's "heavy" git fields (stashes, tags, remotes, merged branches…) keyed to a `.git` fingerprint, so an unchanged repo skips those git calls on the next rescan; delete it and the next rescan is simply slower, one time. `repo-identity.json` is the identity ledger that lets a renamed or moved repo keep its tags, star, archive state and notes instead of being treated as a brand-new repo. Delete it and the loss is immediate, not deferred: any repo already renamed or moved before the file was lost gets a brand-new id on the very next scan, and its tags/favorites/archive/notes stay stranded under the id it no longer has. Repos that were never renamed are unaffected, and renames from that point on are protected again once the ledger rebuilds.

`REPO_RADAR_CONFIG` and `REPO_RADAR_PORT` (default 17420) override the config path and port — set **both** to run a second, fully independent instance. The server binds `127.0.0.1` only and validates the Origin header on every API and WebSocket request.

The default port sits above the OS dynamic port range on purpose: Windows uses 49152–65535 by default but 1024–15000 once Hyper-V/WSL2 is installed, and the system reserves whole blocks out of the active range — a port inside it fails to bind with `EACCES`, and the blocks move across reboots.

If the **default** port still can't be bound, repo-radar falls back (`+1000`, `+2000`, `+3000`, then an OS-assigned port) rather than refusing to start, remembers the port it landed on and reuses it on later launches, and shows it next to the version in ⚙ Settings. Reusing it matters because the port is part of the page's origin, and the board keeps saved views, the activity log, theme and language in origin-scoped browser storage — letting the port bounce back and forth would make that data appear to vanish and return. Delete `<config dir>/port-state.json` to go back to the default port.

A port you set yourself via `REPO_RADAR_PORT` is never substituted — it's a promise to your bookmarks, reverse-proxy upstreams and scripts, so an unbindable one fails loudly instead. Same in `npm run dev`, where the vite proxy target is fixed at config-load time.

## Development

```bash
npm run dev     # vite + the app window with hot reload
npm test        # server + web + desktop test suites and typechecks
npm run dist    # build installers into dist-electron/
```

Stack: Electron shell + Node + Hono (all git via `spawn`, zero native deps) + Vite / React 19 / antd 6, with chokidar + WebSocket for live updates. The Hono server runs inside Electron's main process and the window loads it over `127.0.0.1`, so the UI is plain HTTP + WebSocket — exactly what it would be in a browser.

## About the 365 Open Source Plan

Project **#027** of the [365 Open Source Plan](https://github.com/rockbenben/365opensource) — one person + AI, 300+ open-source projects in a year. [Submit your idea →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)

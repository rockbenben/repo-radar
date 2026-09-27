<p align="center">
  <img src="docs/images/board-en.jpg" width="900" alt="repo·radar board: alert lamps across the top, a Needs action queue, and one card per repo with branch, working-tree state and one-click editor / terminal / folder" />
</p>

# repo-radar

> A local dashboard that watches all your Git repos and shows you which ones need you.

**English** · [简体中文](README.zh.md) · [繁體中文](docs/i18n/README.zh-Hant.md) · [日本語](docs/i18n/README.ja.md) · [한국어](docs/i18n/README.ko.md) · [Español](docs/i18n/README.es.md) · [Français](docs/i18n/README.fr.md) · [Deutsch](docs/i18n/README.de.md) · [Português](docs/i18n/README.pt.md) · [Русский](docs/i18n/README.ru.md) · [Italiano](docs/i18n/README.it.md) · [العربية](docs/i18n/README.ar.md) · [हिन्दी](docs/i18n/README.hi.md) · [বাংলা](docs/i18n/README.bn.md) · [ไทย](docs/i18n/README.th.md) · [Türkçe](docs/i18n/README.tr.md) · [Tiếng Việt](docs/i18n/README.vi.md) · [Bahasa Indonesia](docs/i18n/README.id.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) [![365 Open Source Plan #027](https://img.shields.io/badge/365%20Open%20Source%20Plan-%23027-1f6feb)](https://github.com/rockbenben/365opensource)

[⬇ Download for Windows · macOS · Linux](https://github.com/rockbenben/repo-radar/releases/latest)

You have more Git repos than you can keep track of by hand. repo-radar watches all of them and shows you the few that need you now — so the rest stay off your mind.

It surfaces what you'd otherwise forget to check:

- **Work left unfinished** — uncommitted, unpushed or stashed changes, flagged before you lose them.
- **GitHub waiting on you** — open PRs, issues and failing CI, read through your own logged-in `gh`.
- **Projects going stale** — untouched too long, or overdue to ship.
- **Repos you've lost track of** — all of them on one screen, searchable, one click to open.

Whatever needs action rises to the top as a queue, one item per repo, ranked by urgency. Dismiss with ✓ and it stays gone until something actually changes — one exception: a dismissed stash comes back after 30 days, so a stash you truly forgot can't disappear for good.

## Supported

| Area | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Install | `.exe` installer | `.dmg` | `.AppImage` |
| Closing the window | drops to tray | drops to tray | quits — use **Launch at login** to keep it resident |
| Watching for changes | covers every repo under a scan directory | same | covers the first 200 repos (raise or lift the cap in settings) |

Everything runs on your machine and uses the `git` you already have — no account, no telemetry, nothing uploaded. The GitHub column (PRs, issues, CI) is optional and reads through the [`gh` CLI](https://cli.github.com/) you're already logged into; skip it and the rest still works.

## Install

Grab your platform's file from [Releases](https://github.com/rockbenben/repo-radar/releases) — no Node.js needed. The app isn't code-signed, so each OS warns on first run:

- **Windows** — on the SmartScreen prompt click *More info → Run anyway*.
- **macOS** — right-click → Open the first time. If macOS calls it damaged: `xattr -cr /Applications/repo-radar.app`.
- **Linux** — `chmod +x repo-radar-*.AppImage` first.

Rather not trust a binary? [Build it yourself](docs/development.md) — it's `npm install && npm start`.

On first launch click **Add scan directories** and point it at the folder your repos live *under* — `~/Projects`, not each repo one by one. It looks up to 6 levels down for anything containing a `.git`, and the board fills in. No JSON, no restart.

## The board

One card per repo — health color, branch, working-tree breakdown, ahead/behind, last commit, tags — with one-click **editor / terminal / folder**.

- **Find it** — search, or filter by language, `#tag` or signal lamp. ⌘/Ctrl-K opens a launcher.
- **Save a view** — any filter + sort + grouping, named and reusable.
- **Act in batches** — fetch / pull / push across selected repos, or run one shell command in all of them. One repo failing never stops the rest.
- **Work in place** — the detail panel commits with a live diff, switches branches, discards changes, prunes merged branches, and pulls GitHub PR & CI on demand.
- **Start & move repos** — **+ New** creates a repo and puts it straight on the board; manifest export / import moves your repo list — paths, remotes, groups, tags — to another machine.

The lamps along the top are the alert types — no remote, detached HEAD, unpushed, uncommitted, behind, stashed. Switch off the ones you don't care about in ⚙ Settings.

Two more tabs: **Stats** (year-long commit heatmap, most and least active) and **Worklog** (copy a date range as a Markdown weekly report).

A dark instrument-cockpit theme, localized into 18 languages, with text contrast tuned to WCAG AA in both light and dark.

## Staying current

The default is a 30-minute fallback rescan plus the toolbar's manual rescan. A rescan only reads local git state — it never contacts a remote to find out what changed.

File-watch auto-scan is **off by default** and opt-in from settings. It's local-only too, but with several projects building at once the kernel notification buffer overflows constantly, and an overflow means events we can no longer trust — the only safe answer is another rescan, rate-limited with exponential backoff to at most one per 30 minutes. Still too high a standing price for a glance-at-what-changed tool. Turn it on and new, deleted or renamed repos show up within seconds.

Rename or move a repo and it keeps its tags, star, archive state and notes. repo-radar recognises a repo by what's inside it, not by where it sits, so a moved folder is still the same project rather than a new one.

Scheduled background fetch is opt-in, and it's the only feature that talks to your remotes by itself. The GitHub column is the one thing that reaches the network on a timer without being asked: while the `gh` CLI is installed, PRs, issues and CI refresh through it every 12 minutes and after each rescan. No `gh`, or no GitHub remotes, and the app is fully local.

## Runs quietly in the background

Closing the window drops repo-radar to the tray **on Windows and macOS**, so rescans, watching and GitHub alerts keep running; on Linux it quits, because there is no dependable tray there. On Windows and Linux a click on the tray icon brings the board back; on macOS the icon opens its menu, where that is the first entry — and where Quit lives on every platform.

Quitting waits up to 10 seconds for git work already in flight — a batch pull, a stash drop — so nothing is cut mid-write and leaves a stale `.git/index.lock` behind. If that isn't enough it exits anyway and says so in the log.

Turn on **Launch at login** and it starts headless with your session. Optional desktop notifications fire only when something *new* reaches your GitHub "waiting on me" — a PR, issue or failing CI, never on first load.

## Configuration

Scan directories, excluded folders and the open commands are editable in ⚙ Settings → Scanning & open commands. The rest of your settings live in `~/.repo-radar/config.json`, which you rarely need to open — pure display choices (saved views, theme, language, the activity log) live in browser storage instead. The [configuration reference](docs/configuration.md) has the full field list, the cache files beside it, and the environment variables for running a second instance.

## Known limits

- **Upgrades are manual by design.** No auto-update: run the new installer over the old one.
- **A move that slips past the recognizing scan gets a hint, not a silent loss.** When the automatic match misses, the fresh card offers *"likely a moved copy of the old path"* — click **Migrate** and the tags, star and notes follow it. It only fires for repos scanned at least once on this build (the ledger needs to have seen their remote), and never for a destination you haven't added as a scan directory.
- **Linux has no dependable tray**, so closing the window quits instead of minimizing.
- **Repos you added one by one, outside a scan directory, aren't recognised that way** — move one and you point it at the new path yourself.
- **Discarding changes leaves submodules and nested git repos alone**, and says so rather than reporting a clean sweep.

## About the 365 Open Source Plan

Project **#027** of the [365 Open Source Plan](https://github.com/rockbenben/365opensource) — one person + AI, 300+ open-source projects in a year.

[Submit your idea →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)

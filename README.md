<p align="center">
  <img src="web/public/og-image.png" width="820" alt="repo·radar — a cross-repo action queue answering what needs you now" />
</p>

# repo-radar

> 365 Open Source Plan #027 · A local Git repo dashboard — a cross-repo action queue answering what needs you now.

**[English](README.md)** · [简体中文](docs/i18n/README.zh-Hans.md) · [繁體中文](docs/i18n/README.zh-Hant.md) · [日本語](docs/i18n/README.ja.md) · [한국어](docs/i18n/README.ko.md) · [Español](docs/i18n/README.es.md) · [Français](docs/i18n/README.fr.md) · [Deutsch](docs/i18n/README.de.md) · [Português](docs/i18n/README.pt.md) · [Русский](docs/i18n/README.ru.md) · [Italiano](docs/i18n/README.it.md) · [العربية](docs/i18n/README.ar.md) · [हिन्दी](docs/i18n/README.hi.md) · [বাংলা](docs/i18n/README.bn.md) · [ไทย](docs/i18n/README.th.md) · [Türkçe](docs/i18n/README.tr.md) · [Tiếng Việt](docs/i18n/README.vi.md) · [Bahasa Indonesia](docs/i18n/README.id.md)

A local Git repo dashboard that scans every repo on your machine and puts one screen in front of you first: a cross-repo **action queue** answering *what needs you right now* — click an item and act on it directly. The UI is built on antd 6 with a deep instrument-cockpit theme.

## Quick start

```bash
npm install
npm run build   # build the frontend
npm start       # http://localhost:7420
```

On first launch a default config is created at `~/.repo-radar/config.json`. Edit `roots` to add the directories you want scanned (e.g. `D:\Projects` — escape backslashes as `D:\\Projects` in JSON), then click **Rescan** in the panel.

## Needs you (the entry screen)

The **Needs you** queue at the top of the board is a cross-repo action queue: ranked by urgency, one item per repo — the single most urgent thing, not another "how many commits" vanity dashboard.

- **Waiting on you**: open PRs from others, open issues from others, red CI on the default branch (aggregated in the background via a local, already-authenticated `gh`, refreshed every 12 minutes, or ↻ manually; your own open PRs/issues count as WIP and are excluded) — click an item to jump straight to the matching GitHub page
- **At risk of being lost**: conflicts / behind / uncommitted / unpushed, the longer they sit the higher they rank — unpushed work gets a one-click push, everything else opens the detail panel
- **Overdue for release**: repos with a tagging habit that have piled up ≥3 commits since the latest tag with no release — a nudge to ship (repos that never tag are left alone; the latest tag is picked by creation time across the whole repo, independent of the current branch)
- **Forgotten stash**: a stash sitting untouched for ≥7 days — click through straight to the stash inbox
- **Dismiss**: tap ✓ to clear an item until something new happens — count-based items need the count to grow, change-based items need another commit; a stash dismissal is a snooze that resurfaces after 30 days so a truly forgotten one is never silenced for good
- Expand past 10 items to see everything; shows "all clear" when there's nothing left. Collapses to a thin banner at the top

## Board

- **Cards**: one card per repo (up to 4 per row, equal height). Left edge color = health (green = quiet / amber = attention / red = alert). Shows the real name · description · language · branch (flagged if not main) · working-tree breakdown (`+staged ~modified`) · ahead/behind · health tags · last commit · remote link · tags. Footer always has one-click **editor / terminal / folder**
- **Favorites row**: a dedicated "★ favorites" row at the top of the board — click to open in your editor
- **Readout cluster**: FLEET / CRIT / WARN / CLEAN gauges in the top bar; alert counts light up when > 0
- **Click to filter**: click a card's language or `#tag` to drop it straight into the search box
- **Sort**: last opened / most recently active (by commit time) / by name — favorites always float to the top
- **Attention lamps**: top-bar chips summarizing issue types (no remote / detached HEAD / unpushed / uncommitted / behind / stash); click to filter. "Unpushed" and "behind" each have a one-click "push/pull all"
- **Grouping**: by folder / by language / ungrouped (flat)
- **Command palette ⌘/Ctrl-K**: a launcher — type a name, hit enter to open in your editor (inline buttons for terminal / folder / copy path / open remote)
- **Tag filter**: multi-select tags in the top bar (AND — must carry every selected tag); click a card's `#tag` to add it. Filter + sort + grouping save together as a named "view"
- **Inline preview**: the "⋯" on a card pops up recent commits without opening the detail panel
- **Auto-scan (off by default)**: a "manual ⟳ / auto ⟳" toggle in the top bar. When on, a file watcher refreshes affected cards automatically (60-second cooldown; changes during the cooldown are merged, never dropped). When off, state only updates on Rescan. The board is still populated by one scan on first launch
- **Scheduled fetch (off by default)**: "fetch: off / every 5–60 min" in the top bar — periodically fetches every remote in the background to keep ahead/behind fresh
- **18 languages**: switch the UI language from ⚙ Settings (Simplified/Traditional Chinese, English, Japanese, Korean, Spanish, French, German, Portuguese, Russian, Italian, Arabic, Hindi, Bengali, Thai, Turkish, Vietnamese, Indonesian). On first visit with no saved preference, the UI matches your browser's language automatically (falling back to English if nothing matches); Arabic switches to RTL automatically. Relative times are localized natively via `Intl`. Repo names, descriptions, and commit messages are always left untranslated

## Actions

- The card footer always shows editor / terminal / folder / copy-path buttons; opening one records a "last opened" timestamp used for sorting
- Fetch / pull (`--ff-only`) / push run as batches: select multiple cards → batch-action from the top bar, or one-click a whole "unpushed" / "behind" attention lamp. Progress shows live; one repo failing doesn't stop the rest
- **Run a command across repos**: select cards, type a command in the toolbar (e.g. `npm install`), it runs in parallel inside every selected repo's directory. "Dry run" previews which repos would be affected first; "view output" shows the per-repo result afterward
- **Stash inbox**: with any stash lying around, a "stash inbox (N)" link appears in the top bar — lists every stashed change across every repo, with per-item diff, `apply` / `pop` / `drop`
- Selecting multiple cards also lets you bulk-apply tags
- **Manifest export / import**: export the full repo manifest (path + remotes + group + tags) from **+ new** for backup/moving machines; import re-adopts repos that already exist locally and lists the ones that don't for cloning
- The open command is configurable per target under `open` in config.json; `{path}` is substituted with the repo path
- **+ New**: suggests the next sequence number (e.g. `028-`) and the parent directory of your existing numbered projects, then creates the folder, runs `git init`, writes a README, and rescans it into the board

## Health checks & stats

- Rules (conflicted / no remote / detached HEAD / uncommitted / unpushed / untracked / behind / stash / stale) can be disabled individually via `health.disabledRules`; `staleDays` sets the "stale" threshold
- **Mergeable branches**: cards flag how many local branches are already merged into HEAD (excluding the current branch and main/master); the detail panel offers a one-click `git branch -d` cleanup (only ever deletes branches that are already merged — safe)
- **GitHub (optional, via a local, already-authenticated `gh`)**: the "needs you" queue aggregates open PRs / issues / default-branch CI for every `github.com` remote in the background (rate-limited polling, persisted to disk, instant on restart). The detail panel can also query open-PR detail and the latest CI run on demand; repo descriptions are backfilled from GitHub when available
- **Stats** tab: a year-long cross-repo commit heatmap (local branches only), most recently active, and the 10 repos untouched the longest
- **Worklog** tab: pick a date range to see a cross-repo commit timeline (filterable by author — defaults to "only me" by auto-detecting your git identity), with one-click copy as a Markdown weekly report
- Click a card to open the detail panel: full health breakdown, mergeable branches, **switch / create / discard local branches**, **commit in place** (type a message, it commits) with a live diff of pending changes, GitHub PR/CI, a mini 12-week heatmap, recent commits, stashes, and remotes

## Organizing repos

- Star ★ a card to favorite it (floats to the top); add/remove tags in the detail panel (autocompletes from tags you've already used) and change its group ("auto" restores folder-derived grouping)
- **Notes / to-dos**: jot down "what's next" in the detail panel — it shows on the card
- **Exclude**: hide repos you don't want to see; excluded repos are hidden from the board, alerts, and the command palette by default. "Excluded (N)" in the top bar lets you view/manage them separately (un-exclude from the detail panel)
- Changes apply instantly and are written to config.json without triggering a Git rescan

## Development

```bash
npm run dev     # runs server(7420) + vite(5173) together, frontend proxies /api
npm test        # full server + web test suite + both typechecks
```

Stack: Node + Hono (all git access via `spawn`, zero native dependencies), Vite + React 19 + antd 6 (deeply customized via CSS variables), chokidar + WebSocket for live updates.

## Configuration (config.json)

| Field | Description |
| --- | --- |
| `roots` | Root directories to scan; recursively discovers directories containing `.git` (depth ≤ 6) |
| `excludes` | Directory names to skip (defaults include node_modules) |
| `manualRepos` | Repo paths added manually, outside the configured roots |
| `tags` / `favorites` / `groupOverrides` | Per-repo-id tag / favorite / group overrides |
| `notes` / `archived` | Per-repo-id notes / archived flag |
| `health` | `{ staleDays, disabledRules }` |
| `open` | Command templates for the one-click open targets (editor / terminal / explorer) |

The `REPO_RADAR_CONFIG` environment variable overrides the config file path. The server only listens on `127.0.0.1` and validates the Origin header on both the API and the WebSocket.

## About the 365 Open Source Plan

This is project **#027** of the [365 Open Source Plan](https://github.com/rockbenben/365opensource).

One person + AI, 300+ open-source projects in a year. [Submit your idea →](https://365.aishort.top/)

## License

[MIT](LICENSE)

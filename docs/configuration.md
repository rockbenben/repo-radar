# Configuration reference

Per-repo data and behaviour live in `~/.repo-radar/config.json`. Pure display choices — saved views,
theme, language, the activity log, which alert lamps are hidden — live in origin-scoped browser
storage instead (see *Why port 17420*), so they follow the port, not this file. The common config
fields are covered in the README; this page is the rest.

## Fields

| Field | What it does |
| --- | --- |
| `roots` / `excludes` | where to scan (finds `.git` up to 6 deep, skipping dot-folders and not following symlinks) and which folder names to skip |
| `manualRepos` | repos added outside the roots. Unlike scanned repos these are **not** tracked by identity: rename or move one and its card errors until you fix the path here |
| `health` | `{ staleDays, disabledRules }` — tune the "stale" threshold or switch off individual checks |
| `open` | editor, terminal, and folder commands. The built-in values select platform defaults. Custom values take an executable and arguments, with quotes around arguments containing spaces. `{path}` is inserted as literal text in an argument. For shell pipelines or command sequences, use a separate executable script |
| `autoWatch` / `autoScanMinutes` / `watchLimit` / `notifications` | background behaviour. Only `autoScanMinutes` (30) is on by default |
| `worklogExportMinutes` / `worklogExportPath` | worklog export interval in minutes (0 disables it) and an optional absolute .json file path |
| `autoFetchMinutes` | remote refresh interval in minutes. Set `60` for hourly refresh. Defaults to `0` (off) |
| `autoPull` / `autoPullOverrides` | allow a scheduled remote refresh to fast-forward clean branches. Off globally by default. Each repository can override the global policy |
| `checkUpdates` | desktop builds only: ask GitHub once at startup whether a newer release exists. Off by default; the check never downloads or installs anything — both need your confirmation |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | per-repo organization |
| `lastOpened` | when each repo's editor / terminal / folder button was last used — maintained automatically, nothing to edit by hand |

## Remote refresh and auto-pull

Full scans read local Git state. Set **Remote refresh interval (minutes)** to fetch the checked-out
branch's upstream in the background, including in repositories with local changes. This timer runs
independently of periodic scans. Manual **Fetch** refreshes the selected repository on demand.

Enable **Auto-pull** to apply fetched commits during a scheduled remote refresh when the worktree
is clean and the branch is strictly behind. A repository can override that policy in its detail
panel. Archived repositories and branches without a remote upstream are skipped. Worktrees with
Git operations in progress and worktrees with ignored files that would be overwritten are
protected from auto-pull.

On upgrade, an existing remote refresh interval takes precedence. A configuration that previously
enabled remote updates globally on scans uses its former scan interval as the initial remote
refresh interval.

## Automatic worklog export

Open **Settings → General → Automatic worklog export**. Set a positive interval to enable export.
Leave the path blank to write `worklog.json` beside the active configuration file
(`~/.repo-radar/worklog.json` by default), or enter an absolute path to a `.json` file.
The first scheduled export runs after the initial repository scan or when you enable export
while the app is running. **Export now** uses the saved destination after the initial scan,
including when the interval is set to 0. It refreshes today's record and fills missing dates.
The settings panel shows the archive folder, missing dates, last fully successful export time,
and the most recent failure for that destination. A partial export keeps the previous success time.

Each export atomically replaces the previous UTF-8 JSON snapshot and covers the last 30 local
calendar days, including today. It includes all authors, using the same commit selection as the
Worklog tab. Consumers can read `format` (`repo-radar-worklog`), `schemaVersion` (1),
`exportedAt` (UTC), `since`, `until`, `commits`, `failed`, and `me`.
Use `me.emails` with `commits[].authorEmail` to reproduce the tab's author filter, and check
`failed` for incomplete results. The app logs write failures and retries on the next interval.
Daily files are saved alongside the snapshot under
`archive/YYYY/MM/YYYY-MM-DD.json`. They use the same schema, with `since` and `until` both
set to the file's local date. Days with no commits have an empty `commits` array. For weekly
or monthly summaries, read the relevant daily files in `archive/`.

The first export backfills from the first day of the previous calendar month. On startup and
each scheduled export, Repo Radar fills missing dates since archiving began, including gaps
longer than 30 days. It refreshes today and yesterday, and revisits the most recent archived
day after an interruption. Incomplete Git results leave the affected daily files as they were.
Repo Radar logs the failure and retries missing days on the next export.

Existing files from other programs are protected. Turning off export leaves the snapshot and
daily archives available. Archive files have no automatic expiry.

## The cache and state files next to it

Four rebuildable caches sit beside the config (`repo-cache.json`, `repo-identity.json`,
`github-desc.json`, `github-inbox.json`), plus `port-state.json` covered under *Why port 17420*.
All are safe to delete; the cost of deleting each is different.

`repo-cache.json` remembers each repo's expensive git fields (stashes, tags, remotes, merged
branches) keyed to a `.git` fingerprint, so an unchanged repo skips those calls on the next rescan.
Delete it and the next rescan is simply slower, once.

`repo-identity.json` is the ledger that lets a renamed or moved repo keep its tags, star, archive
state and notes. Deleting it loses data immediately, not later: any repo already renamed or moved
before the file went missing gets a brand-new id on the very next scan, and its organization stays
stranded under the id it no longer has. Repos that were never renamed are unaffected, and renames
from that point on are protected again once the ledger rebuilds.

`github-desc.json` and `github-inbox.json` cache the optional GitHub column (description, PR /
issue / CI) read through `gh`. Deleting them only costs a re-fetch on the next look — no user data,
no id dependency.

The desktop shell also maintains lightweight state files in this folder:

- `window-state.json` — remembers window position, size, and maximized state across runs.
- `autostart-state.json` — desktop-only one-time migration ledger for autostart settings.
- `version-state.json` — tracks the previously run app version; when the version increments, repo-radar clears Electron's HTTP cache before loading the interface to prevent stale bundled assets.
- `repo-radar.log` — application console tee log for diagnosing startup and background issues.
- `electron-userData/` — created only when running with a custom `REPO_RADAR_CONFIG` to give secondary instances their own single-instance lock domain and isolated web storage.

## Environment variables

`REPO_RADAR_CONFIG` and `REPO_RADAR_PORT` (default 17420) override the config path and port. Set
**both** to run a second, fully independent instance — useful for demos and screenshots.

## Why port 17420

It sits above the OS dynamic port range on purpose. Windows uses 49152–65535 by default but
1024–15000 once Hyper-V/WSL2 is installed, and the system reserves whole blocks out of the active
range: a port inside one fails to bind with `EACCES`, and the blocks move across reboots.

If the **default** port still can't be bound, repo-radar falls back (`+1000`, `+2000`, `+3000`, then
an OS-assigned port) rather than refusing to start, remembers where it landed, and shows the port
next to the version in ⚙ Settings. Reusing it matters: the port is part of the page origin, and
saved views, the activity log, theme and language live in origin-scoped browser storage — a port
that bounces makes that data appear to vanish and come back. Delete `<config dir>/port-state.json`
to return to the default.

A port **you** set via `REPO_RADAR_PORT` is never substituted. That is a promise to your bookmarks,
reverse-proxy upstreams and scripts, so an unbindable one fails loudly instead.

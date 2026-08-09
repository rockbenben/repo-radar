# Configuration reference

Everything the UI touches is saved to `~/.repo-radar/config.json`. The common fields are covered in
the README; this page is the rest.

## Fields

| Field | What it does |
| --- | --- |
| `roots` / `excludes` | where to scan (finds `.git` up to 6 deep, not following symlinks) and which folder names to skip |
| `manualRepos` | repos added outside the roots. Unlike scanned repos these are **not** tracked by identity: rename or move one and its card errors until you fix the path here |
| `health` | `{ staleDays, disabledRules }` — tune the "stale" threshold or switch off individual checks |
| `open` | command templates for the editor / terminal / folder buttons (`{path}` = the repo path) |
| `autoWatch` / `autoScanMinutes` / `watchLimit` / `autoFetchMinutes` / `notifications` | background behaviour. Only `autoScanMinutes` (30) is on by default |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | per-repo organization |

## The two cache files next to it

Both are safe to delete — repo-radar rebuilds them, at different costs.

`repo-cache.json` remembers each repo's expensive git fields (stashes, tags, remotes, merged
branches) keyed to a `.git` fingerprint, so an unchanged repo skips those calls on the next rescan.
Delete it and the next rescan is simply slower, once.

`repo-identity.json` is the ledger that lets a renamed or moved repo keep its tags, star, archive
state and notes. Deleting it loses data immediately, not later: any repo already renamed or moved
before the file went missing gets a brand-new id on the very next scan, and its organization stays
stranded under the id it no longer has. Repos that were never renamed are unaffected, and renames
from that point on are protected again once the ledger rebuilds.

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

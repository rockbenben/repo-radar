# Development

```bash
npm install     # needs Node 22.12+ (the floor the current vite / concurrently / electron require; CI runs 24)
npm run dev     # vite + the app window with hot reload
npm test        # server + web + desktop test suites and typechecks
npm run lint    # biome check (lint + import order; no code formatting)
npm run bench   # scan-concurrency benchmark on synthetic repos (a few minutes)
npm run dist    # build installers into dist-electron/
```

## Stack

Electron shell + Node + Hono (all git via `spawn`, zero native deps) + Vite / React 19 / antd 6,
with chokidar + WebSocket for live updates.

The Hono server runs inside Electron's main process and the window loads it over `127.0.0.1`, so the
UI is plain HTTP + WebSocket — exactly what it would be in a browser. That is also why the API
validates the `Origin` header on every request: the only defence against another local page driving
your git repos.

## Layout

| Path | What lives there |
| --- | --- |
| `server/` | Hono API, git plumbing, scanner, file watcher, GitHub (`gh`) integration |
| `web/` | React board, detail panel, settings, 18-language i18n |
| `desktop/` | Electron main process: window, tray, autostart, graceful quit |
| `scripts/` | app / tray icon assets, `bench-scan.mjs` (scan concurrency) |

The build helpers live where they run from: `desktop/scripts/` (dev launch) and `build/` (installer
script), not the root `scripts/`.

## Benchmarks

`npm run bench` builds a throwaway set of git repos under the temp dir (300 by default, one in six
dirty) and times the cold scan path — `getRepoCore` → fingerprint → `getRepoHeavy` — at several
`mapLimit` concurrency levels, alternating pass order so file-cache warming can't favour one level.
It bundles the real `server/src` modules with esbuild rather than reimplementing them, so the
numbers describe the shipped code; flags: `--repos`, `--levels`, `--rounds`, `--keep`.

Measure concurrency this way, not by launching the app: the tray build is single-instance, the port
can move, and the startup scan interleaves with manual rescans, which makes any wall-clock read from
outside the process unreliable.

## Tests

`npm test` runs three suites plus typechecks. CI runs `npm run lint`, `npm test` and the build on
Windows, macOS and Linux. The server suite drives real `git` and the real file watching APIs, so it
is run on all three — they behave differently enough (paths and CRLF, FSEvents delivering events
after a handle closes, inotify limits) that passing on one says little about the others.

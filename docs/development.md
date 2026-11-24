# Development

```bash
npm install     # Node 22.13+ on the 22.x line, or Node 24+ (CI runs Node 26 Active LTS)
npm run dev     # starts the app after Vite binds 127.0.0.1:5173
npm test        # server + web + desktop test suites and typechecks
npm run lint    # biome check (lint + import order; no code formatting)
npm run check:workflows # check workflow shell blocks syntax with bash -n
npm run bench   # scan-concurrency benchmark on synthetic repos (a few minutes)
npm run pack    # package unpacked desktop app into dist-electron/
npm run dist    # build installers and packages into dist-electron/
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

`npm test` runs three suites plus typechecks and release asset fixture tests. CI runs `npm run lint`,
`npm run check:workflows`, `npm test` and the build on Windows, macOS and Linux. The server suite drives
real `git` and the real file watching APIs, so it is run on all three — they behave differently enough
(paths and CRLF, FSEvents delivering events after a handle closes, inotify limits) that passing on one says
little about the others.

The web suite also runs on Node 26 in CI. Development startup requires port 5173 to be free.
Dead code checks run with `npx knip` (`knip.json` configures binary exceptions and desktop entry points).
Release targets consistency is checked with `node scripts/check-release-config.mjs`.

## Releases

After a push to main passes CI, the release workflow reads commits since the highest published
stable GitHub Release. A Conventional Commit with ! or a BREAKING CHANGE footer bumps the major
version, feat bumps minor, and fix or perf bumps patch. The largest bump wins. Other commits
accumulate until the next release. Existing tags and unrelated drafts reserve their numbers;
CI advances the patch if the calculated tag is already occupied.

The tracked package version is a development placeholder. CI stamps the release version into each
build checkout before compiling the app. After verifying all installers and update manifests it
publishes the draft and its tag on the tested commit. Retry failed jobs on the original CI run.
The publish job rechecks the candidate before uploading and verifies the public asset digests.

Windows x64 and ARM64 share one NSIS installer and updater manifest. Both Linux AppImage architectures have separate updater manifests. The two macOS DMGs use
manual updates. Release notes include download and signing information for the shipped packages.

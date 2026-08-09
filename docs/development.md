# Development

```bash
npm install
npm run dev     # vite + the app window with hot reload
npm test        # server + web + desktop test suites and typechecks
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
| `scripts/` | icons and build helpers |

## Tests

`npm test` runs three suites plus typechecks. The server suite drives real `git` and the real file
watching APIs, so it is run on Windows, macOS and Linux in CI — the three behave differently enough
(paths and CRLF, FSEvents delivering events after a handle closes, inotify limits) that passing on
one says little about the others.

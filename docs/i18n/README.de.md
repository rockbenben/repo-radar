<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — ein lokales Dashboard, das alle deine Git-Repos im Blick behält und die markiert, die dich brauchen" />
</p>

# repo-radar

> 365-Open-Source-Projekt #027 · Ein lokales Dashboard, das alle deine Git-Repos im Blick behält und dir zeigt, welche dich brauchen.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch** · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Du hast mehr Git-Repos, als du von Hand im Blick behalten kannst. repo-radar behält sie alle im Auge und zeigt dir die wenigen, die dich jetzt brauchen — damit der Rest dir aus dem Kopf geht.

Es holt hervor, was du sonst zu prüfen vergessen würdest:

- **Repos, die du aus den Augen verloren hast** — jedes Repo, das dir gehört, auf einem Bildschirm, durchsuchbar, jedes davon mit einem Klick geöffnet.
- **Unfertig gebliebene Arbeit** — uncommittete, ungepushte oder gestashte Änderungen, markiert, bevor du sie verlierst.
- **GitHub wartet auf dich** — offene PRs, Issues und fehlschlagende CI über alle Repos hinweg, gesammelt über dein lokales, bereits authentifiziertes `gh`.
- **Projekte, die veralten** — die, die du zu lange nicht angefasst hast, oder die überfällig zum Veröffentlichen sind.

Die, die Handlung erfordern, steigen als Warteschlange an die Spitze des Boards, nach Dringlichkeit sortiert, ein Eintrag pro Repo — klick, um direkt zu handeln. Verwirf mit ✓, und es bleibt weg, bis sich wirklich etwas ändert; wenn nichts wartet, steht dort „all clear“. Der Rest deiner Repos ist immer nur eine Suche entfernt.

## Installation

Schnapp dir die Datei für deine Plattform von [Releases](https://github.com/rockbenben/repo-radar/releases) — kein Node.js nötig. Die App ist nicht codesigniert, daher warnt jedes Betriebssystem beim ersten Start:

- **Windows** — führe `repo-radar-<version>-x64-setup.exe` aus; klicke bei der SmartScreen-Meldung auf *Weitere Informationen → Trotzdem ausführen*.
- **macOS** — öffne `repo-radar-<version>-arm64.dmg` und ziehe die App nach Applications. Beim ersten Mal Rechtsklick → Öffnen; nennt macOS sie beschädigt, entferne das Quarantäne-Flag einmalig mit `xattr -cr /Applications/repo-radar.app`.
- **Linux** — `chmod +x repo-radar-<version>-x86_64.AppImage && ./repo-radar-<version>-x86_64.AppImage`.

Oder aus dem Quellcode starten:

```bash
npm install
npm start
```

Klicke beim ersten Start auf **Scan-Verzeichnisse hinzufügen** (oder ⚙ Einstellungen → Scan-Verzeichnisse) und richte es auf die Ordner, die deine Repos enthalten — kein JSON, kein Neustart; es scannt neu, sobald du speicherst. Die Einstellungen liegen in `~/.repo-radar/config.json`, falls du sie lieber von Hand editierst.

## Das Board

Eine Karte pro Repo — Health-Farbe, Branch, Working-Tree-Aufschlüsselung, ahead/behind, letzter Commit, Tags — mit Ein-Klick **Editor / Terminal / Ordner** auf jeder Karte. Von hier aus kannst du:

- **Finden** — suchen, auf eine Sprache / einen `#tag` / eine Warnleuchte klicken, um zu filtern, sortieren und nach Ordner oder Sprache gruppieren; speichere jeden Filter + Sortierung + Gruppierung als benannte Ansicht. ⌘/Strg-K öffnet einen Launcher.
- **In Batches handeln** — wähle Repos für fetch / pull (`--ff-only`) / push aus oder führe einen Shell-Befehl parallel über sie hinweg aus (mit Dry-Run-Vorschau und Ausgabe pro Repo). Ein fehlschlagendes Repo stoppt nie die übrigen.
- **In ein Repo eintauchen** — das Detail-Panel liefert eine vollständige Health-Aufschlüsselung, Branches wechseln / erstellen / verwerfen, **an Ort und Stelle committen** mit Live-Diff, GitHub-PR & -CI auf Anfrage, letzte Commits, Stashes, eine 12-Wochen-Heatmap und ein sicheres Ein-Klick-Aufräumen bereits gemergter Branches.
- **Aktuell bleiben** — optionaler Auto-Scan per Datei-Überwachung und geplanter Hintergrund-Fetch, beide standardmäßig aus. Ein **Stats**-Tab (jahresübergreifende Commit-Heatmap, aktivste/inaktivste) und ein **Worklog**-Tab, der einen Zeitraum als Markdown-Wochenbericht kopiert.
- **Repos starten & verschieben** — **+ New** schlägt das nächste nummerierte Projekt vor, führt `git init` aus, schreibt eine README und übernimmt es ins Board; Manifest-Export / -Import trägt deine Einrichtung von Rechner zu Rechner.

Die UI ist antd 6 in einem dunklen Instrumenten-Cockpit-Theme, in 18 Sprachen lokalisiert (beim ersten Besuch automatisch an deinen Browser angeglichen, RTL für Arabisch).

## Läuft leise im Hintergrund

Das Fenster zu schließen legt repo-radar in den Tray, sodass Datei-Überwachung, geplante Fetches und GitHub-Benachrichtigungen weiterlaufen — klick auf das Tray-Symbol, um das Board zurückzuholen, oder beende es wirklich über das Tray-Menü. (Unter Linux, wo Desktop-Trays nicht zuverlässig sind, beendet das Schließen stattdessen; nutze Bei der Anmeldung starten, um es resident zu halten.)

Schalte **Bei der Anmeldung starten** in ⚙ Einstellungen ein, und es startet headless mit deiner Sitzung — kein Fenster, bis du danach verlangst. Optionale Desktop-Benachrichtigungen feuern nur, wenn etwas *Neues* deine Warteschlange erreicht, auch bei geschlossenem Fenster. Upgrades sind bewusst manuell (kein Auto-Update): führe den neuen Installer über den alten aus. Logs landen in `<config dir>/logs/repo-radar.log`.

## Konfiguration

Alles, was die UI berührt, wird in `~/.repo-radar/config.json` gespeichert — du musst sie selten öffnen. Die Felder, die zählen:

| Feld | Was es bewirkt |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | wo gescannt wird (findet `.git` bis 6 Ebenen tief), was übersprungen wird, und außerhalb der Roots hinzugefügte Repos |
| `health` | `{ staleDays, disabledRules }` — passe den „stale“-Schwellenwert an oder deaktiviere einzelne Checks |
| `open` | Befehlsvorlagen für die Buttons Editor / Terminal / Ordner (`{path}` = der Repo-Pfad) |
| `autoWatch` / `autoFetchMinutes` / `notifications` | Hintergrundverhalten — alles standardmäßig aus |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | Organisation pro Repo |

`REPO_RADAR_CONFIG` und `REPO_RADAR_PORT` (Standard 7420) überschreiben Konfigurationspfad und Port — setze **beide**, um eine zweite, vollständig unabhängige Instanz zu betreiben. Der Server bindet nur `127.0.0.1` und validiert den Origin-Header bei jeder API- und WebSocket-Anfrage.

## Entwicklung

```bash
npm run dev     # vite + das App-Fenster mit Hot Reload
npm test        # Server-, Web- und Desktop-Testsuiten sowie Typechecks
npm run dist    # baut Installer nach dist-electron/
```

Stack: Electron-Shell + Node + Hono (jeglicher Git-Zugriff über `spawn`, keine nativen Abhängigkeiten) + Vite / React 19 / antd 6, mit chokidar + WebSocket für Live-Updates. Der Hono-Server läuft im Hauptprozess von Electron, und das Fenster lädt ihn über `127.0.0.1` — die UI ist also reines HTTP + WebSocket, genau wie im Browser.

## Über den 365 Open Source Plan

Projekt **#027** des [365 Open Source Plan](https://github.com/rockbenben/365opensource) — eine Person + KI, über 300 Open-Source-Projekte in einem Jahr. [Reiche deine Idee ein →](https://365.aishort.top/)

## Lizenz

[MIT](../../LICENSE)

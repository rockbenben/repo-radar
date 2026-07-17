<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — a cross-repo action queue answering what needs you now" />
</p>

# repo-radar

> 365-Open-Source-Projekt #027 · Ein lokales Git-Repo-Dashboard — eine repoübergreifende Aktionswarteschlange, die beantwortet, was gerade deine Aufmerksamkeit braucht.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch** · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Ein lokales Git-Repo-Dashboard, das jedes Repo auf deinem Rechner scannt und dir zuerst einen einzigen Bildschirm zeigt: eine repoübergreifende **Aktionswarteschlange**, die beantwortet, *was gerade deine Aufmerksamkeit braucht* — klick auf einen Eintrag und handle direkt. Die Oberfläche basiert auf antd 6 mit einem tiefen Instrumenten-Cockpit-Theme.

## Schnellstart

```bash
npm install
npm run build   # build the frontend
npm start       # http://localhost:7420
```

Beim ersten Start wird eine Standardkonfiguration unter `~/.repo-radar/config.json` angelegt. Bearbeite `roots`, um die Verzeichnisse hinzuzufügen, die gescannt werden sollen (z. B. `D:\Projects` — Backslashes in JSON als `D:\\Projects` escapen), und klicke dann im Panel auf **Rescan**.

## Needs you (der Einstiegsbildschirm)

Die **Needs you**-Warteschlange oben im Board ist eine repoübergreifende Aktionswarteschlange: nach Dringlichkeit sortiert, ein Eintrag pro Repo — die eine dringendste Sache, nicht noch ein weiteres "Wie viele Commits"-Vanity-Dashboard.

- **Wartet auf dich**: offene PRs von anderen, offene Issues von anderen, rote CI auf dem Default-Branch (im Hintergrund aggregiert über ein lokales, bereits authentifiziertes `gh`, alle 12 Minuten aktualisiert, oder manuell per ↻; deine eigenen offenen PRs/Issues zählen als WIP und werden ausgeschlossen) — klick auf einen Eintrag, um direkt zur passenden GitHub-Seite zu springen
- **Gefahr, verloren zu gehen**: Konflikte / hinter dem Remote / uncommitted / unpushed — je länger sie liegen bleiben, desto höher die Priorität — ungepushte Arbeit bekommt einen Ein-Klick-Push, alles andere öffnet das Detail-Panel
- **Überfällig für ein Release**: Repos mit Tagging-Gewohnheit, bei denen sich seit dem letzten Tag ≥3 Commits ohne Release angesammelt haben — ein Stups, endlich zu veröffentlichen (Repos, die nie taggen, werden in Ruhe gelassen; das letzte Tag wird nach Erstellungszeit über das gesamte Repo hinweg ermittelt, unabhängig vom aktuellen Branch)
- **Vergessener Stash**: ein Stash, der seit ≥7 Tagen unangetastet herumliegt — klick durch, direkt zum Stash-Posteingang
- **Verwerfen**: tippe auf ✓, um einen Eintrag zu quittieren, bis sich etwas Neues ereignet — count-basierte Einträge brauchen einen wachsenden Zähler, änderungsbasierte Einträge brauchen einen weiteren Commit; ein Stash-Verwerfen ist ein Schlummern, das nach 30 Tagen wieder auftaucht, damit ein wirklich vergessener Stash nie endgültig zum Schweigen gebracht wird
- Über 10 Einträge hinaus ausklappen, um alles zu sehen; zeigt "alles klar", wenn nichts mehr übrig ist. Klappt sich zu einem schmalen Banner oben zusammen

## Board

- **Karten**: eine Karte pro Repo (bis zu 4 pro Zeile, gleiche Höhe). Farbe am linken Rand = Health (grün = ruhig / gelb = Aufmerksamkeit nötig / rot = Alarm). Zeigt den echten Namen · Beschreibung · Sprache · Branch (markiert, falls nicht main) · Working-Tree-Aufschlüsselung (`+staged ~modified`) · ahead/behind · Health-Tags · letzten Commit · Remote-Link · Tags. In der Fußzeile immer Ein-Klick **Editor / Terminal / Ordner**
- **Favoriten-Zeile**: eine eigene "★ Favoriten"-Zeile oben im Board — klick, um im Editor zu öffnen
- **Anzeigecluster**: FLEET / CRIT / WARN / CLEAN-Anzeigen in der oberen Leiste; Alarmzähler leuchten auf, wenn > 0
- **Klick zum Filtern**: klick auf die Sprache oder den `#tag` einer Karte, um ihn direkt in das Suchfeld zu übernehmen
- **Sortierung**: zuletzt geöffnet / zuletzt aktiv (nach Commit-Zeit) / nach Name — Favoriten schwimmen immer nach oben
- **Warnleuchten**: Chips in der oberen Leiste, die Problemtypen zusammenfassen (kein Remote / detached HEAD / unpushed / uncommitted / behind / stash); klick zum Filtern. "Unpushed" und "behind" haben jeweils ein Ein-Klick "push/pull all"
- **Gruppierung**: nach Ordner / nach Sprache / ungruppiert (flach)
- **Befehlspalette ⌘/Strg-K**: ein Launcher — tippe einen Namen, Enter drücken, um im Editor zu öffnen (Inline-Buttons für Terminal / Ordner / Pfad kopieren / Remote öffnen)
- **Tag-Filter**: Mehrfachauswahl von Tags in der oberen Leiste (UND-Verknüpfung — muss jedes ausgewählte Tag tragen); klick auf den `#tag` einer Karte, um ihn hinzuzufügen. Filter + Sortierung + Gruppierung werden zusammen als benannte "Ansicht" gespeichert
- **Inline-Vorschau**: das "⋯" auf einer Karte zeigt die letzten Commits, ohne das Detail-Panel zu öffnen
- **Auto-Scan (standardmäßig aus)**: ein "manuell ⟳ / auto ⟳"-Umschalter in der oberen Leiste. Wenn aktiviert, aktualisiert ein Datei-Watcher betroffene Karten automatisch (60-Sekunden-Cooldown; Änderungen während des Cooldowns werden zusammengeführt, nie verworfen). Wenn deaktiviert, wird der Zustand nur bei Rescan aktualisiert. Das Board wird auch dann durch einen einmaligen Scan beim ersten Start befüllt
- **Geplanter Fetch (standardmäßig aus)**: "fetch: aus / alle 5–60 Min" in der oberen Leiste — holt periodisch im Hintergrund jedes Remote, um ahead/behind aktuell zu halten
- **18 Sprachen**: die UI-Sprache lässt sich unter ⚙ Einstellungen umschalten (vereinfachtes/traditionelles Chinesisch, Englisch, Japanisch, Koreanisch, Spanisch, Französisch, Deutsch, Portugiesisch, Russisch, Italienisch, Arabisch, Hindi, Bengalisch, Thai, Türkisch, Vietnamesisch, Indonesisch). Beim ersten Besuch ohne gespeicherte Präferenz gleicht sich die UI automatisch an die Sprache deines Browsers an (Fallback auf Englisch, wenn nichts passt); Arabisch schaltet automatisch auf RTL um. Relative Zeitangaben werden nativ über `Intl` lokalisiert. Repo-Namen, Beschreibungen und Commit-Nachrichten bleiben immer unübersetzt

## Aktionen

- Die Kartenfußzeile zeigt immer Buttons für Editor / Terminal / Ordner / Pfad kopieren; das Öffnen eines davon speichert einen "zuletzt geöffnet"-Zeitstempel, der zur Sortierung genutzt wird
- Fetch / Pull (`--ff-only`) / Push laufen als Batches: mehrere Karten auswählen → Batch-Aktion aus der oberen Leiste, oder per Ein-Klick eine ganze "unpushed" / "behind"-Warnleuchte abarbeiten. Der Fortschritt wird live angezeigt; ein fehlschlagendes Repo stoppt nicht die übrigen
- **Einen Befehl über mehrere Repos hinweg ausführen**: Karten auswählen, einen Befehl in der Toolbar eintippen (z. B. `npm install`), er läuft parallel im Verzeichnis jedes ausgewählten Repos. "Probelauf" zeigt vorab, welche Repos betroffen wären; "Ausgabe anzeigen" zeigt danach das Ergebnis pro Repo
- **Stash-Posteingang**: sobald irgendwo ein Stash herumliegt, erscheint ein "Stash-Posteingang (N)"-Link in der oberen Leiste — listet jede gestashte Änderung über alle Repos hinweg, mit Diff pro Eintrag, `apply` / `pop` / `drop`
- Die Auswahl mehrerer Karten erlaubt außerdem das Massen-Anwenden von Tags
- **Manifest-Export / -Import**: exportiere das vollständige Repo-Manifest (Pfad + Remotes + Gruppe + Tags) über **+ Neu** für Backups/Rechnerwechsel; der Import übernimmt Repos wieder, die lokal bereits existieren, und listet die auf, die es nicht gibt, damit sie geklont werden können
- Der Öffnen-Befehl ist pro Ziel unter `open` in config.json konfigurierbar; `{path}` wird durch den Repo-Pfad ersetzt
- **+ Neu**: schlägt die nächste laufende Nummer vor (z. B. `028-`) und das übergeordnete Verzeichnis deiner vorhandenen nummerierten Projekte, legt dann den Ordner an, führt `git init` aus, schreibt eine README und scannt sie ins Board ein

## Health-Checks & Statistiken

- Regeln (conflicted / kein Remote / detached HEAD / uncommitted / unpushed / untracked / behind / stash / veraltet) lassen sich einzeln über `health.disabledRules` deaktivieren; `staleDays` legt den "veraltet"-Schwellenwert fest
- **Mergeable Branches**: Karten zeigen an, wie viele lokale Branches bereits in HEAD gemerged sind (ohne den aktuellen Branch und main/master); das Detail-Panel bietet einen Ein-Klick-`git branch -d`-Cleanup an (löscht nur jemals Branches, die bereits gemerged sind — also sicher)
- **GitHub (optional, über ein lokales, bereits authentifiziertes `gh`)**: die "Needs you"-Warteschlange aggregiert im Hintergrund offene PRs / Issues / Default-Branch-CI für jedes `github.com`-Remote (ratenbegrenztes Polling, auf Festplatte persistiert, beim Neustart sofort verfügbar). Das Detail-Panel kann außerdem auf Anfrage Open-PR-Details und den letzten CI-Lauf abfragen; Repo-Beschreibungen werden, sofern verfügbar, von GitHub nachgeladen
- **Statistiken**-Tab: eine jahresübergreifende repoübergreifende Commit-Heatmap (nur lokale Branches), zuletzt aktive Repos und die 10 Repos, die am längsten unangetastet blieben
- **Arbeitsprotokoll**-Tab: wähle einen Zeitraum, um eine repoübergreifende Commit-Zeitleiste zu sehen (filterbar nach Autor — standardmäßig "nur ich" durch automatische Erkennung deiner Git-Identität), mit Ein-Klick-Kopie als Markdown-Wochenbericht
- Klick auf eine Karte öffnet das Detail-Panel: vollständige Health-Aufschlüsselung, mergeable Branches, **lokale Branches wechseln / erstellen / verwerfen**, **an Ort und Stelle committen** (Nachricht eintippen, es committet) mit Live-Diff der ausstehenden Änderungen, GitHub-PR/CI, eine Mini-12-Wochen-Heatmap, letzte Commits, Stashes und Remotes

## Repos organisieren

- Markiere eine Karte mit ★ als Favorit (schwimmt nach oben); füge im Detail-Panel Tags hinzu/entferne sie (Autovervollständigung aus bereits verwendeten Tags) und ändere ihre Gruppe ("auto" stellt die ordnerbasierte Gruppierung wieder her)
- **Notizen / To-dos**: notiere dir im Detail-Panel "was als Nächstes ansteht" — es erscheint auf der Karte
- **Ausschließen**: verstecke Repos, die du nicht sehen willst; ausgeschlossene Repos sind standardmäßig im Board, bei den Alarmen und in der Befehlspalette ausgeblendet. "Ausgeschlossen (N)" in der oberen Leiste erlaubt es, sie separat anzuzeigen/zu verwalten (aus dem Detail-Panel wieder einschließen)
- Änderungen wirken sich sofort aus und werden in config.json geschrieben, ohne einen Git-Rescan auszulösen

## Entwicklung

```bash
npm run dev     # runs server(7420) + vite(5173) together, frontend proxies /api
npm test        # full server + web test suite + both typechecks
```

Stack: Node + Hono (jeglicher Git-Zugriff über `spawn`, keine nativen Abhängigkeiten), Vite + React 19 + antd 6 (tiefgehend über CSS-Variablen angepasst), chokidar + WebSocket für Live-Updates.

## Konfiguration (config.json)

| Feld | Beschreibung |
| --- | --- |
| `roots` | Zu scannende Wurzelverzeichnisse; entdeckt rekursiv Verzeichnisse, die ein `.git` enthalten (Tiefe ≤ 6) |
| `excludes` | Verzeichnisnamen, die übersprungen werden (standardmäßig u. a. node_modules) |
| `manualRepos` | Manuell hinzugefügte Repo-Pfade außerhalb der konfigurierten roots |
| `tags` / `favorites` / `groupOverrides` | Pro-Repo-ID Tag- / Favoriten- / Gruppen-Overrides |
| `notes` / `archived` | Pro-Repo-ID Notizen / Archiviert-Flag |
| `health` | `{ staleDays, disabledRules }` |
| `open` | Befehlsvorlagen für die Ein-Klick-Öffnen-Ziele (Editor / Terminal / Explorer) |

Die Umgebungsvariable `REPO_RADAR_CONFIG` überschreibt den Pfad zur Konfigurationsdatei. Der Server lauscht nur auf `127.0.0.1` und validiert den Origin-Header sowohl bei der API als auch beim WebSocket.

## Über den 365 Open Source Plan

Dies ist Projekt **#027** des [365 Open Source Plan](https://github.com/rockbenben/365opensource).

Eine Person + KI, über 300 Open-Source-Projekte in einem Jahr. [Reiche deine Idee ein →](https://365.aishort.top/)

## Lizenz

[MIT](../../LICENSE)

<p align="center">
  <img src="../../docs/images/board-en.jpg" width="900" alt="repo·radar-Board: Warnlampen oben, darunter die Warteschlange „Braucht dich“ und je eine Karte pro Repo mit Branch, Arbeitsverzeichnis-Status und Editor / Terminal / Ordner per Klick" />
</p>

# repo-radar

> Ein lokales Dashboard, das alle deine Git-Repos im Blick behält und dir zeigt, welche dich brauchen.

[English](../../README.md) · [简体中文](../../README.zh.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch** · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

[![365 Open Source Plan #027](https://img.shields.io/badge/365%20Open%20Source%20Plan-%23027-1f6feb)](https://github.com/rockbenben/365opensource)

[⬇ Für Windows · macOS · Linux herunterladen](https://github.com/rockbenben/repo-radar/releases/latest)

Du hast mehr Git-Repos, als du von Hand im Kopf behalten kannst. repo-radar behält alle im Auge und zeigt dir die wenigen, die jetzt dich brauchen — der Rest darf dir aus dem Kopf gehen.

Es holt hervor, was du sonst zu prüfen vergisst:

- **Liegengebliebene Arbeit** — nicht committete, nicht gepushte oder gestashte Änderungen, markiert bevor du sie verlierst.
- **GitHub wartet auf dich** — offene PRs, Issues und rote CI, gelesen über dein bereits angemeldetes `gh`.
- **Projekte, die einschlafen** — zu lange nicht angefasst oder überfällig für ein Release.
- **Repos, die du aus den Augen verloren hast** — alle auf einem Bildschirm, durchsuchbar, ein Klick zum Öffnen.

Was Handlung braucht, steigt als Warteschlange nach oben: ein Eintrag pro Repo, nach Dringlichkeit. Mit ✓ abhaken, und es bleibt weg, bis sich wirklich etwas ändert — eine Ausnahme: ein abgehakter Stash meldet sich nach 30 Tagen noch einmal, damit ein wirklich vergessener nicht für immer verschwindet.

## Unterstützt

| Bereich | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Installation | `.exe`-Installer | `.dmg` | `.AppImage` |
| Fenster schließen | geht in die Tray | geht in die Tray | beendet sich — nutze **Beim Anmelden starten**, damit es bleibt |
| Änderungen beobachten | alle Repos unter einem Scan-Verzeichnis | dito | die ersten 200 Repos (Grenze in den Einstellungen anheben oder aufheben) |

Alles läuft auf deinem Rechner und nutzt das `git`, das du schon hast — kein Konto, keine Telemetrie, nichts wird hochgeladen. Die GitHub-Spalte (PRs, Issues, CI) ist optional und liest über die [`gh` CLI](https://cli.github.com/), bei der du bereits angemeldet bist; ohne sie funktioniert der Rest weiterhin.

## Installation

Hol dir die Datei für deine Plattform aus den [Releases](https://github.com/rockbenben/repo-radar/releases) — kein Node.js nötig. Die App ist nicht signiert, also warnt jedes OS beim ersten Start:

- **Windows** — bei der SmartScreen-Meldung auf *Weitere Informationen → Trotzdem ausführen*.
- **macOS** — beim ersten Mal Rechtsklick → Öffnen. Wenn macOS sie als beschädigt meldet: `xattr -cr /Applications/repo-radar.app`.
- **Linux** — zuerst `chmod +x repo-radar-*.AppImage`.

Du willst einer Binärdatei nicht einfach vertrauen? [Bau sie selbst](../development.md) — es ist `npm install && npm start`.

Beim ersten Start auf **Scan-Verzeichnisse hinzufügen** klicken und auf den Ordner zeigen, *unter* dem deine Repos liegen — etwa `~/Projekte`, nicht jedes Repo einzeln. Er sucht bis zu 6 Ebenen tief nach allem mit einem `.git`, und das Board füllt sich. Kein JSON, kein Neustart.

## Das Board

Eine Karte pro Repo — Zustandsfarbe, Branch, Aufschlüsselung des Arbeitsverzeichnisses, ahead/behind, letzter Commit, Tags — mit **Editor / Terminal / Ordner** per Klick.

- **Finden** — suchen oder nach Sprache, `#tag` oder Signallampe filtern. ⌘/Strg-K öffnet einen Launcher.
- **Ansicht speichern** — jeder Filter + Sortierung + Gruppierung, benannt und wiederverwendbar.
- **Im Stapel handeln** — fetch / pull / push über ausgewählte Repos oder ein Shell-Kommando in allen. Ein fehlschlagendes Repo stoppt die anderen nie.
- **An Ort und Stelle arbeiten** — das Detailpanel committet mit Live-Diff, wechselt Branches, verwirft Änderungen, räumt gemergte Branches auf und holt GitHub-PRs & CI auf Abruf.
- **Repos anlegen & umziehen** — **+ Neu** legt ein Repo an und setzt es direkt aufs Board; Manifest-Export / -Import nimmt die Repo-Liste mit — Pfade, Remotes, Gruppen, Tags — und richtet sie auf dem nächsten Rechner wieder ein.

Die Lampen oben sind die Warntypen — kein Remote, detached HEAD, nicht gepusht, nicht committet, hinter dem Remote, Stash übrig. Was dich nicht interessiert, schaltest du in ⚙ Einstellungen ab.

Zwei weitere Tabs: **Statistik** (Commit-Heatmap über ein Jahr, aktivste und ruhigste Repos) und **Arbeitsjournal** (einen Zeitraum als Markdown-Wochenbericht kopieren).

Ein dunkles Instrumenten-Cockpit-Theme, in 18 Sprachen lokalisiert, Textkontrast in hellem wie dunklem Theme auf WCAG AA abgestimmt.

## Aktuell bleiben

Standard ist ein Fallback-Rescan alle 30 Minuten plus der manuelle Rescan in der Toolbar. Ein Rescan liest nur den lokalen Git-Zustand — er fragt niemals einen Remote ab, um Änderungen zu entdecken.

Der Auto-Scan per Dateiüberwachung ist **standardmäßig aus** und wird in den Einstellungen aktiviert. Auch er bleibt lokal, aber wenn mehrere Projekte gleichzeitig bauen, läuft der Benachrichtigungspuffer des Kernels ständig über — und ein Überlauf heißt: die Events sind weg, denen können wir nicht mehr trauen. Die einzig sichere Antwort ist ein weiterer Rescan, per exponentiellem Backoff auf höchstens einen pro 30 Minuten gedrosselt. Trotz allem ein zu hoher Dauerpreis für ein Werkzeug, mit dem man kurz nachsieht, was sich geändert hat. Eingeschaltet tauchen neue, gelöschte oder umbenannte Repos innerhalb von Sekunden auf.

Benenne ein Repo um oder verschiebe es, und Tags, Stern, Archivstatus und Notizen bleiben. repo-radar erkennt ein Repo an dem, was drinsteckt, nicht daran, wo es liegt — ein verschobener Ordner ist also weiterhin dasselbe Projekt und kein neues.

Der geplante Hintergrund-Fetch ist optional und die einzige Funktion, die von sich aus deine Remotes anspricht. Die GitHub-Spalte ist das Einzige, was ungefragt zeitgesteuert ins Netz geht: Solange die `gh`-CLI installiert ist, holen PRs, Issues und CI darüber alle 12 Minuten und nach jedem Rescan Daten. Kein `gh` oder keine GitHub-Remotes, und die App bleibt vollständig lokal.

## Läuft leise im Hintergrund

Das Fenster zu schließen legt repo-radar **unter Windows und macOS** in die Tray, sodass Rescans, Überwachung und GitHub-Hinweise weiterlaufen; unter Linux beendet es sich dort, weil es da keine verlässliche Tray gibt. Unter Windows und Linux holt ein Klick aufs Tray-Symbol das Board zurück; unter macOS öffnet das Symbol sein Menü, in dem das der erste Eintrag ist — und dort steht überall auch Beenden.

Beim Beenden wird bis zu 10 Sekunden auf laufende git-Arbeit gewartet — ein Stapel-Pull, ein verworfener Stash — damit nichts mitten im Schreiben abbricht und ein veraltetes `.git/index.lock` hinterlässt. Reicht das nicht, beendet es sich trotzdem und schreibt es ins Log.

Schalte **Beim Anmelden starten** ein, und es startet ohne Fenster mit deiner Sitzung. Optionale Desktop-Benachrichtigungen kommen nur, wenn etwas *Neues* auf deiner GitHub-Liste „wartet auf dich“ landet — PR, Issue oder fehlgeschlagene CI; beim ersten Laden nie.

## Konfiguration

Scan-Verzeichnisse, ausgeschlossene Ordner und die Öffnen-Befehle bearbeitest du unter ⚙ Einstellungen → Scan & Öffnen-Befehle. Der Rest liegt in `~/.repo-radar/config.json`, das du selten öffnen musst — reine Anzeigeeinstellungen (gespeicherte Ansichten, Theme, Sprache, Aktivitätsprotokoll) liegen dagegen im Browser-Speicher. Die vollständige Feldliste, die Cache-Dateien daneben und die Umgebungsvariablen für eine zweite Instanz stehen in der [Konfigurationsreferenz](../configuration.md).

## Bekannte Grenzen

- **Upgrades sind bewusst manuell.** Kein Auto-Update: den neuen Installer über den alten laufen lassen.
- **Ein Umzug, den der erkennende Scan verpasst, hinterlässt keinen stillen Verlust, sondern einen Hinweis.** Wenn die automatische Zuordnung danebengreift, bietet die neue Karte *„wahrscheinlich eine verschobene Kopie des alten Pfads“* — mit **Migrieren** folgen Tags, Stern und Notizen dem Repo. Der Hinweis erscheint nur bei Repos, die auf dieser Installation mindestens einmal gescannt wurden (die Buchführung muss ihr Remote gesehen haben), und nie für ein Ziel, das du nicht als Scan-Verzeichnis hinzugefügt hast.
- **Linux hat keine verlässliche Tray**, deshalb beendet das Schließen des Fensters die App.
- **Repos, die du einzeln außerhalb eines Scan-Verzeichnisses hinzugefügt hast, werden so nicht wiedererkannt** — verschiebst du eines, zeigst du selbst auf den neuen Pfad.
- **Das Verwerfen von Änderungen lässt Submodule und verschachtelte git-Repos in Ruhe** und sagt das auch, statt reinen Tisch zu melden.

## Über den 365 Open Source Plan

Projekt **#027** des [365 Open Source Plan](https://github.com/rockbenben/365opensource) — eine Person + KI, über 300 Open-Source-Projekte in einem Jahr.

[Reiche deine Idee ein →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)

<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — una dashboard locale che tiene d'occhio tutti i tuoi repo Git e segnala quelli che hanno bisogno di te" />
</p>

# repo-radar

> Piano 365 Open Source #027 · Una dashboard locale che tiene d'occhio tutti i tuoi repo Git e ti mostra quali hanno bisogno di te.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · **Italiano** · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Hai più repo Git di quanti tu ne possa tenere a mente a mano. repo-radar li tiene tutti d'occhio e ti mostra i pochi che hanno bisogno di te adesso — così il resto ti esce dalla testa.

Fa emergere ciò che altrimenti dimenticheresti di controllare:

- **Repo che hai perso di vista** — ogni repo che possiedi su un'unica schermata, con ricerca, aprine uno qualsiasi con un clic.
- **Lavoro rimasto incompiuto** — modifiche non committate, non pushate o in stash, segnalate prima che tu le perda.
- **GitHub che aspetta te** — PR aperte, issue e CI in errore su tutti i repo, raccolte tramite il tuo `gh` locale già autenticato.
- **Progetti che diventano obsoleti** — quelli che non tocchi da troppo tempo, o in ritardo per il rilascio.

Quelli che richiedono un'azione salgono in cima alla board come una coda, ordinati per urgenza, una voce per repo — clicca per agire direttamente. Ignoralo con ✓ e resta fuori finché qualcosa non cambia davvero; quando non c'è nulla in attesa, mostra "all clear". Il resto dei tuoi repo è sempre a una ricerca di distanza.

## Installazione

Prendi il file per la tua piattaforma da [Releases](https://github.com/rockbenben/repo-radar/releases) — niente Node.js necessario. L'app non è firmata digitalmente, quindi ogni sistema operativo avvisa al primo avvio:

- **Windows** — esegui `repo-radar-<version>-x64-setup.exe`; al prompt di SmartScreen clicca *Ulteriori informazioni → Esegui comunque*.
- **macOS** — apri `repo-radar-<version>-arm64.dmg` e trascina l'app in Applications. Clic destro → Apri la prima volta; se macOS la dichiara danneggiata, rimuovi una volta il flag di quarantena con `xattr -cr /Applications/repo-radar.app`.
- **Linux** — `chmod +x repo-radar-<version>-x86_64.AppImage && ./repo-radar-<version>-x86_64.AppImage`.

Oppure esegui dal codice sorgente:

```bash
npm install
npm start
```

Al primo avvio, clicca **Aggiungi directory da scansionare** (o ⚙ Impostazioni → Directory da scansionare) e puntalo alle cartelle che contengono i tuoi repo — niente JSON, niente riavvio; riscansiona nell'istante in cui salvi. Le impostazioni vivono in `~/.repo-radar/config.json` se preferisci modificarle a mano.

## La board

Una card per repo — colore di salute, branch, riepilogo della working tree, avanti/indietro, ultimo commit, tag — con **editor / terminale / cartella** con un clic su ogni card. Da qui puoi:

- **Trovare** — cerca, clicca su un linguaggio / un `#tag` / una spia di attenzione per filtrare, ordina e raggruppa per cartella o linguaggio; salva qualsiasi filtro + ordinamento + raggruppamento come vista con un nome. ⌘/Ctrl-K apre un launcher.
- **Agire in batch** — seleziona i repo per fetch / pull (`--ff-only`) / push, oppure esegui un comando di shell in parallelo su di essi (con anteprima dry-run e output per repo). Se un repo fallisce, non ferma mai gli altri.
- **Scavare in un repo** — il pannello dei dettagli offre un riepilogo completo di salute, cambiare / creare / eliminare branch, **commit sul posto** con un diff live, PR e CI di GitHub su richiesta, commit recenti, stash, una heatmap di 12 settimane e una pulizia sicura con un clic dei branch già uniti.
- **Restare aggiornato** — scansione automatica opzionale tramite file watching e fetch programmato in background, entrambi disattivati di default. Una scheda **Stats** (heatmap dei commit di un anno, più/meno attivi) e una scheda **Worklog** che copia un intervallo di date come report settimanale in Markdown.
- **Avviare e spostare repo** — **+ New** suggerisce il prossimo progetto numerato, esegue `git init`, scrive un README e lo adotta nella board; l'esportazione / importazione del manifest porta la tua configurazione da una macchina all'altra.

L'interfaccia è antd 6 con un tema scuro da plancia di comando strumentale, localizzata in 18 lingue (allineata automaticamente al tuo browser alla prima visita, RTL per l'arabo).

## Gira silenziosamente in background

Chiudere la finestra manda repo-radar nella tray, così il file watching, i fetch programmati e gli avvisi GitHub continuano a girare — clicca sull'icona nella tray per riportare la board, oppure esci davvero dal menu della tray. (Su Linux, dove le tray del desktop non sono affidabili, chiudere esce invece; usa Avvia all'accesso per mantenerlo residente.)

Attiva **Avvia all'accesso** in ⚙ Impostazioni e parte senza interfaccia con la tua sessione — nessuna finestra finché non la richiedi. Le notifiche desktop opzionali scattano solo quando qualcosa di *nuovo* raggiunge la tua coda, anche a finestra chiusa. Gli aggiornamenti sono manuali per scelta (nessun aggiornamento automatico): esegui il nuovo installer sopra quello vecchio. I log finiscono in `<directory di configurazione>/logs/repo-radar.log`.

## Configurazione

Tutto ciò che l'interfaccia tocca viene salvato in `~/.repo-radar/config.json` — raramente hai bisogno di aprirlo. I campi che contano:

| Campo | Cosa fa |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | dove scansionare (individua `.git` fino a 6 livelli di profondità), cosa saltare e i repo aggiunti fuori dalle root |
| `health` | `{ staleDays, disabledRules }` — regola la soglia "stale" o disattiva singoli controlli |
| `open` | modelli di comando per i pulsanti editor / terminale / cartella (`{path}` = il percorso del repo) |
| `autoWatch` / `autoFetchMinutes` / `notifications` | comportamento in background — tutto disattivato di default |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | organizzazione per repo |

`REPO_RADAR_CONFIG` e `REPO_RADAR_PORT` (predefinita 7420) sovrascrivono il percorso di configurazione e la porta — imposta **entrambe** per eseguire una seconda istanza completamente indipendente. Il server è in ascolto solo su `127.0.0.1` e convalida l'header Origin a ogni richiesta API e WebSocket.

## Sviluppo

```bash
npm run dev     # vite + la finestra dell'app con hot reload
npm test        # suite di test server + web + desktop e typecheck
npm run dist    # compila gli installer in dist-electron/
```

Stack: shell Electron + Node + Hono (tutto git via `spawn`, zero dipendenze native) + Vite / React 19 / antd 6, con chokidar + WebSocket per gli aggiornamenti in tempo reale. Il server Hono gira dentro il processo principale di Electron e la finestra lo carica via `127.0.0.1`, quindi la UI è HTTP + WebSocket puro — esattamente come sarebbe in un browser.

## Informazioni sul 365 Open Source Plan

Progetto **#027** del [365 Open Source Plan](https://github.com/rockbenben/365opensource) — una persona + l'IA, oltre 300 progetti open source in un anno. [Proponi la tua idea →](https://365.aishort.top/)

## Licenza

[MIT](../../LICENSE)

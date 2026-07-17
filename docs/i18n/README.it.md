<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — a cross-repo action queue answering what needs you now" />
</p>

# repo-radar

> Piano 365 Open Source #027 · Una dashboard locale per i repo Git — una coda di azioni cross-repo che risponde alla domanda di cosa ho bisogno adesso.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · **Italiano** · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Una dashboard locale per i repo Git che scansiona tutti i repository presenti sulla tua macchina e ti mette davanti, prima di tutto, un'unica schermata: una **coda di azioni** cross-repo che risponde alla domanda *di cosa ho bisogno adesso* — clicca su una voce e agisci direttamente. L'interfaccia è costruita su antd 6 con un tema profondo da plancia di comando strumentale.

## Avvio rapido

```bash
npm install
npm run build   # compila il frontend
npm start       # http://localhost:7420
```

Al primo avvio viene creata una configurazione predefinita in `~/.repo-radar/config.json`. Modifica `roots` per aggiungere le directory che vuoi scansionare (ad es. `D:\Projects` — nel JSON i backslash vanno scritti come `D:\\Projects`), poi clicca **Rescan** nel pannello.

## Needs you (la schermata di ingresso)

La coda **Needs you**, in cima alla board, è una coda di azioni cross-repo: ordinata per urgenza, una voce per repository — la cosa più urgente in assoluto, non l'ennesima dashboard vanitosa sul "quanti commit".

- **In attesa di te**: PR aperte da altri, issue aperte da altri, CI in rosso sul branch predefinito (aggregate in background tramite un `gh` locale già autenticato, aggiornate ogni 12 minuti oppure manualmente con ↻; le tue PR/issue aperte contano come lavoro in corso e vengono escluse) — clicca su una voce per saltare direttamente alla pagina GitHub corrispondente
- **A rischio di andare perse**: conflitti / indietro rispetto al remoto / non committato / non pushato — più a lungo restano lì, più salgono in classifica — il lavoro non pushato ha un push con un clic, tutto il resto apre il pannello dei dettagli
- **In ritardo per il rilascio**: repository con l'abitudine di taggare che hanno accumulato ≥3 commit dall'ultimo tag senza rilasciare — un promemoria per pubblicare (i repository che non taggano mai vengono lasciati in pace; l'ultimo tag viene scelto in base alla data di creazione su tutto il repository, indipendentemente dal branch corrente)
- **Stash dimenticato**: uno stash rimasto intoccato per ≥7 giorni — clicca per andare dritto all'inbox degli stash
- **Ignora**: tocca ✓ per liberare una voce finché non succede qualcosa di nuovo — le voci basate su conteggio richiedono che il conteggio cresca, quelle basate su modifiche richiedono un altro commit; ignorare uno stash equivale a rimandarlo, e riappare dopo 30 giorni, così uno stash davvero dimenticato non viene mai messo a tacere per sempre
- Espandi oltre le 10 voci per vedere tutto; mostra "tutto a posto" quando non resta nulla. Si riduce a un sottile banner in alto

## Board

- **Card**: una card per repository (fino a 4 per riga, tutte della stessa altezza). Il colore del bordo sinistro indica lo stato di salute (verde = tranquillo / ambra = attenzione / rosso = allarme). Mostra il nome reale · la descrizione · il linguaggio · il branch (segnalato se non è main) · il riepilogo della working tree (`+staged ~modified`) · quanto è avanti/indietro · i tag di salute · l'ultimo commit · il link al remoto · i tag. Il footer ha sempre editor / terminale / cartella con un clic
- **Riga dei preferiti**: una riga dedicata "★ favorites" in cima alla board — clicca per aprire nel tuo editor
- **Cluster di lettura**: indicatori FLEET / CRIT / WARN / CLEAN nella barra superiore; i conteggi di allarme si accendono quando sono > 0
- **Clic per filtrare**: clicca sul linguaggio o su un `#tag` di una card per inserirlo direttamente nella casella di ricerca
- **Ordinamento**: ultimo aperto / più recentemente attivo (per data del commit) / per nome — i preferiti salgono sempre in cima
- **Spie di attenzione**: chip nella barra superiore che riassumono i tipi di problema (nessun remoto / HEAD distaccato / non pushato / non committato / indietro / stash); clicca per filtrare. "Non pushato" e "indietro" hanno ciascuno un "push/pull su tutti" con un clic
- **Raggruppamento**: per cartella / per linguaggio / senza raggruppamento (piatto)
- **Palette dei comandi ⌘/Ctrl-K**: un launcher — digita un nome, premi invio per aprire nel tuo editor (pulsanti inline per terminale / cartella / copia percorso / apri remoto)
- **Filtro per tag**: selezione multipla di tag nella barra superiore (in AND — deve avere tutti i tag selezionati); clicca su un `#tag` di una card per aggiungerlo. Filtro + ordinamento + raggruppamento si salvano insieme come "vista" con un nome
- **Anteprima inline**: il "⋯" su una card mostra i commit recenti senza aprire il pannello dei dettagli
- **Scansione automatica (disattivata di default)**: un interruttore "manual ⟳ / auto ⟳" nella barra superiore. Se attivo, un file watcher aggiorna automaticamente le card interessate (raffreddamento di 60 secondi; le modifiche durante il raffreddamento vengono unite, mai perse). Se disattivo, lo stato si aggiorna solo con Rescan. La board viene comunque popolata da una scansione al primo avvio
- **Fetch programmato (disattivato di default)**: "fetch: off / ogni 5–60 min" nella barra superiore — esegue periodicamente il fetch di ogni remoto in background per mantenere aggiornato lo stato avanti/indietro
- **18 lingue**: cambia la lingua dell'interfaccia da ⚙ Impostazioni (cinese semplificato/tradizionale, inglese, giapponese, coreano, spagnolo, francese, tedesco, portoghese, russo, italiano, arabo, hindi, bengalese, thai, turco, vietnamita, indonesiano). Alla prima visita, senza preferenze salvate, l'interfaccia si allinea automaticamente alla lingua del browser (con fallback all'inglese se nessuna corrisponde); l'arabo passa automaticamente a RTL. Gli orari relativi sono localizzati nativamente tramite `Intl`. I nomi dei repository, le descrizioni e i messaggi di commit non vengono mai tradotti

## Azioni

- Il footer della card mostra sempre i pulsanti editor / terminale / cartella / copia percorso; aprirne uno registra un timestamp di "ultimo aperto" usato per l'ordinamento
- Fetch / pull (`--ff-only`) / push vengono eseguiti in batch: seleziona più card → azione in batch dalla barra superiore, oppure un clic su un'intera spia di attenzione "non pushato" / "indietro". L'avanzamento viene mostrato in tempo reale; se un repository fallisce, gli altri non si fermano
- **Esegui un comando su più repository**: seleziona le card, digita un comando nella toolbar (ad es. `npm install`), viene eseguito in parallelo nella directory di ogni repository selezionato. "Dry run" mostra in anteprima quali repository sarebbero coinvolti; "view output" mostra in seguito il risultato per ciascun repository
- **Inbox degli stash**: se c'è uno stash in giro, appare un link "stash inbox (N)" nella barra superiore — elenca ogni modifica messa in stash in tutti i repository, con diff per singola voce, `apply` / `pop` / `drop`
- Selezionare più card permette anche di applicare tag in blocco
- **Esportazione / importazione del manifest**: esporta il manifest completo dei repository (percorso + remoti + gruppo + tag) da **+ new** per backup o cambio macchina; l'importazione riadotta i repository già presenti in locale ed elenca quelli mancanti per clonarli
- Il comando di apertura è configurabile per ciascuna destinazione tramite `open` in config.json; `{path}` viene sostituito con il percorso del repository
- **+ New**: suggerisce il prossimo numero di sequenza (ad es. `028-`) e la directory principale dei tuoi progetti numerati esistenti, poi crea la cartella, esegue `git init`, scrive un README e lo rileva nella board con una scansione

## Controlli di salute e statistiche

- Le regole (conflitto / nessun remoto / HEAD distaccato / non committato / non pushato / non tracciato / indietro / stash / obsoleto) possono essere disattivate singolarmente tramite `health.disabledRules`; `staleDays` imposta la soglia di "obsoleto"
- **Branch unibili**: le card segnalano quanti branch locali sono già stati uniti in HEAD (escludendo il branch corrente e main/master); il pannello dei dettagli offre una pulizia con `git branch -d` con un clic (elimina solo ed esclusivamente branch già uniti — è sicuro)
- **GitHub (opzionale, tramite un `gh` locale già autenticato)**: la coda "needs you" aggrega in background PR aperte / issue / CI del branch predefinito per ogni remoto `github.com` (polling con limite di frequenza, persistito su disco, istantaneo al riavvio). Il pannello dei dettagli può anche interrogare a richiesta i dettagli delle PR aperte e l'ultima esecuzione CI; le descrizioni dei repository vengono compilate da GitHub quando disponibili
- Scheda **Statistiche**: una heatmap dei commit cross-repo su un anno (solo branch locali), gli elementi più recentemente attivi e i 10 repository non toccati da più tempo
- Scheda **Worklog**: scegli un intervallo di date per vedere una timeline dei commit cross-repo (filtrabile per autore — di default "solo io", rilevando automaticamente la tua identità git), con copia con un clic come report settimanale in Markdown
- Clicca su una card per aprire il pannello dei dettagli: riepilogo completo dello stato di salute, branch unibili, **cambio / creazione / eliminazione di branch locali**, **commit sul posto** (digita un messaggio e viene eseguito il commit) con un diff live delle modifiche in sospeso, PR/CI di GitHub, una mini heatmap di 12 settimane, commit recenti, stash e remoti

## Organizzare i repository

- Metti una stella ★ su una card per aggiungerla ai preferiti (sale in cima); aggiungi/rimuovi tag nel pannello dei dettagli (con autocompletamento dai tag già usati) e cambia il suo gruppo ("auto" ripristina il raggruppamento derivato dalla cartella)
- **Note / cose da fare**: annota "cosa fare dopo" nel pannello dei dettagli — viene mostrato sulla card
- **Esclusione**: nascondi i repository che non vuoi vedere; i repository esclusi sono nascosti di default dalla board, dagli avvisi e dalla palette dei comandi. "Excluded (N)" nella barra superiore permette di visualizzarli/gestirli separatamente (rimuovi l'esclusione dal pannello dei dettagli)
- Le modifiche si applicano istantaneamente e vengono scritte in config.json senza avviare una nuova scansione Git

## Sviluppo

```bash
npm run dev     # avvia insieme server(7420) + vite(5173), il frontend fa da proxy su /api
npm test        # suite di test completa server + web e entrambi i typecheck
```

Stack: Node + Hono (tutto l'accesso a git avviene tramite `spawn`, zero dipendenze native), Vite + React 19 + antd 6 (personalizzato in profondità tramite variabili CSS), chokidar + WebSocket per gli aggiornamenti in tempo reale.

## Configurazione (config.json)

| Campo | Descrizione |
| --- | --- |
| `roots` | Directory radice da scansionare; individua ricorsivamente le directory contenenti `.git` (profondità ≤ 6) |
| `excludes` | Nomi di directory da saltare (di default include node_modules) |
| `manualRepos` | Percorsi di repository aggiunti manualmente, al di fuori delle root configurate |
| `tags` / `favorites` / `groupOverrides` | Override per repository di tag / preferiti / gruppo |
| `notes` / `archived` | Note per repository / flag di archiviazione |
| `health` | `{ staleDays, disabledRules }` |
| `open` | Modelli di comando per le destinazioni di apertura con un clic (editor / terminale / esplora risorse) |

La variabile d'ambiente `REPO_RADAR_CONFIG` sovrascrive il percorso del file di configurazione. Il server è in ascolto solo su `127.0.0.1` e convalida l'header Origin sia sull'API che sul WebSocket.

## Informazioni sul 365 Open Source Plan

Questo è il progetto **#027** del [365 Open Source Plan](https://github.com/rockbenben/365opensource).

Una persona + l'IA, oltre 300 progetti open source in un anno. [Proponi la tua idea →](https://365.aishort.top/)

## Licenza

[MIT](../../LICENSE)

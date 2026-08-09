<p align="center">
  <img src="../../docs/images/board-en.jpg" width="900" alt="Plancia di repo·radar: spie di allerta in alto, coda «richiede intervento» sotto e una scheda per repo con branch, stato dell'albero di lavoro ed editor / terminale / cartella in un clic" />
</p>

# repo-radar

> Piano 365 Open Source #027 · Una dashboard locale che tiene d'occhio tutti i tuoi repo Git e ti mostra quali hanno bisogno di te.

[English](../../README.md) · [简体中文](../../README.zh.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · **Italiano** · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

[⬇ Scarica per Windows · macOS · Linux](https://github.com/rockbenben/repo-radar/releases/latest)

Hai più repo Git di quanti tu ne possa tenere a mente. repo-radar li sorveglia tutti e ti mostra i pochi che ti servono adesso — gli altri puoi togliterli dalla testa.

Fa emergere ciò che altrimenti dimenticheresti di controllare:

- **Lavoro lasciato a metà** — modifiche non committate, non pushate o in stash, segnalate prima che tu le perda.
- **GitHub che ti aspetta** — PR aperte, issue e CI rossa, letti tramite il tuo `gh` già autenticato.
- **Progetti che si raffreddano** — non toccati da troppo tempo, o con una release in ritardo.
- **Repo persi di vista** — tutti su una schermata, cercabili, aperti con un clic.

Ciò che richiede un intervento sale in cima come coda: una voce per repo, per urgenza. Scarta con ✓ e resta fuori finché qualcosa non cambia davvero.

## Compatibilità

| Aspetto | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Installazione | installer `.exe` | `.dmg` | `.AppImage` |
| Chiusura della finestra | va nella tray | va nella tray | esce — usa **Avvia all'accesso** per tenerlo attivo |
| Monitoraggio delle modifiche | tutti i repo sotto una directory di scansione | idem | i primi 200 repo (il limite si alza o si toglie nelle impostazioni) |

Tutto gira sulla tua macchina e usa il `git` che hai già — nessun account, nessuna telemetria, niente viene caricato. La colonna GitHub (PR, issue, CI) è opzionale e legge tramite la [CLI `gh`](https://cli.github.com/) con cui sei già autenticato; senza, il resto funziona lo stesso.

## Installazione

Prendi il file per la tua piattaforma dalle [Releases](https://github.com/rockbenben/repo-radar/releases) — niente Node.js. L'app non è firmata, quindi ogni sistema avvisa al primo avvio:

- **Windows** — al prompt SmartScreen, *Ulteriori informazioni → Esegui comunque*.
- **macOS** — la prima volta clic destro → Apri. Se macOS la dà per danneggiata: `xattr -cr /Applications/repo-radar.app`.
- **Linux** — prima `chmod +x repo-radar-*.AppImage`.

Preferisci non fidarti di un binario? [Compilalo tu](../development.md) — è `npm install && npm start`.

Al primo avvio premi **Aggiungi directory da scansionare** e punta alla cartella che *contiene* i tuoi repo — una `~/Progetti`, non ogni repo uno per uno. Scende fino a 6 livelli cercando qualsiasi cosa con un `.git`, e la plancia si riempie. Niente JSON, niente riavvio.

## La plancia

Una scheda per repo — colore di salute, branch, dettaglio dell'albero di lavoro, ahead/behind, ultimo commit, tag — con **editor / terminale / cartella** in un clic.

- **Trovarlo** — cerca, oppure filtra per linguaggio, `#tag` o spia. ⌘/Ctrl-K apre un launcher.
- **Salvare una vista** — qualsiasi filtro + ordinamento + raggruppamento, con un nome e riutilizzabile.
- **Agire in blocco** — fetch / pull / push sui repo selezionati, o uno stesso comando shell in tutti. Un repo che fallisce non ferma mai gli altri.
- **Lavorare sul posto** — il pannello di dettaglio committa con diff dal vivo, cambia branch, scarta modifiche, ripulisce i branch già mergiati e recupera PR e CI di GitHub su richiesta.
- **Creare e spostare repo** — **+ Nuovo** crea un repo e lo mette subito in plancia; export / import del manifest porta la tua configurazione su un'altra macchina.

Le spie in alto sono i tipi di allerta — nessun remote, non pushato, non committato, indietro rispetto al remote, stash residuo. Spegni quelle che non ti interessano in ⚙ Impostazioni.

Altre due schede: **Statistiche** (heatmap dei commit su un anno, repo più e meno attivi) e **Diario di lavoro** (copia un intervallo di date come report settimanale in Markdown).

Tema scuro da plancia strumentale, localizzato in 18 lingue, contrasto del testo tarato su WCAG AA sia in chiaro sia in scuro.

## Restare aggiornati

Di default: una riscansione di riserva ogni 30 minuti più quella manuale della barra — locale, silenziosa, senza rete.

La scansione automatica tramite monitoraggio dei file è **disattivata di default** e si attiva dalle impostazioni. È anch'essa solo locale, ma con più progetti che compilano insieme il buffer di notifiche del kernel va in overflow di continuo, e ogni overflow costa una riscansione — un prezzo fisso troppo alto per uno strumento con cui dai un'occhiata a cosa è cambiato. Attivata, i repo aggiunti, eliminati o rinominati compaiono in pochi secondi.

Rinomina o sposta un repo e mantiene tag, preferito, stato di archivio e note. repo-radar riconosce un repo da ciò che contiene, non da dove si trova: una cartella spostata resta lo stesso progetto, non uno nuovo.

Il fetch pianificato in background è opzionale ed è l'unica funzione che esce in rete di propria iniziativa.

## Gira in silenzio in background

Chiudere la finestra ripone repo-radar nella tray, così riscansioni, monitoraggio e avvisi GitHub continuano. Clicca l'icona per richiamare la plancia, o esci dal menu della tray.

All'uscita attende fino a 10 secondi il lavoro git già in corso — un pull di gruppo, uno stash scartato — perché nulla venga troncato a metà scrittura lasciando un `.git/index.lock` vecchio. Se non basta esce comunque e lo scrive nel log.

Attiva **Avvia all'accesso** e parte senza finestra insieme alla tua sessione. Le notifiche desktop sono opzionali e scattano solo quando qualcosa di *nuovo* entra nella coda.

## Configurazione

Directory da scansionare, cartelle escluse e comandi di apertura si modificano da ⚙ Impostazioni → Scansione e comandi di apertura. Il resto sta in `~/.repo-radar/config.json`, che raramente devi aprire — l'elenco completo dei campi, i due file di cache accanto e le variabili d'ambiente per una seconda istanza sono nel [riferimento di configurazione](../configuration.md).

## Limiti noti

- **Gli aggiornamenti sono manuali per scelta.** Niente auto-update: esegui il nuovo installer sopra il vecchio.
- **Un repo spostato viene riconosciuto alla scansione successiva — se salta quella scansione, i tag non lo seguono.** Uno spostamento lento tra volumi, o una destinazione non ancora aggiunta come directory di scansione, torna come scheda nuova e lascia i tag su quella vecchia.
- **Linux non ha una tray affidabile**, quindi chiudere la finestra chiude l'app.
- **I repo aggiunti uno a uno, fuori da una directory di scansione, non vengono riconosciuti così** — se ne sposti uno, il nuovo percorso lo indichi tu.
- **Scartare le modifiche non tocca submodule e repo git annidati**, e lo dice invece di dichiarare pulizia completa.

## Informazioni sul 365 Open Source Plan

Progetto **#027** del [365 Open Source Plan](https://github.com/rockbenben/365opensource) — una persona + l'IA, oltre 300 progetti open source in un anno.

[Proponi la tua idea →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)

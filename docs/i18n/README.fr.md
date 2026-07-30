<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — un tableau de bord local qui surveille tous vos dépôts Git et signale ceux qui requièrent votre attention" />
</p>

# repo-radar

> Plan Open Source 365 #027 · Un tableau de bord local qui surveille tous vos dépôts Git et vous montre ceux qui requièrent votre attention.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Vous avez plus de dépôts Git que vous ne pouvez en suivre à la main. repo-radar les garde tous à l'œil et vous montre les quelques-uns qui requièrent votre attention maintenant — pour que les autres sortent de votre esprit.

Il fait remonter ce que vous oublieriez sinon de vérifier :

- **Des dépôts que vous avez perdus de vue** — chaque dépôt que vous possédez sur un seul écran, avec recherche, ouvrez n'importe lequel en un clic.
- **Du travail resté inachevé** — des changements non commités, non poussés ou en stash, signalés avant que vous ne les perdiez.
- **GitHub qui vous attend** — PR ouvertes, issues et CI en échec sur l'ensemble de vos dépôts, rassemblés via votre `gh` local déjà authentifié.
- **Des projets qui deviennent obsolètes** — ceux que vous n'avez pas touchés depuis trop longtemps, ou dont la publication est en retard.

Ceux qui appellent une action remontent en haut du tableau sous forme de file, classés par urgence, un élément par dépôt — cliquez pour agir directement dessus. Écartez-le avec ✓ et il reste hors de vue jusqu'à ce que quelque chose change réellement ; quand rien n'attend, il affiche « all clear ». Le reste de vos dépôts n'est jamais qu'à une recherche.

## Installation

Récupérez le fichier de votre plateforme depuis [Releases](https://github.com/rockbenben/repo-radar/releases) — Node.js non requis. L'app n'est pas signée numériquement, donc chaque système d'exploitation avertit au premier lancement :

- **Windows** — exécutez `repo-radar-<version>-x64-setup.exe` ; sur l'invite SmartScreen, cliquez sur *Informations complémentaires → Exécuter quand même*.
- **macOS** — ouvrez `repo-radar-<version>-arm64.dmg` et faites glisser l'app vers Applications. Clic droit → Ouvrir la première fois ; si macOS la dit endommagée, retirez une fois l'attribut de quarantaine avec `xattr -cr /Applications/repo-radar.app`.
- **Linux** — `chmod +x repo-radar-<version>-x86_64.AppImage && ./repo-radar-<version>-x86_64.AppImage`.

Ou lancez depuis les sources :

```bash
npm install
npm start
```

Au premier lancement, cliquez sur **Ajouter des répertoires à scanner** (ou ⚙ Paramètres → Répertoires à scanner) et pointez-le vers les dossiers qui contiennent vos dépôts — aucun JSON, aucun redémarrage ; le scan repart dès que vous enregistrez. La configuration réside dans `~/.repo-radar/config.json` si vous préférez l'éditer à la main.

## Le tableau

Une carte par dépôt — couleur de santé, branche, détail de l'arbre de travail, avance/retard, dernier commit, tags — avec **éditeur / terminal / dossier** en un clic sur chaque carte. À partir d'ici, vous pouvez :

- **Trouver** — recherchez, cliquez sur un langage / un `#tag` / un voyant d'attention pour filtrer, triez et regroupez par dossier ou par langage ; enregistrez n'importe quel filtre + tri + regroupement en tant que vue nommée. ⌘/Ctrl-K ouvre un lanceur.
- **Agir par lots** — sélectionnez des dépôts pour fetch / pull (`--ff-only`) / push, ou exécutez une commande shell en parallèle sur l'ensemble (avec une prévisualisation dry-run et une sortie par dépôt). L'échec d'un dépôt n'arrête jamais les autres.
- **Creuser un dépôt** — le panneau de détail donne un bilan de santé complet, changer / créer / abandonner des branches, **committer sur place** avec un diff en direct, PR & CI GitHub à la demande, commits récents, stashes, une heatmap de 12 semaines et un nettoyage en un clic des branches déjà fusionnées — proposé uniquement lorsque vous êtes sur `main`/`master`, la seule position où « déjà fusionnée » signifie fusionnée dans le tronc. Abandonner les modifications restaure les fichiers suivis et supprime les non suivis, mais laisse intacts le contenu des sous-modules et les dépôts git imbriqués non suivis ; s'il reste quelque chose, il vous le dit au lieu d'annoncer une réussite.
- **Rester à jour** — la voie de rafraîchissement par défaut est un rescan toutes les 30 minutes, plus le rescan manuel de la barre. Le scan automatique par surveillance de fichiers est **désactivé par défaut** et s'active à la demande dans le panneau de réglages : il est purement local et ne touche jamais au réseau, mais quand plusieurs projets compilent en même temps le tampon de notifications du noyau déborde en permanence, et chaque débordement coûte un rescan — un prix permanent trop élevé pour un outil qui sert à jeter un œil à ce qui a changé. Une fois activé : sous Windows et macOS, une seule surveillance récursive par répertoire de scan couvre tous les dépôts qu'il contient, si bien qu'un dépôt ajouté, supprimé ou renommé apparaît en quelques secondes ; sous Linux les dépôts sont surveillés individuellement et `watchLimit` (200 par défaut, 0 = illimité) plafonne leur nombre, les favoris et les dépôts récemment commités passant en priorité. Si les débordements se répètent, les rescans de rattrapage s'espacent exponentiellement (au plus toutes les 30 minutes) et ne reconstruisent plus les surveillances — cela n'arrive plus que lorsqu'une cible surveillée a réellement disparu. Un rescan toutes les 30 minutes rattrape ce que la surveillance manque, la barre affiche « dernier scan », et le panneau de réglages montre la couverture en direct (« M sur N surveillés »). Renommer ou déplacer un dépôt conserve ses tags, son étoile, son état d'archive et ses notes — repo-radar suit l'identité, pas seulement le chemin. L'appariement a lieu au tour de scan **juste après** le déplacement, ce qui laisse deux failles : un déplacement lent entre volumes qui chevauche deux tours de scan, avec entre-temps l'ajout/la suppression d'un autre dépôt ou le rescan périodique ; et un déplacement dont la destination n'est pas scannée à ce tour-là — sortir un dépôt de vos répertoires de scan puis n'ajouter son nouvel emplacement comme répertoire de scan que plus tard est la façon habituelle d'y tomber. Les deux retombent sur l'identité par chemin : le dépôt revient sous forme de nouvelle carte, et ses tags/étoile/archive/notes restent sous l'id qu'il ne porte plus. Le fetch programmé en arrière-plan est optionnel. Un onglet **Stats** (heatmap des commits sur un an, les plus/moins actifs) et un onglet **Worklog** qui copie une plage de dates sous forme de rapport hebdomadaire Markdown.
- **Démarrer et déplacer des dépôts** — **+ New** suggère le prochain projet numéroté, exécute `git init`, écrit un README et l'adopte dans le tableau ; l'export / import de manifeste transporte votre configuration d'une machine à l'autre.

L'interface est antd 6 dans un thème sombre façon cockpit d'instruments, localisée en 18 langues (alignée automatiquement sur votre navigateur à la première visite, RTL pour l'arabe).

## Tourne discrètement en arrière-plan

Fermer la fenêtre renvoie repo-radar dans la barre système, si bien que le rescan périodique, la surveillance des fichiers (si vous l'avez activée), les fetch programmés et les alertes GitHub continuent de tourner — cliquez sur l'icône de la barre système pour ramener le tableau, ou quittez réellement depuis le menu de la barre système. (Sous Linux, où les barres système du bureau ne sont pas fiables, fermer quitte à la place ; utilisez Lancer à la connexion pour le garder résident.)

À la fermeture, repo-radar attend jusqu'à 10 secondes la fin du travail git déjà en cours — un pull par lot, un stash abandonné, un fetch programmé — pour que rien ne soit coupé en pleine écriture en laissant un `.git/index.lock` périmé. Si ce délai ne suffit pas, il quitte quand même et le consigne dans le journal : c'est le seul endroit qui explique un `index.lock` découvert plus tard.

Activez **Lancer à la connexion** dans ⚙ Paramètres et il démarre sans interface avec votre session — aucune fenêtre tant que vous ne la demandez pas. Les notifications bureau optionnelles ne se déclenchent que lorsque quelque chose de *nouveau* atteint votre file, même fenêtre fermée. Les mises à jour sont manuelles par choix (pas d'auto-update) : exécutez le nouvel installeur par-dessus l'ancien. Les logs atterrissent dans `<répertoire de configuration>/logs/repo-radar.log`.

## Configuration

Tout ce que l'interface touche est enregistré dans `~/.repo-radar/config.json` — vous avez rarement besoin de l'ouvrir. Les champs qui comptent :

| Champ | Rôle |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | où scanner (trouve `.git` jusqu'à 6 niveaux de profondeur, sans suivre les liens symboliques), quoi ignorer, et les dépôts ajoutés hors des racines — une entrée `manualRepos` renommée ou déplacée n'est pas suivie par identité comme l'est un dépôt scanné ; la carte reste en erreur jusqu'à ce que vous mettiez son chemin à jour ici, et si le déplacement date de plus d'un tour de scan, cette mise à jour ramène la carte mais pas ses tags/étoile/archive/notes |
| `health` | `{ staleDays, disabledRules }` — ajustez le seuil « stale » ou désactivez des vérifications individuelles |
| `open` | modèles de commande pour les boutons éditeur / terminal / dossier (`{path}` = le chemin du dépôt) |
| `autoWatch` / `autoScanMinutes` / `watchLimit` / `autoFetchMinutes` / `notifications` | comportement en arrière-plan — seul `autoScanMinutes` (30) est activé par défaut ; les trois autres, `autoWatch` compris, sont désactivés. `watchLimit` (200, 0 = illimité) ne s'applique **que sous Linux**, où les dépôts sont surveillés individuellement ; Windows et macOS utilisent une surveillance récursive par répertoire de scan et couvrent toujours tous les dépôts |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | organisation par dépôt |

Deux autres fichiers vivent à côté de `config.json`, tous deux supprimables sans risque — repo-radar les reconstruit, à des coûts différents. `repo-cache.json` mémorise les champs git « lourds » de chaque dépôt (stashes, tags, remotes, branches fusionnées…) indexés sur une empreinte de `.git`, si bien qu'un dépôt inchangé évite ces appels git au rescan suivant ; le supprimer rend simplement le prochain rescan plus lent, une fois. `repo-identity.json` est le registre d'identité qui permet à un dépôt renommé ou déplacé de garder ses tags, son étoile, son état d'archive et ses notes au lieu d'être traité comme un dépôt tout neuf. Ici la perte est immédiate, pas différée : tout dépôt déjà renommé ou déplacé **avant** la perte du fichier reçoit un id tout neuf au scan suivant, et ses tags/étoile/archive/notes restent échoués sous l'id qu'il ne porte plus. Les dépôts jamais renommés ne sont pas touchés, et à partir du moment où le registre est reconstruit, les renommages sont de nouveau protégés.

`REPO_RADAR_CONFIG` et `REPO_RADAR_PORT` (17420 par défaut) remplacent le chemin de configuration et le port — définissez les **deux** pour exécuter une seconde instance totalement indépendante. Le serveur n'écoute que sur `127.0.0.1` et valide l'en-tête Origin à chaque requête API et WebSocket.

Le port par défaut se situe volontairement au-dessus de la plage de ports dynamiques du système : Windows utilise 49152–65535 par défaut, mais 1024–15000 dès que Hyper-V/WSL2 est installé, et le système réserve des blocs entiers dans la plage active — un port qui s'y trouve échoue au bind avec `EACCES`, et ces blocs se déplacent d'un redémarrage à l'autre.

Si le port **par défaut** reste impossible à lier, repo-radar bascule sur le candidat suivant (`+1000`, `+2000`, `+3000`, puis un port attribué par le système) au lieu de refuser de démarrer, retient le port retenu pour les lancements suivants et l'affiche à côté de la version dans ⚙ Réglages. Ce rappel compte, car le port fait partie de l'origine de la page et le tableau conserve vues enregistrées, journal d'activité, thème et langue dans un stockage navigateur lié à l'origine : laisser le port osciller ferait disparaître puis réapparaître ces données. Supprimez `<dossier de configuration>/port-state.json` pour revenir au port par défaut.

Un port que vous fixez via `REPO_RADAR_PORT` n'est jamais remplacé — c'est une promesse faite à vos favoris, à vos upstreams de reverse proxy et à vos scripts ; s'il est impossible à lier, l'échec est bruyant. Idem avec `npm run dev`, où la cible du proxy vite est figée au chargement de la configuration.

## Développement

```bash
npm run dev     # vite + la fenêtre de l'app avec hot reload
npm test        # suites de tests server + web + desktop et typechecks
npm run dist    # build des installeurs dans dist-electron/
```

Stack : shell Electron + Node + Hono (tout Git via `spawn`, aucune dépendance native) + Vite / React 19 / antd 6, avec chokidar + WebSocket pour les mises à jour en direct. Le serveur Hono tourne dans le processus principal d'Electron et la fenêtre le charge via `127.0.0.1`, donc l'UI est du HTTP + WebSocket ordinaire — exactement ce que ce serait dans un navigateur.

## À propos du 365 Open Source Plan

Projet **#027** du [365 Open Source Plan](https://github.com/rockbenben/365opensource) — une personne + l'IA, plus de 300 projets open source en un an. [Proposez votre idée →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)
<p align="center">
  <img src="../../web/public/og-image.png" width="820" alt="repo·radar — a cross-repo action queue answering what needs you now" />
</p>

# repo-radar

> Plan Open Source 365 #027 · Un tableau de bord local pour vos dépôts Git — une file d'action inter-dépôts qui répond à ce qui requiert votre attention maintenant.

[English](../../README.md) · [简体中文](README.zh-Hans.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

Un tableau de bord local pour vos dépôts Git qui scanne tous les dépôts présents sur votre machine et place en premier un écran unique : une **file d'action** inter-dépôts répondant à *ce qui requiert votre attention maintenant* — cliquez sur un élément pour agir directement dessus. L'interface est construite sur antd 6, avec un thème profond façon cockpit d'instruments.

## Démarrage rapide

```bash
npm install
npm run build   # build the frontend
npm start       # http://localhost:7420
```

Au premier lancement, une configuration par défaut est créée dans `~/.repo-radar/config.json`. Modifiez `roots` pour ajouter les répertoires que vous souhaitez scanner (par exemple `D:\Projects` — échappez les antislashs en `D:\\Projects` dans le JSON), puis cliquez sur **Rescan** dans le panneau.

## Needs you (l'écran d'entrée)

La file **Needs you**, en haut du tableau, est une file d'action inter-dépôts : classée par urgence, un élément par dépôt — la chose la plus urgente, et non un énième tableau de bord vanity qui compte les commits.

- **Waiting on you** : PR ouvertes par d'autres, issues ouvertes par d'autres, CI rouge sur la branche par défaut (agrégées en arrière-plan via un `gh` local déjà authentifié, rafraîchies toutes les 12 minutes, ou ↻ manuellement ; vos propres PR/issues ouvertes comptent comme WIP et sont exclues) — cliquez sur un élément pour être renvoyé directement vers la page GitHub correspondante
- **At risk of being lost** : conflits / retard / non commité / non poussé — plus ça traîne, plus le classement remonte ; le travail non poussé bénéficie d'un push en un clic, tout le reste ouvre le panneau de détail
- **Overdue for release** : dépôts ayant l'habitude de taguer et qui ont accumulé ≥3 commits depuis le dernier tag sans release — un rappel pour publier (les dépôts qui ne taguent jamais sont laissés tranquilles ; le dernier tag est choisi par date de création sur l'ensemble du dépôt, indépendamment de la branche courante)
- **Forgotten stash** : un stash resté intouché pendant ≥7 jours — cliquez pour accéder directement à la boîte de réception des stash
- **Dismiss** : appuyez sur ✓ pour effacer un élément jusqu'à ce que quelque chose de nouveau se produise — les éléments basés sur un compte ont besoin que le compte augmente, les éléments basés sur un changement ont besoin d'un nouveau commit ; un dismiss de stash est une mise en veille qui refait surface après 30 jours, afin qu'un stash vraiment oublié ne soit jamais réduit au silence pour de bon
- Dépliez au-delà de 10 éléments pour tout voir ; affiche « tout est clair » quand il ne reste rien. Se replie en une fine bannière en haut

## Board

- **Cartes** : une carte par dépôt (jusqu'à 4 par ligne, hauteur égale). Couleur du bord gauche = santé (vert = calme / ambre = attention / rouge = alerte). Affiche le vrai nom · description · langage · branche (signalée si ce n'est pas main) · détail de l'arbre de travail (`+staged ~modified`) · avance/retard · tags de santé · dernier commit · lien vers le remote · tags. Le pied de carte propose toujours **éditeur / terminal / dossier** en un clic
- **Ligne des favoris** : une ligne dédiée « ★ favorites » en haut du tableau — cliquez pour ouvrir dans votre éditeur
- **Bloc d'indicateurs** : jauges FLEET / CRIT / WARN / CLEAN dans la barre supérieure ; les compteurs d'alerte s'allument quand > 0
- **Cliquer pour filtrer** : cliquez sur le langage ou le `#tag` d'une carte pour le faire tomber directement dans la barre de recherche
- **Tri** : dernier ouvert / le plus récemment actif (par date de commit) / par nom — les favoris remontent toujours en tête
- **Voyants d'attention** : puces dans la barre supérieure résumant les types de problèmes (pas de remote / HEAD détachée / non poussé / non commité / en retard / stash) ; cliquez pour filtrer. « Unpushed » et « behind » disposent chacun d'un « push/pull all » en un clic
- **Regroupement** : par dossier / par langage / sans regroupement (à plat)
- **Palette de commandes ⌘/Ctrl-K** : un lanceur — tapez un nom, appuyez sur entrée pour ouvrir dans votre éditeur (boutons en ligne pour terminal / dossier / copier le chemin / ouvrir le remote)
- **Filtre par tags** : sélection multiple de tags dans la barre supérieure (ET — doit porter chaque tag sélectionné) ; cliquez sur le `#tag` d'une carte pour l'ajouter. Filtre + tri + regroupement s'enregistrent ensemble sous forme de « vue » nommée
- **Aperçu en ligne** : le « ⋯ » d'une carte affiche les commits récents sans ouvrir le panneau de détail
- **Scan automatique (désactivé par défaut)** : un bascule « manual ⟳ / auto ⟳ » dans la barre supérieure. Activé, un observateur de fichiers rafraîchit automatiquement les cartes concernées (délai de récupération de 60 secondes ; les changements survenus pendant ce délai sont fusionnés, jamais perdus). Désactivé, l'état ne se met à jour qu'au Rescan. Le tableau est de toute façon peuplé par un scan au premier lancement
- **Fetch programmé (désactivé par défaut)** : « fetch: off / every 5–60 min » dans la barre supérieure — récupère périodiquement chaque remote en arrière-plan pour garder l'avance/retard à jour
- **18 langues** : changez la langue de l'interface depuis ⚙ Réglages (chinois simplifié/traditionnel, anglais, japonais, coréen, espagnol, français, allemand, portugais, russe, italien, arabe, hindi, bengali, thaï, turc, vietnamien, indonésien). Lors de la première visite sans préférence enregistrée, l'interface s'aligne automatiquement sur la langue de votre navigateur (repli sur l'anglais si aucune correspondance) ; l'arabe bascule automatiquement en RTL. Les durées relatives sont localisées nativement via `Intl`. Les noms de dépôts, descriptions et messages de commit ne sont jamais traduits

## Actions

- Le pied de carte affiche toujours les boutons éditeur / terminal / dossier / copier-le-chemin ; ouvrir l'un d'eux enregistre un horodatage « dernier ouvert » utilisé pour le tri
- Fetch / pull (`--ff-only`) / push s'exécutent par lots : sélectionnez plusieurs cartes → action groupée depuis la barre supérieure, ou un clic sur tout un voyant d'attention « unpushed » / « behind ». La progression s'affiche en direct ; l'échec d'un dépôt n'arrête pas les autres
- **Exécuter une commande sur plusieurs dépôts** : sélectionnez des cartes, tapez une commande dans la barre d'outils (par exemple `npm install`), elle s'exécute en parallèle dans le répertoire de chaque dépôt sélectionné. « Dry run » prévisualise d'abord quels dépôts seraient concernés ; « view output » affiche ensuite le résultat par dépôt
- **Boîte de réception des stash** : dès qu'un stash traîne quelque part, un lien « stash inbox (N) » apparaît dans la barre supérieure — liste chaque changement stashé à travers tous les dépôts, avec diff par élément, `apply` / `pop` / `drop`
- Sélectionner plusieurs cartes permet aussi d'appliquer des tags en masse
- **Export / import de manifeste** : exportez le manifeste complet des dépôts (chemin + remotes + groupe + tags) depuis **+ new** pour la sauvegarde ou le changement de machine ; l'import réadopte les dépôts déjà présents localement et liste ceux qui ne le sont pas pour un clonage
- La commande d'ouverture est configurable par cible sous `open` dans config.json ; `{path}` est remplacé par le chemin du dépôt
- **+ New** : suggère le prochain numéro de séquence (par exemple `028-`) et le répertoire parent de vos projets numérotés existants, puis crée le dossier, exécute `git init`, écrit un README, et le rescanne dans le tableau

## Contrôles de santé et statistiques

- Les règles (conflit / pas de remote / HEAD détachée / non commité / non poussé / non suivi / en retard / stash / obsolète) peuvent être désactivées individuellement via `health.disabledRules` ; `staleDays` définit le seuil « obsolète »
- **Branches fusionnables** : les cartes signalent combien de branches locales sont déjà fusionnées dans HEAD (hors branche courante et main/master) ; le panneau de détail propose un nettoyage `git branch -d` en un clic (ne supprime jamais que des branches déjà fusionnées — sans risque)
- **GitHub (optionnel, via un `gh` local déjà authentifié)** : la file « needs you » agrège en arrière-plan les PR / issues ouvertes / l'état de la CI sur la branche par défaut pour chaque remote `github.com` (interrogation à débit limité, persistée sur disque, instantanée au redémarrage). Le panneau de détail peut aussi interroger à la demande le détail d'une PR ouverte et le dernier run de CI ; les descriptions de dépôt sont complétées depuis GitHub lorsque disponibles
- Onglet **Stats** : une heatmap des commits inter-dépôts sur un an (branches locales uniquement), les plus récemment actifs, et les 10 dépôts inactifs depuis le plus longtemps
- Onglet **Worklog** : choisissez une plage de dates pour voir une chronologie de commits inter-dépôts (filtrable par auteur — par défaut « moi seulement », en détectant automatiquement votre identité git), avec copie en un clic sous forme de rapport hebdomadaire Markdown
- Cliquez sur une carte pour ouvrir le panneau de détail : détail complet de la santé, branches fusionnables, **changer / créer / abandonner des branches locales**, **committer sur place** (tapez un message, il commit) avec un diff en direct des changements en attente, PR/CI GitHub, une mini heatmap de 12 semaines, commits récents, stashes et remotes

## Organiser les dépôts

- Marquez d'une étoile ★ une carte pour la mettre en favori (elle remonte en tête) ; ajoutez/retirez des tags dans le panneau de détail (autocomplétion à partir des tags déjà utilisés) et changez son groupe (« auto » restaure le regroupement dérivé du dossier)
- **Notes / to-dos** : notez « ce qui vient ensuite » dans le panneau de détail — cela s'affiche sur la carte
- **Exclure** : masquez les dépôts que vous ne voulez pas voir ; les dépôts exclus sont par défaut masqués du tableau, des alertes et de la palette de commandes. « Excluded (N) » dans la barre supérieure permet de les visualiser/gérer séparément (annuler l'exclusion depuis le panneau de détail)
- Les changements s'appliquent instantanément et sont écrits dans config.json sans déclencher de rescan Git

## Développement

```bash
npm run dev     # runs server(7420) + vite(5173) together, frontend proxies /api
npm test        # full server + web test suite + both typechecks
```

Stack technique : Node + Hono (tous les accès Git via `spawn`, aucune dépendance native), Vite + React 19 + antd 6 (profondément personnalisé via des variables CSS), chokidar + WebSocket pour les mises à jour en direct.

## Configuration (config.json)

| Champ | Description |
| --- | --- |
| `roots` | Répertoires racines à scanner ; découvre récursivement les répertoires contenant `.git` (profondeur ≤ 6) |
| `excludes` | Noms de répertoires à ignorer (inclut node_modules par défaut) |
| `manualRepos` | Chemins de dépôts ajoutés manuellement, en dehors des racines configurées |
| `tags` / `favorites` / `groupOverrides` | Surcharges de tag / favori / groupe par identifiant de dépôt |
| `notes` / `archived` | Notes / indicateur d'archivage par identifiant de dépôt |
| `health` | `{ staleDays, disabledRules }` |
| `open` | Modèles de commande pour les cibles d'ouverture en un clic (éditeur / terminal / explorateur) |

La variable d'environnement `REPO_RADAR_CONFIG` remplace le chemin du fichier de configuration. Le serveur n'écoute que sur `127.0.0.1` et valide l'en-tête Origin à la fois sur l'API et sur le WebSocket.

## À propos du 365 Open Source Plan

Ce projet est le **#027** du [365 Open Source Plan](https://github.com/rockbenben/365opensource).

Une personne + l'IA, plus de 300 projets open source en un an. [Proposez votre idée →](https://365.aishort.top/)

## Licence

[MIT](../../LICENSE)

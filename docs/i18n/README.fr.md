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
- **Creuser un dépôt** — le panneau de détail donne un bilan de santé complet, changer / créer / abandonner des branches, **committer sur place** avec un diff en direct, PR & CI GitHub à la demande, commits récents, stashes, une heatmap de 12 semaines et un nettoyage sûr en un clic des branches déjà fusionnées.
- **Rester à jour** — scan automatique optionnel par surveillance de fichiers et fetch programmé en arrière-plan, tous deux désactivés par défaut. Un onglet **Stats** (heatmap des commits sur un an, les plus/moins actifs) et un onglet **Worklog** qui copie une plage de dates sous forme de rapport hebdomadaire Markdown.
- **Démarrer et déplacer des dépôts** — **+ New** suggère le prochain projet numéroté, exécute `git init`, écrit un README et l'adopte dans le tableau ; l'export / import de manifeste transporte votre configuration d'une machine à l'autre.

L'interface est antd 6 dans un thème sombre façon cockpit d'instruments, localisée en 18 langues (alignée automatiquement sur votre navigateur à la première visite, RTL pour l'arabe).

## Tourne discrètement en arrière-plan

Fermer la fenêtre renvoie repo-radar dans la barre système, si bien que la surveillance des fichiers, les fetch programmés et les alertes GitHub continuent de tourner — cliquez sur l'icône de la barre système pour ramener le tableau, ou quittez réellement depuis le menu de la barre système. (Sous Linux, où les barres système du bureau ne sont pas fiables, fermer quitte à la place ; utilisez Lancer à la connexion pour le garder résident.)

Activez **Lancer à la connexion** dans ⚙ Paramètres et il démarre sans interface avec votre session — aucune fenêtre tant que vous ne la demandez pas. Les notifications bureau optionnelles ne se déclenchent que lorsque quelque chose de *nouveau* atteint votre file, même fenêtre fermée. Les mises à jour sont manuelles par choix (pas d'auto-update) : exécutez le nouvel installeur par-dessus l'ancien. Les logs atterrissent dans `<répertoire de configuration>/logs/repo-radar.log`.

## Configuration

Tout ce que l'interface touche est enregistré dans `~/.repo-radar/config.json` — vous avez rarement besoin de l'ouvrir. Les champs qui comptent :

| Champ | Rôle |
| --- | --- |
| `roots` / `excludes` / `manualRepos` | où scanner (trouve `.git` jusqu'à 6 niveaux de profondeur), quoi ignorer, et les dépôts ajoutés hors des racines |
| `health` | `{ staleDays, disabledRules }` — ajustez le seuil « stale » ou désactivez des vérifications individuelles |
| `open` | modèles de commande pour les boutons éditeur / terminal / dossier (`{path}` = le chemin du dépôt) |
| `autoWatch` / `autoFetchMinutes` / `notifications` | comportement en arrière-plan — tout désactivé par défaut |
| `tags` / `favorites` / `groupOverrides` / `notes` / `archived` | organisation par dépôt |

`REPO_RADAR_CONFIG` et `REPO_RADAR_PORT` (7420 par défaut) remplacent le chemin de configuration et le port — définissez les **deux** pour exécuter une seconde instance totalement indépendante. Le serveur n'écoute que sur `127.0.0.1` et valide l'en-tête Origin à chaque requête API et WebSocket.

## Développement

```bash
npm run dev     # vite + la fenêtre de l'app avec hot reload
npm test        # suites de tests server + web + desktop et typechecks
npm run dist    # build des installeurs dans dist-electron/
```

Stack : shell Electron + Node + Hono (tout Git via `spawn`, aucune dépendance native) + Vite / React 19 / antd 6, avec chokidar + WebSocket pour les mises à jour en direct. Le serveur Hono tourne dans le processus principal d'Electron et la fenêtre le charge via `127.0.0.1`, donc l'UI est du HTTP + WebSocket ordinaire — exactement ce que ce serait dans un navigateur.

## À propos du 365 Open Source Plan

Projet **#027** du [365 Open Source Plan](https://github.com/rockbenben/365opensource) — une personne + l'IA, plus de 300 projets open source en un an. [Proposez votre idée →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)
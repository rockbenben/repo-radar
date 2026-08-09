<p align="center">
  <img src="../../docs/images/board-en.jpg" width="900" alt="Tableau repo·radar : voyants d'alerte en haut, file « à traiter » en dessous, puis une carte par dépôt avec branche, état de l'arbre de travail et éditeur / terminal / dossier en un clic" />
</p>

# repo-radar

> Plan Open Source 365 #027 · Un tableau de bord local qui surveille tous vos dépôts Git et vous montre ceux qui requièrent votre attention.

[English](../../README.md) · [简体中文](../../README.zh.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Italiano](README.it.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [বাংলা](README.bn.md) · [ไทย](README.th.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md)

[⬇ Télécharger pour Windows · macOS · Linux](https://github.com/rockbenben/repo-radar/releases/latest)

Vous avez plus de dépôts Git que vous ne pouvez en suivre de tête. repo-radar les surveille tous et vous montre les quelques-uns qui vous réclament maintenant — les autres peuvent sortir de votre esprit.

Il remonte ce que vous oublieriez de vérifier :

- **Le travail laissé en plan** — modifications non commitées, non poussées ou mises en stash, signalées avant que vous ne les perdiez.
- **GitHub qui vous attend** — PR ouvertes, issues et CI au rouge, lues via votre `gh` déjà connecté.
- **Les projets qui s'endorment** — trop longtemps sans y toucher, ou en retard de publication.
- **Les dépôts perdus de vue** — tous sur un écran, cherchables, ouverts en un clic.

Ce qui demande une action remonte en file d'attente : une entrée par dépôt, par urgence. Écartez d'un ✓ et cela reste écarté jusqu'à ce que quelque chose change vraiment.

## Prise en charge

| Aspect | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Installation | installeur `.exe` | `.dmg` | `.AppImage` |
| Fermer la fenêtre | passe en zone de notification | idem | quitte — utilisez **Lancer à l'ouverture de session** pour le garder |
| Surveillance des changements | tous les dépôts sous un répertoire scanné | idem | les 200 premiers dépôts (plafond ajustable ou levable dans les réglages) |

Tout tourne sur votre machine et utilise le `git` que vous avez déjà — pas de compte, pas de télémétrie, rien n'est envoyé. La colonne GitHub (PR, issues, CI) est facultative et passe par la [CLI `gh`](https://cli.github.com/) où vous êtes déjà connecté ; sans elle, le reste fonctionne.

## Installation

Prenez le fichier de votre plateforme dans les [Releases](https://github.com/rockbenben/repo-radar/releases) — pas besoin de Node.js. L'application n'est pas signée, chaque système avertit au premier lancement :

- **Windows** — sur l'invite SmartScreen, *Informations complémentaires → Exécuter quand même*.
- **macOS** — clic droit → Ouvrir la première fois. Si macOS la dit endommagée : `xattr -cr /Applications/repo-radar.app`.
- **Linux** — d'abord `chmod +x repo-radar-*.AppImage`.

Plutôt que de faire confiance à un binaire ? [Compilez-le vous-même](../development.md) — c'est `npm install && npm start`.

Au premier lancement, cliquez sur **Ajouter des répertoires à scanner** et pointez vers le dossier qui *contient* vos dépôts — un `~/Projets`, pas chaque dépôt un par un. Il descend jusqu'à 6 niveaux pour trouver tout ce qui a un `.git`, et le tableau se remplit. Pas de JSON, pas de redémarrage.

## Le tableau

Une carte par dépôt — couleur de santé, branche, détail de l'arbre de travail, ahead/behind, dernier commit, tags — avec **éditeur / terminal / dossier** en un clic.

- **Le retrouver** — rechercher, ou filtrer par langage, `#tag` ou voyant. ⌘/Ctrl-K ouvre un lanceur.
- **Enregistrer une vue** — n'importe quel filtre + tri + regroupement, nommé et réutilisable.
- **Agir en lot** — fetch / pull / push sur les dépôts sélectionnés, ou une même commande shell dans tous. Un dépôt en échec n'arrête jamais les autres.
- **Travailler sur place** — le panneau de détail commite avec un diff en direct, change de branche, annule des modifications, nettoie les branches fusionnées et récupère PR & CI GitHub à la demande.
- **Créer et déplacer** — **+ Nouveau** crée un dépôt et le place directement sur le tableau ; l'export / import de manifeste emporte votre configuration d'une machine à l'autre.

Les voyants du haut sont les types d'alerte — sans remote, non poussé, non commité, en retard, stash restant. Éteignez ceux qui ne vous concernent pas dans ⚙ Paramètres.

Deux autres onglets : **Statistiques** (heatmap des commits sur un an, dépôts les plus et les moins actifs) et **Journal de travail** (copier une période en rapport hebdomadaire Markdown).

Un thème sombre façon cockpit d'instruments, localisé en 18 langues, contraste du texte calibré sur WCAG AA en clair comme en sombre.

## Rester à jour

Par défaut : une réanalyse de secours toutes les 30 minutes, plus la réanalyse manuelle de la barre d'outils — local, discret, sans réseau.

L'analyse automatique par surveillance de fichiers est **désactivée par défaut**, à activer dans les réglages. Elle reste locale, mais quand plusieurs projets compilent en même temps le tampon de notifications du noyau déborde en continu, et chaque débordement coûte une réanalyse — un prix permanent trop élevé pour un outil qui sert à jeter un œil à ce qui a changé. Activée, les dépôts ajoutés, supprimés ou renommés apparaissent en quelques secondes.

Renommez ou déplacez un dépôt : ses tags, favori, état d'archive et notes suivent. repo-radar reconnaît un dépôt à ce qu'il contient, pas à l'endroit où il se trouve — un dossier déplacé reste donc le même projet, pas un nouveau.

Le fetch d'arrière-plan planifié est facultatif et la seule fonction qui sorte sur le réseau d'elle-même.

## Tourne discrètement en arrière-plan

Fermer la fenêtre range repo-radar dans la zone de notification : réanalyses, surveillance et alertes GitHub continuent. Cliquez sur l'icône pour rappeler le tableau, ou quittez depuis son menu.

À la fermeture, il attend jusqu'à 10 secondes le travail git en cours — un pull groupé, un stash supprimé — pour que rien ne soit coupé en pleine écriture et ne laisse un `.git/index.lock` périmé. Si cela ne suffit pas, il quitte quand même et le dit dans le journal.

Activez **Lancer à l'ouverture de session** et il démarre sans fenêtre avec votre session. Les notifications de bureau sont facultatives et ne se déclenchent que quand quelque chose de *nouveau* entre dans votre file.

## Configuration

Répertoires à scanner, dossiers exclus et commandes d'ouverture se modifient dans ⚙ Paramètres → Analyse et commandes d'ouverture. Le reste vit dans `~/.repo-radar/config.json`, que vous ouvrirez rarement — la liste complète des champs, les deux fichiers de cache à côté et les variables d'environnement pour une seconde instance sont dans la [référence de configuration](../configuration.md).

## Limites connues

- **Les mises à jour sont manuelles par choix.** Pas d'auto-update : relancez le nouvel installeur par-dessus l'ancien.
- **Un dépôt déplacé est reconnu à l'analyse suivante — s'il rate cette analyse, ses tags ne suivent pas.** Un déplacement lent entre volumes, ou une destination pas encore ajoutée comme répertoire à scanner, revient en carte neuve et laisse les tags sur l'ancienne.
- **Linux n'a pas de zone de notification fiable**, donc fermer la fenêtre quitte l'application.
- **Les dépôts ajoutés un par un, hors répertoire scanné, ne sont pas reconnus ainsi** — si vous en déplacez un, vous indiquez vous-même le nouveau chemin.
- **Annuler les modifications ne touche ni aux sous-modules ni aux dépôts git imbriqués**, et le dit au lieu d'annoncer un nettoyage complet.

## À propos du 365 Open Source Plan

Projet **#027** du [365 Open Source Plan](https://github.com/rockbenben/365opensource) — une personne + l'IA, plus de 300 projets open source en un an.

[Proposez votre idée →](https://365.aishort.top/) · [Discord](https://discord.gg/PZTQfJ4GjX) · [Telegram](https://t.me/aishort_top)

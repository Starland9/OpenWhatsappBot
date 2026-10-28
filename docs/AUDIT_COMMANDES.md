# Audit des commandes d'OpenWhatsappBot

Rapport destiné au propriétaire du bot. Date de l'audit : **2026-10-27**. Branche : `001-audit-fix-commands`.

**Mise à jour du 2026-10-28 (fonctionnalité 002, branche `002-admin-panel`)** : le panel d'administration web a changé le comportement de `.update`, ajouté l'application de l'anti-lien, de l'anti-bot et du mode muet, la désactivation de commandes depuis le panel et la limitation des messages d'erreur envoyés au propriétaire. Les lignes concernées sont marquées « (002) » ; la checklist de la section 7 a une nouvelle partie « Panel d'administration ».

Documents liés : [spécification](../specs/001-audit-fix-commands/spec.md), [constats bruts avec fichier:ligne](../specs/001-audit-fix-commands/audit-findings.md), [rapport des dépendances](../specs/001-audit-fix-commands/deps-report.md), [spécification du panel d'administration](../specs/002-admin-panel/spec.md), [guide de validation du panel](../specs/002-admin-panel/quickstart.md).

## Sommaire

1. [Résumé](#1-résumé)
2. [Tableau par commande](#2-tableau-par-commande)
3. [Services externes morts ou remplacés](#3-services-externes-morts-ou-remplacés)
4. [Changements de syntaxe à connaître](#4-changements-de-syntaxe-à-connaître)
5. [Dépendances](#5-dépendances)
6. [Points à surveiller et décisions pour le propriétaire](#6-points-à-surveiller-et-décisions-pour-le-propriétaire)
7. [Checklist de vérification manuelle](#7-checklist-de-vérification-manuelle)
8. [Comment vérifier](#8-comment-vérifier)

---

## 1. Résumé

### Périmètre

Les 81 fichiers de `plugins/` ont été audités (la fonctionnalité 002 en a ajouté deux, `knownchats` et `groupguard`, sans commande : 83 fichiers, 81 modules chargés au démarrage). Les 81 d'origine se répartissent ainsi :

- **78 commandes** (une ligne chacune dans le tableau de la section 2) ;
- 1 module sans commande qui réagit aux messages : `trackmessages` ;
- 2 fichiers qui n'enregistrent aucune commande : `buttons` (aide partagée pour les boutons) et `pollplus` (fusionné dans `poll`).

Chaque commande a été évaluée sur les mêmes critères : réponse sans argument, réponse sur appel valide, réponse quand le service externe échoue, application des restrictions d'accès, absence de détail technique dans les messages, traduction. Les services externes ont été testés en réel le 2026-10-27 quand c'était possible (sans clé, ou avec la clé déjà configurée pour Gemini).

### Statuts des 78 commandes

| Statut | Nombre | Sens |
| --- | --- | --- |
| OK | 1 | Fonctionnait déjà ; seule la traduction a été ajoutée. |
| Corrigée | 68 | Des défauts ont été trouvés et corrigés. |
| Désactivée | 1 | Le service externe est mort et n'a pas d'équivalent gratuit ; la commande reste au menu et répond « service indisponible ». |
| À surveiller | 8 | Corrigée, mais l'appel réel n'a pas pu être vérifié (clé absente, paiement requis) ou dépend d'un service instable. Voir la colonne « Défauts » et la section 6. |

Modules sans commande : `trackmessages` Corrigée, `buttons` Corrigée, `pollplus` Désactivée, `knownchats` et `groupguard` Nouveaux (002) (voir la fin de la section 2).

### Corrections transverses majeures

La plupart des défauts des commandes venaient de quelques manques dans le cœur du bot. Ils ont été corrigés une fois pour toutes.

- **Correspondance exacte des commandes.** Avant, les alias étaient lus comme une expression régulière : `.kiss`, `.class` ou `.boss` déclenchaient `statussave`, `.export` déclenchait `level`, `.faq` déclenchait `quote`, `.giftcard` déclenchait `image`. Une commande ne répond plus qu'à son nom ou à un alias exact, majuscules comprises. Les doublons d'alias sont signalés au démarrage et l'ordre de chargement est fixe.
- **Permissions réellement appliquées.** `ownerOnly` n'était jamais lu. Le registre applique maintenant les réserves « propriétaire », « groupe », « privé » et le nouveau « admins » avant d'exécuter la commande. Sans propriétaire configuré (`SUDO` vide), les commandes réservées refusent tout le monde.
- **Boutons.** Les clics sur les boutons n'ont jamais fonctionné : WhatsApp renvoie la réponse sous un format (native-flow) que le bot ne lisait pas. Elle est maintenant lue. Si les boutons ne s'affichent pas, répondre à un message en citant un chiffre fonctionne aussi.
- **Un seul pipeline pour le mode normal et le mode panel.** `panel.js` avait une copie ancienne du traitement des messages (pas de boutons, pas de statistiques, pas de sauvegarde des statuts). Les deux modes partagent maintenant `lib/core/pipeline.js`.
- **Identifiants LID.** Avec les nouvelles adresses WhatsApp (LID), le propriétaire échouait aux contrôles de droits et les contrôles d'admin échouaient dans certains groupes. Le bot accepte maintenant les deux formes.
- **Réglages sans effet.** Bienvenue, départ, filtres, AFK, désactivation du bot (`.ban`), statistiques et niveaux, notifications et rappels répondaient « activé » sans rien faire. Les événements sont branchés.
- **Persistance.** AFK, `.ban`, rappels, tâches et notifications étaient gardés en mémoire et perdus au redémarrage. Ils sont enregistrés en base ; les rappels ratés pendant une coupure sont envoyés avec la mention « en retard » (moins de 6 h) ou signalés.
- **Économie atomique.** Plus de double dépense (`daily`, `give`, `dice`). Le dé était une « planche à billets » : tous les modes de mise rapportaient plus qu'ils ne coûtaient (espérance entre 1,25 et 1,84) et une mise perdue plantait après le débit. Le dé a maintenant un avantage pour la maison.
- **Services morts remplacés.** YouTube, Instagram, paroles, Reddit, Giphy, génération d'images, citations et faits utilisaient des services morts ou bloqués. Détail en section 3.
- **Traductions fr/en complètes.** Environ 300 réponses étaient écrites en dur ; tous les messages passent maintenant par le système de traduction, en français et en anglais, y compris les descriptions du menu.
- **Erreurs sans détail technique.** L'utilisateur ne voit plus que des messages génériques ; la trace complète va dans les journaux et en message privé au propriétaire. Les clés d'API ne sont plus écrites dans les journaux. (002) Le message privé avec la trace est limité à **un par commande et par période de 10 minutes** (une commande qui échoue en boucle ne noie plus le propriétaire) ; chaque erreur reste dans les journaux et les statistiques du panel, et une série de 10 erreurs en 10 minutes déclenche une seule alerte « erreurs en série » par heure.
- **(002) Commande désactivée.** Une commande désactivée depuis le panel, partout ou dans un seul groupe, répond « 🚫 Cette commande est désactivée pour le moment. » (propriétaire compris, pour qu'il sache pourquoi rien ne se passe). Le contrôle vient après le refus « propriétaire seulement » (les commandes du propriétaire restent invisibles aux autres) et avant les contrôles de groupe et d'admin. Le réglage survit au redémarrage.
- **Schéma SQLite réparé.** Le démarrage modifiait les tables à chaque fois (`alter: true`), ce qui transformait des clés composées en contraintes par colonne : un membre averti dans un groupe ne pouvait plus l'être dans un autre. La synchronisation est maintenant additive, et les tables abîmées de votre `database.db` sont reconstruites sans perdre de lignes.
- **Dépendances.** 18 paquets inutilisés retirés, 3 paquets abandonnés ou dépréciés remplacés, 3 mises à jour majeures, tout le reste à jour sauf deux exceptions (section 5).
- **Tests automatiques.** `yarn test` charge toutes les commandes et simule leurs appels sans WhatsApp ni réseau (près de 200 tests, une dizaine de secondes à l'époque de l'audit ; avec le panel d'administration, environ 2 350 tests en une vingtaine de secondes).

---

## 2. Tableau par commande

### Lecture du tableau

- **Accès** : *Tous* ; *Admins* (admin du groupe ou propriétaire, dans un groupe) ; *Propriétaire* (numéros de `SUDO`) ; *Groupe* (uniquement dans un groupe) ; *Privé* (uniquement en discussion privée). Un accès est appliqué par le registre, sauf mention « (interne) » : la commande vérifie elle-même une sous-action.
- **Services externes** : « aucun » = tout est local. « Clé » indique la variable à renseigner dans `config.env`. L'état est celui du 2026-10-27.
- **Statut** : OK, Corrigée, Désactivée, À surveiller.

### Administration

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.delfilter` | | Admins | aucun | Corrigée | Suppression sensible à la casse, sur des filtres jamais déclenchés → suppression par motif (sans casse) ou par numéro de `.filter list`, cache vidé. |
| `.filter` | | Admins | aucun | Corrigée | Aucun filtre ne se déclenchait ; textes anglais en dur → déclenchement sur message exact ou mot entier (motif échappé, jamais une regex), délai de 10 s, 50 filtres par groupe, un motif existant est mis à jour. |
| `.goodbye` | | Admins | aucun | Corrigée | Message de départ jamais envoyé, pas d'interrupteur (« off » était enregistré comme texte) → colonne `goodbye`, `on/off/reset/<texte>`, envoi au départ ou à l'exclusion d'un membre. |
| `.statussave` | `ss` | Propriétaire | aucun | Corrigée | `.kiss`, `.class` le déclenchaient ; `AUTO_STATUS_SAVE` écrasait « off », liste vide = tous les contacts sans avertissement, sauvegarde des statuts cassée (LID, champ inexistant) → numéros normalisés, avertissement sur liste vide, le message dit quand la variable force l'activation, plafond de taille. |
| `.welcome` | | Admins | aucun | Corrigée | Bienvenue jamais envoyée → événement branché : un seul message qui mentionne tous les arrivants, le bot est ignoré, variables `@user`, `@group`, `@desc`, texte multi-lignes de 1000 caractères, aperçu, texte par défaut traduit. |

### IA

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.ar` | | Propriétaire | Gemini (clé `GEMINI_API_KEY`), appel réel OK | Corrigée | « Off » ignoré pendant 5 min (cache), numéros avec espaces ; le répondeur envoyait les réactions et messages vides à Gemini et ne tenait pas compte de la consigne de personnalité → cache vidé, consigne système, délai, limite par numéro, ne traite plus groupes, réactions ni messages vides, ne plante jamais. |
| `.gemini` | | Tous | Gemini (clé `GEMINI_API_KEY`), appel réel OK | Corrigée | Réponse « undefined », erreur brute de l'API montrée, aucun délai → modèle `GEMINI_MODEL`, délai de 30 s, message « pas de réponse ou bloqué », image citée, anti-spam de 5 s. |
| `.gpt` | | Tous | OpenAI (clé `OPENAI_API_KEY`), non testé en réel | À surveiller | Description sur une mauvaise clé de traduction, fragment de clé OpenAI pouvant apparaître dans une erreur → délai de 60 s sans nouvelle tentative, modèle `OPENAI_MODEL`, image citée, anti-spam de 5 s. Testé avec un faux client seulement ; `gpt-4o-mini` sera retiré le 2027-01-14. |
| `.imagen` | | Tous | Gemini images (clé `GEMINI_API_KEY`), **forfait payant requis** | À surveiller | Le modèle `imagen-4.0-fast` est arrêté depuis le 2026-08-17 et la réponse était lue avec la mauvaise structure → modèle par défaut `gemini-nano-banana-2.1` (`IMAGE_MODEL`), anti-spam de 20 s, texte de 1500 caractères au plus. Une clé gratuite reçoit « limit 0 » et un message « forfait payant requis » ; le cas de succès n'est testé qu'en simulation. |

### Téléchargements

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.apk` | | Tous | Aptoide (sans clé), répond | Corrigée | Téléchargeait automatiquement le premier résultat (jusqu'à 100 Mo) à chaque recherche → `.apk <nom>` liste 5 résultats, `.apk dl <n>` télécharge (plafond de taille, domaine `aptoide.com` uniquement, avertissement, anti-spam). |
| `.dl` | `socialdl`, `sdl` | Tous | yt-dlp ; backend `BACKEND_URL` facultatif et **hors service** | Corrigée | Le backend du propriétaire ne répond plus (certificat Traefik par défaut et 404), images envoyées comme vidéos, `MAX_UPLOAD` ignoré → yt-dlp d'abord, liste d'hôtes autorisés (TikTok, Instagram, Facebook, X, YouTube, Pinterest, Reddit), type détecté, `MAX_UPLOAD` respecté. TikTok testé en réel. Spotify passe uniquement par le backend. |
| `.insta` | | Tous | yt-dlp | Corrigée | Les deux fournisseurs utilisés n'existaient plus → yt-dlp avec liste d'hôtes Instagram, lien cité lu correctement. Instagram demande souvent une connexion : la commande répond alors « privé ou indisponible ». |
| `.ytdl` | `ytv`, `yta`, `yts` | Tous | yt-dlp (binaire récent obligatoire) | À surveiller | `play-dl` restait bloqué sans fin sur l'erreur 429, `.ytv` envoyait de l'audio comme vidéo, taille contrôlée après téléchargement → yt-dlp, playlists, chaînes et directs refusés, vidéo 15 min au plus, audio 60 min, recherche par `.yts`. Le yt-dlp installé sur votre machine (2024) échoue ; l'image Docker installe la dernière version. |

### Économie

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.balance` | `bal`, `coins`, `wallet` | Groupe | aucun | Corrigée | Lignes fantômes créées en base, carte en anglais, utilisable en privé → lecture sans création, classement des 5 premiers soldes positifs, opérations atomiques partagées. |
| `.daily` | `claim` | Groupe | aucun | Corrigée | Double réclamation possible en parallèle, série remise à 0, gain non plafonné → réclamation atomique (payée une seule fois), série d'au moins 1, gain = min(200, 50 + 10 × série). |
| `.give` | `pay`, `transfer` | Groupe | aucun | Corrigée | Lecture puis écriture sans transaction (double dépense), dons au bot ou à un non-membre, `NaN` selon l'ordre des arguments → transaction avec débit conditionnel, refuse soi-même, le bot, un non-membre et un montant invalide, arguments dans les deux ordres. |

### Divertissement

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.av` | | Tous (réglages : admins, interne) | aucun | Corrigée | Clés de traduction erronées, ligne de groupe créée à chaque lecture ou en privé, fautes de frappe → corrigé ; le message « désactivé » explique comment l'activer. Contenu en français uniquement ; le mode `adult` reste désactivé par défaut. |
| `.fact` | | Tous | uselessfacts v2 (sans clé, anglais) ; français : 18 faits locaux | Corrigée | La clé de démonstration d'api-ninjas est morte → uselessfacts v2, faits locaux en français, traduction. |
| `.joke` | | Tous | JokeAPI, repli official-joke-api (sans clé) | À surveiller | Textes en anglais en dur → traduit. En français, JokeAPI est interrogée en `lang=fr` et laisse passer quelques blagues de mauvais goût malgré le mode sûr : décision du propriétaire (section 6). |
| `.quiz` | `guess` | Tous | aucun | Corrigée | Les réponses prenaient les commandes et messages vides pour des tentatives, `.quiz2` (alias de trivia) était capté, 5 questions → sous-commandes sans casse, parties séparées, 12 questions FR et 12 EN, réponses normalisées, `.guess <n>`, expiration. |
| `.quoteof` | `inspirational` | Tous | ZenQuotes, dummyjson (sans clé), 12 citations locales | Corrigée | Masquée par `.quote` (alias `q`), quotable.io mort → ZenQuotes (réponse de limite filtrée), puis dummyjson, puis liste locale. |

### Jeux

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.dice` | `roll` | Tous (mises : groupes) | aucun | Corrigée | « Planche à billets » (espérance de gain de 1,25 à 1,84 sur tous les modes), plantage après débit d'une mise perdue, double dépense, mises gratuites en privé → dés invalides refusés, mises de 10 à 1000 en groupe, débit atomique, avantage pour la maison (d6 et 2d6 : 83 % de retour, d20 : 75 %, pile ou face : 95 %), tirage cryptographique. |
| `.hangman` | `pendu` | Tous | aucun | Corrigée | Indiquait `.guess <lettre>` (commande du quiz), consommait les réponses d'autres commandes, mots impossibles ("yo-yo") → mots `a-z` de 4 lettres au moins, listes FR et EN, expiration 15 min, `.hangman <lettre>`, réponse au plateau, `stop`, `help`, 6 erreurs. |
| `.rps` | `pfc` | Tous | aucun | Corrigée | Contre le bot, le choix du joueur était remplacé par un tirage au hasard ; clés de traduction fausses ; choix visibles de tous → `.rps <coup>`, duel avec choix en privé par boutons et résultat dans le groupe, expiration 2 min. |
| `.tictactoe` | `ttt`, `xo` | Groupe | aucun | Corrigée | Appelait l'envoi interactif sans repli, écrasait la partie d'un autre joueur, pas d'arrêt → listes avec repli, ids avec nonce, `.ttt <1-9>`, `stop`, refus de remplacer la partie d'un autre. |
| `.trivia` | `quiz2` | Tous | Open Trivia DB (sans clé), répond | Corrigée | Entités HTML affichées (`&quot;`), mauvaise réponse qui révélait la bonne et laissait la partie ouverte, score perdu → décodage correct, un essai par joueur, minuteur de 60 s, score de session, `.trivia score` / `stop`. Appels réseau testés en simulation seulement. |

### Général

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.afk` | | Tous | aucun | Corrigée | État global en mémoire (n'importe qui pouvait mettre le propriétaire en AFK), mention jamais détectée → état par utilisateur enregistré en base, message de retour avec la durée, annonce de l'absence quand on mentionne ou cite la personne (60 s entre deux annonces). |
| `.alive` | | Tous | aucun | Corrigée | Carte d'état en anglais en dur → traduite. |
| `.bmenu` | `buttonmenu`, `menu2` | Tous | aucun (aide boutons) | Corrigée | Les boutons ne réagissaient jamais → ids `menu:cat`, `menu:cmd`, `menu:home`, parcours catégorie → commandes → fiche, catégorie propriétaire cachée. |
| `.feedback` | `fb` | Tous | aucun | Corrigée | Transfert qui échouait sans le dire, présenté comme « anonyme » alors que le numéro était envoyé, aucune limite → transfert corrigé, plus de promesse d'anonymat, 1 message par minute, 1000 caractères, échec signalé. |
| `.help` | | Tous | aucun | Corrigée | Argument non normalisé, motif brut affiché → `.help <commande>` accepte préfixe et majuscules et affiche nom, alias, description, catégorie, accès et usage ; `.help` seul donne le guide. |
| `.menu` | | Tous | aucun | Corrigée | Montrait aux autres les commandes du propriétaire, un seul alias, texte français en dur → traduit, alias affichés, icônes par catégorie, commandes du propriétaire cachées aux autres, moins de 4000 caractères. |
| `.ping` | | Tous | aucun | OK | Rien à corriger ; message traduit, repli quand WhatsApp refuse la modification du message. |

### Groupe

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.demote` | | Admins | aucun | Corrigée | Succès affiché même quand WhatsApp refusait (statut 403), possibilité de se rétrograder soi-même → vérification du résultat de chaque cible, refus du bot, du propriétaire, du créateur et de soi-même, plusieurs mentions. |
| `.idea` | `idee`, `suggest` | Groupe | aucun | Corrigée | Plantait même sans argument (`this._list`), « top » limité aux 50 dernières idées, votes simultanés perdus → fonctions de module, top calculé sur toutes les idées, votes atomiques, ids sans JID, suppression par admin ou propriétaire. |
| `.kick` | | Admins | aucun | Corrigée | Statut non vérifié, aucune protection de la cible, une seule mention → toutes les mentions ou l'auteur cité, bot admin contrôlé, une requête, résultat par personne. |
| `.poll` | `vote`, `poll+`, `pollplus` | Groupe | aucun | Corrigée | `.poll` n'existait pas (seul `poll+`), faux décomptes, fermeture ouverte à tous → un seul sondage natif, question coupée au premier `?`, 2 à 12 options sans doublons, `.poll+` pour plusieurs choix. WhatsApp compte les votes lui-même. |
| `.promote` | | Admins | aucun | Corrigée | Mêmes défauts que `.kick` → mêmes corrections. |
| `.quote` | `q` | Groupe | aucun | Corrigée | Plantait (`this._add`, etc.), l'alias `q` captait `.faq` et `.iq`, bouton « Sauver » impossible → fonctions de module, bouton retiré, légendes enregistrées. |
| `.role` | | Groupe ; `set` : admins (interne) | aucun | Corrigée | Plantait (`this._list`) et les rôles n'étaient jamais appliqués → `muted` : messages supprimés ; `banned` : membre retiré (et à son retour) ; `vip` : exempté de `.warn` ; avertissement si le bot n'est pas admin. |
| `.stats` | | Groupe | aucun | Corrigée | Copie en mémoire sans lien avec le vrai suivi → reconstruite sur les statistiques en base (totaux et 10 premiers avec mentions), remise à zéro par admin ou propriétaire. |
| `.tagall` | | Admins | aucun | Corrigée | Inondait le groupe de ceil(N/50) messages sans pause, en-tête répété → un seul message (en-tête multi-lignes), découpé avec 1,5 s de pause au-delà de 800 membres, bot exclu, échecs partiels signalés. |
| `.warn` | | Admins | aucun | Corrigée | Cible uniquement par réponse, exclusion non vérifiée qui effaçait quand même l'avertissement, compteur non atomique, un seul marqueur remplacé → mention ou réponse, `.warn list`, `.warn reset @user`, incrément atomique, ligne effacée seulement si l'exclusion a réussi, VIP exemptés. |

### Infos

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.news` | `crypto`, `stock` | Tous | NewsAPI (clé `NEWS_API_KEY`), Alpha Vantage (clé `ALPHA_VANTAGE_KEY`), CoinGecko (sans clé) | À surveiller | Clé d'API écrite dans les journaux, texte libre envoyé comme code pays, quota Alpha Vantage mal géré → clé jamais journalisée, code pays à 2 lettres sinon recherche, message de quota, cache CoinGecko et tickers. NewsAPI et Alpha Vantage testés en simulation (pas de clé). |
| `.weather` | `meteo` | Tous | WeatherAPI (clé `WEATHER_API_KEY`) ; repli Open-Meteo sans clé ; les deux répondent | Corrigée | Format d'erreur cassé et clé dans les journaux → langue du bot (`LANG`), clé jamais journalisée, repli sans clé. |

### Médias

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.convert` | `topng`, `tojpg`, `topdf`, `tomp3` | Tous | aucun (ffmpeg, sharp) | Corrigée | Images recompressées, MP3 et OGG mal étiquetés, bannière ffmpeg dans les erreurs, documents téléchargés en entier avant d'être refusés → validation avant le téléchargement, plafond de 50 Mo ou `MAX_UPLOAD`, envoi en document avec le bon type, PDF via sharp, OGG en opus, vidéo sans piste audio signalée. |
| `.image` | `img`, `gif`, `giphy` | Tous | Unsplash (clé `UNSPLASH_API_KEY`), Giphy (clé `GIPHY_API_KEY`), non testés en réel | À surveiller | La clé de démonstration de Giphy est bannie (403), les GIF étaient envoyés comme vidéos → clé obligatoire (sinon « non configuré »), envoi en MP4 animé, limite de débit gérée. |
| `.music` | `song`, `spotify`, `play` | Tous | iTunes Search (sans clé), répond ; Spotify (clés facultatives) | Corrigée | Alias `lyrics` en conflit, fichier temporaire non supprimé, « undefined » dans le titre → alias retiré, aperçu en mémoire annoncé « 30 s », clés Spotify lues dans la configuration (jeton mis en cache). |
| `.save` | | Propriétaire | aucun | Corrigée | Média cité sans clé de message, envoyé au premier numéro `SUDO` et non à l'appelant → envoyé à celui qui lance la commande, statuts image, vidéo, audio et texte. |
| `.sticker` | | Tous | aucun (ffmpeg, node-webpmux) | Corrigée | Fichiers temporaires laissés, durée non limitée (jusqu'à 2,6 Mo), nom du pack et de l'auteur ignorés → refuse un sticker cité, 10 s au plus, jusqu'à 3 encodages pour passer sous 900 Ko, `STICKER_PACKNAME` et `STICKER_AUTHOR` appliqués. |
| `.transcribe` | `speak` | Tous | OpenAI Whisper (clé `OPENAI_API_KEY`), non testé en réel ; Google TTS (sans clé), répond | À surveiller | Fragment de clé OpenAI visible dans une erreur, MP3 envoyé comme note vocale, `.speak` plantait au-delà de 200 caractères → clé contrôlée avant le téléchargement, 25 Mo au plus, délai de 60 s, 10 s entre deux appels, `.speak` découpé et converti en opus. |
| `.vv` | | Propriétaire | aucun | Corrigée | **Faille de vie privée** : n'importe qui pouvait révéler un média « vue unique » dans le groupe ; certains formats de « vue unique » étaient ignorés → réservée au propriétaire, tous les formats pris en charge, plafond de taille, message d'usage si rien n'est cité. |

### Propriétaire

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.ban` | | Propriétaire | aucun | Corrigée | Sans effet : l'état était en mémoire et jamais lu → table `BannedChat`, effet immédiat, survit au redémarrage. |
| `.exec` | `eval` | Propriétaire, privé | aucun | Corrigée | L'usage annonçait `.eval` sans alias, résultat pouvant afficher des secrets de la configuration dans un groupe → privé seulement, alias `eval`, sortie `util.inspect`, secrets masqués, délai de 60 s, code multi-lignes. |
| `.unban` | | Propriétaire | aucun | Corrigée | Sans effet → réactive la discussion ; passe la barrière même dans la discussion désactivée (LID compris). |
| `.update` | | Propriétaire | git (origine) ; `yt-dlp -U` | Corrigée (002 : refaite) | Les fichiers non suivis bloquaient la mise à jour, `pull` sans `--ff-only`, option Yarn obsolète, aucun délai ni verrou → **(002)** même moteur et même verrou que la page Maintenance du panel : refus clair avant toute modification pour une image Docker, une archive sans git, un HEAD détaché, une branche sans équivalent sur GitHub ou des fichiers suivis modifiés ; récupération puis `merge --ff-only` sur `origin/<branche courante>` ; `yarn install --immutable` seulement si les dépendances ont changé ; **démarrage d'essai** du nouveau code dans un processus séparé (`tools/verify-boot.js`) et **retour automatique à la version précédente** s'il échoue (« Mise à jour annulée ») ; mise à jour de yt-dlp au mieux. **Redémarrage** : seul un bot supervisé se relance (PM2, hébergeur de bots, ou `SUPERVISED=true`) ; en conteneur, sous systemd ou sans superviseur, la réponse dit de redémarrer soi-même le programme et le panel affiche le bandeau « redémarrage nécessaire » jusqu'au prochain démarrage. Réponses génériques. |

### Recherche

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.lyrics` | | Tous | LRCLIB (sans clé), répond | Corrigée | lyrics.ovh mal appelé (404) et some-random-api bloqué (403), message cité lu comme `[object Object]`, alias en conflit avec `music` → LRCLIB, jusqu'à 3 messages d'environ 3500 caractères, recherche libre, texte cité. |
| `.pinterest` | | Tous | Pinterest (recherche anonyme bloquée : 403) | Désactivée | Aucun équivalent gratuit → la commande reste au menu, répond « service indisponible » et propose `.image`. |
| `.reddit` | | Tous | Reddit OAuth (clés `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`), non testé en réel | À surveiller | Accès anonyme bloqué (403), nom de sous-reddit non validé, contenu `over_18` non filtré, risque de requête vers un hôte arbitraire → OAuth « client credentials » (sinon « non configuré »), sous-reddit validé, médias limités à `i.redd.it`, `preview.redd.it` et `i.imgur.com`, posts épinglés et `over_18` ignorés, 16 Mo au plus. |

### Statistiques

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.groupinfo` | `ginfo`, `stats2` | Groupe | aucun | Corrigée | Dépendait du suivi mort, boutons injoignables, « heures de pointe » fausses → vue d'ensemble avec mentions, boutons `ginfo:top` et `ginfo:xp` avec repli texte, heures de pointe supprimées. |
| `.level` | `xp`, `rank` | Tous | aucun | Corrigée | Aucune donnée (suivi mort), lignes fantômes, rang global comptant des lignes et non des personnes, `.export` le déclenchait → lecture sans création, rang par utilisateurs distincts, carte globale en privé. |
| `.top` | `active`, `leaderboard`, `lb` | Groupe | aucun | Corrigée | Plantait (`this._showCategory`), aucune donnée, page négative = erreur SQL → pages à partir de 1 et bornées, libellés traduits, seuls les scores supérieurs à 0 sont listés. |

### Utilitaires

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.delcmd` | | Propriétaire | aucun | Corrigée | Cache obsolète pendant 5 min, texte français en dur → cache vidé, préfixe retiré, traduit. |
| `.exportcontacts` | | Propriétaire | aucun | Corrigée | Fonction morte (Baileys v7 n'a plus de magasin de contacts), export envoyé dans le groupe, injection de formules CSV → exporte les participants du groupe (ou de tous les groupes depuis un privé), numéros et LID fusionnés, envoyé en privé à l'appelant, JSON ou CSV protégé. |
| `.fancy` | | Tous | aucun | Corrigée | Caractères tronqués au-delà de U+FFFF et tables Unicode fausses → `fromCodePoint`, bonnes tables (trous gérés), 11 styles, 500 caractères au plus. |
| `.getcmd` | | Propriétaire | aucun | Corrigée | Liste non bornée → 30 entrées au plus, traduit. |
| `.notify` | | Tous (enregistrement en groupe) | aucun | Corrigée | Fonction jamais appelée ; une fois branchée, elle aurait lu tous les groupes et écrit en privé à des non-membres → mot-clé lié au groupe où il est ajouté, alerte privée seulement aux membres et jamais à l'auteur ni depuis un privé, mot entier, 20 mots-clés par personne, 5 min sans doublon et 10 messages privés par heure, enregistrement en base. |
| `.pdf` | | Tous | aucun | Corrigée | Lisait le média du message courant et non du message cité, retours à la ligne perdus, fichiers temporaires laissés → image ou sticker cité en A4, génération en mémoire, glyphes non gérés remplacés (emoji → `?`), 20000 caractères au plus. |
| `.qr` | | Tous | aucun | Corrigée | Niveau H plafonnant à environ 1273 octets, retours à la ligne perdus → niveau M, texte multi-lignes (carte de contact, Wi-Fi) ou cité, 1000 caractères au plus. |
| `.remind` | `reminder`, `rappel` | Tous | aucun | Corrigée | Rappels en mémoire, socket périmé après une reconnexion, pas de liste ni d'annulation, fuseau horaire ignoré, unité `j` absente → enregistrés en base avec un seul planificateur, fuseau `TIMEZONE`, `.remind list`, `.remind list all` (admins), `.remind cancel <id>`, 20 en attente par personne. |
| `.setcmd` | | Propriétaire | aucun | Corrigée | Aucune validation de la commande, préfixe mal retiré → commande inconnue refusée, cache vidé. |
| `.task` | `todo` | Tous | aucun | Corrigée | Branches `todo` et `remind` injoignables, liste en mémoire, effaçable par n'importe qui → table `Task`, `undone`, `clear [all]`, `del`, suppression par le créateur, un admin ou le propriétaire, 100 tâches par discussion. |
| `.trt` | `translate`, `tr` | Tous | Traducteur Google (sans clé) puis MyMemory ; les deux répondent | Corrigée | Réponse à un message simple en échec, premier mot de 2 lettres pris pour une langue, `.translate` annoncé mais inexistant → alias `translate` et `tr`, texte cité, code ISO validé, langue du bot par défaut. |
| `.tts` | | Tous | Google TTS (sans clé), répond | Corrigée | Import cassé donc détection de langue morte, MP3 envoyé comme note vocale → détection réparée, note vocale opus, langue forcée par `{xx}` ou `{xx-YY}`, texte trop long refusé (`TTS_MAX_LENGTH`), texte cité. |

### WhatsApp

| Commande | Alias | Accès | Services externes | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- | --- | --- |
| `.antidelete` | `antidel` | Propriétaire | aucun | Corrigée | Ne transférait jamais rien : l'événement de suppression était mal lu → lecture correcte, cache vidé à chaque changement, numéros et LID acceptés, plafond de taille. |
| `.getantidelete` | `getantidel` | Propriétaire | aucun | Corrigée | La commande de lecture était correcte ; le défaut venait du gestionnaire (voir `.antidelete`) → alias `getantidel`, numéros et LID acceptés, usage avec le préfixe. |
| `.getvv` | | Propriétaire | aucun | Corrigée | Défaut mineur (l'état était toujours affiché comme activé), usage incorrect → corrigé, plus de fuite d'erreur. |
| `.setvv` | | Propriétaire | aucun | Corrigée | Cache non vidé après un changement, formats de « vue unique » manqués → cache vidé, accepte `g`, `p`, `null`, un JID ou un numéro, détecte tous les formats de « vue unique » et l'audio. |

### Modules sans commande

| Module | Rôle | Statut | Défauts constatés → corrections |
| --- | --- | --- | --- |
| `trackmessages` | Suivi des messages : statistiques, niveaux, classement | Corrigée | Jamais appelé, donc statistiques et niveaux figés → branché sur chaque message de groupe, compte atomique, XP de 5, 10 ou 15 avec 1 min entre deux gains, ignore les réactions et les messages du compte du bot. |
| `buttons` | Aide partagée d'envoi de boutons et de listes | Corrigée | Repli « répondez par le numéro » que rien ne traitait, message cité mal passé → ids enregistrés dans l'ordre d'affichage, repli numéroté traduit, mentions, listes paginées réellement envoyées. Service : `@ryuu-reinzz/button-helper` 2.2.3. |
| `pollplus` | Ancien fichier de `poll+` | Désactivée | Fusionné dans `poll` : `poll+` et `pollplus` sont des alias de `.poll` ; le fichier est volontairement vide. |
| `knownchats` (002) | Registre des discussions connues : les privés qui ont écrit au bot et les groupes vus, pour choisir les destinataires d'une diffusion dans le panel | Nouveau | Observateur sans commande (priorité 5, il ne consomme jamais le message) : enregistre un privé la première fois qu'il écrit (au plus une écriture par heure et par discussion), puis, à chaque connexion, actualise les noms des groupes (au plus toutes les 6 h) et marque comme « ancien groupe » ceux que le bot a quittés. Les privés muets depuis plus d'un an sont purgés chaque jour. |
| `groupguard` (002) | Applique l'**anti-lien** et l'**anti-bot** des groupes, réglés dans le panel (page Groupes) | Nouveau | Les colonnes `antilink` et `antibot` et les messages `ANTILINK_MSG` / `ANTIBOT_MSG` existaient mais rien ne les appliquait → un hook (priorité 50, après les observateurs et avant les filtres). **Le bot doit être admin du groupe**, sinon il ne fait rien (le panel avertit). **Anti-lien** : un lien (URL, `www.`, invitation `chat.whatsapp.com`, `wa.me`) envoyé par un membre qui n'est ni admin ni propriétaire est supprimé ; l'auteur reçoit un avertissement (`WARN_LIMIT`, `WARN_MESSAGE`, mêmes compteurs que `.warn`) et est retiré à la limite (`ANTILINK_MSG`). La règle est stricte : une commande qui contient un lien est supprimée et **n'est pas exécutée** (`.dl <lien>` d'un membre) ; admins et propriétaires sont exemptés, commandes comprises ; un VIP voit son message supprimé sans avertissement. **Anti-bot** : l'expéditeur est retiré (`ANTIBOT_MSG`) seulement quand l'identifiant du message a une forme qu'aucun client WhatsApp ne produit (`3EB0` + 36 caractères hexadécimaux, `BAE5` + 12) ; l'identifiant de 22 caractères (Baileys 7, probablement aussi WhatsApp Web) est seulement journalisé et inscrit à l'historique comme « suspect », jamais suivi d'une action, pour ne pas retirer un humain. |
| Mode muet (002) | Page Groupes du panel, sans commande ni module | Nouveau | Bascule le réglage WhatsApp « seuls les admins peuvent envoyer des messages » (`announcement` / `not_announcement`) dans les deux sens ; le bot doit être admin ; la colonne `mute` reflète le dernier état posé par le bot. |

---

## 3. Services externes morts ou remplacés

| Service | État au 2026-10-27 | Remplacement ou décision |
| --- | --- | --- |
| YouTube via `play-dl` (`.ytdl`) | Bloqué sans fin sur l'erreur 429 ; paquet abandonné en 2023 | **yt-dlp** (binaire système). Il doit rester à jour : un yt-dlp de 2024 échoue. L'image Docker installe la dernière version ; `.update` tente `yt-dlp -U`. |
| Instagram (deux fournisseurs tiers) | Les noms de domaine n'existent plus | yt-dlp. Instagram exige souvent une connexion : la commande répond « privé ou indisponible ». |
| Backend `api.socialdl.starland9.dev` (`.dl`) | **Infrastructure du propriétaire hors service** : il sert le certificat auto-signé par défaut de Traefik et répond 404 | **À réparer hors de ce dépôt.** Le backend est devenu facultatif (`BACKEND_URL`, vide par défaut) et ne sert plus qu'en repli après yt-dlp. Sans lui, Spotify n'est pas disponible dans `.dl`. |
| Paroles (lyrics.ovh, some-random-api) | 404 et 403 | **LRCLIB** (sans clé, répond). |
| Pinterest (recherche anonyme) | 403, aucun équivalent gratuit | `.pinterest` **désactivée** : elle reste au menu, répond « service indisponible » et propose `.image`. |
| Reddit (accès anonyme `.json`) | 403 « Blocked » | API OAuth Reddit : renseigner `REDDIT_CLIENT_ID` et `REDDIT_CLIENT_SECRET` (application de type « script »). Sans clés, la commande répond « non configuré ». |
| Giphy (clé de démonstration) | Bannie (403) | `GIPHY_API_KEY` obligatoire, envoi en MP4 animé. |
| Imagen 4 (`.imagen`) | Arrêté le 2026-08-17 | Modèle d'images de Gemini (`gemini-nano-banana-2.1` par défaut, `IMAGE_MODEL` pour en changer). **Demande un forfait Gemini payant** : une clé gratuite reçoit « limit 0 ». |
| quotable.io (`.quoteof`) | Nom de domaine mort | ZenQuotes, puis dummyjson, puis 12 citations locales. |
| api-ninjas, clé de démonstration (`.fact`) | Morte | uselessfacts v2 (anglais) ; en français, 18 faits locaux. |
| OpenAI `gpt-4o-mini` (`.gpt`) | Retrait annoncé le 2027-01-14 | Modèle configurable (`OPENAI_MODEL`) : à changer avant cette date. |

Services qui répondaient normalement : WeatherAPI et Open-Meteo, CoinGecko, iTunes Search, Aptoide, Open Trivia DB, JokeAPI et official-joke-api, uselessfacts, ZenQuotes, dummyjson, Google TTS, le traducteur Google et MyMemory, Gemini, LRCLIB, TikTok via yt-dlp. Non testés en réel faute de clé : OpenAI, NewsAPI, Alpha Vantage, Unsplash, Giphy, Reddit, Spotify.

### Nouvelles variables de `config.env`

Voir `config.env.example` pour les valeurs par défaut.

| Variable | Rôle |
| --- | --- |
| `GEMINI_MODEL`, `GEMINI_VISION_MODEL`, `IMAGE_MODEL`, `OPENAI_MODEL` | Modèles utilisés par `.gemini` et le répondeur, par l'analyse d'image, par `.imagen`, par `.gpt`. |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Obligatoires pour `.reddit`. |
| `BACKEND_URL` | Backend de téléchargement facultatif, vide par défaut. |
| `YTDLP_PATH`, `DOWNLOAD_TIMEOUT` | Chemin du binaire yt-dlp et durée maximale d'un téléchargement (180 000 ms). |
| `TIMEZONE` | Fuseau horaire des rappels (`UTC` par défaut). |
| `WARN_MESSAGE`, `WARN_KICK_MESSAGE` | À mettre entre guillemets quand ils contiennent `\n`. |
| `ADMIN_PANEL` (002) | Panel d'administration activé par défaut ; seule la valeur exacte `false` le désactive. Remplace `PANEL_ENABLED`, qui n'a jamais rien fait et n'est plus lu (une ligne de la console le signale s'il est encore défini). |
| `PANEL_HOST`, `PANEL_PORT` (002) | Plus définis par défaut : adresse automatique (`127.0.0.1` en local, `0.0.0.0` en conteneur ou quand l'hébergeur définit `PORT`) ; `HOST` et `PORT` sont acceptés. |
| `PANEL_PUBLIC_URL`, `PANEL_TRUST_PROXY` (002) | Adresse publique du panel (lien de configuration, `Origin` accepté) et reverse proxys dont on croit les en-têtes `X-Forwarded-*`. |
| `LOG_FORMAT`, `SUPERVISED`, `UPDATE_CHECK` (002) | Format des journaux (`pretty` / `json`), détection du superviseur pour `.update` (`auto`, `true`, `false`), recherche d'une nouvelle version. |
| `AUTO_STATUS_SAVE`, `STATUS_SAVE_LIST`, `TTS_MAX_LENGTH`, `MESSAGE_CONCURRENCY_LIMIT`, `CACHE_*`, `CONVERSATION_*`, `MEMORY_*` (002) | Déjà lus par le code mais absents de l'exemple ; maintenant documentés dans `config.env.example` et modifiables dans le panel. |
| 21 réglages (002) | `SESSION_ID`, `AUTO_READ`, `VPS`, `ANTI_DELETE`, `STATUS_SAVE_FOLDER`, les clés `GROQ`, `RMBG`, `CLOUDMERSIVE`, `APYHUB`, `DEEPAI`, `WAIFUPICS`, `PUTERJS`, `IMAGE_API_*`, `HEROKU_*`, `KOYEB*`, `RENDER_*` : aucun code ne les lit. Ils restent en fin de `config.env.example` sous « No effect in this version ». |

---

## 4. Changements de syntaxe à connaître

### Accès

- **Désormais réservées au propriétaire** : `.vv` (avant : tout le monde), `.exec` / `.eval` (en privé uniquement), `.update`, `.exportcontacts`, `.statussave`, `.ban`, `.unban`.
- **Réservées aux admins du groupe** : `.kick`, `.promote`, `.demote`, `.tagall`, `.warn`, `.welcome`, `.goodbye`, `.filter`, `.delfilter`. Si le bot n'est pas admin, il l'explique.
- **Uniquement en groupe** : `.balance`, `.daily`, `.give`, `.top`, `.stats`, `.groupinfo`, `.tictactoe`, `.idea`, `.quote`, `.role`, `.poll` et les mises de `.dice`.
- Un nom ou alias inconnu ne déclenche plus rien : `.kiss`, `.class`, `.boss`, `.export`, `.expire`, `.giftcard`, `.faq`, `.iq`, `.display` sont ignorés.

### Commandes

| Commande | Nouvelle syntaxe ou nouveau comportement |
| --- | --- |
| `.kick`, `.promote`, `.demote` | Plusieurs mentions à la fois. |
| `.warn` | Cible par mention ou par réponse ; `.warn list` ; `.warn reset @user`. |
| `.goodbye` | `.goodbye on`, `off`, `reset` ou `<texte>`. |
| `.welcome` | `on`, `off`, `reset` ou `<texte>` sur plusieurs lignes (1000 caractères) ; variables `@user`, `@group`, `@desc`. |
| `.delfilter` | `<motif>` ou `<numéro>` affiché par `.filter list`. |
| `.afk` | Propre à chaque personne (avant : un seul état pour tout le bot). |
| `.role` | `.role set @user <member, vip, muted ou banned>` ; `.role @user` ouvre un sélecteur ; `.role list` ; `.role check [@user]`. |
| `.poll` | `.poll Question ? choix 1, choix 2` (la barre verticale est aussi acceptée comme séparateur) ; `.poll+` pour plusieurs choix. Plus de décompte ni de fermeture. |
| `.remind` | Durées `30s`, `10m`, `2h`, `1d`, `3j`, `1h30m`, heure `HH:MM` ou date `YYYY-MM-DD HH:MM` ; `.remind list`, `.remind list all`, `.remind cancel <id>`. De 5 s à 1 an, 500 caractères. |
| `.task` | `add <texte>`, `list`, `done <n>`, `undone <n>`, `del <n>`, `clear` ou `clear all`. |
| `.notify` | `add <mot>`, `del <mot>`, `list`, `on`, `off`, `clear`. |
| `.dice` | `.dice d6 <mise> <1-6>`, `.dice coin <mise> <pile ou face>`, `.dice 2d6 <mise>`, `.dice d20 <mise>`. Mises de 10 à 1000, en groupe seulement. |
| `.top` | `.top <catégorie> <page>`, pages à partir de 1. |
| `.stats` | `.stats words` supprimé ; `.stats reset` pour admins et propriétaire. |
| `.hangman` | `.hangman <lettre>` ou réponse au plateau ; `stop` ; `help`. `.guess` n'est plus la commande du pendu. |
| `.quiz` / `.guess` | `.guess <n>` ; `.quiz` seul lance une partie. |
| `.rps` | `.rps <coup>` ; en duel, chaque joueur choisit en privé. |
| `.tictactoe` | `.ttt <1-9>` ; `.ttt stop`. |
| `.trivia` | Réponses `1` à `4` ; `.trivia score` ; `.trivia stop`. |
| `.convert` | `png`, `jpg`, `webp`, `pdf` (images et stickers) ; `mp3`, `ogg`, `m4a` (audio et vidéo). Les documents sont refusés. |
| `.tts` | Texte trop long refusé (`TTS_MAX_LENGTH`, 500 par défaut) ; `{xx}` force la langue. |
| `.transcribe` | Réponse à une note vocale uniquement ; 10 s entre deux appels. |
| `.pdf`, `.qr`, `.sticker` | `.pdf` sans titre, emoji remplacés par `?` ; `.qr` 1000 caractères au plus ; `.sticker` refuse un sticker cité. |
| `.lyrics` | Recherche libre ; n'est plus un alias de `.music`. |
| `.dl` | `.dl <lien>` ou `.dl <lien> audio` ; les jetons de qualité sont supprimés. |
| `.ytdl` | Vidéo : 15 min au plus ; `.yta` : audio de 60 min au plus ; `.yts <recherche>`. |
| `.reddit` | `.reddit r/<sub> [mots]` ou `.reddit <mots>`. |
| `.pinterest` | Indisponible ; utiliser `.image`. |
| `.image`, `.gif` | Nécessitent `UNSPLASH_API_KEY` et `GIPHY_API_KEY`. |
| `.apk` | `.apk <nom>` liste 5 résultats ; `.apk dl <n>` télécharge. |
| `.trt` | Alias `translate` et `tr` ; texte cité accepté. |
| `.fancy` | 11 styles. |
| `.quote` | Plus de bouton « Sauver ». |
| `.news` | Texte libre = recherche ; `.crypto` accepte les tickers. |
| `.gpt`, `.gemini`, `.imagen` | Anti-spam de 5 s, 5 s et 20 s ; prompt d'`.imagen` de 1500 caractères au plus. |
| `.fact` | En français, faits locaux (sans service). |
| `.feedback` | N'est plus anonyme ; 1 message par minute. |
| `.setcmd`, `.getcmd` | `.setcmd` valide la commande ; `.getcmd` liste 30 entrées au plus. |
| `.exportcontacts` | Exporte les membres du groupe (ou de tous les groupes depuis un privé), envoi en privé à l'appelant. |
| `.menu`, `.bmenu` | Les commandes du propriétaire sont cachées aux autres ; les ids de `.bmenu` ont changé. |

### Panel d'administration (002)

- **Commande désactivée** : elle répond « 🚫 Cette commande est désactivée pour le moment. » à tout le monde, propriétaire compris, tant qu'elle n'est pas réactivée dans le panel (page Commandes, partout ou par groupe).
- **`.update now`** : voir la ligne `.update` ; sans superviseur le bot ne se relance pas seul.
- **Anti-lien** : même `.dl <lien>` est supprimé quand il vient d'un membre non admin d'un groupe protégé.
- **Textes** : un texte ou une description de commande modifiés dans le panel (page Textes) remplacent ceux de `lang/*.json` à la prochaine réponse ; les variables (`{0}`, `&mention`...) ne peuvent pas être retirées.

### Boutons

Si les boutons ne s'affichent pas ou ne répondent pas, répondre en **citant le message** avec le numéro de l'option (par exemple `2`) fonctionne.

---

## 5. Dépendances

Détail complet, avec version avant et après pour chaque paquet : [deps-report.md](../specs/001-audit-fix-commands/deps-report.md). Vérification : `node tools/check-unused-deps.js` annonce 0 dépendance inutilisée.

| Action | Paquets |
| --- | --- |
| Retirées (inutilisées) : 18 | `@distube/ytdl-core`, `audio-decode`, `browser-id3-writer`, `cheerio`, `cookie`, `cron`, `fastq`, `form-data`, `fs-extra`, `googleapis`, `heroku-client`, `jimp`, `link-preview-js`, `moment`, `node-fetch`, `qrcode-reader`, `translate-google-api`, `youtubei.js` |
| Remplacées : 3 | `play-dl` (abandonné) → binaire `yt-dlp` ; `fluent-ffmpeg` (déprécié) → `lib/utils/ffmpeg.js` ; `@google/generative-ai` (déprécié) → `@google/genai` |
| Mises à jour majeures : 3 | `dotenv` 17 → 18, `openai` 6 → 7, `simple-git` 3 → 4 |
| Mises à jour mineures : 9 | `@google/genai`, `axios`, `file-type`, `pdfkit`, `pg`, `pino`, `pino-pretty`, `pm2`, `sharp` |
| Déjà à jour : 10 | `@hapi/boom`, `@ryuu-reinzz/button-helper`, `@vitalets/google-translate-api`, `google-tts-api`, `html-entities`, `node-webpmux`, `qrcode`, `qrcode-terminal`, `sequelize`, `sqlite3` |
| Ajoutée : 1 | `luxon` (fuseaux horaires des rappels) |

### Exceptions (FR-026)

- **`baileys` 7.0.0-rc14** : la lignée 7 n'existe qu'en préversion ; revenir à la 6.7 (stable) casserait le bot.
- **`axios` ^1.20.0** et **`openai` ^7.45.0** : une version corrective plus récente (axios 1.21.0, openai 7.45.1) est sortie moins de 24 h avant l'audit et Yarn la met en quarantaine. À monter à partir du 2026-10-28.

Dépendances système : `ffmpeg` (inchangé) et **`yt-dlp`** (nouveau, voir section 3). Le script `postinstall` qui forçait `sharp@0.33.5` a été supprimé.

---

## 6. Points à surveiller et décisions pour le propriétaire

- **Contrôles sur appareil réel non faits.** Tout a été vérifié avec des faux sockets et des simulations, jamais avec un vrai compte : boutons « native-flow » (clic et repli numéroté), événements de suppression (anti-delete), « vue unique », bienvenue et départ, médias envoyés. La checklist de la section 7 sert à cela.
- **Backend `api.socialdl.starland9.dev`** : à réparer hors de ce dépôt (certificat Traefik par défaut, 404). Tant qu'il est hors service, laisser `BACKEND_URL` vide ; yt-dlp couvre TikTok, Instagram, Facebook, X, YouTube, Pinterest et Reddit.
- **yt-dlp** : à garder à jour (`.update` tente `yt-dlp -U` ; la page Maintenance du panel a un bouton dédié et refuse tant qu'un téléchargement tourne). Votre binaire local de 2024 échoue sur YouTube. Dans un conteneur, la mise à jour est perdue quand le conteneur est recréé.
- **(002) Anti-bot** : les identifiants de message de 22 caractères ne sont jamais suivis d'une action, car WhatsApp Web en produit probablement de la même forme. La forme `BAE5` + 12 caractères est reprise de souvenir de Baileys 6 (absente de Baileys 6.7.9 et 7.0.0-rc14). À valider avec de vraies captures (checklist de la section 7).
- **(002) Panel exposé** : il écoute en local par défaut. L'ouvrir à Internet exige un reverse proxy avec HTTPS (`PANEL_PUBLIC_URL`, `PANEL_TRUST_PROXY`) ; sinon un avertissement permanent s'affiche. Les clés API enregistrées depuis le panel sont chiffrées avec `data/panel.key` : à conserver avec `data/`.
- **`.imagen`** : demande un forfait Gemini payant.
- **`gpt-4o-mini`** : retiré par OpenAI le 2027-01-14. Changer `OPENAI_MODEL` avant cette date.
- **Postgres non testé.** La nouvelle synchronisation du schéma et les requêtes atomiques de l'économie n'ont été exécutées que sur SQLite. Les anciennes contraintes en double créées par `alter: true` sur Postgres ne sont pas nettoyées (sans danger).
- **Blagues en français** : JokeAPI peut renvoyer des blagues de mauvais goût malgré le mode sûr. Option : garder tel quel, ou ne servir que les blagues anglaises ou locales.
- **Fichier suivi par git par erreur** : `data/status_save.json` (numéros de téléphone) était versionné malgré `.gitignore`. Il est désormais retiré du suivi (voir section 9).
- **Statistiques et niveaux** : les messages envoyés par le compte du bot (donc aussi par le propriétaire depuis ce compte) ne sont pas comptés, car on ne peut pas les distinguer des réponses du bot.
- **Quotas des clés** : l'audit a fait quelques appels réels à Gemini avec la clé configurée (quelques centimes).
- **Aide** : `.help dice`, `.help fancy`, `.help qr` et `.help tts` n'affichent pas l'usage, dont le texte attend des arguments. Amélioration facultative : exporter `command.usage` dans ces plugins.
- **Versions à monter** : `axios` et `openai` après le 2026-10-28 (section 5).

---

## 7. Checklist de vérification manuelle

À faire sur un vrai compte (FR-025). Préparer : un numéro de test dans `SUDO` (« propriétaire »), un second numéro de test (« B »), et un groupe de test où le bot est admin. Lancer `LOG_LEVEL=debug yarn dev` et lire les journaux : « Loaded 81 plugins », aucune ligne `Failed to load plugin`, aucun avertissement `Duplicate alias`.

### Démarrage

- [ ] `LOG_LEVEL=debug yarn dev` : 81 modules chargés, aucun échec de chargement, aucun alias en double.
- [ ] Sur une base existante : « Database synced », sans erreur, et la table `warns` accepte un avertissement dans deux groupes différents pour le même membre.

### Accès et correspondance exacte

- [ ] `.kiss`, `.export`, `.faq` : aucune réponse.
- [ ] Depuis B : `.vv` en réponse à un média « vue unique », `.exec 1`, `.ban`, `.update` : refus clair, aucun effet.
- [ ] (002) Désactiver `.ping` dans le panel (partout), puis `.ping` depuis B et depuis le propriétaire : « Cette commande est désactivée pour le moment. » aux deux ; redémarrer le bot : toujours désactivée ; la réactiver dans le panel : elle répond de nouveau. Refaire pour un seul groupe : elle répond encore dans l'autre.
- [ ] Depuis le propriétaire, en groupe (adresses LID comprises) : `.ban` et `.vv` sont acceptés.
- [ ] Depuis B (non admin) : `.kick @x`, `.tagall`, `.warn @x`, `.welcome on` : refus. Retirer les droits d'admin du bot puis `.kick @x` depuis un admin : le bot explique qu'il doit être promu.
- [ ] `.PING` (majuscules) répond comme `.ping`.

### Bienvenue et départ

- [ ] `.welcome on`, puis ajouter B au groupe : message de bienvenue qui mentionne B.
- [ ] Ajouter deux membres d'un coup : un seul message qui mentionne les deux.
- [ ] `.goodbye on`, puis retirer B : message de départ ; faire quitter B lui-même : message de départ aussi.
- [ ] `.welcome off` puis ajouter B : aucun message.

### Filtres, AFK, notifications

- [ ] `.filter salut=Bonjour !` puis envoyer « Salut » : « Bonjour ! » ; `.filter list` ; `.delfilter 1`, puis « Salut » : aucune réponse.
- [ ] Depuis B : `.afk déjeuner` ; depuis le propriétaire, mentionner B puis citer un de ses messages : réponse avec la raison et la durée ; quand B écrit, message de retour et état levé.
- [ ] `.notify add urgent` depuis B (membre du groupe) ; le propriétaire écrit « c'est urgent » dans le groupe : B reçoit un message privé ; écrire « urgentissime » : rien ; B n'est pas alerté de ses propres messages.

### Rôles

- [ ] `.role set @B muted` (bot admin) : les messages de B sont supprimés. `.role set @B member` le rétablit.
- [ ] `.role set @B banned` : B est retiré du groupe ; le réajouter : il est retiré de nouveau.
- [ ] `.role set @B vip`, puis avertir B jusqu'à `WARN_LIMIT` avec `.warn @B` : B n'est pas exclu.

### Désactivation du bot dans une discussion

- [ ] `.ban` dans le groupe, puis `.ping` depuis B : aucune réponse. Redémarrer le bot, `.ping` de nouveau : toujours aucune réponse. `.unban` depuis le propriétaire : le bot répond de nouveau.

### Statistiques et économie

- [ ] Envoyer quelques messages, puis `.level` et `.top` : compteurs différents de zéro.
- [ ] `.daily` deux fois de suite : la seconde est refusée ; `.balance`, `.give @B 10`, `.dice d6 10 3`.

### Rappels

- [ ] `.remind 1m test`, redémarrer le bot dans la minute : le rappel arrive. `.remind list` puis `.remind cancel <id>` sur un autre rappel.
- [ ] `.remind 10m test`, couper le bot 15 minutes, le relancer : le rappel arrive avec la mention « en retard ».

### Boutons et réponse par numéro

- [ ] `.menu2`, appuyer sur une catégorie puis sur une commande : les boutons fonctionnent.
- [ ] `.ttt @B` puis appuyer sur une case : le coup est joué.
- [ ] Sur un message à boutons, répondre en citant le message avec `2` : la deuxième option est choisie.
- [ ] Après un redémarrage, appuyer sur un bouton d'un ancien message : réponse « expiré » ou relance, jamais le silence.

### Messages supprimés et « vue unique »

- [ ] `.antidel g` (ou `.antidel p`), envoyer un message depuis B puis le supprimer : le message supprimé est renvoyé dans le groupe (ou au propriétaire avec `p`). `.antidel null` désactive.
- [ ] `.setvv p`, B envoie une photo en « vue unique » : le propriétaire la reçoit en privé. `.vv` en réponse à une « vue unique » : le média est envoyé au propriétaire seulement.
- [ ] `.statussave add <numéro de B>`, B publie un statut : il est sauvegardé.

### Mode panel

- [ ] Rejouer les scénarios « bienvenue », « filtre » et « boutons » avec `yarn panel` : comportement identique ; `/health` répond 200 une fois le bot connecté.

### Médias et téléchargements

- [ ] `.ytv <lien>` et `.yta <lien>` : une vidéo lisible, un audio lisible (avec un yt-dlp récent).
- [ ] `.dl <lien TikTok>`, `.lyrics <titre>`, `.sticker` sur une photo, `.convert png` sur un sticker, `.tts bonjour`.
- [ ] `.pinterest chat` : « service indisponible » et suggestion de `.image`.

### Panel d'administration (002)

À faire sur un vrai appareil ; le déroulé complet (installation isolée, scénarios, critères de réussite) est dans le [guide de validation](../specs/002-admin-panel/quickstart.md). Travailler dans une copie de travail (`git worktree`) pour ne pas toucher à vos `sessions/`, `database.db` et `data/`.

**Accès et tableau de bord**

- [ ] Premier démarrage : le lien de configuration s'affiche, le mot de passe se choisit et le réglage d'une valeur se fait en moins de 5 minutes ; le lien ne sert qu'une fois et expire après 30 minutes.
- [ ] Cinq mots de passe faux bloquent l'origine ; le bon est refusé pendant 15 minutes ; l'historique et une alerte au propriétaire le consignent.
- [ ] Tableau de bord : état, numéro, durée de fonctionnement, mémoire, dix dernières erreurs ; « Redémarrer » garde la session (pas de QR) et `/health` n'est `503` que brièvement.

**Appairage**

- [ ] Installation neuve : QR en moins de 5 s, il se renouvelle, scan, « connecté » en moins de 10 s.
- [ ] Appairage par code (chiffres avec indicatif) : saisir `XXXX-XXXX` sur le téléphone, connecté.
- [ ] « Déconnecter » retire l'appareil sur le téléphone et vide `sessions/main`.
- [ ] Une tentative par code abandonnée efface la session au bout de 3 minutes environ et un QR revient.

**Réglages, commandes, textes**

- [ ] Changer le préfixe : actif au message suivant ; une valeur invalide est refusée champ par champ.
- [ ] Clé API affichée « définie » + 4 derniers caractères seulement ; « Tester » répond acceptée ou refusée ; un second clic dans les 10 s est limité ; `enc:v1:` en base ; `data/panel.key` en mode 600.
- [ ] Commande désactivée partout et dans un groupe : le propriétaire est refusé aussi ; survit au redémarrage.
- [ ] Un texte et une description de commande modifiés apparaissent aussitôt ; retirer une variable est refusé.

**Groupes et gardien de groupe**

- [ ] Bienvenue avec aperçu ; une variable inconnue est refusée ; les filtres s'appliquent en direct.
- [ ] Anti-lien : sans admin du bot, le panel avertit ; un lien est supprimé et le membre averti ; retiré à la limite ; le `.dl <lien>` d'un membre est supprimé et non exécuté ; admins et propriétaire exemptés, commandes comprises.
- [ ] Anti-bot : un compte de bibliothèque (identifiant de 40 caractères `3EB0...` ou `BAE5...`) est retiré ; un identifiant de 22 caractères est seulement journalisé comme suspect ; **un humain sur WhatsApp Web, Android et iPhone n'est pas retiré** ; ajouter le `key.id` capturé sur WhatsApp Web aux fixtures de `test/groupguard.test.js`.
- [ ] Mode muet : bascule « seuls les admins peuvent envoyer des messages » dans les deux sens.
- [ ] Un ancien groupe quitté est listé et supprimable.

**Données, diffusions, sauvegarde**

- [ ] Un rappel annulé dans le panel n'arrive jamais ; un ajustement d'économie apparaît dans `.balance` ; un résultat négatif est refusé.
- [ ] Diffusion vers deux groupes et un privé : espacement respecté, une fois chacun, annulation, reprise sans doublon après un redémarrage en cours d'envoi, ponctuelle et récurrente envoyées une seule fois ; le rapport d'une destination en échec propose une nouvelle diffusion pré-remplie (pas de bouton « réessayer ») ; la page Stockage liste les « médias de diffusion » et garde ceux d'une diffusion récurrente quand on les vide.
- [ ] Export, restauration sur une installation vierge, données identiques ; mauvaise phrase secrète et fichier altéré refusés. L'export annonce sa taille (`Content-Length`) et la vérification de la restauration affiche `ignoredSettings` / `ignoredTexts`.

**Maintenance et alertes**

- [ ] `.update now` et le bouton du panel avec une version distante plus récente ; retour arrière sur un commit cassé ; un conteneur affiche des instructions ; résultats de la mise à jour de yt-dlp ; purge des médias temporaires.
- [ ] Alertes reçues : reconnexion après plus de 5 minutes, clé refusée (une fois par jour), connexion bloquée, nouvelle origine, erreurs en série (une alerte, un message privé avec la trace par commande et par période de 10 minutes).

**Transversal**

- [ ] Chaque page à 360 px sans défilement horizontal ; thèmes clair et sombre selon l'appareil.
- [ ] Aucune requête vers un hôte tiers pendant l'usage du panel (onglet Réseau des outils de développement).
- [ ] `yarn test`, `node tools/check-unused-deps.js` (0 dépendance inutilisée) et la boucle `curl` des routes historiques (`/ /health /healthz /status /ping /metrics /api/info`) sont verts.

---

## 8. Comment vérifier

Utiliser Node 24 (`nvm use 24`).

```bash
yarn test                         # node --test --test-force-exit "test/**/*.test.js"
node tools/check-unused-deps.js   # attendu : 0 unused dependencies
```

- `yarn test` charge les 81 modules, vérifie les alias (aucun doublon, aucun faux positif), les refus de permissions, la réponse de chaque commande sans argument, la présence des traductions fr et en, le pipeline et la synchronisation de la base. Depuis la fonctionnalité 002 il couvre aussi le panel d'administration (authentification, routes, interface, sauvegardes, diffusions, mise à jour avec retour arrière, alertes, `config.env.example`). Il n'utilise ni WhatsApp ni le réseau, et dure une vingtaine de secondes (environ 2 350 tests).
- Lancer les scripts et outils avec `OWB_NO_CONFIG_ENV=1` pour qu'ils ne lisent pas votre `config.env`.
- Une commande testée seule : `node --test --test-force-exit test/commands.test.js`.
- Les tests tournent en français par défaut ; `BOT_LANG=en yarn test` les lance en anglais.

## 9. Revue finale (sécurité, cœur, intégrité des données)

Une revue indépendante de toute la branche a été faite en fin de chantier. Elle a fuzzé chaque alias avec des arguments inattendus, soit 24 656 appels. Résultat : aucune erreur levée, aucune fuite (`Error:`, `undefined`, `NaN`, `[object Object]`) et aucun contournement des droits propriétaire. L'économie, le planificateur et la synchronisation de la base ont été vérifiés.

### Corrigé à l'issue de la revue

| Gravité | Problème | Correction |
| --- | --- | --- |
| Critique | `.dl` acceptait un lien de playlist, de chaîne ou de profil et téléchargeait **toutes** les entrées (jusqu'à 230 Mo chacune) : de quoi saturer le disque et la bande passante en quelques requêtes | `--playlist-items 1` dans `lib/utils/downloader.js` + test `test/downloader.test.js` |
| Majeur | Les téléchargements yt-dlp n'avaient aucune limite de concurrence | Au plus 2 en parallèle ; au-delà, l'utilisateur reçoit « trop de demandes, réessayez » |
| Majeur | La sauvegarde auto des statuts ignorait les statuts adressés en LID (numéro dans `remoteJidAlt`) | `remoteJidAlt` pris en compte |

### Restant (connu, non corrigé)

| Gravité | Point | Commentaire |
| --- | --- | --- |
| Majeur | Les messages reçus pendant une déconnexion (lots `append`) ne sont plus traités | C'est un compromis volontaire : cela évite de rejouer l'historique et les messages du bot. Le bot sur `master` les traitait. **Décision à prendre** : les accepter s'ils sont récents (moins de 2 min) et ne viennent pas du bot ? |
| Mineur | En mode anti-delete `g`, un message supprimé est republié dans une discussion désactivée par `.ban` ; les rappels créés avant `.ban` y sont quand même envoyés | Le filtre des discussions désactivées ne couvre que les messages entrants |
| Mineur | Un propriétaire vu uniquement en LID (sans `participantAlt`) est refusé | Contournement : ajouter aussi son LID dans `SUDO`. Même comportement que sur `master` |
| Mineur | Un membre `muted` peut encore cliquer des boutons de jeu | Les réponses de boutons sont traitées avant le hook de modération |
| Mineur | Comptes d'économie possiblement séparés pour un expéditeur vu seulement en LID (`daily`, `dice`) | Peu probable ; l'utilisateur ne le contrôle pas |

### Problèmes antérieurs au chantier, corrigés après la revue

| Problème | Correction |
| --- | --- |
| `panel.js` : l'arrêt (SIGTERM) appelait `client.stop()` → `sock.logout()`, donc chaque redémarrage en mode panel déconnectait la session WhatsApp (nouveau QR à scanner) | `stop()` ferme la connexion sans déconnecter l'appareil et n'autorise plus de reconnexion après un arrêt volontaire ; `logout()` est une méthode séparée, jamais appelée à l'arrêt |
| `panel.js` : `POST /api/restart` sans aucune authentification | Clé `PANEL_TOKEN` : endpoint désactivé (403) si elle est vide, sinon `Authorization: Bearer <jeton>` exigé (401), POST uniquement (405) |
| `data/status_save.json` (numéros de téléphone) suivi par git malgré `.gitignore`, ce qui bloquait `.update now` | Retiré du suivi (`git rm --cached`) ; le fichier local est conservé |

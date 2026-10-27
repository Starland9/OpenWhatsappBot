# Feature Specification: Audit et correction des commandes du bot

**Feature Branch**: `001-audit-fix-commands`

**Created**: 2026-10-27

**Status**: Draft

**Input**: User description: "Audit et correction de toutes les commandes (plugins) existantes d'OpenWhatsappBot : vérifier que chaque commande est correctement implémentée (fonctionnement, permissions, gestion d'erreurs, i18n, dépendances/API externes), corriger les bugs du registre (ownerOnly non appliqué, alias regex trop permissifs), la divergence du pipeline de panel.js, et les événements de groupe (welcome/goodbye) non branchés."

## Contexte

Le bot expose environ 80 commandes. Un premier inventaire a montré des défauts de plusieurs natures :

- des réglages enregistrés par une commande sans aucun effet ensuite (message de bienvenue/départ, filtres de réponse automatique, statut AFK, désactivation du bot dans une discussion, notifications, statistiques/niveaux/classement qui ne se mettent jamais à jour) ;
- des restrictions d'accès déclarées mais pas appliquées ;
- des noms de commande qui se déclenchent sur des mots qui ne sont pas la commande, et un même nom revendiqué par deux commandes ;
- un mode de lancement (« panel ») qui traite les messages différemment du mode normal.

Le détail commande par commande n'est pas connu à l'avance : il est le premier livrable de cette fonctionnalité.

## Clarifications

### Session 2026-10-27

- Q: Que faire d'une commande dont le service externe est définitivement hors service ? → A: La remplacer par un service gratuit équivalent s'il en existe un ; sinon la garder au menu en répondant « service indisponible ». Dans les deux cas, le rapport le signale.
- Q: Quel périmètre pour les traductions ? → A: Migration complète : tous les messages de toutes les commandes passent par le système de traduction, en français et en anglais.
- Q: Comment vérifier les corrections ? → A: Un contrôle automatisé local, lançable en une commande, qui charge toutes les commandes et simule leurs appels sans WhatsApp (chargement, accès, alias, réponses sans argument), complété par une vérification manuelle des événements de groupe sur un vrai compte.
- Q (ajout du propriétaire en cours de planification) : Faut-il aussi mettre à jour les dépendances ? → A: Oui : chaque dépendance passe à sa dernière version majeure stable, dans la mesure du possible.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Rapport d'audit de chaque commande (Priority: P1)

Le propriétaire du bot veut savoir, pour chaque commande, si elle fonctionne, ce qui ne va pas et ce qui a été fait. Il consulte un rapport unique qui liste toutes les commandes avec un statut et une justification.

**Why this priority**: C'est la demande explicite (« auditer si les commandes sont bien implémentées ») et la base de toutes les corrections. Sans lui, impossible de savoir ce qui reste à faire.

**Independent Test**: Ouvrir le rapport et vérifier que chaque commande listée par le menu du bot y figure, avec un statut et au moins une ligne de justification.

**Acceptance Scenarios**:

1. **Given** l'ensemble des commandes chargées par le bot, **When** le propriétaire ouvre le rapport, **Then** chaque commande y apparaît avec son nom, ses alias, son statut (OK, Corrigée, Désactivée, À surveiller) et la raison.
2. **Given** une commande corrigée, **When** le propriétaire lit sa ligne, **Then** il voit le défaut constaté et la correction apportée.
3. **Given** une commande qui dépend d'un service externe, **When** le propriétaire lit sa ligne, **Then** il voit quel service, s'il nécessite une clé et si le service répondait au moment de l'audit.

---

### User Story 2 - Les commandes sensibles sont réservées aux bonnes personnes (Priority: P1)

Un utilisateur quelconque tente d'utiliser une commande réservée au propriétaire (exécution de code, mise à jour, export de contacts, désactivation du bot, sauvegardes) ou une commande d'administration de groupe (exclure, promouvoir, avertir, configurer bienvenue/filtres). Il est refusé avec un message clair, et rien ne se passe.

**Why this priority**: Une permission non appliquée sur ces commandes donne à n'importe quel contact le contrôle du compte WhatsApp ou de la machine hôte. C'est le risque le plus grave de l'audit.

**Independent Test**: Depuis un numéro non propriétaire et non admin, envoyer chaque commande sensible ; vérifier le refus et l'absence d'effet. Refaire depuis le numéro propriétaire ; vérifier que la commande s'exécute.

**Acceptance Scenarios**:

1. **Given** une commande déclarée réservée au propriétaire, **When** un non-propriétaire l'envoie, **Then** le bot répond par un refus et n'exécute rien.
2. **Given** une commande d'administration de groupe, **When** un membre non admin l'envoie, **Then** le bot refuse ; **When** un admin l'envoie alors que le bot n'est pas admin du groupe, **Then** le bot explique qu'il doit être promu admin.
3. **Given** une commande réservée au propriétaire, **When** le propriétaire l'envoie, **Then** elle s'exécute normalement.

---

### User Story 3 - Chaque commande répond (Priority: P1)

Un utilisateur envoie n'importe quelle commande du menu. Il obtient toujours une réponse : le résultat attendu, un message d'usage s'il manque un argument, ou un message d'erreur compréhensible (clé d'API absente, service externe indisponible, média manquant). Aucune commande ne reste muette ni ne fait planter le traitement des autres messages.

**Why this priority**: Une commande muette ou absente est perçue comme un bot cassé ; c'est le cœur de « bien implémentée ».

**Independent Test**: Pour chaque commande, envoyer (a) la commande sans argument, (b) un appel valide, (c) un appel dont la dépendance externe est indisponible ; vérifier qu'une réponse arrive dans chaque cas.

**Acceptance Scenarios**:

1. **Given** une commande qui attend un argument, **When** elle est envoyée sans argument, **Then** le bot répond par un message d'usage avec un exemple.
2. **Given** une commande qui dépend d'une clé de service non configurée, **When** elle est envoyée, **Then** le bot indique que la fonctionnalité n'est pas configurée, sans afficher de détail technique interne.
3. **Given** un service externe qui ne répond pas ou renvoie une erreur, **When** la commande est envoyée, **Then** le bot répond par un message d'échec dans un délai raisonnable, et les autres commandes restent utilisables.
4. **Given** une commande qui attend un média en réponse, **When** elle est envoyée sans média cité, **Then** le bot explique quoi faire.
5. **Given** le démarrage du bot, **When** toutes les commandes sont chargées, **Then** aucune commande du menu n'est manquante à cause d'une erreur de chargement, et toute commande qui échoue au chargement est signalée dans les journaux.

---

### User Story 4 - Les réglages enregistrés ont réellement un effet (Priority: P2)

Un admin active un message de bienvenue, un filtre de réponse automatique ou désactive le bot dans une discussion ; un utilisateur se met en AFK ou programme une notification ; les membres d'un groupe discutent et consultent leur niveau ou le classement. Chaque réglage enregistré produit l'effet annoncé.

**Why this priority**: Ces commandes répondent « activé » mais ne font rien ensuite. Le défaut est trompeur, mais moins grave qu'une faille de permission ou une commande muette.

**Independent Test**: Pour chaque fonctionnalité, activer le réglage puis provoquer l'événement déclencheur (arrivée d'un membre, mot-clé du filtre, mention d'un utilisateur AFK, message dans une discussion désactivée, heure de la notification, envoi de messages puis consultation du niveau).

**Acceptance Scenarios**:

1. **Given** un message de bienvenue activé dans un groupe, **When** un membre rejoint le groupe, **Then** le message de bienvenue est envoyé avec la mention du membre ; idem pour le départ.
2. **Given** un filtre enregistré pour un mot-clé dans une discussion, **When** un message contenant ce mot-clé arrive, **Then** le bot envoie la réponse associée.
3. **Given** un utilisateur en AFK, **When** quelqu'un le mentionne ou lui répond, **Then** le bot signale son absence et sa raison ; **When** l'utilisateur AFK écrit à nouveau, **Then** son statut AFK est levé.
4. **Given** le bot désactivé dans une discussion par le propriétaire, **When** un utilisateur y envoie une commande, **Then** le bot l'ignore ; le propriétaire peut toujours le réactiver. La désactivation survit à un redémarrage.
5. **Given** des membres qui envoient des messages, **When** ils consultent leur niveau, leurs statistiques ou le classement, **Then** les compteurs reflètent les messages envoyés depuis l'activation.
6. **Given** une notification ou un rappel programmé, **When** l'heure est atteinte, **Then** le message est envoyé dans la bonne discussion.

---

### User Story 5 - Une commande se déclenche seulement sur son nom exact (Priority: P2)

Un utilisateur tape un mot préfixé qui n'est pas une commande, ou qui ressemble à une commande sans l'être. Le bot ne déclenche rien. Quand il tape un nom ou un alias exact, quelle que soit la casse, c'est toujours la même commande qui répond.

**Why this priority**: Des déclenchements parasites déroutent les utilisateurs, et un nom revendiqué par deux commandes donne un résultat imprévisible d'un démarrage à l'autre.

**Independent Test**: Envoyer chaque nom et alias exact (réponse attendue), puis des variantes avec un préfixe ou un suffixe ajouté (aucune réponse attendue).

**Acceptance Scenarios**:

1. **Given** une commande avec des alias, **When** un utilisateur envoie un mot qui commence ou finit par l'un des alias sans lui être égal, **Then** aucune commande n'est déclenchée.
2. **Given** deux commandes qui revendiquent le même nom, **When** l'audit est terminé, **Then** chaque nom n'appartient plus qu'à une seule commande.
3. **Given** un nom de commande en majuscules ou en casse mixte, **When** il est envoyé, **Then** la commande se déclenche comme en minuscules.

---

### User Story 6 - Même comportement quel que soit le mode de lancement (Priority: P3)

L'opérateur héberge le bot sur une plateforme qui impose le mode « panel ». Les commandes, les boutons, le suivi des statistiques et la sauvegarde des statuts se comportent exactement comme en mode normal.

**Why this priority**: Ne touche que les déploiements en mode panel, mais ces utilisateurs voient aujourd'hui des boutons sans effet et des statistiques figées.

**Independent Test**: Lancer le bot dans chacun des deux modes et rejouer le même scénario (commande, clic sur un bouton, statut publié par un contact suivi) ; comparer les réponses.

**Acceptance Scenarios**:

1. **Given** le bot lancé en mode panel, **When** un utilisateur clique sur un bouton envoyé par une commande, **Then** la commande concernée traite le clic comme en mode normal.
2. **Given** une correction du traitement des messages, **When** elle est livrée, **Then** elle s'applique aux deux modes sans avoir à la dupliquer.

---

### User Story 7 - Dépendances à jour, sans paquet mort (Priority: P2)

Le propriétaire veut un bot dont les composants tiers sont à leur dernière version majeure stable, sans composant inutilisé ni abandonné. Il limite ainsi les failles connues et les pannes dues à des interfaces obsolètes.

**Why this priority**: Plusieurs commandes dépendent de composants obsolètes ou abandonnés, et corriger les commandes sur des versions qui vont changer ferait le travail deux fois. Les mises à jour se font donc avant les corrections des commandes, mais elles restent au service de l'objectif principal.

**Independent Test**: Comparer la liste des dépendances du projet avec les dernières versions stables publiées ; démarrer le bot ; lancer le contrôle automatisé.

**Acceptance Scenarios**:

1. **Given** les dépendances du projet, **When** la mise à jour est terminée, **Then** chacune est à sa dernière version stable publiée, hors préversions. Toute exception est justifiée dans le rapport d'audit.
2. **Given** une dépendance qu'aucune partie du bot n'utilise, **When** la mise à jour est terminée, **Then** elle est retirée du projet.
3. **Given** une dépendance dépréciée ou abandonnée, **When** la mise à jour est terminée, **Then** elle est remplacée par une alternative maintenue ou par une capacité native de la plateforme d'exécution.
4. **Given** les dépendances mises à jour, **When** le bot démarre et que le contrôle automatisé s'exécute, **Then** les deux réussissent sans avertissement de dépréciation lié au code du projet.

---

### Edge Cases

- Commande envoyée dans une discussion où le bot est désactivé, par le propriétaire (doit rester possible pour réactiver) ou par quelqu'un d'autre (ignorée).
- Membre qui rejoint un groupe dont la configuration n'a jamais été créée : pas de message, pas d'erreur.
- Plusieurs membres ajoutés en une seule fois : un message de bienvenue par membre ou un message groupé, mais aucun oublié.
- Clic sur un bouton d'un ancien message après redémarrage du bot : réponse « expiré » ou relance, jamais un silence ni une erreur technique.
- Réponse citée à un message quelconque (pas un jeu) : elle ne doit pas être interceptée par un jeu en cours dans une autre discussion.
- Service externe très lent : la commande abandonne après un délai et le dit, sans bloquer les autres messages.
- Argument très long ou contenant des caractères spéciaux : pas de plantage, pas d'injection dans un motif de recherche.
- Le propriétaire n'a configuré aucun numéro administrateur : les commandes réservées refusent tout le monde au lieu de tout autoriser.
- Message envoyé par le bot lui-même (compte propriétaire) : ne déclenche pas les filtres ni les réponses AFK en boucle.

## Requirements *(mandatory)*

### Functional Requirements

#### Audit

- **FR-001**: Le livrable MUST inclure un rapport d'audit couvrant 100 % des commandes chargées par le bot, avec pour chacune : nom et alias, catégorie, restriction d'accès, dépendances externes (et besoin de clé), statut (OK / Corrigée / Désactivée / À surveiller) et justification.
- **FR-002**: Chaque commande MUST être évaluée sur les mêmes critères : réponse sans argument, réponse sur appel valide, réponse en cas d'échec de dépendance, application des restrictions d'accès, absence de fuite de détails techniques à l'utilisateur, traduction des messages.

#### Accès

- **FR-003**: Toute restriction d'accès déclarée par une commande (propriétaire, groupe uniquement, privé uniquement) MUST être appliquée avant son exécution, sans dépendre d'une vérification répétée dans la commande.
- **FR-004**: Les commandes qui permettent d'exécuter du code, de modifier le bot, d'exporter des données personnelles, de désactiver le bot ou de lire des messages supprimés/éphémères MUST être réservées au propriétaire.
- **FR-005**: Les commandes d'administration de groupe MUST être réservées aux admins du groupe ou au propriétaire, et MUST vérifier que le bot est admin avant toute action qui l'exige.
- **FR-006**: En l'absence de propriétaire configuré, les commandes réservées MUST refuser tous les utilisateurs.

#### Réponses et robustesse

- **FR-007**: Chaque commande MUST répondre à chaque appel : résultat, message d'usage, ou message d'erreur compréhensible.
- **FR-008**: Une commande qui dépend d'une clé de service absente MUST l'indiquer à l'utilisateur sans tenter l'appel.
- **FR-009**: Une commande qui dépend d'un service externe MUST abandonner après un délai borné et prévenir l'utilisateur ; l'échec d'une commande MUST NOT empêcher le traitement des autres messages.
- **FR-010**: Les messages d'erreur montrés aux utilisateurs MUST NOT contenir de trace technique ; le détail complet MUST rester disponible pour le propriétaire (journaux et/ou message privé).
- **FR-011**: Une commande qui ne peut pas se charger au démarrage MUST être signalée clairement dans les journaux, et MUST NOT empêcher les autres commandes de se charger.
- **FR-012**: Les commandes dont la dépendance externe est définitivement hors service MUST être rebranchées sur un service gratuit équivalent s'il en existe un ; à défaut, elles MUST rester au menu et répondre que le service est indisponible. Aucune commande n'est supprimée pour ce motif.

#### Effets des réglages

- **FR-013**: Les messages de bienvenue et de départ MUST être envoyés lors des arrivées et départs de membres dans les groupes où ils sont activés.
- **FR-014**: Les filtres de réponse automatique MUST déclencher leur réponse quand un message correspondant arrive dans la discussion concernée.
- **FR-015**: Le statut AFK MUST être signalé aux personnes qui mentionnent ou répondent à l'utilisateur AFK, et levé quand il écrit à nouveau.
- **FR-016**: La désactivation du bot dans une discussion MUST empêcher toute commande d'y être exécutée, sauf la réactivation par le propriétaire, et MUST persister après un redémarrage.
- **FR-017**: Chaque message reçu dans un groupe MUST être comptabilisé pour les statistiques, les niveaux et le classement.
- **FR-018**: Les notifications et rappels programmés MUST être envoyés à l'heure prévue dans la bonne discussion, y compris après un redémarrage si leur heure n'est pas encore passée.

#### Déclenchement

- **FR-019**: Une commande MUST se déclencher uniquement quand le mot qui suit le préfixe est exactement égal (sans tenir compte de la casse) à son nom ou à l'un de ses alias.
- **FR-020**: Chaque nom et alias MUST appartenir à une seule commande ; un doublon MUST être signalé au démarrage.
- **FR-021**: Les réponses aux boutons et aux jeux MUST être attribuées uniquement à la commande qui les a émises et à la discussion concernée.

#### Modes de lancement

- **FR-022**: Le traitement des messages MUST être identique en mode normal et en mode panel, à partir d'une seule définition partagée.

#### Langue

- **FR-023**: Tous les messages montrés aux utilisateurs par toutes les commandes (réponses, usages, erreurs, descriptions du menu) MUST passer par le système de traduction et exister en français et en anglais ; les autres langues continuent de se rabattre sur l'anglais.
- **FR-023b**: Changer la langue du bot MUST changer la langue de tous ces messages, y compris les descriptions affichées par le menu et l'aide.

#### Vérification

- **FR-024**: Le projet MUST fournir un contrôle automatisé local, lançable en une seule commande et sans compte WhatsApp, qui vérifie pour toutes les commandes : chargement, application des restrictions d'accès, déclenchement exact des noms et alias, unicité des noms, réponse à un appel sans argument, et présence des traductions françaises et anglaises.
- **FR-025**: Les fonctionnalités liées aux événements de groupe et aux envois programmés MUST être couvertes par une checklist de vérification manuelle sur un vrai compte, livrée avec le rapport d'audit.

#### Dépendances

- **FR-026**: Chaque dépendance directe MUST être à sa dernière version majeure stable publiée. Lorsqu'aucune version stable ne convient (par exemple, la seule lignée compatible n'existe qu'en préversion), la dernière version disponible de cette lignée MUST être retenue et l'exception justifiée dans le rapport.
- **FR-027**: Les dépendances qui ne sont utilisées par aucune partie du bot (ni directement, ni comme pilote, transport ou outil de lancement) MUST être retirées.
- **FR-028**: Les dépendances dépréciées ou abandonnées MUST être remplacées par une alternative maintenue ou par une capacité native de la plateforme ; deux dépendances qui rendent le même service MUST être réduites à une seule.
- **FR-029**: Les changements incompatibles introduits par les mises à jour MUST être adaptés dans le code avant les corrections des commandes, et le rapport d'audit MUST lister chaque dépendance avec sa version avant/après et l'action menée (mise à jour, retrait, remplacement, exception).

### Key Entities

- **Commande**: une action déclenchée par un nom préfixé. Attributs : nom, alias, catégorie, description, restriction d'accès, dépendances externes, statut d'audit.
- **Entrée du rapport d'audit**: une ligne par commande. Attributs : statut, défauts constatés, corrections apportées, dépendances et leur état.
- **Réglage de discussion**: configuration attachée à une discussion ou un groupe (bienvenue, départ, filtres, désactivation du bot) qui doit produire un effet lors d'un événement.
- **Statistique de membre**: compteur de messages par membre et par groupe, à partir duquel sont calculés le niveau et le classement.
- **Élément programmé**: notification ou rappel avec une heure, une discussion cible et un contenu.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100 % des commandes du menu figurent dans le rapport d'audit avec un statut et une justification.
- **SC-002**: 0 commande réservée exécutable par un utilisateur non autorisé, vérifié pour chaque commande réservée.
- **SC-003**: 100 % des commandes répondent dans les trois cas testés (sans argument, appel valide, dépendance indisponible) ; aucune ne reste muette.
- **SC-004**: Les commandes qui dépendent d'un service externe répondent (résultat ou échec) en moins de 30 secondes dans 100 % des cas.
- **SC-005**: Chacune des six fonctionnalités à effet différé (bienvenue/départ, filtres, AFK, désactivation, statistiques, notifications) produit son effet lors de son scénario de test.
- **SC-006**: 0 déclenchement parasite sur une liste de variantes (nom + préfixe/suffixe) couvrant toutes les commandes à alias.
- **SC-007**: Le même scénario de test donne des réponses identiques dans les deux modes de lancement.
- **SC-008**: 100 % des commandes se chargent au démarrage dans un environnement où les dépendances déclarées du projet sont installées.
- **SC-009**: 100 % des messages montrés aux utilisateurs existent en français et en anglais ; en passant la langue du bot de l'une à l'autre, aucun message ne reste dans l'ancienne langue.
- **SC-010**: Le contrôle automatisé passe sur toutes les commandes et s'exécute en moins de 2 minutes sur un poste de développement.
- **SC-011**: 100 % des dépendances directes sont à leur dernière version stable ou figurent comme exception justifiée ; 0 dépendance inutilisée ou dépréciée ne reste dans le projet.

## Assumptions

- Le périmètre est l'ensemble des commandes présentes dans le dossier des plugins à la date de l'audit ; l'ajout de nouvelles commandes est hors périmètre.
- « Propriétaire » désigne les numéros configurés comme administrateurs du bot ; « admin » désigne un administrateur du groupe WhatsApp.
- Les fonctionnalités à effet différé (bienvenue, filtres, AFK, désactivation, statistiques, notifications) étaient voulues et doivent être rendues fonctionnelles, pas supprimées.
- La désactivation du bot dans une discussion doit survivre à un redémarrage (aujourd'hui elle est perdue), comme les autres réglages déjà enregistrés.
- Le délai maximal d'attente d'un service externe reste celui déjà en vigueur pour le bot (30 secondes).
- Les clés de service ne sont pas toutes configurées dans l'environnement d'audit ; une commande dont la clé manque est évaluée sur son message « non configuré » et marquée « À surveiller » si son appel réel n'a pas pu être testé.
- L'échec de chargement constaté localement pour 16 commandes vient d'un environnement local non synchronisé avec les dépendances déclarées du projet ; l'audit se fait dans un environnement conforme aux prérequis du projet.
- Le rapport d'audit est rédigé en français, comme la majorité de la documentation du projet.
- Une dépendance inutilisée est retirée plutôt que mise à jour ; si une commande corrigée en a besoin plus tard, elle est réintroduite à sa dernière version.
- La bibliothèque WhatsApp n'existe dans sa lignée actuelle qu'en préversion ; revenir à l'ancienne lignée stable casserait le bot. Elle reste donc sur la dernière préversion de la lignée actuelle, et c'est l'exception attendue de FR-026.

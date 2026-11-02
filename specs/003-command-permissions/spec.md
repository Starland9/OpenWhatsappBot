# Feature Specification: Permissions par commande

**Feature Branch**: `003-command-permissions`

**Created**: 2026-10-30

**Status**: Draft

**Input**: User description: "aujourd'hui l'auto vv ne marche que dans les groupes et la commande vv juste par le proprio ; et si on implémentait un système de permission modulaire" — reformulé : système de permissions par commande, réglé uniquement depuis le panel d'administration, qui permet au propriétaire d'ouvrir ou de fermer n'importe quelle commande à des personnes nommées, dans un groupe précis ou partout.

## Contexte

Aujourd'hui, le niveau d'accès d'une commande est fixé dans son code : publique, réservée aux administrateurs du groupe, ou réservée au propriétaire. Le propriétaire ne peut pas le changer. Par exemple, `.vv` (révéler une vue unique citée) est réservée au propriétaire depuis l'audit 001 : n'importe qui pouvait révéler une vue unique devant tout le groupe. Il n'existe donc aucun moyen de la confier à une personne de confiance sans la rouvrir à tout le monde.

Le panel (fonctionnalité 002) sait déjà désactiver une commande partout ou dans un groupe, et la page de chaque groupe liste ses membres. Il manque la possibilité de dire **qui** peut utiliser une commande, pas seulement si elle est active.

Conséquences pour le propriétaire :

- il ne peut pas confier `.vv` à un co-gérant de groupe sans rouvrir la faille de vie privée corrigée en 001 ;
- il ne peut pas réserver une commande coûteuse (génération d'images, IA) à quelques membres d'un groupe ;
- la seule restriction possible est la désactivation totale, propriétaire compris.

### Hors périmètre : l'auto-vv des vues uniques reçues en privé

Le propriétaire a constaté que l'auto-vv (renvoi automatique des vues uniques) fonctionne en groupe mais pas en privé. Ce n'est pas un défaut du bot. Depuis le 15/11/2024, le serveur WhatsApp supprime le contenu des vues uniques envoyées aux appareils liés qui ne les « supportent » pas. Seuls les appareils capables de bloquer les captures d'écran les reçoivent (présentation Zengo, Troopers 26). Le bot est un appareil lié : il reçoit en privé un message « vue unique indisponible », sans média. Le seul contournement connu consiste à déclarer le bot comme un téléphone Android. Le propriétaire l'a écarté (contournement volontaire d'une protection, re-appairage, risque pour le compte). L'auto-vv en groupe ne change pas.

## Clarifications

### Session 2026-10-30

- Q: Quelles commandes couvre le système ? → A: Toutes les commandes du bot, réglables une par une. Pas de lots ni de catégories.
- Q: À qui peut-on ouvrir une commande ? → A: À des personnes nommées uniquement. Pas aux administrateurs du groupe en bloc, pas au rôle VIP, pas à « tout le monde ».
- Q: Les règles sont-elles par groupe ou globales ? → A: Les deux : un groupe précis, ou « partout » (tous les groupes et le privé).
- Q: Ouvrir seulement, ou aussi fermer ? → A: Les deux. Une commande peut être ouverte à des personnes en plus de son niveau normal, ou fermée au reste pour n'être utilisable que par ces personnes.
- Q: Une personne autorisée « partout » garde-t-elle la commande dans un groupe où elle est fermée à une autre liste ? → A: Oui. « Partout » est un passe-droit personnel, valable dans tous les groupes.
- Q: Le propriétaire garde-t-il l'accès en mode « ces personnes seulement » ? → A: Oui, toujours, sauf si la commande est désactivée dans le panel (comme aujourd'hui).
- Q: Que voit un membre refusé par le mode « ces personnes seulement » ? → A: Rien : le bot ignore la commande en silence.
- Q: Quelles commandes ne sont jamais délégables ? → A: `.eval`/`.exec`, `.update`, `.exportcontacts`, `.ban`/`.unban`, `.setvv`/`.getvv`, `.antidel`/`.getantidel`, `.ar` (réponses automatiques), `.statussave`, `.setcmd`/`.delcmd`/`.getcmd`. La liste est fixée dans le code et le panel ne peut pas la modifier. Parmi les commandes réservées au propriétaire, `.vv` et `.save` sont délégables.
- Q: Où part le média quand quelqu'un d'autre que le propriétaire utilise `.vv` ? → A: En privé, chez la personne qui l'a demandé, jamais dans le groupe.
- Q: Où se règlent les permissions, et qui les règle ? → A: Dans le panel uniquement, par le propriétaire uniquement. Il n'y a pas de commande WhatsApp, et les administrateurs de groupe ne peuvent rien accorder.
- Q: Les permissions expirent-elles ? → A: Non. Elles restent jusqu'à ce que le propriétaire les retire.
- Q: Comment conduire le projet ? → A: Avec Spec Kit, dans `specs/003-command-permissions`, sur sa propre branche.
- Q: Que montrent le menu et l'aide à une personne ? → A: Ce qu'elle peut utiliser, là où elle se trouve. Une commande qui lui a été ouverte apparaît ; une commande qui lui est fermée (« ces personnes seulement ») disparaît de son menu, ce qui va avec le refus silencieux.

### Session 2026-10-30 (après la recherche du plan)

- Q: Une commande est à la fois désactivée et en « ces personnes seulement » : que voit un membre non listé ? → A: Rien (silence). La commande lui est invisible. Les personnes listées et le propriétaire voient « commande désactivée ».
- Q: Une personne déléguée lance `.vv` sans citer de message, ou sur un média trop lourd : où va la réponse ? → A: En privé chez elle. Le groupe ne voit rien.
- Q: Comment remettre une commande à son niveau normal dans un groupe quand une règle « partout » la ferme ? → A: Avec une règle de groupe « normal + ces personnes », éventuellement sans personne. Elle signifie « niveau normal ici » et l'emporte sur la règle « partout ». Le panel l'affiche comme une exception.
- Q: « Oublier ce groupe » dans le panel efface-t-il aussi ses permissions ? → A: Oui. Si le bot quitte simplement le groupe, ses règles restent.
- Q: Faut-il l'indicatif du pays pour un numéro saisi ? → A: Oui. Les espaces, le « + », les tirets, les points, les parenthèses et un « 00 » en tête sont ignorés.
- Q: Une future commande réservée au propriétaire, sans précision, est-elle délégable ? → A: Non, elle est verrouillée par défaut. Une commande du propriétaire n'est délégable que si son code le déclare (comme `.vv` et `.save`), et un test oblige à faire ce choix explicitement.
- Q: Quelle raison afficher pour une commande jamais délégable ? → A: Cinq raisons courtes : elle exécute du code, elle met à jour le bot, elle exporte des données personnelles, elle peut exclure le propriétaire d'une discussion, elle règle le comportement du bot.
- Q: Comment s'enregistrent les modifications d'une règle ? → A: Avec un bouton Enregistrer. Les avertissements s'affichent avant l'enregistrement, et chaque enregistrement donne une seule entrée d'audit.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Confier une commande à une personne dans un groupe (Priority: P1)

Le propriétaire ouvre la page d'un groupe dans le panel, puis l'onglet « Permissions ». Il choisit une commande, par exemple `.vv`, et ajoute un ou plusieurs membres du groupe. Ces membres peuvent désormais utiliser la commande dans ce groupe, en plus des personnes qui y avaient déjà droit. Pour `.vv` et `.save`, le média part en privé chez la personne qui a lancé la commande.

**Why this priority**: C'est le besoin d'origine. Il apporte seul de la valeur : `.vv` confiée à un co-gérant sans rouvrir la faille de vie privée.

**Independent Test**: Dans le panel, ouvrir `.vv` au membre B dans le groupe A. Depuis B, répondre `.vv` à une vue unique dans le groupe A : B reçoit le média en privé et le groupe ne voit rien. Depuis C (non nommé), même geste : C reçoit le refus habituel « réservée au propriétaire ».

**Acceptance Scenarios**:

1. **Given** `.vv` réservée au propriétaire et aucune règle, **When** le propriétaire l'ouvre au membre B dans le groupe A, **Then** dès le message suivant B peut l'utiliser dans le groupe A, par n'importe lequel de ses alias.
2. **Given** `.vv` ouverte à B dans le groupe A, **When** B l'utilise en réponse à une vue unique, **Then** le média révélé est envoyé en privé à B, rien n'est posté dans le groupe A, et le réglage de destination de l'auto-vv n'est pas utilisé.
3. **Given** `.vv` ouverte à B dans le groupe A, **When** B l'utilise dans le groupe D ou en privé avec le bot, **Then** il reçoit le refus habituel, puisque la règle ne vaut que pour le groupe A.
4. **Given** `.vv` ouverte à B dans le groupe A, **When** le propriétaire utilise `.vv`, **Then** le comportement est celui d'aujourd'hui (destination de l'auto-vv, sinon la discussion courante).
5. **Given** `.kick` (réservée aux administrateurs) ouverte à B, qui n'est pas administrateur du groupe A, **When** le propriétaire enregistre la règle, **Then** le panel affiche un avertissement clair : B pourra retirer des membres par l'intermédiaire du bot. **When** B lance ensuite `.kick @C`, **Then** la commande s'exécute si le bot est administrateur du groupe.
6. **Given** une règle sur `.vv` pour B dans le groupe A, **When** le propriétaire retire B, **Then** dès le message suivant B reçoit à nouveau le refus habituel.
7. **Given** des règles enregistrées, **When** le bot redémarre, **Then** elles s'appliquent toujours.
8. **Given** `.vv` ouverte à B dans le groupe A, **When** B tape `.menu` ou `.help` dans le groupe A, **Then** `.vv` y figure. **When** B les tape dans le groupe D, **Then** `.vv` n'y figure pas.

---

### User Story 2 - Réserver une commande à quelques personnes dans un groupe (Priority: P1)

Le propriétaire veut que `.imagen` ne soit utilisable, dans le groupe A, que par trois membres. Dans l'onglet « Permissions » du groupe, il passe la commande en mode « ces personnes seulement » et nomme les trois membres. Les autres membres du groupe, administrateurs compris, n'obtiennent plus aucune réponse du bot quand ils tapent `.imagen` dans ce groupe. Ailleurs, la commande ne change pas.

**Why this priority**: C'est l'autre moitié du besoin (fermer, pas seulement ouvrir). Il est testable sans l'US1.

**Independent Test**: Passer `.dice` en « ces personnes seulement » avec B dans le groupe A. B lance `.dice` dans A et obtient une réponse. C lance `.dice` dans A et n'obtient rien. C lance `.dice` dans le groupe D et obtient une réponse.

**Acceptance Scenarios**:

1. **Given** `.imagen` publique, **When** le propriétaire la passe en « ces personnes seulement » avec B dans le groupe A, **Then** dans le groupe A, B peut l'utiliser et tous les autres membres sont ignorés en silence (pas de réponse, pas de réaction).
2. **Given** cette règle, **When** un administrateur du groupe A qui n'est pas dans la liste tape `.imagen`, **Then** il est ignoré lui aussi.
3. **Given** cette règle, **When** le propriétaire tape `.imagen` dans le groupe A, **Then** la commande s'exécute, même s'il n'est pas dans la liste.
4. **Given** cette règle, **When** n'importe qui tape `.imagen` dans un autre groupe ou en privé, **Then** la commande se comporte comme avant.
5. **Given** une commande en « ces personnes seulement » dont la liste est vide, **When** un membre la tape dans le groupe, **Then** il est ignoré. Seul le propriétaire peut l'utiliser, et le panel l'indique.
6. **Given** une commande désactivée dans le panel (globalement ou dans le groupe A), **When** une personne nommée dans une règle la tape dans le groupe A, **Then** elle reçoit « commande désactivée », comme tout le monde : la désactivation l'emporte sur les permissions.
7. **Given** `.imagen` en « ces personnes seulement » avec B dans le groupe A, **When** C tape `.menu` ou `.help imagen` dans le groupe A, **Then** `.imagen` n'y apparaît pas pour C. Pour B et pour le propriétaire, elle y apparaît.

---

### User Story 3 - Donner une commande à une personne partout (Priority: P2)

Le propriétaire veut que B puisse utiliser `.vv` dans tous les groupes et en privé avec le bot. Sur la page Commandes du panel, il ouvre la commande et règle la portée « partout » : il ajoute B, choisi parmi les contacts connus du bot ou saisi par son numéro. La même page permet de passer une commande en « ces personnes seulement » partout.

**Why this priority**: C'est utile pour une personne de confiance présente dans plusieurs groupes, mais l'US1 couvre déjà le cas courant.

**Independent Test**: Ouvrir `.vv` partout à B. B l'utilise dans le groupe A, dans le groupe D et en privé : à chaque fois, il reçoit le média en privé.

**Acceptance Scenarios**:

1. **Given** `.vv` ouverte partout à B, **When** B l'utilise dans n'importe quel groupe ou en privé avec le bot, **Then** elle s'exécute et le média part en privé chez B.
2. **Given** `.imagen` en « ces personnes seulement » partout avec B, et aucune règle dans le groupe A, **When** C tape `.imagen` dans le groupe A ou en privé, **Then** C est ignoré.
3. **Given** `.imagen` en « ces personnes seulement » partout avec B, et dans le groupe A une règle « normal + ces personnes » sans personne pour `.imagen` (« niveau normal ici »), **When** C tape `.imagen` dans le groupe A, **Then** la commande s'exécute : le mode du groupe l'emporte sur le mode « partout ».
4. **Given** B autorisé partout à `.imagen`, et `.imagen` en « ces personnes seulement » dans le groupe A avec une liste qui ne contient pas B, **When** B tape `.imagen` dans le groupe A, **Then** la commande s'exécute : une autorisation « partout » vaut dans tous les groupes.
5. **Given** B autorisé partout, **When** le propriétaire saisit le numéro de B avec l'indicatif du pays, avec ou sans « + », espaces ou tirets, **Then** le panel enregistre la même personne et la reconnaît sous son numéro comme sous son identifiant LID. **When** il saisit un numéro sans indicatif ou trop court, **Then** le panel le refuse et rappelle le format attendu.

---

### User Story 4 - Voir et contrôler les permissions en place (Priority: P2)

Le propriétaire veut savoir à tout moment qui peut faire quoi. Le panel montre :

- sur la page Commandes, pour chaque commande, sa règle « partout » et le nombre de groupes qui ont une règle propre ;
- dans l'onglet « Permissions » d'un groupe, les règles de ce groupe et les personnes autorisées partout qui y ont aussi accès.

Les commandes jamais délégables apparaissent grisées, avec la raison. Chaque changement est inscrit dans le journal d'audit du panel et inclus dans les sauvegardes.

**Why this priority**: Sans cette vue, le propriétaire ne peut pas vérifier ce qu'il a ouvert. La page reste utile même si elle se limite d'abord à l'affichage.

**Independent Test**: Créer deux règles (une dans le groupe A, une partout). Les retrouver sur la page Commandes et dans l'onglet du groupe A. Les retrouver aussi dans le journal d'audit. Exporter une sauvegarde puis la restaurer sur une base vide : les règles reviennent.

**Acceptance Scenarios**:

1. **Given** la page Commandes, **When** le propriétaire l'ouvre, **Then** chaque commande indique son niveau normal, sa règle « partout » s'il y en a une, et le nombre de groupes qui ont une règle propre.
2. **Given** une commande jamais délégable (par exemple `.eval`), **When** le propriétaire tente de lui ajouter une règle, **Then** le panel l'en empêche et explique pourquoi. Une règle de ce genre envoyée directement au serveur est refusée.
3. **Given** un changement de règle, **When** il est enregistré, **Then** le journal d'audit indique la commande, la portée, le mode, les personnes ajoutées ou retirées, et la date.
4. **Given** une règle qui vise une personne sortie du groupe, **When** le propriétaire ouvre l'onglet du groupe, **Then** la personne apparaît comme « ne fait plus partie du groupe » et peut être retirée.
5. **Given** une règle sur une commande qui n'existe plus (plugin retiré), **When** le propriétaire ouvre le panel, **Then** la règle apparaît comme orpheline et peut être supprimée.
6. **Given** une sauvegarde qui contient des règles, **When** elle est restaurée, **Then** les règles s'appliquent dès le message suivant.

---

### Edge Cases

- Un sticker associé à une commande par `.setcmd` déclenche cette commande : les règles s'appliquent à l'auteur du sticker exactement comme s'il avait tapé la commande.
- Le mode « normal + ces personnes » sur une commande déjà publique ne change rien. Le panel le signale au lieu de l'interdire.
- Un membre est connu sous deux identités (numéro et LID) : il est reconnu sous l'une ou l'autre, comme le propriétaire l'est aujourd'hui.
- Une personne nommée qui envoie la commande depuis un groupe où le bot est désactivé (« ban ») n'obtient rien. La désactivation de la discussion passe avant tout.
- Une commande réservée aux groupes (`onlyGroup`) ouverte « partout » à B reste refusée en privé, avec le message habituel. Une commande réservée au privé (`onlyPm`) reste refusée en groupe.
- Une commande d'administration ouverte à un non-administrateur s'exécute, mais l'action échoue si le bot n'est pas administrateur du groupe. La commande donne alors la même réponse qu'aujourd'hui.
- `.vv` utilisée par une personne autorisée qui n'a jamais écrit au bot en privé : le bot lui envoie quand même le média en privé. Si WhatsApp refuse l'envoi, la personne n'a rien et rien n'apparaît dans le groupe (la commande reste discrète).
- Un groupe que le bot a quitté garde ses règles. Elles redeviennent actives si le bot y revient.
- Le propriétaire figure dans une liste : c'est sans effet, il a toujours accès.
- Deux onglets du panel modifient la même règle en même temps : le dernier enregistrement gagne, et le journal d'audit trace les deux.
- Le chargement des règles échoue (base indisponible) : le bot applique les niveaux normaux codés dans les plugins, comme si aucune règle n'existait. Les commandes réservées au propriétaire le restent.

## Requirements *(mandatory)*

### Functional Requirements

#### Règles

- **FR-001**: Le système MUST permettre de définir, pour n'importe quelle commande délégable, une règle par portée : un groupe précis, ou « partout » (tous les groupes et toutes les discussions privées).
- **FR-002**: Une règle MUST avoir l'un de ces deux modes, avec une liste de personnes nommées : « normal + ces personnes » (la commande garde son niveau normal et les personnes listées y ont droit en plus) ou « ces personnes seulement » (seules les personnes listées et le propriétaire y ont droit). L'absence de règle est le mode « normal ».
- **FR-003**: Une règle MUST s'appliquer à tous les alias de la commande, et à une commande déclenchée par un sticker associé.
- **FR-004**: Les bénéficiaires MUST être des personnes nommées, reconnues sous leur numéro comme sous leur identifiant LID. Une règle ne peut pas viser un rôle, les administrateurs en bloc ou « tout le monde ».
- **FR-005**: Les règles MUST être permanentes : elles persistent aux redémarrages et ne disparaissent que si le propriétaire les retire.

#### Décision d'accès

- **FR-006**: Pour une commande donnée, dans une discussion donnée, le système MUST décider dans cet ordre :
  1. une discussion où le bot est désactivé ne reçoit rien, comme aujourd'hui ;
  2. le propriétaire est toujours autorisé par les règles ;
  3. une personne listée dans la règle « partout » ou, en groupe, dans la règle de ce groupe, est autorisée par les règles ;
  4. sinon, le mode qui s'applique est celui de la règle du groupe s'il en existe une (même sans personne), sinon celui de la règle « partout », sinon « normal » ;
  5. en mode « ces personnes seulement », la personne est refusée en silence, même si la commande est par ailleurs désactivée ;
  6. sinon, les contrôles d'aujourd'hui s'appliquent dans leur ordre actuel : niveau propriétaire (sauf pour une personne autorisée par les règles), commande désactivée (pour tout le monde, propriétaire et personnes autorisées compris), contexte groupe ou privé, niveau administrateur (sauf pour une personne autorisée par les règles), avec les messages d'aujourd'hui.
- **FR-007**: Un refus dû au mode « ces personnes seulement » MUST être silencieux : pas de réponse, pas de réaction, pas de message d'erreur. Il est seulement noté dans le journal du bot.
- **FR-008**: Les contraintes de contexte d'une commande (réservée aux groupes, réservée au privé) MUST rester appliquées aux personnes autorisées, avec les messages d'aujourd'hui.
- **FR-009**: Une commande d'administration de groupe ouverte à une personne qui n'est pas administrateur MUST s'exécuter pour elle. Les vérifications que le bot fait sur ses propres droits (être administrateur du groupe) restent inchangées.
- **FR-010**: Un changement de règle MUST s'appliquer dès le message suivant, sans redémarrage.
- **FR-011**: Si les règles ne peuvent pas être lues, le système MUST appliquer les niveaux normaux des commandes, comme si aucune règle n'existait.

#### Commandes jamais délégables

- **FR-012**: Chaque commande MUST pouvoir être déclarée « jamais délégable » dans son code, avec une raison. Cette déclaration ne se change pas depuis le panel. Par défaut, une commande réservée au propriétaire n'est pas délégable, sauf si son code la déclare délégable. Toute autre commande est délégable, sauf si son code la déclare jamais délégable.
- **FR-013**: Sont déclarées jamais délégables : `.eval`/`.exec`, `.update`, `.exportcontacts`, `.ban`/`.unban`, `.setvv`/`.getvv`, `.antidel`/`.getantidel`, `.ar` (réponses automatiques), `.statussave`, `.setcmd`/`.delcmd`/`.getcmd`. Toutes les autres commandes sont délégables, y compris `.vv` et `.save`.
- **FR-014**: Le système MUST ignorer toute règle sur une commande jamais délégable, même si elle existe en base (restauration, ajout manuel). Le panel MUST refuser d'en créer une.

#### `.vv` et `.save` délégués

- **FR-015**: Quand `.vv` est utilisée par une autre personne que le propriétaire, le média révélé MUST être envoyé en privé à cette personne, jamais dans la discussion où la commande a été tapée, quel que soit le réglage de destination de l'auto-vv.
- **FR-016**: Quand `.save` est utilisée par une autre personne que le propriétaire, le média MUST être envoyé en privé à cette personne, et `.save` MUST être aussi discrète que `.vv` : aucune réaction et aucune réponse dans la discussion où la commande a été tapée, les réponses et avis (mode d'emploi, erreurs, média trop lourd) étant envoyés dans la discussion privée de cette personne.
- **FR-017**: Pour le propriétaire, `.vv` et `.save` MUST garder leur comportement actuel.
- **FR-018**: `.vv` MUST rester discrète pour une personne autorisée : rien dans le groupe quand la citation n'est pas une vue unique, que le média ne peut pas être téléchargé ou que l'envoi échoue. Le mode d'emploi (rien de cité) et l'avis « média trop lourd » lui sont envoyés en privé.

#### Panel

- **FR-019**: Les règles MUST se régler uniquement depuis le panel, par le propriétaire. Aucune commande WhatsApp ne permet de les créer, de les modifier ou de les lire, et les administrateurs de groupe ne peuvent rien accorder.
- **FR-020**: La page de chaque groupe MUST offrir un onglet « Permissions » qui liste les règles du groupe. Elle permet d'en créer, de changer leur mode et d'ajouter ou retirer des personnes choisies parmi les membres du groupe. Une règle « normal + ces personnes » sans personne est permise dans un groupe : elle y rétablit le niveau normal malgré une règle « partout », et le panel l'affiche comme une exception. L'onglet montre aussi les personnes autorisées « partout » qui ont accès dans ce groupe. Les modifications d'une règle s'enregistrent avec un bouton Enregistrer, après affichage des avertissements.
- **FR-021**: La page Commandes MUST montrer pour chaque commande son niveau normal, sa règle « partout » et le nombre de groupes qui ont une règle propre. Elle permet de régler la règle « partout » en choisissant des personnes parmi les contacts connus du bot ou en saisissant un numéro.
- **FR-022**: Le panel MUST afficher les commandes jamais délégables grisées, avec leur raison parmi cinq : elle exécute du code, elle met à jour le bot, elle exporte des données personnelles, elle peut exclure le propriétaire d'une discussion, elle règle le comportement du bot. Une raison inconnue s'affiche comme « réservée au propriétaire ».
- **FR-023**: Le panel MUST avertir clairement quand une règle ouvre une commande d'administration à une personne qui n'est pas administrateur du groupe, quand le mode « normal + ces personnes » vise une commande déjà publique, et quand une règle « ces personnes seulement » a une liste vide.
- **FR-024**: Le panel MUST signaler les personnes qui ne font plus partie du groupe et les règles sur des commandes qui n'existent plus, et permettre de les retirer.
- **FR-025**: Chaque création, modification ou suppression de règle MUST être inscrite dans le journal d'audit du panel : commande, portée, mode, personnes ajoutées ou retirées.
- **FR-026**: Les règles MUST être incluses dans les sauvegardes du panel et rétablies par une restauration.
- **FR-027**: Tous les textes ajoutés (panel et bot) MUST exister en français et en anglais.
- **FR-030**: L'action « Oublier ce groupe » du panel MUST aussi supprimer les règles de ce groupe. Un groupe que le bot quitte garde ses règles.
- **FR-031**: Un numéro saisi MUST comporter l'indicatif du pays (8 à 15 chiffres). Les espaces, le « + », les tirets, les points, les parenthèses et un « 00 » en tête sont ignorés. Le panel n'exige pas que la personne soit membre du groupe au moment de l'enregistrement, puisque le bot peut être hors ligne : il la signale comme « ne fait plus partie du groupe » quand c'est le cas.

#### Menu et aide

- **FR-028**: Le menu et l'aide MUST montrer à chaque personne les commandes qu'elle peut utiliser dans la discussion courante, selon la même décision que FR-006 : une commande qui lui est ouverte y apparaît, une commande qui lui est fermée par le mode « ces personnes seulement » n'y apparaît pas. L'aide sur une commande fermée à la personne se comporte comme pour une commande inconnue.
- **FR-029**: Sans aucune règle, le menu et l'aide MUST afficher exactement ce qu'ils affichent aujourd'hui.

### Key Entities

- **Règle de permission**: une commande (son nom principal), une portée (un groupe ou « partout »), un mode (« normal + ces personnes » ou « ces personnes seulement »), et des dates de création et de modification. Une seule règle par couple commande et portée.
- **Bénéficiaire**: une personne nommée dans une règle, identifiée par son numéro, avec l'identifiant LID connu quand il existe. Elle appartient à une règle, et une personne n'apparaît qu'une fois par règle.
- **Commande** (existante) : gagne un attribut « jamais délégable », déclaré dans son code. Son niveau normal (public, administrateurs, propriétaire) ne change pas.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Le propriétaire peut confier `.vv` à un membre d'un groupe depuis le panel en moins d'une minute, sans toucher au code ni à la configuration et sans redémarrer.
- **SC-002**: Dans 100 % des cas testés, un média révélé par `.vv` à la demande d'une personne autre que le propriétaire n'apparaît que dans la discussion privée de cette personne.
- **SC-003**: Aucune commande jamais délégable ne peut être exécutée par une autre personne que le propriétaire, quelles que soient les règles en base, y compris après la restauration d'une sauvegarde modifiée à la main.
- **SC-004**: Sans aucune règle, le comportement de chaque commande, du menu et de l'aide est identique à celui d'avant la fonctionnalité. Les tests existants sur les commandes, le registre, le pipeline, le menu et l'aide passent sans modification de leurs attentes. Seuls les tests qui comptent les tables, les modèles sauvegardés ou les champs du panel sont mis à jour pour la nouvelle table.
- **SC-005**: Un changement de règle prend effet sur le message suivant. Le traitement d'une commande ne ralentit pas de façon perceptible, y compris avec plusieurs centaines de règles.
- **SC-006**: Le propriétaire peut répondre à « qui peut utiliser telle commande dans tel groupe ? » depuis une seule page du panel.

## Assumptions

- Le système s'appuie sur le panel de la fonctionnalité 002 (authentification, journal d'audit, sauvegardes, page Groupes avec la liste des membres, page Commandes, désactivation des commandes), fusionné sur `master`. Cette branche part de `master`.
- Un seul propriétaire administre le panel. Les « propriétaires » au sens du bot sont les numéros de SUDO, qui ont toujours accès.
- Les rôles de groupe existants (`.role` : vip, muted, banned) ne changent pas et n'interviennent pas dans les permissions. Un membre « muted » ou « banned » reste traité par `.role` comme aujourd'hui, même s'il est nommé dans une règle.
- Le mode « normal » n'est pas stocké. Supprimer la règle « partout » ramène la commande à son niveau normal. Supprimer la règle d'un groupe y rétablit ce que dit la règle « partout ».
- Une personne est enregistrée sous son numéro dès qu'il est connu, comme pour les rôles de groupe. Un identifiant LID seul est accepté quand le numéro est inconnu.
- Hors périmètre : l'auto-vv des vues uniques reçues en privé (voir Contexte) ; la gestion des permissions par commande WhatsApp ; les lots de commandes et les catégories ; les permissions temporaires ; la délégation du droit d'accorder des permissions ; l'accès au panel pour d'autres personnes que le propriétaire.

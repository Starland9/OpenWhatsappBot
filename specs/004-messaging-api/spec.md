# Feature Specification: API d'envoi de messages

**Feature Branch**: `004-messaging-api`

**Created**: 2026-11-02

**Status**: Draft

**Input**: User description: "Impl un client de sendMessage a multi format pour que je puisse send un message via api et rend le client vraiment modulaire car dans le futur il se pourrait que je rajoute une panoplie de end point et surtout pense a la secu" — reformulé : API HTTP qui permet à un programme externe de faire envoyer par le bot des messages WhatsApp de tous formats (texte, médias, localisation, contact, sondage, boutons et listes). Elle sert de socle modulaire : d'autres endpoints s'y ajouteront plus tard sans toucher au reste. La sécurité passe en premier.

## Contexte

Aujourd'hui, le bot n'envoie un message que dans trois cas : en réponse à une commande WhatsApp, par le répondeur automatique, ou par une diffusion lancée depuis le panel (fonctionnalité 002 : une image ou un document avec un texte, au plus 200 destinataires, sous la session du propriétaire). Un programme externe ne peut pas lui demander d'envoyer un message : ni un outil d'automatisation (n8n, Make), ni un site web, ni un CRM, ni un script lancé par un cron. Le seul point d'entrée HTTP protégé par jeton est l'ancien redémarrage.

Le propriétaire veut pouvoir écrire « envoie cette facture en PDF à ce client » ou « préviens ce groupe que le serveur est tombé » depuis n'importe quel programme. Il veut aussi pouvoir ajouter d'autres endpoints plus tard (lire des messages, réagir, supprimer, gérer des groupes…) sans réécrire ce qui existe.

Quatre risques encadrent la fonctionnalité :

- **le bannissement du numéro** : WhatsApp sanctionne les comptes qui envoient en masse ou trop vite, surtout à des inconnus ;
- **la clé volée** : quiconque la détient parle au nom du propriétaire ;
- **l'escalade** : le bot traite ses propres messages comme ceux du propriétaire. Un texte envoyé par l'API qui commence par le préfixe ne doit jamais devenir une commande ;
- **le téléchargement d'URL** : un bot qui va chercher un fichier à une adresse donnée peut être détourné vers le réseau interne de l'hébergeur.

## Clarifications

### Session 2026-11-02

- Q: Qui appelle l'API, et comment s'authentifie-t-on ? → A: Avec des clés nommées, créées dans le panel. Chacune a ses propres droits par famille d'endpoints. Elle est révocable et peut avoir une expiration et une liste d'adresses IP. Elle n'est affichée qu'une fois, puis stockée sous une forme irréversible.
- Q: À qui une clé peut-elle envoyer ? → A: Chaque clé a sa politique de destinataires : une liste de numéros et de groupes, ou « discussions connues du bot », ou « n'importe qui ». Cette dernière s'active explicitement, avec un avertissement.
- Q: Quels formats dans la première version ? → A: Tous : texte, médias (image, vidéo, GIF, audio, note vocale, document, sticker), localisation, contact, sondage, boutons et listes.
- Q: Comment l'appelant fournit-il un média ? → A: En envoyant le fichier dans la requête, ou en donnant une URL publique que le bot télécharge sous protection stricte. Pas de base64 dans le JSON ni de média pré-téléversé dans cette version.
- Q: Que renvoie l'API quand on demande un envoi ? → A: Une réponse immédiate avec un identifiant. L'envoi passe par une file cadencée, et un endpoint donne son statut. Une option « attendre le résultat » retient la réponse jusqu'à 30 secondes.
- Q: Que couvre « client modulaire » ? → A: L'API côté serveur uniquement. Un nouvel endpoint ou un nouveau format s'ajoute comme un module, sans modifier le reste. Une description lisible par machine permet de générer un client dans n'importe quel langage. Pas de SDK ni d'outil en ligne de commande.
- Q: D'où l'API est-elle appelée ? → A: D'Internet, en HTTPS, exposée comme le panel. Elle est désactivée par défaut et s'active dans le panel. Une clé reçue en HTTP clair est refusée, sauf en local.
- Q: Que garde-t-on des messages envoyés ? → A: Les métadonnées seules : clé, destinataire (masqué dans les journaux), format, taille, statut, horodatages. Jamais le texte ni le média. L'historique se consulte dans le panel et est purgé après 30 jours.
- Q: L'appelant récupère-t-il les réponses aux boutons, listes et sondages ? → A: Oui, par le suivi du message : choix, auteur, heure, pendant la durée de conservation. Pas d'appel sortant : les rappels (webhooks) viendront plus tard.
- Q: Que propose le panel ? → A: Une page API : gestion des clés et de leurs droits, historique des envois, et un formulaire d'essai qui envoie avec le même moteur que l'API.
- Q: Quelles limites de débit par défaut ? → A: Des limites prudentes, réglables dans le panel : au moins 2 secondes entre deux messages, 30 envois par minute et 1 000 par jour par clé. Au-delà, un refus clair indique le délai à attendre.

### Session 2026-11-02 (clarify)

- Q: Faut-il retaper le mot de passe du panel avant une action sensible sur l'API ? → A: Oui. Le mot de passe est redemandé pour activer l'API, créer ou dupliquer une clé, élargir ses droits, passer sa politique à « n'importe qui » ou élargir ses restrictions d'IP. La confirmation vaut 5 minutes. Révoquer, restreindre ou couper l'API reste immédiat, sans mot de passe.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Envoyer un texte depuis un programme externe (Priority: P1)

Le propriétaire active l'API dans le panel, puis crée une clé nommée « n8n ». Il lui donne le droit d'envoyer du texte et l'autorise à écrire à deux numéros. Le panel affiche la clé une seule fois. Il la colle dans son outil d'automatisation, qui envoie une requête : destinataire, texte. L'API répond aussitôt avec un identifiant de message et le statut « en file ». Quelques secondes plus tard, le destinataire reçoit le texte, envoyé par le compte du bot.

**Why this priority**: C'est le besoin exprimé. Cette histoire pose aussi tout le socle de sécurité (activation, clés, droits, politique de destinataires, débit, file) que les autres histoires réutilisent. Livrée seule, elle a déjà de la valeur.

**Independent Test**: Activer l'API, créer une clé « texte » limitée à un numéro de test, envoyer un texte avec un client HTTP quelconque, vérifier la réception, puis vérifier chaque refus (pas de clé, mauvaise clé, clé révoquée, destinataire hors liste, droit manquant).

**Acceptance Scenarios**:

1. **Given** l'API désactivée (réglage par défaut), **When** un programme appelle n'importe quel endpoint de l'API, **Then** la réponse est celle d'une adresse inexistante, sans indice que l'API existe.
2. **Given** l'API activée, **When** le propriétaire crée une clé, **Then** le secret complet s'affiche une seule fois avec un bouton « copier » ; ensuite le panel ne montre que son nom et ses 4 derniers caractères.
3. **Given** une clé avec le droit « texte » et un numéro autorisé, **When** elle demande l'envoi d'un texte à ce numéro, **Then** l'API répond immédiatement avec un identifiant et le statut « en file », et le statut passe à « envoyé » une fois que WhatsApp a accepté le message.
4. **Given** la même requête renvoyée avec la même clé d'idempotence moins de 24 heures après, **When** l'API la reçoit, **Then** elle renvoie le même identifiant et n'envoie pas de second message.
5. **Given** une requête sans clé, avec une clé inconnue, révoquée ou expirée, ou venant d'une IP hors de la liste de la clé, **When** l'API la reçoit, **Then** elle la refuse avec un code explicite, rien n'est envoyé et l'échec compte pour le blocage de l'origine.
6. **Given** une clé valide, **When** elle vise un destinataire hors de sa politique, **Then** le refus porte le code `recipient_not_allowed` et rien n'est mis en file.
7. **Given** une clé valide, **When** elle envoie un texte qui commence par le préfixe des commandes (par exemple `.eval …`), **Then** le destinataire reçoit le texte tel quel et le bot ne l'exécute jamais comme une commande.
8. **Given** une requête qui porte la clé dans l'adresse (URL) plutôt que dans l'en-tête prévu, ou qui arrive en HTTP clair depuis une autre machine que le serveur lui-même, **When** l'API la reçoit, **Then** elle la refuse sans utiliser la clé.
9. **Given** l'option « attendre le résultat », **When** l'envoi aboutit en moins de 30 secondes, **Then** la réponse contient directement le statut final ; sinon elle contient le statut du moment.

---

### User Story 2 - Envoyer des médias, par fichier ou par URL (Priority: P1)

Le propriétaire donne à sa clé « facturation » le droit d'envoyer des documents. Son logiciel envoie un PDF dans la requête, avec un nom de fichier et une légende. Le client reçoit le document. Un autre script envoie une image en donnant son URL publique : le bot la télécharge, vérifie que c'est bien une image et l'envoie.

**Why this priority**: « Multi-format » est au cœur de la demande, et les médias en sont la plus grande partie. Le téléchargement par URL est aussi le point le plus risqué pour la sécurité.

**Independent Test**: Envoyer un fichier de chaque format média (image, vidéo, GIF, audio, note vocale, document, sticker) depuis un fichier puis depuis une URL. Vérifier le rendu sur un vrai téléphone. Rejouer la batterie d'URL piégées et vérifier qu'aucune n'atteint sa cible.

**Acceptance Scenarios**:

1. **Given** une clé avec le droit « image », **When** elle envoie un fichier image avec une légende, **Then** le destinataire reçoit l'image légendée.
2. **Given** un fichier audio envoyé au format « note vocale », **When** le message arrive, **Then** il se lit comme une note vocale, pas comme un fichier audio.
3. **Given** une image envoyée au format « sticker », **When** le message arrive, **Then** c'est un sticker.
4. **Given** un fichier dont le contenu réel ne correspond pas au format demandé (un exécutable déclaré comme image), **When** l'API le reçoit, **Then** elle le refuse avec le code `media_type_mismatch` et ne garde pas le fichier.
5. **Given** un fichier plus lourd que la limite du format, **When** l'API le reçoit, **Then** elle coupe la réception dès que la limite est dépassée et refuse avec `media_too_large`.
6. **Given** une clé avec le droit « média par URL », **When** elle donne une URL HTTPS publique qui renvoie une image, **Then** le bot la télécharge, la vérifie et l'envoie.
7. **Given** une URL qui vise, directement ou après une redirection, une adresse privée, locale ou réservée (réseau interne, boucle locale, service de métadonnées de l'hébergeur), **When** l'API la reçoit, **Then** elle refuse avec `url_forbidden` et aucune connexion n'atteint cette adresse.
8. **Given** une clé sans le droit « média par URL », **When** elle donne une URL, **Then** le refus porte le code `forbidden` et rien n'est téléchargé.

---

### User Story 3 - Suivre un envoi et consulter l'historique (Priority: P2)

Le script qui a demandé un envoi interroge son statut avec l'identifiant reçu : « en file », « envoyé », puis « distribué » et « lu » quand WhatsApp les communique, ou « échec » avec la raison. Dans le panel, le propriétaire voit l'historique de tous les envois de l'API, filtrable par clé, statut, format et période.

**Why this priority**: Avec une file, l'appelant doit pouvoir savoir ce qu'il est advenu de son message. C'est aussi l'outil de diagnostic du propriétaire.

**Independent Test**: Envoyer un message, suivre son statut jusqu'à « lu ». Provoquer un échec (numéro absent de WhatsApp) et un message expiré (bot déconnecté plus de 10 minutes). Vérifier que l'historique montre chaque cas sans le contenu des messages.

**Acceptance Scenarios**:

1. **Given** un message envoyé, **When** l'appelant demande son statut, **Then** il reçoit le statut courant et l'heure de chaque étape franchie.
2. **Given** un numéro qui n'utilise pas WhatsApp, **When** l'envoi est tenté, **Then** le message passe à « échec » avec le code `not_on_whatsapp`.
3. **Given** le bot déconnecté, **When** un message attend plus de 10 minutes, **Then** il passe à « expiré » et n'est jamais envoyé plus tard.
4. **Given** deux clés, **When** l'une demande le statut d'un message de l'autre, **Then** la réponse est « introuvable », comme pour un identifiant qui n'existe pas.
5. **Given** l'historique du panel, **When** le propriétaire l'ouvre, **Then** il voit pour chaque envoi la clé, le destinataire, le format, la taille, le statut et les heures, jamais le texte ni le média.
6. **Given** un envoi vieux de plus de 30 jours, **When** le nettoyage quotidien passe, **Then** l'envoi et ses réponses sont supprimés.

---

### User Story 4 - Gérer les clés et essayer depuis le panel (Priority: P2)

Le propriétaire ouvre la page API du panel. Il voit ses clés : nom, droits, politique de destinataires, limites, date de dernière utilisation et dernière IP. Il retire à une clé le droit d'envoyer des vidéos, réduit son quota journalier, ajoute une date d'expiration. Il soupçonne une fuite : il duplique la clé (même réglages, nouveau secret), met à jour son programme, puis révoque l'ancienne. Avant de brancher un nouvel outil, il essaie un sondage depuis le formulaire d'essai.

**Why this priority**: Sans gestion fine des clés, la sécurité repose sur une seule clé à tout faire. Le formulaire d'essai évite de déboguer à l'aveugle.

**Independent Test**: Créer, modifier, dupliquer et révoquer une clé, et vérifier l'effet immédiat de chaque action sur les requêtes. Envoyer un message de chaque format depuis le formulaire d'essai. Vérifier le journal d'audit.

**Acceptance Scenarios**:

1. **Given** une clé active, **When** le propriétaire lui retire un droit, **Then** la requête suivante qui en a besoin est refusée.
2. **Given** une clé avec des messages en file, **When** le propriétaire la révoque (avec confirmation), **Then** ses requêtes suivantes sont refusées et ses messages en file passent à « annulé ».
3. **Given** une clé, **When** le propriétaire la duplique, **Then** une nouvelle clé aux mêmes réglages est créée avec un nouveau secret, affiché une fois ; l'ancienne reste valide jusqu'à sa révocation.
4. **Given** le formulaire d'essai, **When** le propriétaire choisit un format, un destinataire et un contenu, **Then** le message part avec le même moteur et les mêmes contrôles que l'API (sauf la clé), apparaît dans l'historique avec la source « panel » et respecte le même espacement.
5. **Given** toute création, modification, duplication ou révocation de clé, et tout changement de l'interrupteur de l'API, **When** l'action est enregistrée, **Then** une entrée d'audit la décrit, sans aucun secret.
6. **Given** la politique « n'importe qui », **When** le propriétaire la choisit pour une clé, **Then** le panel affiche l'avertissement sur le risque de bannissement et demande une confirmation.
7. **Given** une session du panel ouverte depuis plus de 5 minutes sans confirmation du mot de passe, **When** le propriétaire crée une clé ou élargit ses droits, **Then** le panel lui redemande son mot de passe avant d'enregistrer ; un mauvais mot de passe n'enregistre rien.
8. **Given** une clé active, **When** le propriétaire la révoque ou lui retire un droit, **Then** l'action s'applique sans demander le mot de passe.

---

### User Story 5 - Envoyer une localisation, un contact ou un sondage (Priority: P3)

Un livreur partage par l'API la position du point de retrait. Une boutique envoie la carte de contact de son service client. Un club envoie un sondage « quel jour pour l'entraînement ? » dans son groupe, puis lit les votes par le suivi du message.

**Why this priority**: Ces formats complètent l'offre et sont simples à valider, mais ils servent moins souvent que le texte et les médias.

**Independent Test**: Envoyer une localisation, un contact et un sondage à un téléphone de test. Vérifier le rendu natif de chacun. Voter au sondage et lire les votes dans le suivi.

**Acceptance Scenarios**:

1. **Given** une latitude, une longitude, et éventuellement un nom et une adresse, **When** la localisation est envoyée, **Then** le destinataire voit une carte native ouvrable.
2. **Given** un nom et au moins un numéro avec indicatif, **When** le contact est envoyé, **Then** le destinataire peut l'enregistrer d'un geste.
3. **Given** une question et 2 à 12 options distinctes, à choix unique ou multiple, **When** le sondage est envoyé, **Then** le destinataire voit un sondage natif.
4. **Given** un sondage envoyé, **When** des membres votent ou changent leur vote, **Then** le suivi du message montre le dernier vote de chaque votant et le total par option.
5. **Given** une latitude hors limites, une seule option de sondage ou des options en double, **When** l'API reçoit la requête, **Then** elle la refuse champ par champ, sans rien mettre en file.

---

### User Story 6 - Boutons et listes, avec récupération des réponses (Priority: P3)

Une clinique envoie « Confirmez-vous votre rendez-vous de demain ? » avec deux boutons, « Oui » et « Non ». Le patient touche « Oui », ou répond « 1 » en citant le message si son téléphone n'affiche pas les boutons. Le logiciel de la clinique lit la réponse par le suivi du message.

**Why this priority**: C'est le format le plus utile pour l'automatisation, mais il dépend du suivi (histoire 3) et WhatsApp n'affiche pas les boutons natifs sur tous les téléphones.

**Independent Test**: Envoyer des boutons et une liste à deux téléphones de test, l'un qui affiche les boutons natifs, l'autre non. Répondre par un toucher, puis par un numéro cité. Vérifier les réponses dans le suivi et l'absence de toute autre réaction du bot.

**Acceptance Scenarios**:

1. **Given** un texte et 1 à 3 boutons (identifiant et libellé chacun), **When** le message est envoyé, **Then** le destinataire voit les boutons, ou leur version texte numérotée si son téléphone ne les affiche pas.
2. **Given** une liste d'au plus 10 choix, **When** elle est envoyée, **Then** le destinataire peut ouvrir la liste et choisir, ou répondre par le numéro du choix.
3. **Given** un message à boutons envoyé par l'API, **When** le destinataire touche un bouton ou répond par son numéro en citant le message, **Then** le suivi enregistre l'identifiant du choix, son auteur et l'heure.
4. **Given** une réponse à un bouton de l'API, **When** le bot la reçoit, **Then** elle ne déclenche ni le répondeur automatique, ni une commande, ni le bouton d'une autre fonction du bot.
5. **Given** une réponse arrivée plus de 7 jours après l'envoi, **When** le bot la reçoit, **Then** elle n'est plus enregistrée.

---

### User Story 7 - Ajouter un endpoint ou un format sans toucher au reste (Priority: P3)

Six mois plus tard, le propriétaire (ou un développeur) veut ajouter un endpoint « réagir à un message » et un format « carte produit ». Il écrit un module par ajout : ce que l'endpoint attend, le droit qu'il exige, ses limites, ce qu'il renvoie. Au démarrage suivant, l'endpoint fonctionne. Il apparaît dans la documentation de l'API et dans la liste des droits du panel, et pour un format, dans le formulaire d'essai. Aucune clé existante n'en reçoit le droit sans action du propriétaire.

**Why this priority**: C'est la demande « vraiment modulaire ». Elle ne livre rien de visible au premier jour, mais elle fixe la forme de tout le reste, et la sécurité d'un futur endpoint ne doit pas dépendre de la vigilance de celui qui l'écrit.

**Independent Test**: Ajouter un endpoint et un format factices dans un test, sans modifier d'autre fichier que leurs textes traduits. Vérifier qu'ils sont servis, documentés et proposés dans le panel, et qu'un endpoint déclaré sans droit empêche le démarrage.

**Acceptance Scenarios**:

1. **Given** un nouveau module de format, **When** le bot démarre, **Then** le format est accepté par l'endpoint d'envoi, documenté, proposé dans les droits des clés, dans les filtres de l'historique et dans le formulaire d'essai.
2. **Given** un nouvel endpoint qui ne déclare pas le droit qu'il exige, **When** le bot démarre, **Then** le démarrage de l'API échoue avec un message qui nomme l'endpoint, et aucun endpoint de l'API n'est servi.
3. **Given** un nouvel endpoint ou format, **When** le propriétaire ouvre une clé existante, **Then** le nouveau droit y est décoché.
4. **Given** un module d'endpoint, **When** il traite une requête, **Then** l'authentification, le contrôle de l'origine, le contrôle du HTTPS, les droits, les quotas, la validation et le format des erreurs ont déjà été appliqués par le socle commun, que le module ne peut pas contourner.

---

### Edge Cases

- **Bot déconnecté** : les requêtes sont acceptées et attendent dans la file ; un message non envoyé après 10 minutes passe à « expiré ».
- **Bot qui démarre, ou restauration d'une sauvegarde en cours** : l'API répond « indisponible, réessayez » avec un délai conseillé et ne met rien en file.
- **Redémarrage du bot avec des messages en file** : ils reprennent après le redémarrage, sauf ceux qui ont expiré entre-temps. Un message dont l'envoi était en cours à l'arrêt passe à « incertain » et n'est jamais renvoyé : un message n'est jamais envoyé deux fois.
- **API coupée dans le panel** : les nouvelles requêtes sont refusées comme une adresse inexistante ; les messages en file passent à « annulé ».
- **Clé révoquée ou expirée avec des messages en file** : ils passent à « annulé ».
- **Rafale de requêtes** : au-delà du quota par minute, par jour ou du nombre de messages en attente de la clé, la requête est refusée avec le délai à attendre ; la file n'envoie jamais deux messages à moins de 2 secondes d'écart.
- **Diffusion du panel en cours** : l'espacement de 2 secondes vaut pour tous les envois automatiques, diffusions et API confondus.
- **Brute-force sur les clés** : après 10 échecs d'authentification en 5 minutes depuis la même origine, celle-ci est bloquée 15 minutes et les propriétaires reçoivent une alerte.
- **Clé utilisée depuis une IP jamais vue** : alerte facultative aux propriétaires (activable dans le panel).
- **Groupe dont le bot n'est plus membre, ou où seuls les administrateurs peuvent écrire** : l'envoi passe à « échec » avec un code qui le dit.
- **Discussion désactivée dans le bot** (commande `ban`) : l'envoi est refusé avec `chat_disabled`.
- **Numéro mal formé** : l'indicatif du pays est exigé ; espaces, « + », tirets, points, parenthèses et « 00 » en tête sont ignorés (mêmes règles que la fonctionnalité 003).
- **Clé d'idempotence réutilisée avec un contenu différent** : refus avec `idempotency_conflict`, rien n'est envoyé.
- **Champ inconnu dans la requête** : refus avec la liste des champs fautifs ; rien n'est mis en file.
- **Texte trop long** : plus de 4 096 caractères pour un texte, ou plus de 1 024 pour une légende : refus.
- **Conversion impossible** (audio illisible pour une note vocale, image corrompue pour un sticker) : l'envoi passe à « échec » avec `media_conversion_failed`.
- **URL lente, énorme ou qui ment sur sa taille** : le téléchargement s'arrête à 30 secondes ou à la limite de taille, quelle que soit la taille annoncée par le serveur distant.
- **URL avec identifiants** (`https://user:pass@…`), en HTTP clair, ou vers un port inhabituel : refus avec `url_forbidden`.
- **Nom de domaine qui change d'adresse entre la vérification et le téléchargement** : l'adresse est vérifiée au moment de la connexion, à chaque redirection (3 au plus).
- **Citation d'un message** : seul un message envoyé par l'API dans la même discussion, encore dans l'historique, peut être cité ; sinon refus.
- **Aperçu de lien demandé** : il exige le droit « média par URL » et passe par les mêmes protections que le téléchargement d'une URL.
- **Appel depuis le navigateur d'un site tiers** : refusé ; l'API n'est pas faite pour être appelée depuis une page web, où la clé serait visible.
- **Cookie de session du panel présenté à l'API, ou clé d'API présentée au panel** : sans effet ; les deux accès sont séparés.

## Requirements *(mandatory)*

### Functional Requirements

#### Activation et exposition

- **FR-001**: L'API MUST être désactivée par défaut et ne s'activer que depuis le panel, par un propriétaire, avec confirmation du mot de passe (FR-021). Désactivée, chacun de ses endpoints MUST répondre comme une adresse inexistante, et aucune file ni minuterie de l'API ne MUST tourner.
- **FR-002**: Couper l'API MUST refuser immédiatement toute nouvelle requête et faire passer les messages en file à « annulé ».
- **FR-003**: L'API MUST refuser une clé reçue sur une connexion non chiffrée, sauf si la requête vient de la machine elle-même. Derrière un proxy de confiance (même réglage que le panel), elle MUST se fier à ce que le proxy déclare du chiffrement.
- **FR-004**: L'API MUST être réservée aux appels de programme à programme : aucune autorisation d'appel depuis une page web d'un autre site. Une session du panel MUST NOT donner accès à l'API, et une clé d'API MUST NOT donner accès au panel.
- **FR-005**: L'API MUST être versionnée : un changement incompatible MUST passer par une nouvelle version, et la version en cours MUST continuer de fonctionner.
- **FR-006**: Pendant le démarrage du bot et pendant une restauration de sauvegarde, l'API MUST répondre « indisponible » avec un délai conseillé, sans rien mettre en file.
- **FR-007**: L'API MUST être servie par le même serveur que le panel et MUST NOT exister quand le panel est désactivé (les clés se gèrent dans le panel).

#### Clés et droits

- **FR-010**: Un propriétaire MUST pouvoir créer depuis le panel une clé nommée. Son secret MUST être aléatoire, d'au moins 256 bits, et commencer par un préfixe fixe que les outils de détection de secrets savent reconnaître. Il MUST être affiché une seule fois, puis conservé sous une forme irréversible. Le panel MUST ensuite n'en montrer que le nom et les 4 derniers caractères.
- **FR-011**: Chaque clé MUST porter une liste de droits, un par endpoint et, pour l'envoi, un par format, plus un droit distinct « média par URL ». Les droits MUST suivre le principe du refus par défaut : une clé neuve n'en a aucun, et un endpoint ou un format ajouté plus tard n'est accordé à aucune clé existante.
- **FR-012**: Chaque clé MUST porter une politique de destinataires : « liste » (numéros et groupes nommés), « discussions connues du bot » (groupes où il est membre et contacts qui lui ont déjà écrit) ou « n'importe qui ». La politique d'une clé neuve MUST être « liste » vide, et « n'importe qui » MUST exiger une confirmation après un avertissement sur le risque de bannissement.
- **FR-013**: Chaque clé MUST pouvoir porter une liste facultative d'adresses ou de plages IP autorisées, et une date d'expiration facultative.
- **FR-014**: La révocation d'une clé MUST prendre effet à la requête suivante. Les messages en file de cette clé MUST passer à « annulé ».
- **FR-015**: Un propriétaire MUST pouvoir dupliquer une clé : même nom suivi d'un suffixe, mêmes droits, politique, limites et restrictions, nouveau secret affiché une fois. L'ancienne clé reste valide jusqu'à sa révocation.
- **FR-016**: La clé MUST être lue uniquement dans l'en-tête prévu. Une requête qui porte une clé dans l'adresse MUST être refusée sans que la clé soit utilisée.
- **FR-017**: Le secret d'une clé MUST NOT apparaître dans les journaux, l'historique, l'audit, les messages d'erreur ou les réponses de l'API. Seuls ses 4 derniers caractères peuvent être affichés, et seulement dans le panel.
- **FR-018**: Après 10 échecs d'authentification en 5 minutes depuis la même origine, l'API MUST bloquer cette origine pendant 15 minutes et le signaler aux propriétaires (alerte « origine bloquée », activable).
- **FR-019**: Le panel MUST montrer pour chaque clé la date de sa dernière utilisation et la dernière IP. Une alerte facultative MUST pouvoir prévenir les propriétaires quand une clé sert depuis une IP jamais vue pour elle.
- **FR-020**: L'activation et la désactivation de l'API, ainsi que la création, la modification, la duplication et la révocation d'une clé, MUST produire chacune une entrée d'audit sans secret.
- **FR-021**: Le panel MUST redemander le mot de passe du propriétaire avant d'enregistrer une action qui élargit l'accès : activer l'API, créer ou dupliquer une clé, lui ajouter un droit, passer sa politique de destinataires à un mode plus large ou ajouter des destinataires, élargir ou retirer ses restrictions d'IP, repousser ou retirer son expiration. Une confirmation réussie MUST valoir 5 minutes pour la session qui l'a obtenue. Les mauvais mots de passe MUST être limités comme les tentatives de connexion au panel. Les actions qui restreignent l'accès (révoquer, retirer un droit, réduire une liste, couper l'API) MUST rester possibles sans mot de passe.

#### Envoi : règles communes à tous les formats

- **FR-030**: Une requête d'envoi MUST viser un seul destinataire : un numéro avec indicatif du pays, normalisé comme dans la fonctionnalité 003, ou un identifiant de groupe tel que le panel l'affiche.
- **FR-031**: Une requête MUST être validée strictement avant toute mise en file : un champ inconnu, manquant ou hors limites MUST entraîner un refus qui liste chaque champ fautif avec un code ; rien n'est alors mis en file.
- **FR-032**: Les contrôles MUST s'appliquer dans cet ordre, et le premier qui échoue donne la réponse : clé valide, droit pour l'endpoint et le format, politique de destinataires, discussion non désactivée dans le bot, quotas, contenu.
- **FR-033**: Une requête acceptée MUST recevoir aussitôt un identifiant de message impossible à deviner et le statut « en file ». Avec l'option « attendre le résultat », la réponse MUST arriver dès que le message est envoyé ou en échec, et au plus tard 30 secondes après, avec le statut du moment.
- **FR-034**: Une requête MUST pouvoir porter une clé d'idempotence. Pendant 24 heures, la même clé d'API avec la même clé d'idempotence MUST renvoyer le message déjà créé sans renvoyer de message. Avec un contenu différent, la requête MUST être refusée avec `idempotency_conflict`.
- **FR-035**: La file MUST espacer d'au moins 2 secondes, plus un aléa de 0 à 20 %, deux envois automatiques, API et diffusions du panel confondus. L'espacement MUST être réglable vers le haut uniquement.
- **FR-036**: Chaque clé MUST avoir un quota par minute (30 par défaut), un quota par jour (1 000 par défaut) et un nombre maximal de messages en attente (100 par défaut), réglables dans le panel. La file entière MUST être plafonnée à 500 messages en attente (réglable). Au-delà, la requête MUST être refusée avec le délai à attendre.
- **FR-037**: Un message non envoyé 10 minutes (réglable) après son acceptation MUST passer à « expiré » et ne jamais partir ensuite.
- **FR-038**: Les messages en file MUST survivre à un redémarrage du bot. Un message dont l'envoi était en cours à l'arrêt MUST passer à « incertain » et ne jamais être renvoyé : aucun message n'est envoyé deux fois.
- **FR-039**: Le bot MUST NOT interpréter un message envoyé par l'API comme une commande, comme une réponse à un bouton ou comme un message à traiter, quel que soit son contenu.
- **FR-040**: Avant d'envoyer à un numéro inconnu du bot, celui-ci MUST vérifier qu'il utilise WhatsApp ; sinon l'envoi passe à « échec » avec `not_on_whatsapp`. Un groupe où le bot ne peut pas écrire MUST donner un échec avec un code qui le dit.
- **FR-041**: Un envoi vers une discussion désactivée dans le bot MUST être refusé avec `chat_disabled`.
- **FR-042**: Un texte MUST pouvoir mentionner des participants par leur numéro (dans un groupe), et citer un message envoyé par l'API dans la même discussion et encore présent dans l'historique.
- **FR-043**: L'aperçu de lien MUST être désactivé par défaut. Demandé, il MUST exiger le droit « média par URL » et passer par les protections de FR-060.

#### Formats

- **FR-050**: **Texte** : 1 à 4 096 caractères.
- **FR-051**: **Médias** : image, vidéo, GIF (lu en boucle), audio (fichier), note vocale (convertie au format vocal de WhatsApp), document (nom de fichier assaini) et sticker (converti depuis une image). Image, vidéo, GIF et document MUST accepter une légende de 1 024 caractères au plus.
- **FR-052**: Le type réel d'un média MUST être déterminé d'après son contenu, jamais d'après ce que déclare l'appelant. Un contenu qui ne correspond pas au format MUST être refusé avec `media_type_mismatch`.
- **FR-053**: Un média MUST respecter la limite de taille des médias du bot (réglage existant) et la limite propre à son format. La réception MUST s'arrêter dès que la limite est dépassée.
- **FR-054**: **Localisation** : latitude entre -90 et 90, longitude entre -180 et 180, nom et adresse facultatifs de 256 caractères au plus.
- **FR-055**: **Contact** : 1 à 10 cartes. Chacune a un nom affiché obligatoire, au moins un numéro avec indicatif, et une organisation et un e-mail facultatifs. La carte MUST être construite par le bot à partir de ces champs ; l'appelant ne fournit jamais le contenu brut de la carte.
- **FR-056**: **Sondage** : une question de 255 caractères au plus, 2 à 12 options distinctes de 100 caractères au plus, choix unique ou multiple.
- **FR-057**: **Boutons** : un texte et 1 à 3 boutons ; **liste** : un texte, un libellé de bouton et 1 à 10 choix, chacun avec un titre et une description facultative. Chaque bouton ou choix porte un identifiant fourni par l'appelant, de 64 caractères au plus pris dans un jeu restreint. L'identifiant MUST être isolé des boutons des autres fonctions du bot. Le message MUST inclure la version texte numérotée pour les téléphones qui n'affichent pas les boutons natifs.
- **FR-058**: Une conversion de média qui échoue MUST faire passer l'envoi à « échec » avec `media_conversion_failed`.

#### Média par URL

- **FR-060**: Le téléchargement d'un média par URL MUST exiger le droit « média par URL » et respecter toutes ces règles :
  - HTTPS uniquement, sans identifiants dans l'URL, sur le port standard ;
  - adresse de destination publique, vérifiée au moment de la connexion : sont refusées les adresses privées, de boucle locale, locales au lien (dont les services de métadonnées des hébergeurs), multicast et réservées, en IPv4 comme en IPv6, formes déguisées comprises ;
  - même vérification à chaque redirection, 3 redirections au plus ;
  - 30 secondes au plus en tout ; arrêt dès que la limite de taille est dépassée, quelle que soit la taille annoncée ;
  - aucun cookie ni en-tête d'authentification transmis.
  Toute violation MUST donner un refus avec `url_forbidden` ou `url_unreachable`.
- **FR-061**: Le média désigné par une URL MUST être téléchargé et vérifié pendant le traitement de la requête, avant la mise en file. L'appelant sait donc tout de suite si le média est refusé.

#### Suivi et historique

- **FR-070**: Chaque message MUST avoir un statut parmi « en file », « en cours », « envoyé », « distribué », « lu », « échec » (avec un code), « expiré », « annulé » et « incertain ». L'heure de chaque changement est conservée. « Distribué » et « lu » ne concernent que les discussions privées, et ne sont renseignés que si WhatsApp les communique.
- **FR-071**: Une clé MUST pouvoir lire le statut de ses propres messages, un par un ou en liste paginée filtrable par statut, format et période. Le message d'une autre clé MUST être traité comme inexistant.
- **FR-072**: Pour les boutons, les listes et les sondages, le suivi MUST exposer les réponses reçues pendant 7 jours après l'envoi : identifiant du choix, auteur, heure ; pour un sondage, le dernier vote de chaque votant et le total par option.
- **FR-073**: L'historique MUST conserver uniquement des métadonnées : clé ou source « panel », destinataire, format, taille, statut et heures, code d'échec, identifiant WhatsApp. Il MUST NOT conserver le texte, la légende ni le média. Le destinataire MUST être masqué dans les journaux.
- **FR-074**: L'historique et les réponses MUST être supprimés après 30 jours (réglable) par le nettoyage quotidien.
- **FR-075**: Le fichier d'un média en attente MUST être supprimé dès que son message est envoyé, en échec, expiré ou annulé. Le nettoyage quotidien MUST supprimer tout fichier orphelin.

#### Panel

- **FR-080**: Le panel MUST offrir une page API avec :
  - l'interrupteur de l'API ;
  - la liste des clés (nom, état, droits, politique de destinataires, limites, restrictions d'IP, expiration, création, dernière utilisation et dernière IP) ;
  - la création, la modification, la duplication et la révocation d'une clé, avec confirmation pour la révocation.
- **FR-081**: Le panel MUST afficher l'historique des envois filtrable par clé, statut, format et période. Le détail d'un envoi MUST montrer les étapes de son statut et ses réponses.
- **FR-082**: Le panel MUST offrir un formulaire d'essai. Il couvre chaque format déclaré et se construit à partir de la description du format. Il envoie avec le même moteur, les mêmes contrôles de contenu et le même espacement que l'API, sous la session du propriétaire et avec la source « panel », et chaque essai produit une entrée d'audit.
- **FR-083**: Le panel MUST afficher, par clé et par jour, le nombre d'envois et d'échecs.
- **FR-084**: Le panel MUST permettre de télécharger la description lisible par machine de l'API, avec un exemple de requête par format.
- **FR-085**: Tous les textes ajoutés au panel et au bot MUST exister en français et en anglais.

#### Modularité

- **FR-090**: Chaque endpoint MUST être déclaré par un module autonome qui décrit : sa méthode et son chemin, le droit qu'il exige, le schéma de sa requête, ses limites (taille, débit), sa réponse et sa documentation. Un endpoint déclaré sans droit MUST empêcher le démarrage de l'API, avec un message qui le nomme. L'API ne compte aucun endpoint public.
- **FR-091**: Chaque format d'envoi MUST être déclaré par un module autonome qui décrit : son nom, ses champs et leur validation, les types et tailles de média acceptés, sa préparation (conversion), son envoi, l'interprétation des réponses s'il est interactif, sa documentation et la description de son formulaire d'essai.
- **FR-092**: Ajouter un endpoint ou un format MUST demander uniquement le nouveau module, ses tests et ses textes traduits. Il MUST apparaître de lui-même dans la documentation, dans la liste des droits du panel, dans les filtres de l'historique et, pour un format, dans le formulaire d'essai.
- **FR-093**: L'authentification, le blocage des origines, le contrôle du HTTPS, les droits, les quotas, la validation, le format des erreurs, la journalisation et l'audit MUST être appliqués par un socle commun avant le module, sans que celui-ci puisse les contourner.
- **FR-094**: Les erreurs MUST être renvoyées sous une forme unique : un code stable et ses paramètres, jamais de message interne ni de trace. Chaque réponse MUST porter un identifiant de requête qui permet de la retrouver dans les journaux.

### Key Entities

- **Clé d'API** : un accès nommé pour un programme externe. Attributs : nom, empreinte irréversible du secret, 4 derniers caractères, droits (endpoints, formats, média par URL), politique de destinataires (mode et liste), quotas (par minute, par jour, en attente), restrictions d'IP, expiration, état (active, révoquée), dates de création et de dernière utilisation, dernière IP, IP déjà vues.
- **Message de l'API** : un envoi demandé par une clé ou par le formulaire d'essai. Attributs : identifiant public, clé ou source « panel », clé d'idempotence, destinataire, format, taille, statut et heure de chaque étape, code d'échec, identifiant WhatsApp, heure d'acceptation et d'expiration. Aucun contenu.
- **Réponse reçue** : un choix fait par un destinataire sur un message à boutons, à liste ou à sondage. Attributs : message concerné, auteur, identifiant(s) du choix, heure. Pour un sondage, le dernier vote d'un votant remplace le précédent.
- **Média en attente** : le fichier d'un message en file, déjà vérifié et prêt à partir. Il est supprimé à la fin du message.
- **Endpoint** et **Format** : des déclarations de modules (pas des données en base). Elles alimentent la documentation, la liste des droits, les filtres et le formulaire d'essai.
- **Réglages de l'API** : interrupteur, espacement minimal, quotas par défaut, délai d'expiration en file, durée de conservation de l'historique, alertes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: À partir de l'API activée et de la seule documentation, un propriétaire crée une clé et fait recevoir un premier texte par un téléphone en moins de 5 minutes.
- **SC-002**: Sur la table complète des endpoints, 100 % des requêtes sans clé valide, sans le droit requis, hors politique de destinataires ou hors restrictions d'IP sont refusées, et aucun message ne part.
- **SC-003**: Aucun secret de clé, aucun texte ni aucun média envoyé n'apparaît dans les journaux, l'historique, l'audit ou les réponses d'erreur, d'après un contrôle automatique sur l'ensemble des scénarios de test.
- **SC-004**: 100 % des formats de la première version s'affichent correctement sur un vrai téléphone (liste de contrôle manuelle), et les boutons et les listes restent utilisables par leur version texte sur un téléphone qui ne les affiche pas.
- **SC-005**: Sur une rafale de 100 requêtes acceptées, deux envois ne sont jamais séparés de moins de 2 secondes, et chaque requête au-delà d'un quota reçoit un refus avec le délai à attendre.
- **SC-006**: Aucun message n'est envoyé deux fois, que ce soit sur une requête rejouée avec la même clé d'idempotence ou après un redémarrage avec des messages en file.
- **SC-007**: 100 % des cas de la batterie d'URL piégées (adresses privées, boucle locale, métadonnées d'hébergeur, redirection vers une adresse interne, changement d'adresse du domaine, HTTP clair, identifiants dans l'URL, taille mentie, serveur lent) sont refusés, et aucune connexion n'atteint une adresse interne.
- **SC-008**: Aucun texte envoyé par l'API, y compris un texte qui commence par le préfixe d'une commande réservée au propriétaire, n'est exécuté par le bot.
- **SC-009**: Ajouter un format ou un endpoint de démonstration ne modifie aucun fichier existant en dehors des catalogues de traduction, et le nouvel élément apparaît dans la documentation, les droits et (pour un format) le formulaire d'essai.
- **SC-010**: Une requête de texte acceptée reçoit sa réponse en moins d'une seconde, sans compter le temps d'envoi d'un fichier ou de téléchargement d'une URL.
- **SC-011**: API désactivée, le bot ne consomme pas plus de mémoire qu'avant la fonctionnalité ; API activée et au repos, l'écart reste sous 20 Mo.

## Assumptions

- **Qui gère** : seuls les propriétaires connectés au panel gèrent l'API et ses clés ; il n'y a pas de rôle intermédiaire.
- **Un destinataire par requête** : l'envoi en masse reste la diffusion du panel ; un endpoint d'envoi groupé pourra s'ajouter plus tard sur le même socle.
- **Hors périmètre, prévus comme futurs endpoints** : lecture des messages reçus, rappels (webhooks), réaction, modification et suppression d'un message, gestion des groupes, statuts et chaînes. Le socle doit les accueillir sans changement.
- **Pas de SDK ni d'outil en ligne de commande** : la description lisible par machine permet d'en générer un dans n'importe quel langage.
- **HTTPS** : le chiffrement est assuré par l'hébergeur ou un proxy, comme pour le panel. Le bot ne gère pas de certificat.
- **Média par URL** : le téléchargement se fait pendant la requête, qui peut donc durer jusqu'à 30 secondes ; le texte et l'envoi de fichier restent rapides.
- **Citation** : seuls les messages envoyés par l'API peuvent être cités ; citer un message reçu viendra avec l'endpoint de lecture.
- **Boutons natifs** : WhatsApp ne les affiche pas sur tous les téléphones ; la version texte numérotée existante du bot sert de repli, et une réponse par numéro cité compte comme un choix.
- **Limites des formats** : longueurs du texte et des légendes, nombre de boutons et de choix, et nombre d'options d'un sondage reprennent les limites courantes de WhatsApp. Les limites de taille par format suivent celles de WhatsApp, plafonnées par le réglage existant de taille des médias.
- **Durées** : historique et réponses conservés 30 jours ; réponses collectées 7 jours après l'envoi ; expiration en file après 10 minutes ; idempotence valable 24 heures. Toutes réglables sauf l'idempotence.
- **Espacement partagé** : l'espacement de 2 secondes s'applique aux envois de l'API et aux diffusions ensemble, puisqu'ils partent du même numéro.
- **Discussions désactivées** : une discussion désactivée dans le bot l'est aussi pour l'API.
- **Statuts dans un groupe** : WhatsApp donne un accusé par participant ; dans un groupe, le suivi s'arrête donc à « envoyé ». « Distribué » et « lu » ne concernent que les discussions privées.
- **Panel requis** : sans panel, pas d'API, puisque les clés s'y gèrent.

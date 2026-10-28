# Feature Specification: Panel d'administration du bot

**Feature Branch**: `002-admin-panel`

**Created**: 2026-10-28

**Status**: Draft

**Input**: User description: "on va concevoir un panel admin pour config le bot graphiquement et tout" — reformulé : Panel d'administration web pour configurer et piloter OpenWhatsappBot graphiquement : réglages du bot (préfixe, langue, propriétaires, clés API, options auto-statut/anti-delete/view-once…), activation/désactivation des commandes, gestion des groupes (bienvenue/départ, filtres, rôles, discussions désactivées), appairage WhatsApp (QR/code), état et redémarrage du bot, journaux et statistiques, le tout protégé par authentification.

## Contexte

Aujourd'hui, tout réglage du bot passe par un fichier de configuration édité à la main puis un redémarrage, ou par des commandes WhatsApp tapées une à une. L'appairage exige de lire un QR code dans la console. Le mode « panel » n'offre qu'une page de statut en lecture seule et un redémarrage protégé par jeton.

Conséquences pour le propriétaire :

- sur un hébergeur sans terminal, changer une clé API ou le préfixe demande d'éditer un fichier, sans validation : une faute de frappe ne se voit qu'au redémarrage ;
- il n'a aucune vue d'ensemble : quels groupes ont un message de bienvenue, quels filtres existent, quelles commandes échouent ;
- réappairer le bot depuis un téléphone est pénible quand le QR n'apparaît que dans les journaux.

Le panel doit couvrir ces usages sans rien retirer de ce qui existe : les commandes WhatsApp de configuration et le fichier de configuration restent utilisables.

## Clarifications

### Session 2026-10-28

- Q: Combien de comptes pour le panel ? → A: Un seul compte administrateur, le propriétaire ; l'historique trace chaque action.
- Q: Quand un réglage est défini à la fois dans le fichier de configuration (ou l'environnement de l'hébergeur) et dans le panel, lequel s'applique ? → A: Le panel prime. Ses valeurs sont enregistrées par le bot et passent devant le fichier ; le panel affiche l'origine de chaque valeur et permet de revenir à celle du fichier.
- Q: Que doit faire le panel en plus de la configuration, des commandes, des groupes, de l'appairage, de l'état et des journaux ? → A: Désactivation des commandes par groupe, sauvegarde/restauration, gestion des données, diffusion de messages, « et encore plus ».
- Q: Que recouvre « et encore plus » ? → A: Outils de maintenance (US11), textes du bot modifiables (US12), alertes au propriétaire (US13) et messages récurrents (US9).
- Q: Comment livrer ce périmètre ? → A: D'un bloc, sur une seule branche et une seule PR, avec un commit par étape.
- Q: Quelle technique pour l'interface ? → A: Sans étape de construction, légère : pages servies par le bot et petites bibliothèques embarquées (contrainte pour le plan, cohérente avec SC-009 et FR-010).
- Q: Le panel est-il activé par défaut ? → A: Oui, dans les deux modes de lancement, désactivable par un réglage ; la sécurité initiale repose sur le lien à usage unique de la console.

### Session 2026-10-28 (après la recherche du plan)

- Q: Sur quelle adresse le panel écoute-t-il par défaut ? → A: Automatique : seulement la machine locale en local ; accessible du réseau quand un conteneur ou un hébergeur est détecté ; un réglage de démarrage force la valeur.
- Q: Comment activer le panel par défaut alors que l'exemple de configuration contient un ancien interrupteur à « false » jamais lu ? → A: Nouveau réglage d'activation (activé par défaut) ; l'ancien est ignoré et retiré de l'exemple.
- Q: L'anti-lien, l'anti-bot et le mode muet sont stockés mais jamais appliqués : que faire ? → A: Les implémenter (FR-031).
- Q: Que fait le mode muet ? → A: Il bascule le réglage WhatsApp du groupe « seuls les administrateurs peuvent envoyer des messages ».
- Q: Que montre la page Stockage, sachant qu'aucune archive anti-suppression ni vue unique n'existe et que les statuts sont transférés sans être enregistrés ? → A: Les catégories réelles : médias temporaires, cache anti-suppression en mémoire, sauvegardes du panel, journaux, base de données (taille seulement).
- Q: Mise à jour sans superviseur détecté ? → A: Appliquer (avec retour arrière si le démarrage d'essai échoue) et afficher « redémarre le programme pour terminer » jusqu'au redémarrage.
- Q: Les traces d'erreur envoyées en privé aux propriétaires à chaque erreur ? → A: Limitées à une par commande toutes les 10 minutes, en plus de l'alerte « erreurs en série ».
- Q: Réglages qu'aucun code ne lit ? → A: Affichés en lecture seule dans un groupe « sans effet aujourd'hui » ; suppression plus tard.
- Q: Clés API enregistrées par le panel ? → A: Chiffrées au repos avec une clé locale propre à l'installation.
- Q: Relais (proxy) non déclaré ? → A: Bandeau d'avertissement et réglage explicite ; aucune confiance automatique aux en-têtes du relais.
- Q: Durcissements ? → A: Session limitée à 7 jours au total ; chemins de programmes exécutés par le bot en lecture seule.
- Q: Choix par défaut ? → A: La sauvegarde exclut l'historique du répondeur IA et l'historique d'administration ; toutes les alertes sont activées au départ ; un message récurrent « le 31 » part le dernier jour des mois plus courts.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Accès sécurisé et premier démarrage (Priority: P1)

Le propriétaire installe le bot et ouvre l'adresse du panel. Le panel refuse tout accès tant qu'aucun compte administrateur n'existe. La console affiche un lien de configuration initiale à usage unique. Le propriétaire l'ouvre, choisit son mot de passe, et se retrouve connecté. Ensuite, toute visite demande ce mot de passe.

**Why this priority**: Le panel donne accès aux clés API, à la session WhatsApp et au contrôle du bot. Sans accès sécurisé, aucune autre fonction ne peut être livrée.

**Independent Test**: Sur une installation neuve, suivre le lien affiché dans la console, créer le mot de passe, se déconnecter, puis vérifier que chaque page et chaque action du panel est refusée sans connexion.

**Acceptance Scenarios**:

1. **Given** une installation sans compte administrateur, **When** le bot démarre, **Then** la console affiche un lien de configuration initiale à usage unique, valable 30 minutes, et le panel n'affiche rien d'autre qu'une invitation à suivre ce lien.
2. **Given** le lien de configuration initiale, **When** le propriétaire choisit un mot de passe d'au moins 12 caractères, **Then** il est connecté et le lien ne fonctionne plus.
3. **Given** un visiteur non connecté, **When** il demande une page ou une action du panel autre que la connexion, **Then** il est renvoyé vers la page de connexion et rien n'est modifié.
4. **Given** 5 échecs de connexion depuis la même origine en 15 minutes, **When** une 6e tentative arrive, **Then** elle est refusée pendant 15 minutes, même avec le bon mot de passe, et l'événement est journalisé.
5. **Given** un administrateur connecté inactif depuis 24 heures, **When** il revient, **Then** il doit se reconnecter.
6. **Given** un propriétaire qui a oublié son mot de passe, **When** il lance la procédure de réinitialisation, **Then** celle-ci exige un accès au serveur (console ou fichiers) et produit un nouveau lien à usage unique.

---

### User Story 2 - Tableau de bord : état et contrôle du bot (Priority: P1)

Une fois connecté, le propriétaire voit d'un coup d'œil si le bot est connecté à WhatsApp, avec quel numéro, depuis quand, combien de messages il a traités, les dernières erreurs et la mémoire utilisée. Il peut redémarrer le bot depuis le panel.

**Why this priority**: C'est la première question du propriétaire (« le bot tourne-t-il ? ») et la base du MVP avec US1.

**Independent Test**: Se connecter, vérifier que l'état affiché correspond à l'état réel, couper la connexion réseau du bot et voir l'état changer, puis redémarrer depuis le panel.

**Acceptance Scenarios**:

1. **Given** un bot connecté, **When** le propriétaire ouvre le tableau de bord, **Then** il voit l'état « connecté », le numéro du bot, la durée de fonctionnement, la version, le nombre de messages traités, la mémoire utilisée et les 10 dernières erreurs.
2. **Given** le tableau de bord ouvert, **When** l'état du bot change (déconnexion, reconnexion, attente d'appairage), **Then** l'affichage se met à jour en 5 secondes au plus, sans recharger la page.
3. **Given** le tableau de bord, **When** le propriétaire demande un redémarrage et le confirme, **Then** le bot se reconnecte et recharge ses réglages, sans que l'hébergeur ait à relancer le programme, et la session WhatsApp est conservée.

---

### User Story 3 - Modifier les réglages du bot (Priority: P1)

Le propriétaire modifie les réglages du bot dans des formulaires regroupés par thème : général (préfixe, langue, fuseau horaire, propriétaires), comportement (toujours en ligne, lecture automatique, vue/réaction/sauvegarde automatique des statuts, anti-suppression, vue unique, réactions), clés API, répondeur automatique, modération (avertissements, messages anti-lien), limites (taille des médias, délais). Chaque réglage a une description, une valeur par défaut, une validation et l'indication de son effet : immédiat, ou après redémarrage.

**Why this priority**: C'est le cœur de la demande (« config le bot graphiquement »).

**Independent Test**: Changer le préfixe de « . » à « ! » dans le panel, puis vérifier sur WhatsApp que « !ping » répond et que « .ping » ne répond plus, sans redémarrage.

**Acceptance Scenarios**:

1. **Given** le préfixe « . », **When** le propriétaire enregistre « ! », **Then** le message suivant « !ping » déclenche la commande et « .ping » ne déclenche plus rien, sans redémarrage.
2. **Given** un formulaire, **When** le propriétaire saisit une valeur invalide (préfixe vide ou avec un espace, langue inconnue, numéro de propriétaire mal formé, nombre hors limites), **Then** l'enregistrement est refusé avec une explication par champ, et aucun réglage n'est modifié.
3. **Given** une clé API saisie et enregistrée, **When** le propriétaire revient sur la page, **Then** il voit seulement « définie » et ses 4 derniers caractères ; la valeur complète n'est plus jamais affichée ni journalisée. Il peut la remplacer ou l'effacer.
4. **Given** un réglage qui ne s'applique qu'au redémarrage, **When** il est enregistré, **Then** le panel affiche « redémarrage nécessaire » avec un bouton de redémarrage, jusqu'au redémarrage.
5. **Given** la liste des propriétaires, **When** le propriétaire la vide, **Then** le panel prévient que plus personne ne pourra utiliser les commandes réservées au propriétaire et demande une confirmation.
6. **Given** un réglage défini dans le fichier de configuration puis modifié dans le panel, **When** le propriétaire consulte ce réglage, **Then** la valeur du panel s'applique, le panel indique « modifié dans le panel » et propose de revenir à la valeur du fichier.
7. **Given** une clé API saisie, **When** le propriétaire demande à la tester, **Then** le panel indique si le service l'accepte, la refuse, ou est injoignable, sans afficher la clé.

---

### User Story 4 - Appairer WhatsApp depuis le navigateur (Priority: P2)

Le bot n'est pas appairé, ou le propriétaire veut changer de numéro. Depuis le panel, il affiche le QR code ou demande un code d'appairage pour un numéro, le scanne ou le saisit sur son téléphone, et voit le bot passer à « connecté ».

**Why this priority**: Indispensable sur un hébergeur sans console lisible, mais le QR de la console fonctionne déjà.

**Independent Test**: Supprimer la session, ouvrir le panel, scanner le QR affiché, et voir le tableau de bord passer à « connecté ».

**Acceptance Scenarios**:

1. **Given** un bot non appairé, **When** le propriétaire ouvre la page d'appairage, **Then** le QR code s'affiche en 5 secondes au plus et se renouvelle automatiquement quand il expire.
2. **Given** la page d'appairage, **When** le propriétaire saisit un numéro valide et demande un code, **Then** un code d'appairage à saisir sur le téléphone s'affiche.
3. **Given** le QR scanné ou le code saisi, **When** l'appairage réussit, **Then** le panel affiche « connecté » et le numéro en 10 secondes au plus.
4. **Given** un bot appairé, **When** le propriétaire demande à déconnecter la session et confirme, **Then** la session est fermée sur WhatsApp et le panel repasse en attente d'appairage.

---

### User Story 5 - Activer et désactiver des commandes (Priority: P2)

Le propriétaire voit la liste de toutes les commandes : nom, alias, catégorie, description, niveau d'accès. Il peut chercher, filtrer par catégorie, et désactiver une commande partout ou seulement dans certains groupes. Une commande désactivée ne s'exécute plus pour personne là où elle l'est ; l'utilisateur qui l'appelle reçoit « commande désactivée ».

**Why this priority**: Permet de retirer une commande gênante ou cassée sans toucher au code. Utile, mais le bot fonctionne sans.

**Independent Test**: Désactiver « dice » dans le panel, envoyer « .dice » sur WhatsApp et recevoir « commande désactivée » ; la réactiver et voir la commande répondre.

**Acceptance Scenarios**:

1. **Given** la page des commandes, **When** le propriétaire l'ouvre, **Then** chaque commande chargée par le bot y figure une seule fois, avec ses alias, sa catégorie, sa description et son niveau d'accès.
2. **Given** une commande active, **When** le propriétaire la désactive, **Then** dès le message suivant elle répond « commande désactivée » à tout le monde, propriétaire compris, par n'importe lequel de ses alias.
3. **Given** une commande désactivée, **When** le bot redémarre, **Then** elle reste désactivée.
4. **Given** une commande active partout, **When** le propriétaire la désactive dans le groupe A seulement, **Then** elle répond « commande désactivée » dans le groupe A et fonctionne normalement dans le groupe B et en privé.
5. **Given** la page d'un groupe, **When** le propriétaire l'ouvre, **Then** il voit la liste des commandes désactivées dans ce groupe et peut la modifier sans passer par la page des commandes.

---

### User Story 6 - Gérer les groupes (Priority: P2)

Le propriétaire voit la liste des groupes du bot (nom, nombre de membres, bot administrateur ou non) et, pour chacun, règle le message de bienvenue et de départ (avec aperçu), l'anti-lien, l'anti-bot, les filtres de réponse automatique, les rôles, les avertissements, et peut désactiver le bot dans ce groupe. Il voit aussi les discussions privées où le bot est désactivé.

**Why this priority**: Ces réglages existent déjà par commandes WhatsApp, une à une et sans vue d'ensemble. Le panel les rend lisibles et modifiables en masse.

**Independent Test**: Activer le message de bienvenue d'un groupe dans le panel, ajouter un membre de test au groupe, et recevoir le message de bienvenue.

**Acceptance Scenarios**:

1. **Given** un bot membre de plusieurs groupes, **When** le propriétaire ouvre la page des groupes, **Then** chaque groupe apparaît avec son nom, son nombre de membres et l'indication « bot administrateur » ou non ; la liste se filtre par nom.
2. **Given** un groupe, **When** le propriétaire active la bienvenue avec un message utilisant les variables disponibles (nom du membre, nom du groupe), **Then** un aperçu montre le rendu, et le prochain membre ajouté reçoit ce message.
3. **Given** un groupe, **When** le propriétaire ajoute, modifie ou supprime un filtre, **Then** le changement s'applique au message suivant du groupe, sans redémarrage.
4. **Given** un groupe où le bot n'est pas administrateur, **When** le propriétaire active l'anti-lien, **Then** le panel prévient que le bot ne pourra pas retirer les membres tant qu'il n'est pas administrateur.
5. **Given** l'anti-lien actif dans un groupe où le bot est administrateur, **When** un membre non administrateur envoie un lien, **Then** le message est supprimé et son auteur averti ; au-delà de la limite d'avertissements, il est retiré du groupe.
6. **Given** un groupe où le bot est administrateur, **When** le propriétaire active le mode muet, **Then** seuls les administrateurs du groupe peuvent encore écrire, et le désactiver rouvre le groupe.
7. **Given** un groupe que le bot a quitté, **When** le propriétaire ouvre la liste, **Then** le groupe apparaît comme « ancien groupe », ses réglages sont conservés, et le propriétaire peut les supprimer.

---

### User Story 7 - Journaux et statistiques (Priority: P3)

Le propriétaire consulte les journaux récents du bot, filtrés par niveau et par texte, et les statistiques d'usage : messages traités par jour, commandes les plus utilisées, commandes en échec, groupes les plus actifs.

**Why this priority**: Aide au diagnostic et au suivi, mais ne bloque aucun usage.

**Independent Test**: Provoquer une erreur de commande, la retrouver dans les journaux du panel avec le filtre « erreur », et voir le compteur d'échecs de cette commande augmenter.

**Acceptance Scenarios**:

1. **Given** la page des journaux, **When** le propriétaire filtre sur « erreur », **Then** seules les entrées d'erreur parmi les 1 000 dernières s'affichent, et les nouvelles arrivent sans recharger la page.
2. **Given** une clé API utilisée par une commande en échec, **When** l'erreur apparaît dans les journaux, **Then** la clé n'y figure pas.
3. **Given** la page des statistiques, **When** le propriétaire l'ouvre, **Then** il voit les messages traités par jour sur 7 jours, les 10 commandes les plus utilisées et les commandes en échec sur la même période.

---

### User Story 8 - Gérer les données du bot (Priority: P3)

Le propriétaire consulte et corrige les données que les commandes ont enregistrées : rappels en attente, soldes de l'économie par groupe, mots-clés d'alerte, commandes liées à des stickers, statuts d'absence, tâches, idées et citations.

**Why this priority**: Aujourd'hui, une donnée erronée (un solde faussé, un rappel en double) ne se corrige qu'à la main dans la base. Utile, mais rare.

**Independent Test**: Créer un rappel par WhatsApp, le voir dans le panel, l'annuler, et vérifier qu'il n'est jamais envoyé.

**Acceptance Scenarios**:

1. **Given** des rappels en attente, **When** le propriétaire ouvre la page des rappels, **Then** il voit chaque rappel avec sa discussion, son auteur et sa date d'envoi, et peut l'annuler ; un rappel annulé n'est jamais envoyé.
2. **Given** l'économie d'un groupe, **When** le propriétaire fixe ou ajoute un montant au solde d'un membre avec un motif, **Then** le solde change immédiatement, sans conflit avec un gain ou une dépense simultanés, et l'historique garde le motif.
3. **Given** un ajustement qui rendrait un solde négatif, **When** le propriétaire l'enregistre, **Then** il est refusé.
4. **Given** un mot-clé d'alerte, une commande-sticker, un statut d'absence, une tâche, une idée ou une citation, **When** le propriétaire le supprime, **Then** il disparaît aussi pour les commandes WhatsApp correspondantes.

---

### User Story 9 - Diffuser un message (Priority: P3)

Le propriétaire rédige un message (texte, avec une image ou un document facultatifs), choisit des groupes et des discussions privées connues du bot, vérifie l'aperçu, et l'envoie tout de suite ou à une date choisie. Il suit l'envoi destination par destination.

**Why this priority**: Pratique pour les annonces, mais envoyer en masse expose le numéro à un blocage par WhatsApp ; la fonction doit donc rester encadrée.

**Independent Test**: Diffuser un message à deux groupes de test, voir la progression, et recevoir le message une seule fois dans chacun.

**Acceptance Scenarios**:

1. **Given** la page de diffusion, **When** le propriétaire choisit les destinations, **Then** il ne peut choisir que des groupes dont le bot est membre et des discussions privées qui ont déjà écrit au bot, jamais un numéro saisi à la main.
2. **Given** un message et 20 destinations, **When** le propriétaire confirme l'envoi, **Then** les messages partent un par un, espacés de 5 secondes au moins par défaut, et la progression s'affiche en direct.
3. **Given** une diffusion en cours, **When** le propriétaire l'annule, **Then** aucune nouvelle destination ne reçoit le message, et le rapport indique les destinations déjà servies.
4. **Given** une diffusion en cours, **When** le bot redémarre, **Then** la diffusion reprend avec les destinations restantes, et aucune destination ne reçoit le message deux fois.
5. **Given** une diffusion programmée, **When** sa date arrive, **Then** elle part, même si le bot a redémarré entre-temps.
6. **Given** un message récurrent « chaque lundi à 8 h » vers un groupe, **When** chaque lundi 8 h arrive (fuseau horaire du bot), **Then** le groupe reçoit le message une seule fois par occurrence ; le propriétaire peut le mettre en pause, le reprendre, le modifier ou le supprimer.
7. **Given** un message récurrent dont une occurrence tombe pendant une coupure du bot, **When** le bot revient plus d'une heure après, **Then** cette occurrence est sautée et notée dans l'historique, et la suivante part normalement.

---

### User Story 10 - Sauvegarder et restaurer (Priority: P3)

Le propriétaire exporte d'un clic une sauvegarde chiffrée de la configuration et des données du bot, et la restaure plus tard, sur la même installation ou sur une autre (changement d'hébergeur, retour arrière).

**Why this priority**: Protège contre la perte d'un hébergeur ou une mauvaise manipulation ; rarement utilisé, mais précieux ce jour-là.

**Independent Test**: Exporter une sauvegarde, la restaurer sur une installation neuve, et vérifier que réglages, commandes désactivées, réglages de groupe et données sont identiques.

**Acceptance Scenarios**:

1. **Given** la page de sauvegarde, **When** le propriétaire exporte avec une phrase de passe d'au moins 12 caractères, **Then** il télécharge un fichier chiffré contenant les réglages, l'état des commandes et les données du bot.
2. **Given** l'export, **When** le propriétaire coche « inclure la session WhatsApp », **Then** le panel prévient que ce fichier permet de prendre le contrôle du numéro, et la session n'est incluse qu'après confirmation.
3. **Given** un fichier de sauvegarde et sa phrase de passe, **When** le propriétaire le restaure, **Then** le panel affiche d'abord son résumé (date, version du bot, nombre d'éléments par type), puis, après confirmation, enregistre une sauvegarde de l'état actuel, remplace les données, et redémarre le bot.
4. **Given** une mauvaise phrase de passe, un fichier altéré, ou une sauvegarde d'une version plus récente du bot, **When** le propriétaire la restaure, **Then** la restauration est refusée avec la raison, et rien n'est modifié.
5. **Given** une sauvegarde faite sur une installation avec un type de base de données, **When** elle est restaurée sur une installation avec l'autre type, **Then** les données sont identiques.

---

### User Story 11 - Outils de maintenance (Priority: P3)

Le propriétaire met à jour le bot et ses outils de téléchargement depuis le panel, et voit l'espace occupé par les médias temporaires, le cache anti-suppression en mémoire, les sauvegardes du panel, les journaux et la base, avec la possibilité de libérer chaque catégorie.

**Why this priority**: Évite de passer par la console pour l'entretien courant, sans être nécessaire au fonctionnement.

**Independent Test**: Ouvrir la page de stockage, vider les médias temporaires, et voir l'espace libéré ; vérifier la présence d'une mise à jour sur une installation en retard d'une version.

**Acceptance Scenarios**:

1. **Given** une installation qui peut se mettre à jour elle-même, **When** une version plus récente existe, **Then** le panel l'indique avec la liste des changements, et l'applique après confirmation, suivie d'un redémarrage.
2. **Given** une installation qui ne peut pas se mettre à jour elle-même (image), **When** le propriétaire ouvre la page de mise à jour, **Then** le panel explique comment mettre à jour.
3. **Given** une mise à jour qui échoue, **When** l'échec survient, **Then** le bot continue avec la version actuelle et le panel affiche la raison.
4. **Given** la page de stockage, **When** le propriétaire vide une catégorie et confirme, **Then** l'espace occupé par cette catégorie retombe à zéro, la base n'étant jamais vidable depuis cette page.

---

### User Story 12 - Personnaliser les textes du bot (Priority: P3)

Le propriétaire modifie les réponses du bot (menu, messages d'erreur, message de bienvenue par défaut, réponses des commandes) en français et en anglais, depuis le panel, sans toucher aux fichiers de langue. Il peut revenir au texte d'origine à tout moment.

**Why this priority**: Donne au bot le ton de son propriétaire. Confortable, sans être nécessaire au fonctionnement.

**Independent Test**: Modifier le texte « commande réservée au propriétaire », appeler une commande réservée depuis un autre numéro et recevoir le nouveau texte ; revenir au texte d'origine et le recevoir à nouveau.

**Acceptance Scenarios**:

1. **Given** la page des textes, **When** le propriétaire cherche un mot ou filtre par commande, **Then** il voit chaque texte concerné en français et en anglais, avec sa version d'origine.
2. **Given** un texte modifié et enregistré, **When** le bot envoie ce texte, **Then** c'est la version modifiée qui part, dès le message suivant, menu et descriptions de commandes compris.
3. **Given** un texte qui contient des emplacements variables (nom, nombre…), **When** le propriétaire enregistre une version qui en retire ou en ajoute un, **Then** l'enregistrement est refusé avec la liste des emplacements attendus.
4. **Given** un texte modifié dont la version d'origine change lors d'une mise à jour du bot, **When** le propriétaire ouvre la page des textes, **Then** la version modifiée reste en place et le panel signale que l'original a changé.

---

### User Story 13 - Recevoir des alertes (Priority: P3)

Le propriétaire reçoit sur WhatsApp un message du bot quand quelque chose demande son attention : le bot revient après une coupure, les erreurs s'accumulent, une clé API est refusée, une connexion au panel est bloquée ou réussit depuis une nouvelle origine, une mise à jour est disponible. Il choisit dans le panel les alertes qu'il veut recevoir.

**Why this priority**: Évite de découvrir un problème des heures plus tard, mais le tableau de bord donne déjà l'information à qui le consulte.

**Independent Test**: Activer l'alerte « erreurs en série », provoquer 10 erreurs de commande en quelques minutes, et recevoir une seule alerte.

**Acceptance Scenarios**:

1. **Given** le bot coupé pendant plus de 5 minutes, **When** il se reconnecte, **Then** les propriétaires reçoivent une alerte avec la durée de la coupure.
2. **Given** l'alerte « erreurs en série » activée, **When** 10 erreurs de commande surviennent en 10 minutes, **Then** les propriétaires reçoivent une seule alerte résumant les commandes en cause, puis aucune autre alerte de ce type pendant une heure.
3. **Given** une clé API refusée par son service, **When** une commande l'utilise, **Then** les propriétaires reçoivent une alerte nommant le service, au plus une fois par service et par 24 heures, sans la clé.
4. **Given** une origine bloquée après 5 échecs de connexion au panel, ou une connexion réussie depuis une origine jamais vue, **When** l'événement survient, **Then** les propriétaires reçoivent une alerte avec l'heure et l'origine.
5. **Given** aucun propriétaire configuré, **When** le propriétaire ouvre la page des alertes, **Then** le panel indique que les alertes ne peuvent être envoyées à personne.

---

### Edge Cases

- **Bot déconnecté ou base indisponible** : le panel reste utilisable pour l'appairage, la consultation de l'état et les réglages qui ne dépendent pas de la base ; les pages qui en dépendent l'indiquent au lieu d'échouer.
- **Deux onglets** modifient le même réglage : le second enregistrement est refusé avec « ce réglage a changé depuis l'ouverture de la page », sans écraser le premier.
- **Session expirée pendant la saisie** : l'enregistrement est refusé, et le panel prévient que la saisie sera perdue avant de renvoyer vers la connexion.
- **Valeur invalide déjà présente dans le fichier de configuration** au démarrage : le panel la signale sur le réglage concerné et le bot utilise la valeur par défaut.
- **Réglages de démarrage** (adresse de la base, port et adresse du panel, dossier de session) : affichés en lecture seule, modifiables seulement dans le fichier de configuration, car le panel en dépend pour fonctionner.
- **Centaines de groupes** : la liste reste paginée et filtrable, et s'affiche en moins de 2 secondes pour 500 groupes.
- **Commande désactivée appelée par le propriétaire** : refusée comme pour tout le monde ; le panel reste le moyen de la réactiver.
- **Appairage demandé alors que le bot est déjà connecté** : le panel exige d'abord la déconnexion confirmée de la session en cours.
- **Message de bienvenue avec une variable inconnue** : l'aperçu la signale et l'enregistrement est refusé.
- **Mot de passe administrateur trop faible** (moins de 12 caractères) : refusé.
- **Panel exposé sur Internet sans HTTPS** : le panel affiche un avertissement permanent tant que la connexion n'est pas chiffrée, sauf en accès local.
- **Commande désactivée partout et activée dans un groupe** : la désactivation globale l'emporte.
- **Diffusion vers un groupe que le bot a quitté** entre-temps : cette destination est marquée en échec, les autres continuent.
- **Diffusion alors que le bot est déconnecté** : elle se met en pause et reprend à la reconnexion. Une diffusion programmée en retard de plus d'une heure n'est pas envoyée et est marquée « expirée ».
- **Restauration interrompue** (coupure, erreur) : l'état d'avant la restauration est conservé.
- **Test d'une clé API répété** : au plus un test par service toutes les 10 secondes, pour ne pas épuiser le quota.

## Requirements *(mandatory)*

### Functional Requirements

#### Accès et sécurité

- **FR-001**: Le panel MUST refuser toute page et toute action, hors connexion et configuration initiale, à un visiteur non authentifié.
- **FR-002**: Le panel MUST gérer un seul compte administrateur, celui du propriétaire, qui a accès à toutes les fonctions.
- **FR-003**: À la première exécution sans compte, le système MUST afficher dans la console un lien de configuration initiale à usage unique, valable 30 minutes ; un nouveau lien est émis à chaque démarrage tant qu'aucun compte n'existe.
- **FR-004**: Le panel MUST exiger un mot de passe d'au moins 12 caractères et ne jamais le conserver sous une forme réversible.
- **FR-005**: Le panel MUST bloquer pendant 15 minutes une origine après 5 échecs de connexion en 15 minutes, et journaliser ces blocages ; quand le panel détecte un relais non déclaré qui ferait partager la même origine à tous les visiteurs, il MUST afficher un bandeau expliquant comment le déclarer, sans faire confiance automatiquement aux en-têtes du relais.
- **FR-006**: Une session MUST expirer après 24 heures d'inactivité, au plus tard 7 jours après la connexion, et à la déconnexion explicite.
- **FR-007**: La réinitialisation du mot de passe MUST exiger un accès au serveur (console ou fichiers) et produire un lien à usage unique.
- **FR-008**: Le panel MUST se protéger contre les actions déclenchées à l'insu de l'administrateur depuis un autre site (toute modification exige une preuve que la requête vient du panel).
- **FR-009**: Le panel MUST afficher un avertissement permanent quand il est consulté hors accès local sans connexion chiffrée.
- **FR-010**: Le panel MUST fonctionner sans charger de ressources depuis des services tiers.
- **FR-011**: Les points de supervision existants (santé, métriques, statut) MUST rester disponibles sans authentification et sans exposer de numéro, de jeton ni de chemin, et le redémarrage par jeton existant MUST continuer de fonctionner.

#### Tableau de bord

- **FR-012**: Le tableau de bord MUST afficher l'état de connexion (connecté, déconnecté, en attente d'appairage), le numéro du bot, la durée de fonctionnement, la version, les messages traités, la mémoire utilisée et les 10 dernières erreurs, mis à jour en 5 secondes au plus.
- **FR-013**: L'administrateur MUST pouvoir redémarrer le bot après confirmation ; le redémarrage reconnecte le bot et recharge ses réglages sans fermer la session WhatsApp et sans dépendre d'une relance du programme par l'hébergeur.

#### Réglages

- **FR-014**: Le panel MUST présenter tous les réglages documentés dans l'exemple de configuration, regroupés par thème, chacun avec un libellé, une description, sa valeur par défaut, sa valeur actuelle et l'origine de cette valeur (défaut, fichier/environnement ou panel) ; les réglages qu'aucune fonction du bot ne lit sont regroupés, en lecture seule, sous « sans effet aujourd'hui ».
- **FR-015**: Le système MUST valider chaque réglage avant enregistrement (type, format, bornes, valeurs autorisées) et refuser tout l'enregistrement si un champ est invalide, avec un message par champ.
- **FR-016**: Les réglages lus à chaque message (préfixe, langue, propriétaires, options de comportement, clés API, réglages du répondeur et de modération) MUST s'appliquer dès le message suivant, sans redémarrage ; les autres MUST être marqués « redémarrage nécessaire » tant que le redémarrage n'a pas eu lieu.
- **FR-017**: Les valeurs secrètes (clés API, jetons, mots de passe) MUST être en écriture seule : le panel n'en affiche que l'état « définie / non définie » et les 4 derniers caractères, et elles n'apparaissent jamais dans les pages, les réponses, les journaux ni l'historique des modifications. Enregistrées par le panel, elles MUST être chiffrées au repos avec une clé propre à l'installation ; si cette clé est perdue, le panel le signale et demande de ressaisir les valeurs.
- **FR-018**: L'administrateur MUST pouvoir rétablir la valeur par défaut d'un réglage.
- **FR-019**: Les réglages de démarrage (adresse de la base, activation, adresse et port du panel, relais de confiance, dossier de session) et les chemins de programmes exécutés par le bot MUST être affichés en lecture seule.
- **FR-020**: Le système MUST détecter qu'un réglage a changé depuis l'ouverture du formulaire et refuser d'écraser ce changement.
- **FR-021**: Une valeur enregistrée dans le panel MUST primer sur celle du fichier de configuration ou de l'environnement, pour tous les réglages modifiables ; l'administrateur MUST pouvoir supprimer la valeur du panel pour revenir à celle du fichier, ou à défaut à la valeur par défaut.
- **FR-022**: L'administrateur MUST pouvoir tester une clé API enregistrée : le panel indique si le service l'accepte, la refuse ou est injoignable, sans afficher la clé, avec au plus un test par service toutes les 10 secondes.

#### Appairage

- **FR-023**: Quand le bot n'est pas appairé, le panel MUST afficher le QR code courant, renouvelé à son expiration, et MUST proposer l'appairage par code pour un numéro saisi.
- **FR-024**: L'administrateur MUST pouvoir fermer la session WhatsApp après confirmation, ce qui ramène le bot en attente d'appairage.

#### Commandes

- **FR-025**: Le panel MUST lister chaque commande chargée une seule fois, avec ses alias, sa catégorie, sa description et son niveau d'accès, avec recherche et filtre par catégorie.
- **FR-026**: L'administrateur MUST pouvoir activer ou désactiver une commande ; l'état est persistant, s'applique dès le message suivant à tous les alias et à tous les utilisateurs, propriétaire compris, et une commande désactivée répond « commande désactivée » dans la langue du bot.
- **FR-027**: L'administrateur MUST pouvoir désactiver une commande dans un ou plusieurs groupes seulement, depuis la page de la commande comme depuis celle du groupe ; la désactivation globale l'emporte sur l'activation dans un groupe.

#### Groupes et discussions

- **FR-028**: Le panel MUST lister les groupes du bot avec leur nom, leur nombre de membres et le statut d'administrateur du bot, avec pagination et filtre par nom.
- **FR-029**: Pour chaque groupe, l'administrateur MUST pouvoir régler la bienvenue et le départ (activation, message avec aperçu des variables), l'anti-lien, l'anti-bot, les filtres (ajout, modification, suppression), les rôles des membres, les avertissements (consultation, remise à zéro) et la désactivation du bot dans le groupe.
- **FR-030**: Les changements de réglages de groupe MUST s'appliquer dès le message ou l'événement suivant, sans redémarrage, et MUST rester cohérents avec les commandes WhatsApp équivalentes (une modification faite par l'une est visible par l'autre).
- **FR-031**: Le bot MUST appliquer, dans un groupe où il est administrateur et où le réglage est actif : l'anti-lien (supprimer un message contenant un lien envoyé par un non-administrateur, avertir son auteur, le retirer au-delà de la limite d'avertissements) ; l'anti-bot (retirer un compte identifié comme bot) ; le mode muet (activer ou désactiver le réglage WhatsApp « seuls les administrateurs peuvent envoyer des messages »). Les administrateurs du groupe et les propriétaires sont exemptés.
- **FR-032**: Le panel MUST prévenir quand un réglage de groupe exige que le bot soit administrateur et qu'il ne l'est pas.
- **FR-033**: Le panel MUST lister les discussions privées où le bot est désactivé et permettre de le réactiver.

#### Journaux, statistiques et traçabilité

- **FR-034**: Le panel MUST afficher les 1 000 dernières entrées du journal, filtrables par niveau et par texte, mises à jour en direct, sans aucune valeur secrète.
- **FR-035**: Le panel MUST afficher les messages traités par jour sur 7 jours, les 10 commandes les plus utilisées et les commandes en échec sur la même période.
- **FR-036**: Le système MUST conserver un historique des actions d'administration (connexions, échecs, modifications de réglages, redémarrages, appairages, déconnexions) avec la date, l'origine et le réglage concerné, sans valeur secrète, consultable dans le panel.

#### Interface

- **FR-037**: Le panel MUST être disponible en français et en anglais, la langue de l'interface étant choisie par l'administrateur, indépendamment de la langue du bot.
- **FR-038**: Toutes les fonctions du panel MUST être utilisables sur un écran de téléphone (largeur de 360 px) comme sur un ordinateur.
- **FR-039**: Toute action destructrice ou perturbatrice (redémarrage, fermeture de session, vidage des propriétaires, suppression de réglages de groupe) MUST demander une confirmation.
- **FR-040**: Le panel MUST être activé par défaut dans les deux modes de lancement du bot (normal ou « panel ») et désactivable par un réglage de démarrage ; si son adresse est indisponible, le bot MUST fonctionner sans panel et le signaler dans la console.
- **FR-041**: Le panel MUST proposer un thème clair et un thème sombre, suivant par défaut la préférence de l'appareil.

#### Données du bot

- **FR-042**: Le panel MUST lister les rappels en attente (discussion, auteur, date d'envoi) et permettre de les annuler ; un rappel annulé n'est jamais envoyé.
- **FR-043**: Le panel MUST afficher les soldes de l'économie par groupe et permettre de fixer ou d'ajouter un montant au solde d'un membre, avec un motif tracé dans l'historique ; l'ajustement MUST rester correct face à un gain ou une dépense simultanés et MUST être refusé s'il rend le solde négatif.
- **FR-044**: Le panel MUST permettre de consulter et de supprimer les mots-clés d'alerte, les commandes liées à des stickers, les statuts d'absence, les tâches, les idées et les citations.
- **FR-045**: Toute donnée modifiée depuis le panel MUST être immédiatement visible par les commandes WhatsApp correspondantes, et inversement.

#### Diffusion

- **FR-046**: Les destinations d'une diffusion MUST se limiter aux groupes dont le bot est membre et aux discussions privées qui ont déjà écrit au bot ; la saisie d'un numéro arbitraire MUST être impossible.
- **FR-047**: Une diffusion MUST contenir un texte et, au plus, une image ou un document dans la limite de taille des médias du bot ; le panel MUST montrer un aperçu et demander une confirmation indiquant le nombre de destinations.
- **FR-048**: Les envois MUST être espacés d'au moins 5 secondes par défaut (réglable, jamais moins de 2 secondes), avec au plus 200 destinations par diffusion ; le panel MUST afficher la progression en direct, permettre l'annulation et produire un rapport par destination (envoyé, échec, annulé).
- **FR-049**: Une diffusion MUST pouvoir être programmée ; diffusions programmées et en cours MUST survivre à un redémarrage, chaque destination recevant le message au plus une fois ; une diffusion en retard de plus d'une heure MUST être marquée « expirée » sans être envoyée.
- **FR-050**: L'administrateur MUST pouvoir créer un message récurrent (chaque jour, certains jours de la semaine, ou un jour du mois, à une heure donnée dans le fuseau horaire du bot ; un jour absent du mois, comme le 31, correspond au dernier jour de ce mois), avec les mêmes limites de destinations, d'espacement et de contenu qu'une diffusion ; il MUST pouvoir le mettre en pause, le reprendre, le modifier et le supprimer. Chaque occurrence MUST partir au plus une fois ; une occurrence en retard de plus d'une heure MUST être sautée et notée dans l'historique.

#### Sauvegarde et restauration

- **FR-051**: L'export MUST produire un fichier unique chiffré par une phrase de passe d'au moins 12 caractères, contenant les réglages, l'état des commandes, les textes personnalisés et les données du bot, hors historique du répondeur IA et historique d'administration ; la session WhatsApp n'y figure que sur demande explicite, après un avertissement ; le compte administrateur du panel n'y figure jamais.
- **FR-052**: La restauration MUST vérifier la phrase de passe et l'intégrité du fichier avant toute modification, afficher un résumé (date, version du bot, nombre d'éléments par type), demander une confirmation, enregistrer automatiquement l'état actuel, puis remplacer les données et redémarrer le bot ; en cas d'échec, l'état d'avant MUST être conservé.
- **FR-053**: Une sauvegarde d'une version antérieure du bot MUST être acceptée, une sauvegarde d'une version plus récente refusée avec explication, et une sauvegarde MUST pouvoir être restaurée quel que soit le type de base de données des deux installations.

#### Maintenance

- **FR-054**: Le panel MUST afficher la version installée et, quand l'installation peut se mettre à jour elle-même, indiquer si une version plus récente existe avec la liste des changements, puis l'appliquer après confirmation et redémarrer ; sinon, il MUST expliquer comment mettre à jour. Un échec de mise à jour MUST laisser le bot sur la version actuelle.
- **FR-055**: Le panel MUST permettre de mettre à jour les outils de téléchargement du bot.
- **FR-056**: Le panel MUST afficher l'espace occupé par les médias temporaires, le cache anti-suppression en mémoire, les sauvegardes du panel, les journaux et la base de données, et permettre de vider chaque catégorie après confirmation, sauf la base de données (taille seulement).

#### Textes du bot

- **FR-057**: Le panel MUST lister tous les textes envoyés par le bot, en français et en anglais, avec leur version d'origine, une recherche par mot et un filtre par commande.
- **FR-058**: L'administrateur MUST pouvoir remplacer un texte dans une langue et revenir à l'original ; le texte remplacé MUST s'appliquer dès le message suivant, menu et descriptions de commandes compris.
- **FR-059**: Un texte remplacé MUST conserver exactement les emplacements variables de l'original, sinon l'enregistrement est refusé.
- **FR-060**: Les textes remplacés MUST survivre aux mises à jour du bot, et le panel MUST signaler ceux dont l'original a changé depuis ; ils MUST faire partie des sauvegardes.

#### Alertes

- **FR-061**: Le système MUST pouvoir envoyer par WhatsApp aux propriétaires une alerte pour chacun de ces événements, chaque type étant activable séparément dans le panel : reconnexion après une coupure de plus de 5 minutes (avec sa durée) ; 10 erreurs de commande en 10 minutes ; clé API refusée par son service ; origine bloquée après des échecs de connexion au panel ; connexion au panel depuis une origine jamais vue ; mise à jour disponible.
- **FR-062**: Les alertes MUST être limitées : au plus une alerte « erreurs en série » par heure, une alerte « clé refusée » par service et par 24 heures, une alerte « mise à jour disponible » par version ; elles ne contiennent jamais de valeur secrète.
- **FR-063**: Une alerte née pendant une coupure MUST être envoyée à la reconnexion ; sans propriétaire configuré, le panel MUST indiquer que les alertes ne peuvent être envoyées. Tous les types d'alertes sont activés au départ.
- **FR-064**: Les traces d'erreur envoyées en privé aux propriétaires MUST être limitées à une par commande toutes les 10 minutes.

### Key Entities

- **Compte administrateur** : identité qui se connecte au panel ; mot de passe (forme non réversible), date de création, dernière connexion.
- **Session d'administration** : accès ouvert après connexion ; date de début, dernière activité, origine, expiration.
- **Lien de configuration initiale / de réinitialisation** : secret à usage unique avec une date d'expiration.
- **Réglage** : clé, thème, type, valeur par défaut, valeur actuelle, origine (défaut, fichier/environnement, panel), secret ou non, effet (immédiat ou au redémarrage), version (pour détecter les modifications concurrentes).
- **État de commande** : commande (par son nom principal), portée (partout, ou un groupe donné), active ou désactivée, date du changement.
- **Diffusion** : contenu (texte, média facultatif), destinations, espacement, date prévue ou règle de récurrence, état (programmée, en cours, en pause, terminée, annulée, expirée), résultat par destination et par occurrence.
- **Texte personnalisé** : texte d'origine (identifiant, langue), version de remplacement, empreinte de l'original au moment du remplacement (pour signaler un original modifié).
- **Alerte** : type, activée ou non, dernier envoi (pour la limitation), file d'attente des alertes nées pendant une coupure.
- **Sauvegarde** : fichier chiffré ; date, version du bot, contenu (réglages, état des commandes, données, session WhatsApp facultative), nombre d'éléments par type.
- **Réglages de groupe** : existants (bienvenue, départ, anti-lien, anti-bot, filtres, rôles, avertissements, discussion désactivée), désormais aussi modifiables depuis le panel.
- **Entrée d'historique d'administration** : date, origine, action, cible, résultat, sans valeur secrète.
- **Statistique d'usage** : compteurs par jour (messages traités, appels et échecs par commande, activité par groupe).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Sur une installation neuve, le propriétaire sécurise le panel et modifie un premier réglage en moins de 5 minutes, sans éditer de fichier.
- **SC-002**: 100 % des réglages de l'exemple de configuration apparaissent dans le panel ; tous sont modifiables sauf les réglages de démarrage, affichés en lecture seule.
- **SC-003**: 100 % des réglages marqués « immédiat » prennent effet sur le message suivant, sans redémarrage.
- **SC-004**: Un contrôle automatisé qui injecte des valeurs secrètes connues ne retrouve aucune d'elles dans les pages, les réponses du panel, les journaux ni l'historique.
- **SC-005**: Un contrôle automatisé couvrant chaque page et chaque action du panel vérifie qu'aucune n'est accessible sans session, et qu'aucune modification n'est possible depuis un autre site.
- **SC-006**: Après le scan du QR affiché par le panel, le tableau de bord indique « connecté » en 10 secondes au plus.
- **SC-007**: L'état affiché par le tableau de bord suit l'état réel du bot avec 5 secondes de retard au plus.
- **SC-008**: Toutes les fonctions sont accessibles sur un écran de 360 px de large, sans défilement horizontal.
- **SC-009**: Au repos, le panel ajoute moins de 50 Mo à la mémoire utilisée par le bot.
- **SC-010**: Les contrôles automatisés existants du bot passent toujours, et les points de supervision existants répondent comme avant.
- **SC-011**: Une sauvegarde exportée puis restaurée sur une installation neuve redonne des réglages, des états de commande et des données identiques : une comparaison automatisée ne relève aucun écart.
- **SC-012**: Une diffusion vers 50 destinations interrompue par un redémarrage n'envoie jamais deux fois le message à la même destination et sert toutes les destinations restantes.
- **SC-013**: Une commande désactivée dans un groupe y est refusée dès le message suivant et fonctionne ailleurs, dans 100 % des cas testés.
- **SC-014**: Un texte modifié dans le panel est celui que le bot envoie dès le message suivant, et aucun texte remplacé ne perd ou n'ajoute d'emplacement variable.
- **SC-015**: Sur une heure de 100 erreurs de commande provoquées, les propriétaires reçoivent une seule alerte « erreurs en série ».
- **SC-016**: Un message récurrent quotidien suivi pendant 7 occurrences simulées, dont une pendant une coupure de plus d'une heure, part exactement 6 fois.

## Assumptions

- Un seul bot, avec une seule session WhatsApp, par installation.
- Le panel est servi par le bot lui-même, à l'adresse et au port du serveur de statut existant ; aucun service séparé n'est à déployer.
- Le chiffrement de la connexion (HTTPS) est fourni par l'hébergeur ou un proxy quand le panel est exposé hors de la machine ; le panel ne gère pas de certificat.
- Navigateurs visés : les deux dernières versions des navigateurs courants, sur ordinateur et téléphone.
- Les commandes WhatsApp de configuration existantes restent disponibles ; le panel et les commandes partagent les mêmes données.
- La mise à jour automatique n'est possible que pour une installation faite depuis le dépôt de sources ; une installation par image se met à jour en changeant d'image.
- Hors périmètre : plusieurs comptes ou des rôles dans le panel ; la lecture des conversations, y compris le contenu du cache anti-suppression (seuls sa taille et sa purge sont proposées) ; l'envoi à des numéros arbitraires ; l'exécution de code ou de commandes système depuis le panel ; la modification du code des plugins ; la gestion de plusieurs bots ou sessions ; la gestion de l'hébergeur.
- Le panel s'appuie sur la fonctionnalité 001 (pipeline unique, registre des commandes, cache des réglages), non encore fusionnée : cette branche part de `001-audit-fix-commands`.

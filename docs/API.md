# API d'envoi de messages

L'API permet à vos propres applications (site web, caisse, outil de suivi de commandes, script) d'envoyer des messages WhatsApp depuis le numéro du bot, par de simples appels HTTP. Elle est **désactivée par défaut**, fait partie du processus du bot et se gère entièrement depuis la page **API** du panel d'administration (voir [ADMIN_PANEL.md](ADMIN_PANEL.md)).

Ce guide s'adresse à deux lecteurs : le **propriétaire** du bot, qui active l'API et crée les clés, et le **développeur** de l'application qui l'appelle. La description machine de l'API (OpenAPI 3.1) et l'onglet Documentation du panel sont en anglais ; ce guide est en français.

Les exemples utilisent des valeurs fictives : `https://bot.example.com` pour l'adresse du bot, `237690000001` pour un numéro, `owbk_<id>_<secret>` pour une clé. Remplacez-les par les vôtres et ne publiez jamais une vraie clé.

## Sommaire

- [Ce que fait l'API (et ce qu'elle ne fait pas)](#ce-que-fait-lapi-et-ce-quelle-ne-fait-pas)
- [Démarrage en cinq minutes](#démarrage-en-cinq-minutes)
- [Activer l'API et le mot de passe demandé](#activer-lapi-et-le-mot-de-passe-demandé)
- [Les clés](#les-clés)
- [Droits](#droits)
- [Destinataires autorisés](#destinataires-autorisés)
- [Transport : HTTPS, proxy, HTTP simple](#transport--https-proxy-http-simple)
- [Authentification et en-têtes](#authentification-et-en-têtes)
- [Envoyer un message : un exemple par format](#envoyer-un-message--un-exemple-par-format)
- [Médias : fichier ou URL](#médias--fichier-ou-url)
- [Le message, ses statuts et ses échecs](#le-message-ses-statuts-et-ses-échecs)
- [Attendre le résultat : `wait`](#attendre-le-résultat--wait)
- [Suivre vos messages](#suivre-vos-messages)
- [Boutons, listes et sondages : lire les réponses](#boutons-listes-et-sondages--lire-les-réponses)
- [Quotas, cadence et `Retry-After`](#quotas-cadence-et-retry-after)
- [Idempotence : réessayer sans envoyer deux fois](#idempotence--réessayer-sans-envoyer-deux-fois)
- [Catalogue des erreurs](#catalogue-des-erreurs)
- [Disponibilité](#disponibilité)
- [Conservation des données et ce qui n'est jamais stocké](#conservation-des-données-et-ce-qui-nest-jamais-stocké)
- [OpenAPI et génération de client](#openapi-et-génération-de-client)
- [Liste de contrôle de sécurité](#liste-de-contrôle-de-sécurité)

## Ce que fait l'API (et ce qu'elle ne fait pas)

- Quatre endpoints sous `/api/v1` : envoyer un message, lire un message, lister vos messages, télécharger la description OpenAPI.
- **Treize formats** d'envoi : texte, image, vidéo, GIF, audio, note vocale, document, sticker, position, contact, sondage, boutons, liste.
- Un destinataire par requête : un numéro avec indicatif du pays, ou un groupe.
- La réponse arrive tout de suite (`202`) : le message entre dans une **file d'attente espacée** (au moins 2 secondes entre deux envois automatiques, cadence partagée avec les diffusions du panel) et part quelques secondes plus tard. Le statut se lit ensuite, ou s'attend avec `wait`.
- **Un texte envoyé par l'API n'est jamais une commande** : `.eval 1+1` ou `.restart` arrivent chez le destinataire comme du texte, quel que soit le préfixe configuré.
- Pas de navigateur (aucun CORS), pas de webhook, pas de lecture des messages reçus, pas de plusieurs destinataires par requête, pas de média en base64 dans v1.

Compatibilité : tout ce qui est ajouté dans `v1` est compatible (nouveau endpoint, format, champ optionnel, champ de réponse, code d'erreur ou d'échec). Un client doit ignorer les champs de réponse inconnus et traiter une valeur d'énumération inconnue comme un cas générique. Un changement incompatible passerait par `/api/v2`, servi à côté de `v1`.

## Démarrage en cinq minutes

1. Dans le panel d'administration, ouvrez **API** et cliquez sur **Activer l'API** (le mot de passe du panel peut être demandé, voir plus bas).
2. Onglet **Clés** > **Nouvelle clé** : donnez un nom, cochez `messages.send.text`, choisissez le destinataire dans la liste, enregistrez.
3. **Copiez la clé complète** quand elle s'affiche : elle ne sera plus jamais montrée.
4. Appelez l'API :

```bash
export OWB_KEY='owbk_<id>_<secret>'

curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "format": "text", "to": "237690000001", "text": "Hello Awa, your order #4821 has shipped. Tracking: https://track.example.com/4821" }'
```

Réponse `202 Accepted`, avec l'en-tête `Location: /api/v1/messages/msg_Vx3k9QfL2mNvB7aRtYhZwc` :

```json
{
  "message": {
    "id": "msg_Vx3k9QfL2mNvB7aRtYhZwc",
    "format": "text",
    "to": "237690000001",
    "chatType": "private",
    "status": "queued",
    "size": 82,
    "requestId": "9f2c4e1a7b3d5c60",
    "steps": { "queued": "2026-11-02T10:15:30.123Z", "sending": null, "sent": null, "delivered": null, "read": null },
    "expiresAt": "2026-11-02T10:25:30.123Z",
    "endedAt": null,
    "failure": null,
    "responses": null
  }
}
```

5. Suivez le message : `curl "https://bot.example.com/api/v1/messages/msg_Vx3k9QfL2mNvB7aRtYhZwc" -H "Authorization: Bearer $OWB_KEY"` (il faut alors aussi le droit `messages.read`).

## Activer l'API et le mot de passe demandé

- **L'API est désactivée tant que vous ne l'activez pas.** Désactivée, tout chemin sous `/api/v1/` répond exactement comme n'importe quelle adresse inconnue du bot, avec ou sans clé : rien ne trahit son existence.
- L'API n'existe que si le panel existe : avec `ADMIN_PANEL=false`, elle n'est pas construite.
- **Activer** affiche un avertissement (risque de restriction ou de bannissement du numéro en cas d'envois automatisés ou en masse) puis demande de confirmer. **Désactiver** annule les messages encore en file (la fenêtre affiche leur nombre) et garde les clés.
- Il n'existe aucun réglage ni variable d'environnement qui active l'API : seul le bouton de la page **API** le fait.

### Le mot de passe est redemandé pour tout ce qui élargit l'accès

Pour qu'une session volée ou laissée ouverte ne suffise pas à ouvrir l'API, le panel redemande le **mot de passe de l'administrateur** avant une modification qui **élargit** ce qu'une clé ou l'API peut faire :

- activer l'API, ajouter un réseau autorisé en HTTP simple ;
- créer ou dupliquer une clé ;
- ajouter un droit, ajouter un destinataire (dans n'importe quel mode), passer au mode « connus » ou « n'importe qui », élargir ou vider la liste d'adresses IP, repousser ou supprimer la date d'expiration.

Ne demandent **jamais** le mot de passe : révoquer une clé, retirer un droit ou un destinataire, restreindre le mode ou la liste d'IP, régler les limites, poser une première expiration ou l'avancer, désactiver l'API.

Une connexion réussie ouvre une fenêtre de **5 minutes** pendant laquelle rien n'est redemandé ; une confirmation la renouvelle. Chaque session a sa propre fenêtre et un redémarrage du bot les efface toutes. Un mauvais mot de passe n'enregistre rien et ne vous déconnecte pas ; cinq erreurs verrouillent la confirmation 15 minutes, comme la connexion.

## Les clés

Une clé a la forme `owbk_<id>_<secret>` : `<id>` fait 16 caractères hexadécimaux en minuscules et `<secret>` 43 caractères base64url (65 caractères en tout). Les outils de détection de secrets la repèrent avec `owbk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}`.

Page **API** > onglet **Clés**. Une clé réunit :

| Réglage | Détail |
|---------|--------|
| Nom | 1 à 64 caractères, unique parmi les clés non révoquées (sans tenir compte de la casse) |
| Droits | Aucun à la création. Voir [Droits](#droits) |
| Destinataires | Liste, connus ou n'importe qui. Voir [Destinataires autorisés](#destinataires-autorisés) |
| Limites | Par minute, par jour, messages en attente. Sans valeur propre, la clé suit les réglages (Réglages > Limites) |
| Adresses IP | Liste facultative (50 entrées au plus : adresse, plage CIDR IPv4 ou IPv6). Vide : aucune restriction |
| Expiration | Facultative. Une clé expirée est refusée et ses messages en attente sont annulés |

Au plus **50 clés non révoquées**. Après la création, la liste n'affiche que le nom et les **4 derniers caractères** de la clé. Il n'existe pas de « révéler » : pour changer de clé, créez-en une nouvelle (ou dupliquez-la : mêmes droits, destinataires, limites, IP et expiration, nouveau secret) et révoquez l'ancienne.

**Révoquer** est immédiat et définitif : la prochaine requête reçoit `401 key_revoked`, les messages en file de la clé deviennent `cancelled`, et la clé disparaît avec son historique 30 jours plus tard (`API_RETENTION_DAYS`). Une clé révoquée n'est jamais réactivée, et une restauration de sauvegarde ne la ressuscite pas.

Un droit ajouté plus tard par un nouvel endpoint ou un nouveau format n'est accordé à **aucune** clé existante : il faut le cocher.

Quand une clé est utilisée depuis une adresse qu'elle n'avait jamais utilisée, le propriétaire peut recevoir une alerte WhatsApp (réglage `ALERT_API_KEY_NEW_IP`, désactivé par défaut ; la toute première adresse ne déclenche jamais d'alerte).

## Droits

Chaque endpoint et chaque format a son droit. Une clé qui ne l'a pas reçoit `403 forbidden` avec le droit manquant dans `params.right`.

| Droit | Autorise |
|-------|----------|
| `messages.send.text`, `.image`, `.video`, `.gif`, `.audio`, `.voice`, `.document`, `.sticker`, `.location`, `.contact`, `.poll`, `.buttons`, `.list` | `POST /api/v1/messages` avec le `format` correspondant |
| `messages.read` | `GET /api/v1/messages/:id` et `GET /api/v1/messages` (vos propres messages seulement) |
| `media.url` | Joindre un média **par URL** (`media.url`) et demander un aperçu de lien (`linkPreview: true`) : le bot télécharge alors une adresse pour vous |
| `api.docs` | `GET /api/v1/openapi.json` |

Donnez à chaque application **uniquement** les droits dont elle a besoin. `media.url` est le plus sensible : sans lui, le bot ne télécharge jamais rien.

## Destinataires autorisés

Chaque clé a une politique de destinataires. Un destinataire hors politique reçoit `403 recipient_not_allowed` (le numéro n'est jamais repris dans la réponse).

| Mode | La clé peut écrire à | Remarque |
|------|----------------------|----------|
| `list` (par défaut) | Seulement les numéros et groupes de sa liste (200 au plus) | Le choix le plus sûr |
| `known` | Les personnes qui ont déjà écrit au bot et les groupes dont il fait partie | La liste est conservée mais ignorée tant que ce mode est choisi |
| `anyone` | N'importe quel numéro WhatsApp | **Risqué** : voir ci-dessous |

**`anyone` expose votre numéro au bannissement.** WhatsApp restreint ou bannit les numéros qui envoient des messages à des inconnus ou en rafale, souvent sans prévenir et parfois définitivement. Le panel demande une confirmation explicite et affiche une bannière tant qu'une clé est en mode `anyone`. Réservez-le à une application en laquelle vous avez toute confiance, avec des limites basses, et surveillez l'historique.

Dans tous les modes, **le numéro du bot lui-même** est refusé (`422`, `fields.to = { code: "not_allowed" }`) et un chat désactivé dans le bot (commande `ban`) répond `409 chat_disabled`.

Le champ `to` accepte un numéro avec indicatif du pays (les espaces, `+`, `-`, `.`, parenthèses et un `00` initial sont ignorés ; 8 à 15 chiffres, sans `0` initial) ou un identifiant de groupe `...@g.us` tel que le panel l'affiche. Toute autre forme (un identifiant `@lid`, un `@s.whatsapp.net`) est `invalid_format`.

## Transport : HTTPS, proxy, HTTP simple

**L'API exige HTTPS.** Une requête est acceptée si l'une de ces conditions est vraie :

1. la connexion est chiffrée, ou un **proxy de confiance** déclare `X-Forwarded-Proto: https` (réglage `PANEL_TRUST_PROXY`, le même que pour le panel) ;
2. c'est une **requête locale** : l'appelant est sur la machine du bot (adresse de boucle locale), sans en-tête `X-Forwarded-*` non fiable. Les autres adresses de la machine (celle du réseau local, par exemple) ne comptent pas comme locales ;
3. l'adresse du client est dans la liste des **réseaux autorisés en HTTP simple** de la page API (onglet Clés).

Toute autre requête reçoit `403 https_required`, **avant** que la clé soit lue.

### Réseaux autorisés en HTTP simple

Cette liste est **vide par défaut**. Elle accepte uniquement des plages privées (10.x.x.x, 172.16 à 172.31, 192.168.x.x, 100.64 à 100.127, `fc00::/7`), 20 entrées au plus ; une adresse publique, la boucle locale, `0.0.0.0/0` et `::/0` sont refusées. L'ajouter demande le mot de passe, la retirer non, et la modification s'applique à la requête suivante sans redémarrage.

### Piège avec Docker

Avec un port publié par Docker (`ports: ["3000:3000"]`), le trafic venu d'Internet peut atteindre le bot avec **l'adresse de la passerelle du réseau Docker** comme appelant. Autoriser en HTTP simple une plage large comme tout le sous-réseau de compose reviendrait alors à admettre Internet en clair. Listez plutôt l'adresse exacte de votre application en `/32` (`192.168.1.20/32`), ou mettez un proxy HTTPS devant le bot (voir [ADMIN_PANEL.md](ADMIN_PANEL.md#reverse-proxy-settings)).

### Derrière un proxy

Déclarez le proxy avec `PANEL_TRUST_PROXY` (et `PANEL_PUBLIC_URL`). Sans cela, tous les appelants partagent l'adresse du proxy : le blocage d'origine (10 échecs d'authentification en 5 minutes, 15 minutes de blocage) peut alors bloquer tout le monde à cause d'un seul client fautif.

### Pas de navigateur

L'API n'est pas faite pour être appelée depuis une page web : tout en-tête `Origin` ou `Sec-Fetch-Site` donne `403 browser_not_allowed`, `OPTIONS` donne `405` et aucune réponse ne porte d'en-tête `Access-Control-*`. Appelez-la depuis votre serveur, jamais depuis le navigateur de vos visiteurs (la clé y serait visible). Un client côté serveur n'envoie pas `Origin`.

## Authentification et en-têtes

```http
Authorization: Bearer owbk_<id>_<secret>
```

- Exactement un en-tête `Authorization`. La clé n'est lue **que** là : une clé dans l'adresse, la requête, le corps, un cookie ou un autre en-tête n'est jamais utilisée. Une adresse qui contient une chaîne en forme de clé ou un paramètre nommé `api_key`, `apikey`, `key`, `token`, `access_token` ou `authorization` est refusée `400 key_in_url`, sans même regarder la clé.
- Le cookie de session du panel ne donne aucun accès à l'API, et une clé d'API n'ouvre rien dans le panel.
- Une clé absente, mal formée, inconnue ou au mauvais secret donne **la même réponse** `401 unauthenticated` (aucune énumération). `key_revoked`, `key_expired` et `ip_not_allowed` ne sont montrés qu'à celui qui détient le secret complet.
- **Blocage d'origine** : 10 échecs d'authentification en 5 minutes bloquent l'adresse pendant 15 minutes (`429 origin_blocked`, `Retry-After` jusqu'à 900), même avec une clé valide. Le propriétaire reçoit une alerte WhatsApp (`ALERT_API_ORIGIN_BLOCKED`).

En-têtes de requête utiles :

| En-tête | Pour | Règle |
|---------|------|-------|
| `Content-Type` | `POST /messages` | `application/json` ou `multipart/form-data` ; sinon `415 unsupported_media_type` |
| `Idempotency-Key` | `POST /messages` | `^[A-Za-z0-9._:-]{1,80}$`, voir [Idempotence](#idempotence--réessayer-sans-envoyer-deux-fois) |

En-têtes de réponse (toutes les réponses, erreurs comprises) :

| En-tête | Valeur |
|---------|--------|
| `X-Request-Id` | 16 caractères hexadécimaux, aussi dans `error.requestId`. **Citez-le dans une demande d'aide** : il retrouve la requête dans les journaux du bot |
| `Location` | `/api/v1/messages/<id>` sur un `202` (relatif, y compris pour un rejeu) |
| `Idempotent-Replayed` | `true` sur un rejeu idempotent |
| `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` | Fenêtre par minute de la clé, sur les réponses de `POST /messages` à partir de l'authentification |
| `Retry-After` | Secondes (au moins 1) sur `429`, `503` et chaque fois que `params.retryAfterMs` existe |
| `WWW-Authenticate` | Sur `401` |

Les corps sont en UTF-8 ; les réponses sont du JSON non compressé (`application/json; charset=utf-8`), avec `Cache-Control: no-store`. Les dates sont en ISO 8601 UTC avec millisecondes (`2026-11-02T10:15:30.123Z`), les valeurs absentes valent `null`. Les chaînes sont normalisées (NFC), rognées, puis mesurées en caractères Unicode. Une propriété inconnue est refusée, à tous les niveaux.

## Envoyer un message : un exemple par format

`POST /api/v1/messages`. Le corps est un objet JSON dont `format` choisit les champs. Champs communs :

| Champ | Obligatoire | Règle |
|-------|-------------|-------|
| `format` | oui | L'un des treize noms ci-dessous |
| `to` | oui | Numéro avec indicatif ou identifiant de groupe, voir [Destinataires](#destinataires-autorisés) |
| `quote` | non | L'`id` d'un message **de la même clé**, **vers la même discussion**, déjà `sent`, `delivered` ou `read` : le nouveau message cite l'ancien. Sinon `fields.quote = { code: "not_found" }` |

Les limites sont **refusées, jamais tronquées**. Chaque faute de la requête est listée d'un coup dans `error.fields` (voir [Catalogue des erreurs](#catalogue-des-erreurs)). Les exemples supposent `OWB_KEY` défini comme plus haut. Pour les formats avec média, la partie `message` est le même objet JSON, envoyé en multipart avec le fichier ; voir [Médias](#médias--fichier-ou-url) pour la variante par URL.

### text

Droit `messages.send.text`. `text` : 1 à 4 096 caractères, envoyé tel quel, **jamais interprété comme une commande**. `mentions` (facultatif, groupes seulement) : 50 numéros au plus, que le texte désigne par `@<numéro>` ; les numéros qui ne sont pas membres sont ignorés. `linkPreview` (facultatif, `false` par défaut) : `true` demande le droit `media.url`, voir plus bas.

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "format": "text", "to": "237690000001", "text": "Hello Awa, your order #4821 has shipped. Tracking: https://track.example.com/4821" }'
```

Aucun lien d'un texte n'est jamais ouvert par défaut : chaque texte part avec la génération d'aperçu désactivée.

### image

Droit `messages.send.image`. Média obligatoire (JPEG, PNG ou WebP, 16 Mo). `caption` : 1 à 1 024 caractères.

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -F 'message={ "format": "image", "to": "237690000001", "caption": "Your receipt" };type=application/json' \
  -F 'file=@./receipt.jpg'
```

### video

Droit `messages.send.video`. MP4, QuickTime (MOV) ou 3GP, 16 Mo. `caption` facultatif.

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -F 'message={ "format": "video", "to": "120363025246125486@g.us", "caption": "Training session of Saturday" };type=application/json' \
  -F 'file=@./training.mp4'
```

### gif

Droit `messages.send.gif`. GIF, MP4 ou MOV, 16 Mo en entrée comme en sortie. Un GIF est converti en MP4 en boucle (`gifPlayback`). `caption` facultatif.

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -F 'message={ "format": "gif", "to": "237690000001", "caption": "Done!" };type=application/json' \
  -F 'file=@./done.gif'
```

### audio

Droit `messages.send.audio`. MP3, Ogg (Opus compris), M4A, WAV, FLAC, AAC ou AMR (pas WebM), 16 Mo. Envoyé comme un **fichier audio** (pas une note vocale). Pas de légende.

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -F 'message={ "format": "audio", "to": "237690000001" };type=application/json' \
  -F 'file=@./song.mp3'
```

### voice

Droit `messages.send.voice`. Tous les types `audio`, plus WebM et MP4 (la piste audio est extraite), 16 Mo. Converti en Ogg/Opus et envoyé comme une **note vocale** (la forme d'onde affichée est plate). Pas de légende.

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -F 'message={ "format": "voice", "to": "237690000001" };type=application/json' \
  -F 'file=@./note.ogg'
```

### document

Droit `messages.send.document`. PDF, ZIP, Office ancien (`.doc` `.xls` `.ppt`) ou OOXML (`.docx` `.xlsx` `.pptx`), OpenDocument, texte brut, CSV ; 100 Mo ; **jamais un exécutable**. `caption` facultatif ; `fileName` (1 à 255 caractères, nettoyé en nom de base) : par défaut le nom du fichier du multipart, sinon `file` et l'extension détectée.

```bash
curl -X POST "https://bot.example.com/api/v1/messages?wait=30" \
  -H "Authorization: Bearer $OWB_KEY" \
  -H "Idempotency-Key: invoice-2026-0042" \
  -F 'message={ "format": "document", "to": "237690000001", "caption": "Invoice 2026-0042", "fileName": "invoice-2026-0042.pdf" };type=application/json' \
  -F 'file=@./invoice-2026-0042.pdf;type=application/pdf'
```

### sticker

Droit `messages.send.sticker`. JPEG, PNG ou WebP, 10 Mo en entrée ; converti en sticker WebP 512 x 512 de 900 Ko au plus, avec le nom de pack et d'auteur du bot (`STICKER_PACKNAME`, `STICKER_AUTHOR`). Pas de légende.

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -F 'message={ "format": "sticker", "to": "237690000001" };type=application/json' \
  -F 'file=@./sticker.png'
```

### location

Droit `messages.send.location`. `latitude` (-90 à 90) et `longitude` (-180 à 180) obligatoires ; `name` et `address` (1 à 256 caractères) facultatifs.

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "format": "location", "to": "237690000001", "latitude": 4.0511, "longitude": 9.7679, "name": "Pickup point", "address": "Rue de la Joie, Douala" }'
```

### contact

Droit `messages.send.contact`. `contacts` : 1 à 10 cartes ; une carte envoie un contact, plusieurs envoient une liste. Chaque carte : `name` (1 à 128), `phones` (1 à 5 numéros distincts avec indicatif), `organization` et `email` facultatifs. Le bot construit lui-même la fiche vCard : vous n'envoyez jamais de texte de fiche brut, et aucune valeur ne peut y ajouter une propriété.

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "format": "contact", "to": "237690000001", "contacts": [ { "name": "Acme Support", "phones": ["+237 690 00 00 02"], "organization": "Acme", "email": "support@acme.example" } ] }'
```

### poll

Droit `messages.send.poll`. `question` (1 à 255), `options` (2 à 12 entrées de 1 à 100 caractères, distinctes), `multiple` (facultatif, `false`). Les votes sont collectés, voir [Boutons, listes et sondages](#boutons-listes-et-sondages--lire-les-réponses).

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "format": "poll", "to": "120363025246125486@g.us", "question": "Which day for training?", "options": ["Tuesday", "Thursday", "Saturday"], "multiple": false }'
```

### buttons

Droit `messages.send.buttons`. `text` (1 à 1 024) et `buttons` (1 à 3), chaque bouton ayant un `id` à vous (`^[A-Za-z0-9_.-]{1,64}$`, distinct) et un `label` de 1 à 20 caractères. Sur les téléphones qui affichent les boutons, ils sont natifs ; le message porte **aussi** une version numérotée et une ligne d'aide, pour les appareils qui ne les affichent pas. Le corps composé doit rester sous 4 096 caractères.

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "format": "buttons", "to": "237690000001", "text": "Do you confirm your appointment tomorrow at 10:00?", "buttons": [ { "id": "confirm", "label": "Yes" }, { "id": "cancel", "label": "No" } ] }'
```

### list

Droit `messages.send.list`. `text` (1 à 1 024), `buttonLabel` (1 à 20, le bouton qui ouvre la liste) et `choices` (1 à 10) avec `id` (comme un bouton), `title` (1 à 24) et `description` (facultative, 1 à 72).

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "format": "list", "to": "237690000001", "text": "Choose a delivery slot", "buttonLabel": "See slots", "choices": [ { "id": "slot-am", "title": "Morning", "description": "8:00 - 12:00" }, { "id": "slot-pm", "title": "Afternoon", "description": "14:00 - 18:00" } ] }'
```

Boutons et listes sont natifs sur les téléphones qui les montrent et un texte numéroté sur les autres ; une réponse par numéro doit **citer** le message.

## Médias : fichier ou URL

Pour image, vidéo, GIF, audio, note vocale, document et sticker, le média arrive d'**une seule** source :

- **un fichier**, dans une requête `multipart/form-data` ;
- **une URL**, dans le JSON : `"media": { "url": "https://files.example.com/receipt.jpg" }` (droit `media.url` obligatoire).

Aucune source : `fields.media = { code: "required" }`. Les deux : `fields.media = { code: "not_allowed" }`. Un fichier sur un format sans média : `fields.file = { code: "not_allowed" }`. Pas de base64 dans le JSON.

```bash
curl -X POST "https://bot.example.com/api/v1/messages" \
  -H "Authorization: Bearer $OWB_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "format": "image", "to": "237690000001", "caption": "Your receipt", "media": { "url": "https://files.example.com/receipt.jpg" } }'
```

**Le contenu est jugé sur ses octets** : le `Content-Type` déclaré, le nom du fichier et l'extension sont ignorés. Un fichier qui ne correspond pas au format est `422 media_type_mismatch` (avec `params.expected`, jamais le type détecté) et il est supprimé aussitôt ; un fichier au-dessus du plafond est `413 media_too_large` (`params.maxBytes`) et la réception s'arrête dès le plafond dépassé. Le plafond effectif est le plus petit de celui du format et du réglage `MAX_UPLOAD`. Une conversion qui échoue **après** l'acceptation (audio illisible, image corrompue) n'est pas une erreur HTTP : le message finit `failed` avec `media_conversion_failed`. Le fichier mis en attente est supprimé dès que le message se termine, quelle que soit l'issue.

### Le multipart

Exactement deux parties, **dans cet ordre** : `message` (le JSON du format, 64 Kio au plus, avec ou sans `Content-Type`) puis `file`. Une partie `file` avant `message` donne `fields.file = { code: "invalid_order" }`. Une requête multipart mal formée est `400 bad_request`. Au plus 2 envois de fichier simultanés par clé et 4 en tout (`429 rate_limited`, `scope: "uploads"`, `Retry-After: 5`) ; un arrêt de 30 secondes sans octet coupe l'envoi.

### Les règles de l'URL

Le bot télécharge le fichier **pendant** la requête, avant de mettre le message en file : vous savez tout de suite s'il est refusé. Utilisez un délai de client d'au moins 65 secondes avec `media.url` (30 secondes de téléchargement au plus, plus `wait`). Règles appliquées à chaque redirection :

| Règle | Sinon |
|-------|-------|
| Schéma `https:` seulement (une redirection vers `http:` aussi) | `422 url_forbidden`, `reason: "scheme"` |
| Pas d'identifiants `user:pass@` | `reason: "credentials"` |
| Port standard 443 seulement | `reason: "port"` |
| Un nom DNS avec au moins un point. **Les adresses IP écrites en clair sont refusées** (`127.0.0.1`, `2130706433`, `[::1]`...), ainsi que `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.localdomain` | `reason: "host"` |
| **Toutes** les adresses du nom doivent être publiques : une seule adresse privée (boucle locale, réseau local, lien local dont `169.254.169.254`, CGNAT, multicast, réservée, etc.) refuse le nom | `reason: "host"` |
| 3 redirections au plus, chacune revalidée depuis la première règle | `reason: "redirects"` à la quatrième |
| Un nom qui ne se résout pas | `reason: "host"` (pas `url_unreachable`, pour ne rien révéler sur les noms internes) |
| Réponse `200` seulement, sans `Content-Encoding` | `502 url_unreachable` |
| Une échéance de 30 secondes pour tout (DNS, redirections, corps) | `502 url_unreachable` |
| Le contenu est compté pendant qu'il arrive | `413 media_too_large` |
| Les premiers octets sont examinés | `422 media_type_mismatch` |

Rien de votre requête (cookie, `Authorization`) n'est transmis au serveur distant et aucun proxy d'environnement n'est utilisé.

### Aperçu de lien

`linkPreview: true` sur un `text` demande le droit `media.url`. Au moment de l'envoi, le bot ouvre le **premier lien `https://`** du texte selon les mêmes règles (256 Kio, HTML seulement), lit `<title>`, `og:title` et `og:description` et les joint comme aperçu. S'il n'y a pas de lien `https://` ou que la récupération échoue, le texte part **sans aperçu** et le message n'échoue pas.

## Le message, ses statuts et ses échecs

La ressource ci-dessus (voir [Démarrage en cinq minutes](#démarrage-en-cinq-minutes)) ne contient **jamais** le contenu du message : ni texte, ni légende, ni fichier, ni question de sondage. Seules les réponses d'un message interactif portent de courts libellés.

| Champ | Sens |
|-------|------|
| `id` | `msg_` suivi de 22 caractères base64url : le seul identifiant à utiliser |
| `format`, `to`, `chatType` | Format, destinataire normalisé (chiffres du numéro ou identifiant du groupe), `private` ou `group` |
| `status` | Voir ci-dessous |
| `size` | Octets du média reçu ; pour les formats sans média, longueur UTF-8 du texte principal ; `null` pour position et contact |
| `requestId` | L'`X-Request-Id` de la requête qui l'a créé |
| `steps` | L'heure de chaque étape atteinte (`queued` est l'heure d'acceptation), `null` avant |
| `expiresAt` | Acceptation + délai d'expiration (10 minutes par défaut) : passé cet instant, un message non envoyé ne partira jamais |
| `endedAt` | Renseigné avec `failed`, `expired`, `cancelled` ou `unknown` |
| `failure` | `{ "code": ... }` pour `failed`, `cancelled` et `unknown` ; `null` sinon |
| `responses` | Pour sondages, boutons et listes ; `null` pour les autres formats |

### Statuts

| Statut | Sens |
|--------|------|
| `queued` | Accepté, il attend son tour dans la file espacée |
| `sending` | Pris par l'expéditeur et remis à WhatsApp : point de non-retour |
| `sent` | Le serveur WhatsApp l'a accepté |
| `delivered` | Arrivé sur l'appareil du destinataire (discussions privées, si WhatsApp le signale) |
| `read` | Lu (discussions privées ; une note vocale écoutée compte) |
| `failed` | Non envoyé, ou refusé par WhatsApp ensuite : voir `failure.code` |
| `expired` | Non envoyé avant `expiresAt`, il ne partira jamais |
| `cancelled` | Retiré de la file avant l'envoi : clé révoquée ou expirée, ou API désactivée |
| `unknown` | Issue incertaine (redémarrage ou délai pendant l'envoi) : **jamais renvoyé**, à vous de décider de renvoyer ou non |

Un message passe de `queued` à `sending`, `expired`, `cancelled` ou `failed` ; de `sending` à `sent`, `failed` ou `unknown` ; de `sent` ou `unknown` à `delivered` puis `read` (accusés de réception, discussions privées seulement : un message de groupe s'arrête à `sent`). Le seul retour en arrière est un refus tardif de WhatsApp, qui fait passer `sent` ou `unknown` à `failed` avec `whatsapp_rejected`.

### Codes d'échec (`failure.code`)

Ce ne sont pas des erreurs HTTP : ils n'apparaissent que sur un message déjà accepté.

| Code | Statut | Sens |
|------|--------|------|
| `not_on_whatsapp` | `failed` | Le numéro n'utilise pas WhatsApp ; rien n'a été envoyé |
| `chat_disabled` | `failed` | La discussion a été désactivée dans le bot (`ban`) après l'acceptation |
| `not_in_group` | `failed` | Le bot n'est plus membre du groupe |
| `group_announce_only` | `failed` | Seuls les administrateurs peuvent écrire dans le groupe et le bot n'en est pas un |
| `media_conversion_failed` | `failed` | Le média n'a pas pu être converti |
| `payload_unavailable` | `failed` | Le contenu mis en attente a disparu ; jamais envoyé en texte seul |
| `whatsapp_rejected` | `failed` | WhatsApp a refusé le message après le relais (accusé négatif, `463` compris). Trois refus de restriction en 10 minutes suspendent aussi la file 15 minutes |
| `send_failed` | `failed` | L'envoi a été refusé avant de partir |
| `key_revoked` | `cancelled` | La clé a été révoquée pendant l'attente |
| `key_expired` | `cancelled` | La clé a expiré pendant l'attente |
| `api_disabled` | `cancelled` | Le propriétaire a désactivé l'API pendant l'attente |
| `interrupted` | `unknown` | Le bot s'est arrêté pendant l'envoi |
| `timeout` | `unknown` | WhatsApp n'a pas répondu à temps |
| `connection_closed` | `unknown` | La connexion est tombée pendant l'envoi |

La liste peut s'allonger dans `v1` : traitez un code inconnu comme un échec générique. Un message `expired` n'a pas de code (la cause est l'expiration elle-même).

## Attendre le résultat : `wait`

`POST /api/v1/messages?wait=N` (`N` de 0 à 30, en chiffres décimaux) garde la réponse ouverte jusqu'à ce que le message atteigne `sent`, `failed`, `expired`, `cancelled` ou `unknown`, ou que `N` secondes se soient écoulées depuis l'acceptation, et renvoie le statut **de cet instant**. Toujours `202`, jamais un statut HTTP qui traduit le statut du message.

- `delivered` et `read` ne terminent jamais une attente : lisez le message ensuite si vous les voulez.
- Un client qui se déconnecte abandonne seulement l'attente ; le message reste en file.
- 200 attentes au plus en même temps pour tout le bot ; au-delà, la réponse est immédiate avec le statut courant (ce n'est pas une erreur).
- `wait=31` est `out_of_range` et `wait=true` est `invalid_format`. L'en-tête `Prefer: wait=` n'est pas pris en compte.
- Avec une file longue, un message peut rester `queued` plus que `N` secondes : `wait` ne remplace pas la lecture du statut.

## Suivre vos messages

Droit `messages.read`, vos propres messages seulement.

```bash
curl "https://bot.example.com/api/v1/messages/msg_Vx3k9QfL2mNvB7aRtYhZwc" \
  -H "Authorization: Bearer $OWB_KEY"
```

`GET /api/v1/messages/:id` répond `200 { message }`. Le message d'une autre clé, celui du panel, un message inexistant, un message purgé et un identifiant mal formé donnent **le même** `404 not_found`. Cet endpoint n'accepte aucun paramètre de requête.

```bash
curl "https://bot.example.com/api/v1/messages?status=sent&format=text&limit=25" \
  -H "Authorization: Bearer $OWB_KEY"
```

`GET /api/v1/messages` répond `200 { "messages": [...], "next": "msg_..." | null }`, du plus récent au plus ancien. Paramètres :

| Paramètre | Défaut | Règle |
|-----------|--------|-------|
| `status` | tous | l'un des neuf statuts |
| `format` | tous | l'un des treize formats |
| `since` | aucun | borne basse incluse sur l'heure d'acceptation (RFC 3339, `...Z` ou `+hh:mm`) |
| `until` | aucun | borne haute exclue ; `until <= since` est `out_of_range` |
| `limit` | `25` | de 1 à 100 |
| `after` | aucun | la valeur `next` de la page précédente |

`next` est l'`id` du dernier élément quand il en reste, sinon `null` ; passez-le dans `after` pour continuer (pagination par curseur : les pages restent stables quand de nouveaux messages arrivent). Un `after` qui n'est pas un message de cette clé donne `422` avec `fields.after = { code: "not_found" }`. Les éléments de la liste n'ont pas de `responses` : lisez le message pour les obtenir.

## Boutons, listes et sondages : lire les réponses

Pour `poll`, `buttons` et `list`, le bot enregistre les réponses pendant **7 jours** après `steps.sent` (`API_REPLY_WINDOW_DAYS`, réglable ; pour un message `unknown`, qui n'a pas d'étape `sent`, à partir de `endedAt`). Sont enregistrés : un appui sur un bouton ou une ligne, une réponse par numéro **qui cite** le message, un vote de sondage. Rien d'autre n'est lu. Après la fenêtre, une réponse est avalée par le bot (aucune autre fonction n'y réagit) mais n'est plus enregistrée. Un message garde 1 000 réponses au plus.

La ressource porte alors `responses` :

```json
{
  "responses": {
    "until": "2026-11-09T10:15:42.000Z",
    "total": 2,
    "items": [
      { "at": "2026-11-02T11:02:10.000Z", "author": "237690000002", "kind": "vote", "via": null, "choices": [ { "id": "1", "label": "Thursday" } ] },
      { "at": "2026-11-02T11:05:44.000Z", "author": "237690000003", "kind": "vote", "via": null, "choices": [ { "id": "0", "label": "Tuesday" }, { "id": "2", "label": "Saturday" } ] }
    ],
    "totals": [
      { "id": "0", "label": "Tuesday", "count": 1 },
      { "id": "1", "label": "Thursday", "count": 1 },
      { "id": "2", "label": "Saturday", "count": 1 }
    ]
  }
}
```

| Champ | Sens |
|-------|------|
| `until` | Fin de la collecte ; `null` tant que le message n'est pas envoyé |
| `total`, `items` | Les réponses, de la plus ancienne à la plus récente : `{ at, author, kind, via, choices }` |
| `author` | Les chiffres du numéro du répondant, ou `<numéro>@lid` quand WhatsApp ne donne qu'un identifiant de confidentialité |
| `kind` | `choice` (boutons, listes) ou `vote` (sondage) |
| `via` | `tap` ou `number` pour un choix, `null` pour un vote |
| `choices` | `{ id, label }` : pour boutons et listes, votre `id` et le libellé du bouton ou le titre de la ligne ; pour un sondage, l'indice de l'option (`"0"` à `"11"`) et son texte |
| `totals` | Sondage seulement : une entrée par option, dans l'ordre, zéros compris ; `null` pour boutons et listes |

Un sondage compte **un élément par votant** : son dernier vote remplace le précédent, et un vote retiré reste présent avec `choices: []`. Boutons et listes ajoutent un élément par réponse (qui appuie deux fois en produit deux). Tant qu'un sondage est en file, `totals` vaut `null`. Les libellés conservés sont de courts textes (100 caractères au plus) gardés pendant la durée de conservation.

## Quotas, cadence et `Retry-After`

Les limites s'appliquent **par clé** et restent exactes sous requêtes simultanées. Chaque clé peut avoir ses propres valeurs ; sans valeur propre, elle suit les réglages (modifier un réglage s'applique à toutes les clés qui n'ont pas de valeur propre, à la requête suivante, jamais aux messages déjà en file).

| Limite (ordre de vérification) | Défaut | Réglage | Refus |
|--------------------------------|--------|---------|-------|
| Messages en attente, toutes clés et panel | 500 | `API_QUEUE_MAX` | `503 queue_full`, `scope: "global"` |
| Attente estimée contre l'expiration | 10 min | `API_QUEUE_EXPIRY_MIN` | `503 queue_full`, `scope: "wait"` |
| En attente par clé (`queued` + `sending`) | 100 | `API_MAX_PENDING` | `429 pending_limit_reached` |
| Messages par jour (jour civil du `TIMEZONE` du bot) | 1 000 | `API_RATE_PER_DAY` | `429 daily_quota_exceeded` |
| Messages par minute (fenêtre glissante de 60 s) | 30 | `API_RATE_PER_MINUTE` | `429 rate_limited`, `scope: "minute"` |

Un message compte dès qu'il est accepté et reste compté quoi qu'il devienne. Un rejeu idempotent, une requête refusée et une requête qui échoue après la réservation ne comptent pas. Le compteur du jour survit aux redémarrages.

**Cadence.** La file envoie **un message à la fois**, avec au moins `SEND_MIN_SPACING_MS` (2 000 ms, relevable seulement) plus une marge aléatoire de 0 à 20 %, espacement partagé avec les diffusions du panel. L'acceptation est immédiate mais la livraison est étalée : 100 messages acceptés partent en 3 min 20 s à 4 min environ. Un message non envoyé `API_QUEUE_EXPIRY_MIN` (10) minutes après son acceptation devient `expired` et ne partira jamais, même si le bot se reconnecte ensuite ; les messages survivent à un redémarrage.

**Admission selon l'attente estimée.** Une requête est refusée quand `(messages en attente + 1) x espacement x 1,1` dépasse l'expiration : avec les défauts, la file accepte environ 272 messages en attente même si le plafond global est de 500, car un message qui ne pourrait pas partir à temps est refusé tout de suite plutôt que d'expirer.

**`Retry-After`.** Chaque `429` et `503` porte `Retry-After` (secondes, au moins 1), calculé à partir de `params.retryAfterMs` : pour la minute, jusqu'à ce que le plus ancien message compté sorte de la fenêtre ; pour le jour, jusqu'au prochain minuit local ; pour une file pleine, de 1 à 300 s ; pour `origin_blocked`, le reste du blocage ; pour `unavailable`, 5 s. Respectez-le au lieu de réessayer en boucle. Les réponses de `POST /messages` à partir de l'authentification portent aussi `RateLimit-Limit`, `RateLimit-Remaining` et `RateLimit-Reset`.

**Restriction WhatsApp.** Un seul refus `463` ne fait échouer que son message (`whatsapp_rejected`). Trois en 10 minutes suspendent la file 15 minutes : les messages restent acceptés, ceux qui expirent pendant la pause deviennent `expired`, et le propriétaire reçoit l'alerte `api_paused`.

## Idempotence : réessayer sans envoyer deux fois

Envoyez un en-tête `Idempotency-Key` (`^[A-Za-z0-9._:-]{1,80}$`) avec `POST /messages` : en cas de délai dépassé ou de réponse perdue, rejouez **la même requête avec la même clé**.

- Pendant **24 heures** à partir de l'acceptation de la première requête, la même clé avec le même contenu renvoie le message déjà créé, dans son état **courant** : `202`, `Location`, `Idempotent-Replayed: true`, **sans nouvel envoi** et sans consommer de quota. `wait` s'applique aussi à un rejeu.
- Le « même contenu » est une empreinte du JSON tel qu'envoyé (l'ordre des clés ne compte pas, un défaut écrit explicitement compte comme une différence) et, en multipart, du SHA-256 du fichier. Pour `media.url`, c'est la chaîne de l'URL qui compte, pas les octets téléchargés. L'en-tête lui-même, `wait`, le nom et le type déclaré du fichier n'en font pas partie.
- Un contenu différent avec la même clé : `409 idempotency_conflict`, rien n'est envoyé.
- Seule une requête **acceptée** est mémorisée : une requête refusée en `4xx` ou `5xx` laisse la clé libre, vous pouvez la corriger et la renvoyer avec la même clé.
- Deux requêtes identiques simultanées créent un seul message ; la perdante est traitée comme un rejeu.
- Le rejeu est vérifié après l'authentification, le droit, la politique de destinataires et le chat désactivé : une clé révoquée ne peut pas rejouer.

## Catalogue des erreurs

Enveloppe unique, toujours :

```json
{ "error": { "code": "forbidden", "params": { "right": "messages.send.image" }, "requestId": "9f2c4e1a7b3d5c60" } }
```

`fields` n'apparaît que pour `validation_failed`. Il n'y a jamais de prose, de trace, de valeur soumise, de numéro de destinataire ni de secret : **traitez le `code`, pas un texte**. `params.retryAfterMs` devient aussi `Retry-After`.

| Code | HTTP | Paramètres | Notes |
|------|------|------------|-------|
| `unavailable` | 503 | `retryAfterMs` (5000) | Base pas prête, restauration en cours, base injoignable, clés illisibles (le service échoue fermé) |
| `method_not_allowed` | 405 | aucun | `Allow` seulement quand la route existe pour un autre verbe |
| `not_found` | 404 | aucun | Chemin inconnu, `:id` mal formé, message inexistant, d'une autre clé ou purgé |
| `bad_request` | 400 | aucun | JSON mal formé ou qui n'est pas un objet, en-tête ou multipart mal formé |
| `https_required` | 403 | aucun | Voir [Transport](#transport--https-proxy-http-simple) |
| `browser_not_allowed` | 403 | aucun | `Origin` ou `Sec-Fetch-Site` présent |
| `key_in_url` | 400 | aucun | La clé n'est pas utilisée |
| `origin_blocked` | 429 | `retryAfterMs` | Reste du blocage, 900 s au plus |
| `unauthenticated` | 401 | aucun | Clé absente, mal formée, inconnue ou mauvais secret : une seule réponse |
| `key_revoked`, `key_expired` | 401 | aucun | Seulement après que le secret correspond |
| `ip_not_allowed` | 403 | aucun | Seulement après que le secret correspond |
| `forbidden` | 403 | `right` | Droit manquant, nommé |
| `recipient_not_allowed` | 403 | aucun | Hors politique ; le numéro n'est jamais repris |
| `chat_disabled` | 409 | aucun | La discussion est désactivée dans le bot |
| `rate_limited` | 429 | `scope` (`minute`, `uploads`), `limit`, `retryAfterMs` | Minute de la clé ; envois de fichiers simultanés |
| `daily_quota_exceeded` | 429 | `limit`, `retryAfterMs` | Jour civil du `TIMEZONE` du bot |
| `pending_limit_reached` | 429 | `limit`, `retryAfterMs` | `queued` + `sending` de la clé |
| `queue_full` | 503 | `scope` (`global`, `wait`, `disk`), `retryAfterMs` | Voir [Quotas](#quotas-cadence-et-retry-after) ; `disk` : médias en attente au-delà de deux fois `MAX_UPLOAD` |
| `idempotency_conflict` | 409 | aucun | Même clé, contenu différent |
| `payload_too_large` | 413 | `maxBytes` | Corps JSON ou partie `message` au-dessus de 64 Kio |
| `media_too_large` | 413 | `maxBytes` | Fichier, téléchargement ou longueur déclarée au-dessus du plafond |
| `unsupported_media_type` | 415 | aucun | `Content-Type` ni JSON ni multipart |
| `validation_failed` | 422 | voir `fields` | Voir ci-dessous |
| `media_type_mismatch` | 422 | `expected` | Le contenu ne correspond pas au format ; le type détecté n'est pas repris |
| `url_forbidden` | 422 | `reason` (`scheme`, `credentials`, `port`, `host`, `redirects`) | Voir [Les règles de l'URL](#les-règles-de-lurl) |
| `url_unreachable` | 502 | aucun | Échec distant ; un nouvel essai peut réussir |
| `internal_error` | 500 | aucun | Journalisé avec l'identifiant de requête |

**Ordre des vérifications.** La première qui échoue répond : clé (authentification, état, adresse IP), puis droit, destinataire (forme de `to`, politique, numéro du bot), discussion désactivée, quotas, enfin le contenu. Un refus de droit ou de politique n'est donc jamais masqué par une faute de contenu, et une requête limitée par un quota est refusée avant d'avoir envoyé son fichier.

### Fautes de `validation_failed`

`fields` associe un chemin pointé à `{ code, params? }` : `to`, `buttons.1.id`, `contacts.0.phones.2`, `options.2`, `media.url`, `idempotency-key` (l'en-tête), `wait`. `$unknown` désigne une propriété inconnue à son niveau (son nom n'est jamais repris).

| Code de champ | Paramètres | Pour |
|---------------|------------|------|
| `required` | aucun | Champ manquant (`media` aussi quand ni fichier ni URL) |
| `invalid_type` | aucun | Mauvais type JSON |
| `invalid_format` | aucun | Motif, nombre, URL, horodatage ou e-mail |
| `too_short`, `too_long` | `min`, `max` | Longueur |
| `out_of_range` | `min`, `max` | Plage numérique (`latitude`, `wait`, `limit`, `until`) |
| `not_allowed` | `allowed` (énumérations) | Valeur non permise : `format` inconnu, `mentions` sur une discussion privée, numéro du bot, fichier et URL ensemble |
| `too_many_items` | `max` | Tableau trop long |
| `unknown_field` | aucun | Propriété inconnue |
| `invalid_order` | aucun | Partie `file` avant `message` |
| `duplicate` | aucun | Option, id de bouton ou de choix, ou téléphone répété |
| `not_found` | aucun | `quote` ou `after` ne désigne pas un message utilisable de cette clé |

## Disponibilité

| Situation | Ce que voit l'appelant |
|-----------|------------------------|
| API désactivée (par défaut) | Tout chemin sous `/api/v1/**`, tout verbe, avec ou sans clé : **la réponse de n'importe quelle adresse inconnue du bot**, octet pour octet. Aucun JSON, aucun indice qu'une API existe |
| `ADMIN_PANEL=false` | Idem : aucune API n'est construite |
| Un module de l'API ne se charge pas au démarrage | Rien n'est servi, même réponse qu'une API désactivée ; le bot, le panel et les commandes continuent, et la page API du panel nomme le module en cause |
| Bot en démarrage (base pas prête) | `503 unavailable` + `Retry-After: 5`, avant toute authentification |
| Restauration de sauvegarde | `503 unavailable` pendant la restauration. Une restauration n'active jamais l'API, ne ressuscite aucune clé et ne rejoue aucun message |
| API désactivée pendant le fonctionnement | La requête suivante n'est plus prise en charge ; les messages en file deviennent `cancelled` (`api_disabled`) ; les attentes en cours se terminent avec ce statut |
| Clé révoquée ou expirée | Sa prochaine requête est refusée ; ses messages en file sont `cancelled` |
| WhatsApp déconnecté | Les requêtes restent acceptées (`202`) ; les messages attendent puis deviennent `expired` à l'échéance. Ce n'est pas un `503` |
| Compte WhatsApp restreint | Voir [Quotas](#quotas-cadence-et-retry-after) : file suspendue 15 minutes, alerte au propriétaire |
| Redémarrage du bot | Les messages en file reprennent sauf s'ils ont expiré ; un message qui était en cours d'envoi devient `unknown` (`interrupted`) et n'est **jamais renvoyé** |

Le propriétaire peut recevoir trois alertes WhatsApp liées à l'API (page Alertes du panel) : origine bloquée (`ALERT_API_ORIGIN_BLOCKED`, activée), clé utilisée depuis une nouvelle adresse (`ALERT_API_KEY_NEW_IP`, désactivée) et file suspendue (`ALERT_API_PAUSED`, activée).

## Conservation des données et ce qui n'est jamais stocké

- **Historique : 30 jours** (réglage `API_RETENTION_DAYS`, de 1 à 365). Un nettoyage quotidien supprime les messages, leurs réponses et les clés révoquées plus anciennes. `API_REPLY_WINDOW_DAYS` ne peut pas dépasser `API_RETENTION_DAYS`. Un message purgé est un `404`, comme un message inexistant.
- **Conservé** : la clé (ou la source « panel »), le destinataire, le format, la taille, le statut et l'heure de chaque étape, le code d'échec, l'identifiant WhatsApp, et, pour les messages interactifs, les réponses avec les libellés courts des boutons, des lignes et des options (100 caractères au plus).
- **Jamais conservé** : le texte, la légende, le nom de fichier, le média. Le contenu d'un message en attente est gardé seulement jusqu'à son statut final, puis effacé dans la même écriture. Le fichier d'un média en attente est supprimé dès que le message est envoyé, en échec, expiré ou annulé, et un nettoyage quotidien supprime tout fichier orphelin.
- **Les clés** : seul un haché irréversible du secret est stocké ; le secret n'est affiché qu'une fois à la création.
- **Journaux et audit** : jamais la clé ni une partie de son secret, jamais un texte, une légende, un nom de fichier, une URL ni un libellé. Le destinataire est masqué dans les journaux. Une clé y apparaît par son numéro dans le panel et son nom.
- **Sauvegardes** du panel : les clés, l'historique des envois et l'état de l'interrupteur ne sont jamais exportés.

## OpenAPI et génération de client

`GET /api/v1/openapi.json` (droit `api.docs`, désactivé pour toute nouvelle clé) renvoie un document OpenAPI **3.1** (JSON Schema 2020-12) généré à partir des endpoints et des formats réellement enregistrés : il ne peut donc pas diverger du comportement. Le propriétaire peut aussi le télécharger depuis l'onglet **Documentation** du panel (bouton « Télécharger le fichier OpenAPI », fichier `openwhatsappbot-api-v1.openapi.json`), **même quand l'API est désactivée** et sans clé.

Le document décrit une opération par endpoint, le schéma de chacun des treize formats (`oneOf` avec un discriminateur sur `format` et un exemple par format), les erreurs, les droits requis (`x-required-rights`) et le schéma de sécurité `bearerAuth`. Il est en **anglais**. Tout générateur compatible OpenAPI 3.1 produit un client (vérifiez que votre version du générateur gère bien la 3.1), par exemple :

```bash
curl -s "https://bot.example.com/api/v1/openapi.json" -H "Authorization: Bearer $OWB_KEY" -o openapi.json
npx @openapitools/openapi-generator-cli generate -i openapi.json -g typescript-fetch -o ./owb-client
```

Configurez le client généré pour envoyer `Authorization: Bearer <votre clé>`. `info.version` (`1.0.0`) suit les évolutions compatibles ; son numéro majeur est celui du chemin (`v1`).

## Liste de contrôle de sécurité

- [ ] L'API est **activée seulement si vous en avez besoin** et désactivée sinon.
- [ ] Le bot est servi en **HTTPS** (proxy de confiance déclaré avec `PANEL_TRUST_PROXY`). Le HTTP simple est limité à des plages privées précises, en `/32` quand le bot est derrière un port publié par Docker.
- [ ] **Une clé par application**, avec uniquement les droits nécessaires. `media.url` seulement si vraiment utile.
- [ ] Destinataires en mode **`list`** chaque fois que possible. `anyone` seulement pour une application de confiance, avec des limites basses.
- [ ] **Limites** adaptées à l'usage réel (par minute, par jour, en attente) et une **liste d'adresses IP** quand l'application a une adresse fixe.
- [ ] Une **date d'expiration** pour les clés temporaires ; révoquez toute clé inutilisée ou compromise (c'est immédiat).
- [ ] La clé est dans une variable d'environnement ou un gestionnaire de secrets de **votre serveur**, jamais dans un dépôt, une page web, une application mobile ou un message. Elle ne figure jamais dans une adresse.
- [ ] Les appels viennent de **votre serveur**, jamais du navigateur de vos visiteurs.
- [ ] Vous utilisez `Idempotency-Key` pour tout envoi que vous pourriez rejouer, et vous respectez `Retry-After`.
- [ ] Vous surveillez l'**historique** de la page API et les **alertes** WhatsApp (origine bloquée, nouvelle adresse, file suspendue).
- [ ] Vous gardez des cadences basses : un numéro WhatsApp qui envoie beaucoup, à des inconnus ou en rafale, finit par être restreint ou banni. Le bot ne peut pas l'empêcher.

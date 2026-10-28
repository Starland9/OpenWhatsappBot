# 🌐 Guide de Déploiement Bot-Hosting.net

Ce guide complet vous explique comment déployer OpenWhatsappBot sur [bot-hosting.net](https://bot-hosting.net) et d'autres plateformes d'hébergement basées sur des panneaux de contrôle.

## 📋 Table des Matières

- [Prérequis](#prérequis)
- [Déploiement Étape par Étape](#déploiement-étape-par-étape)
- [Configuration du Panel](#configuration-du-panel)
- [Panel d'administration web](#panel-dadministration-web)
- [Variables d'Environnement](#variables-denvironnement)
- [Commandes de Démarrage](#commandes-de-démarrage)
- [Endpoints API](#endpoints-api)
- [Dépannage](#dépannage)
- [FAQ](#faq)

---

## 🔧 Prérequis

Avant de commencer, assurez-vous d'avoir :

- ✅ Un compte sur [bot-hosting.net](https://bot-hosting.net) ou une plateforme similaire
- ✅ Un plan avec support Node.js 20+
- ✅ Accès au gestionnaire de fichiers du panel
- ✅ Un compte WhatsApp actif pour le bot
- ✅ (Optionnel) Des clés API pour les fonctionnalités avancées (Gemini, OpenAI, etc.)

---

## 🚀 Déploiement Étape par Étape

### Étape 1 : Créer un Nouveau Service

1. Connectez-vous à votre dashboard bot-hosting.net
2. Cliquez sur **"Create Service"** ou **"Nouveau Service"**
3. Sélectionnez **Node.js** comme type de service
4. Choisissez un nom pour votre bot (ex: `open-whatsapp-bot`)

### Étape 2 : Télécharger le Code

#### Option A : Via Git (Recommandé)
Dans le terminal du panel, exécutez :
```bash
git clone https://github.com/Starland9/OpenWhatsappBot .
```

#### Option B : Via Upload
1. Téléchargez le [ZIP du repository](https://github.com/Starland9/OpenWhatsappBot/archive/refs/heads/master.zip)
2. Extrayez et uploadez tous les fichiers via le gestionnaire de fichiers

### Étape 3 : Installer les Dépendances

Dans le terminal du panel :
```bash
yarn install
```

Ou si yarn n'est pas disponible :
```bash
npm install
```

### Étape 4 : Configurer l'Environnement

1. Créez un fichier `config.env` basé sur `config.env.example` :
```bash
cp config.env.example config.env
```

2. Éditez `config.env` avec vos paramètres :
```env
# Configuration obligatoire
PREFIX=.
SUDO=votre_numero

# Clés API (optionnel mais recommandé ; modifiables ensuite depuis le panel d'administration)
GEMINI_API_KEY=votre_cle_gemini
```

Il n'y a rien à régler pour le panel : il est activé par défaut et utilise le `PORT` fourni par l'hébergeur (voir [Panel d'administration web](#panel-dadministration-web)). `PANEL_ENABLED` n'existe plus.

### Étape 5 : Configurer le Démarrage

Dans les paramètres du service, configurez la commande de démarrage :
```bash
node panel.js
```

Ou via PM2 pour une meilleure stabilité :
```bash
pm2 start panel.js --name bot
```

### Étape 6 : Scanner le QR Code

1. Démarrez le service
2. Consultez les logs pour voir le QR code
3. Scannez-le avec WhatsApp sur votre téléphone
4. Le bot est maintenant connecté !

Les mêmes logs contiennent une ligne « Panel d'administration : ouvrez ce lien pour créer le mot de passe administrateur » : ouvrez-la pour sécuriser le panel web (voir plus bas). Le panel permet aussi d'appairer WhatsApp depuis le navigateur (QR en direct ou code d'appairage), sans lire les logs.

---

## ⚙️ Configuration du Panel

### Fichier panel.js

Le fichier `panel.js` est spécialement conçu pour les plateformes d'hébergement. Il fournit :

| Fonctionnalité | Description |
|----------------|-------------|
| 🏥 Health Check | Endpoint `/health` pour le monitoring de disponibilité |
| 📊 Métriques | Endpoint `/metrics` avec statistiques détaillées |
| 🔄 Keep-Alive | Ping automatique pour maintenir le service actif |
| 🌐 Status Page | Page HTML de statut accessible via le navigateur |
| 🛑 Graceful Shutdown | Arrêt propre du bot lors des redémarrages |

### Différence entre index.js et panel.js

| Aspect | index.js | panel.js |
|--------|----------|----------|
| Panel d'administration | Oui (par défaut) | Oui (par défaut) |
| Health Check, métriques, page de statut | Seulement avec le panel d'administration | Toujours (même avec `ADMIN_PANEL=false`) |
| Usage | VPS/Local | bot-hosting.net |

Les deux fichiers lancent le même bot (`lib/core/boot.js`) ; `panel.js` garde en plus les endpoints de supervision quand le panel d'administration est désactivé, ce que vérifient les hébergeurs.

---

## 🖥️ Panel d'administration web

Le bot embarque une interface web (`/admin/`) pour tout régler sans éditer de fichier : tableau de bord et redémarrage, réglages appliqués à chaud, appairage WhatsApp, commandes et groupes, données du bot, diffusions, sauvegardes, mise à jour, textes, alertes, journaux et statistiques. Elle est **activée par défaut**, dans `index.js` comme dans `panel.js`.

### Premier démarrage

1. Démarrez le service et ouvrez les logs.
2. Repérez la ligne `Panel d'administration : ouvrez ce lien pour créer le mot de passe administrateur (usage unique, valable 30 minutes) : http://...`. Elle est réaffichée à chaque démarrage tant qu'aucun compte n'existe. Avec `PANEL_PUBLIC_URL`, le lien commence par l'adresse publique que vous avez indiquée.
3. Ouvrez-le et choisissez un mot de passe d'au moins 12 caractères : vous êtes connecté. Le lien ne sert qu'une fois et expire au bout de 30 minutes.

Sans terminal, ou si vous avez perdu le mot de passe : créez un fichier vide `data/admin-reset` dans le gestionnaire de fichiers et redémarrez le service. Le lien de réinitialisation apparaît dans les logs et le fichier est supprimé. Avec un terminal : `node tools/admin-reset.js` (le bot peut rester en marche).

### Atteindre le panel

| Où tourne le bot | Adresse d'écoute |
|------------------|------------------|
| Votre ordinateur ou un VPS | `127.0.0.1` : seul cet ordinateur y accède |
| Un conteneur, ou un hébergeur qui définit `PORT` (bot-hosting.net...) | `0.0.0.0` |

- **Hébergeur de bots** : le panel écoute sur le `PORT` du service. Renseignez `PANEL_PUBLIC_URL` avec l'adresse publique du service pour que le lien de configuration soit cliquable. Le HTTPS est fourni par l'hébergeur.
- **VPS** : gardez l'adresse locale et ouvrez un tunnel SSH (`ssh -L 3000:127.0.0.1:3000 utilisateur@serveur`) puis `http://localhost:3000/admin/`, ou placez un reverse proxy avec HTTPS devant le bot. Le panel ne gère pas TLS lui-même ; l'ouvrir sur Internet sans HTTPS affiche un avertissement permanent.
- **Derrière un reverse proxy** : définissez `PANEL_PUBLIC_URL=https://bot.exemple.com` et `PANEL_TRUST_PROXY` (adresse ou réseau du proxy : une IP, un CIDR comme `172.18.0.0/16`, ou `loopback`, `private`). Sans `PANEL_TRUST_PROXY`, les en-têtes `X-Forwarded-*` sont ignorés, tous les visiteurs ont l'adresse du proxy et un bandeau « proxy non déclaré » s'affiche.
- **Désactiver** : `ADMIN_PANEL=false`. Le bot continue de fonctionner.

### Docker

`docker-compose.yml` ne fait qu'**exposer** le port du panel dans le réseau des conteneurs, sans le publier. Pour y accéder depuis la machine, décommentez `ports: ["127.0.0.1:3000:3000"]` ; pour un serveur, passez par un reverse proxy (Traefik, Dokploy...) avec `PANEL_PUBLIC_URL` et `PANEL_TRUST_PROXY`. Le lien de configuration se trouve dans `docker compose logs bot`. Le contrôle de santé de l'image appelle `/ping` (et non `/health`, qui répond 503 tant que WhatsApp n'est pas appairé). Conservez les trois volumes : `bot_sessions` (session WhatsApp), `bot_db` (SQLite) et `bot_data` (`data/panel.key`, `data/backups/`).

### Sauvegardes et clé de chiffrement

- La page **Sauvegarde** exporte réglages (clés API comprises), états des commandes, textes modifiés et données du bot dans un fichier `.owb` chiffré par une phrase secrète d'au moins 12 caractères (non récupérable). Le compte administrateur, l'historique, les alertes et les conversations IA n'y figurent jamais ; la session WhatsApp est facultative et le fichier permettrait alors de prendre le contrôle du numéro. Le fichier est d'abord construit dans `data/tmp` : le téléchargement annonce sa taille (`Content-Length`).
- La restauration vérifie le fichier avant tout (mauvaise phrase secrète, fichier altéré, version plus récente refusés) et affiche un résumé : lignes par table, et ce que cette version ignore (`ignoredSettings`, `ignoredTexts`, tables et colonnes inconnues). Elle crée d'abord une copie automatique `data/backups/pre-restore-<date>.owb`, remplace les données en une seule transaction et garde l'état précédent en cas d'échec. Une sauvegarde passe d'une base SQLite à PostgreSQL et inversement.
- Les clés API saisies dans le panel sont chiffrées dans la base avec la clé `data/panel.key` (créée à la première saisie, droits 600). Si ce fichier est perdu (volume non conservé), les clés enregistrées s'affichent « à ressaisir » et les valeurs de `config.env` s'appliquent en attendant : il suffit de les retaper.

---

## 🔐 Variables d'Environnement

### Variables Obligatoires

| Variable | Description | Exemple |
|----------|-------------|---------|
| `PREFIX` | Préfixe des commandes | `.` |
| `SUDO` | Numéros admin (sans +) | `33612345678` |

### Variables Panel

| Variable | Description | Défaut |
|----------|-------------|--------|
| `ADMIN_PANEL` | Panel d'administration (seule la valeur exacte `false` le désactive). Remplace `PANEL_ENABLED`, qui n'est plus lu | `true` |
| `PANEL_PORT` | Port du serveur HTTP (alias : `PORT`, fourni par l'hébergeur ; ordre : `PANEL_PORT`, `PORT`, `3000`) | `3000` |
| `PANEL_HOST` | Adresse d'écoute (alias : `HOST`). À ne pas définir : le panel écoute sur `127.0.0.1` en local et sur `0.0.0.0` dans un conteneur ou si l'hébergeur définit `PORT` | automatique |
| `PANEL_PUBLIC_URL` | Adresse publique du panel (`https://bot.exemple.com`, sans chemin) : base du lien de création du mot de passe et `Origin` accepté | _(vide)_ |
| `PANEL_TRUST_PROXY` | Reverse proxys dont on croit les en-têtes `X-Forwarded-*` (IP, CIDR, `loopback`, `private`, `all`) | _(vide : jamais)_ |
| `KEEP_ALIVE_INTERVAL` | Intervalle ping (ms) | `60000` |
| `PANEL_TOKEN` | Jeton exigé par `POST /api/restart` (vide = endpoint désactivé) | _(vide)_ |
| `LOG_FORMAT` | `pretty` (lisible) ou `json` (une ligne par entrée) | `pretty` |
| `SUPERVISED` | Qui relance le bot après une mise à jour : `auto`, `true`, `false` | `auto` |
| `UPDATE_CHECK` | Recherche d'une nouvelle version (`false` la désactive) | `true` |

`PANEL_ENABLED` (livré à `false` dans les anciens `config.env.example`) n'a jamais rien fait. S'il est encore défini, une ligne de la console le signale au démarrage ; il est ignoré et **le panel d'administration démarre quand même** : écrivez `ADMIN_PANEL=false` pour le désactiver. Les réglages de démarrage ci-dessus ne se modifient que dans l'environnement ou `config.env` ; le panel les affiche en lecture seule.

### Variables Optionnelles (API)

| Variable | Service | Obtenir |
|----------|---------|---------|
| `GEMINI_API_KEY` | Google Gemini AI | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| `OPENAI_API_KEY` | OpenAI / ChatGPT | [OpenAI Platform](https://platform.openai.com/api-keys) |
| `WEATHER_API_KEY` | Météo | [WeatherAPI](https://www.weatherapi.com/signup.aspx) |
| `NEWS_API_KEY` | Actualités | [NewsAPI](https://newsapi.org/register) |

---

## 🖥️ Commandes de Démarrage

### Pour bot-hosting.net

```bash
# Commande principale (recommandée)
node panel.js

# Avec PM2 (si disponible)
pm2 start panel.js --name bot

# Avec variables d'environnement
PORT=3000 node panel.js
```

### Scripts npm/yarn

```bash
# Mode panel
yarn panel

# Mode panel avec PM2
yarn panel:pm2

# Mode développement (sans panel)
yarn dev
```

---

## 📡 Endpoints API

Le serveur panel expose plusieurs endpoints :

### GET /health
Vérifie l'état de santé du bot.
```json
{
  "status": "healthy",
  "botStatus": "running",
  "connected": true,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### GET /status
Retourne le statut détaillé.
```json
{
  "status": "running",
  "connected": true,
  "uptime": 3600,
  "uptimeFormatted": "1h",
  "version": "59.0.0",
  "messagesProcessed": 150,
  "lastActivity": "2024-01-15T10:30:00.000Z"
}
```

### GET /ping
Simple test de disponibilité.
```json
{
  "pong": true,
  "timestamp": 1705314600000,
  "latency": 0
}
```

### GET /metrics
Métriques système et bot.
```json
{
  "bot": {
    "status": "running",
    "connected": true,
    "uptime": 3600,
    "version": "59.0.0",
    "messagesProcessed": 150
  },
  "system": {
    "memory": {
      "heapUsed": 85,
      "heapTotal": 120,
      "rss": 180
    },
    "memoryUnit": "MB",
    "nodeVersion": "v20.10.0",
    "platform": "linux"
  }
}
```

### GET /api/info
Informations sur le bot.
```json
{
  "name": "OpenWhatsappBot",
  "version": "59.0.0",
  "prefix": ".",
  "repository": "https://github.com/Starland9/OpenWhatsappBot",
  "features": ["AI Chat", "Media Downloads", "..."]
}
```

### POST /api/restart
Déclenche un redémarrage du bot. Protégé : définissez `PANEL_TOKEN` et envoyez `Authorization: Bearer <PANEL_TOKEN>`. Sans jeton configuré l'endpoint répond 403, avec un mauvais jeton 401, avec une autre méthode que POST 405. Le redémarrage ne déconnecte pas la session WhatsApp.
```bash
curl -X POST -H "Authorization: Bearer $PANEL_TOKEN" http://localhost:3000/api/restart
```
```json
{
  "message": "Bot restart initiated",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

## 🔧 Dépannage

### Le bot ne démarre pas

1. **Vérifiez les logs** : Consultez les logs du panel pour identifier l'erreur
2. **Node.js version** : Assurez-vous que Node.js 20+ est utilisé
   ```bash
   node --version
   ```
3. **Dépendances** : Réinstallez les dépendances
   ```bash
   rm -rf node_modules && yarn install
   ```

### QR Code non affiché

1. Consultez les logs en temps réel
2. Attendez quelques secondes après le démarrage
3. Ouvrez la page **Appairage** du panel d'administration : le QR code s'y affiche en direct, ou saisissez votre numéro pour obtenir un code d'appairage

### Le bot se déconnecte souvent

1. Augmentez `KEEP_ALIVE_INTERVAL` si nécessaire
2. Vérifiez les limites de mémoire de votre plan
3. Consultez `/metrics` pour le diagnostic

### Erreur "Port already in use"

Le bot continue de fonctionner, sans panel : la console nomme `PANEL_PORT`, `PANEL_HOST` et `ADMIN_PANEL=false`. Changez le port dans `config.env` :
```env
PANEL_PORT=3001
```

### La session expire

1. Supprimez le dossier `sessions/`
2. Redémarrez le bot
3. Scannez à nouveau le QR code

### Erreurs de base de données

1. Vérifiez les permissions d'écriture
2. Utilisez SQLite (par défaut) ou configurez PostgreSQL :
   ```env
   DATABASE_URL=postgres://user:pass@host:5432/db
   ```

---

## ❓ FAQ

### Q: Quelle est la différence entre `index.js` et `panel.js` ?

**R:** Les deux lancent le même bot et le même panel d'administration. `panel.js` garde en plus les endpoints de monitoring (`/health`, `/ping`...) même quand le panel d'administration est désactivé (`ADMIN_PANEL=false`), ce que vérifient les plateformes d'hébergement. `index.js` est pour les déploiements locaux ou VPS classiques.

### Q: Puis-je utiliser panel.js sur un VPS ?

**R:** Oui ! panel.js fonctionne partout. C'est même recommandé si vous voulez monitorer votre bot via HTTP.

### Q: Le bot consomme combien de RAM ?

**R:** En moyenne 100-200 MB, avec des pics à 300 MB lors du traitement média. Choisissez un plan avec au moins 512 MB.

### Q: Comment mettre à jour le bot ?

**R:** Depuis le panel d'administration, page **Maintenance** : la mise à jour télécharge la nouvelle version, essaie de la démarrer dans un processus de test et revient en arrière si ce démarrage échoue. Le bot ne se relance seul que s'il est supervisé (PM2, hébergeur) ; sinon la page indique de le redémarrer. En ligne de commande :
```bash
git pull --ff-only origin master
yarn install
# Puis redémarrez le service
```
Dans une image Docker, reconstruisez l'image : le panel affiche alors la marche à suivre au lieu d'un bouton.

### Q: Mes sessions sont-elles perdues lors d'un redémarrage ?

**R:** Non, les sessions sont stockées dans le dossier `sessions/` qui persiste entre les redémarrages.

### Q: Comment obtenir le numéro de session (SESSION_ID) ?

**R:** Vous n'en avez pas besoin : `SESSION_ID` n'a plus d'effet. Au premier lancement, scannez le QR code (dans les logs ou sur la page **Appairage** du panel). La session est ensuite conservée dans `sessions/main`.

### Q: Puis-je héberger plusieurs bots ?

**R:** Oui, créez plusieurs services avec des dossiers de session différents.

---

## 📚 Ressources Additionnelles

- [Documentation Principale](../README.md)
- [Guide de Création de Plugins](PLUGIN_CREATION_DOC.md)
- [Guide du Système de Langue](LANGUAGE_SYSTEM.md)
- [Guide d'Optimisation CPU](../CPU_OPTIMIZATION_GUIDE.md)
- [GitHub Repository](https://github.com/Starland9/OpenWhatsappBot)

---

## 🆘 Support

Si vous rencontrez des problèmes :

1. Consultez les [Issues GitHub](https://github.com/Starland9/OpenWhatsappBot/issues)
2. Rejoignez les [Discussions](https://github.com/Starland9/OpenWhatsappBot/discussions)
3. Vérifiez le [Wiki bot-hosting.net](https://wiki.bot-hosting.net)

---

*Ce guide a été créé pour OpenWhatsappBot v59.0.0 et ultérieur.*

# 🌐 Guide de Déploiement Bot-Hosting.net

Ce guide complet vous explique comment déployer OpenWhatsappBot sur [bot-hosting.net](https://bot-hosting.net) et d'autres plateformes d'hébergement basées sur des panneaux de contrôle.

## 📋 Table des Matières

- [Prérequis](#prérequis)
- [Déploiement Étape par Étape](#déploiement-étape-par-étape)
- [Configuration du Panel](#configuration-du-panel)
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
SESSION_ID=
PREFIX=.
SUDO=votre_numero

# Panel Configuration (IMPORTANT pour bot-hosting.net)
PANEL_ENABLED=true
PANEL_PORT=3000

# Clés API (optionnel mais recommandé)
GEMINI_API_KEY=votre_cle_gemini
```

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
| Serveur HTTP | Non | Oui (port 3000) |
| Health Check | Non | Oui |
| Métriques | Non | Oui |
| Page de Statut | Non | Oui |
| Usage | VPS/Local | bot-hosting.net |

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
| `PANEL_ENABLED` | Active le mode panel | `false` |
| `PANEL_PORT` | Port du serveur HTTP | `3000` |
| `PANEL_HOST` | Adresse d'écoute | `0.0.0.0` |
| `KEEP_ALIVE_INTERVAL` | Intervalle ping (ms) | `60000` |
| `PANEL_TOKEN` | Jeton exigé par `POST /api/restart` (vide = endpoint désactivé) | _(vide)_ |
| `PORT` | Port alternatif (si PANEL_PORT non défini) | `3000` |

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

1. Vérifiez que vous utilisez `panel.js` et non `index.js`
2. Consultez les logs en temps réel
3. Attendez quelques secondes après le démarrage

### Le bot se déconnecte souvent

1. Augmentez `KEEP_ALIVE_INTERVAL` si nécessaire
2. Vérifiez les limites de mémoire de votre plan
3. Consultez `/metrics` pour le diagnostic

### Erreur "Port already in use"

Changez le port dans `config.env` :
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

**R:** `panel.js` inclut un serveur HTTP avec des endpoints de monitoring, nécessaires pour les plateformes d'hébergement qui vérifient la disponibilité du service via HTTP. `index.js` est pour les déploiements locaux ou VPS classiques.

### Q: Puis-je utiliser panel.js sur un VPS ?

**R:** Oui ! panel.js fonctionne partout. C'est même recommandé si vous voulez monitorer votre bot via HTTP.

### Q: Le bot consomme combien de RAM ?

**R:** En moyenne 100-200 MB, avec des pics à 300 MB lors du traitement média. Choisissez un plan avec au moins 512 MB.

### Q: Comment mettre à jour le bot ?

**R:** 
```bash
git pull origin master
yarn install
# Puis redémarrez le service
```

### Q: Mes sessions sont-elles perdues lors d'un redémarrage ?

**R:** Non, les sessions sont stockées dans le dossier `sessions/` qui persiste entre les redémarrages.

### Q: Comment obtenir le numéro de session (SESSION_ID) ?

**R:** Au premier lancement, laissez SESSION_ID vide et scannez le QR code. Pour les lancements suivants, la session est automatiquement conservée.

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

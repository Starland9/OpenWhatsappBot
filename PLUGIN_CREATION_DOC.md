---
name: Plugin Creator
description: Createur de plugin
---

# My Agent

# 🤖 Guide de Création de Plugins - OpenWhatsappBot

## 📋 Table des matières

1. [Introduction](#introduction)
2. [Structure d'un Plugin](#structure-dun-plugin)
3. [Système Multilingue](#système-multilingue)
4. [Gestion des Dépendances](#gestion-des-dépendances)
5. [Classes et Méthodes Disponibles](#classes-et-méthodes-disponibles)
6. [Exemples de Plugins](#exemples-de-plugins)
7. [Bonnes Pratiques](#bonnes-pratiques)
8. [Checklist de Validation](#checklist-de-validation)

---

## Introduction

Ce guide est destiné aux développeurs souhaitant créer des plugins pour **OpenWhatsappBot**. Chaque plugin doit être **indépendant**, **compatible** avec l'architecture existante, et **multilingue**.

### Principes Clés


# AGENT_PLUGIN — Guide court pour ajouter un plugin

But : fournir un guide synthétique pour créer un plugin indépendant, multilingue et compatible.

Principes clés
- Indépendant : pas de dépendance circulaire entre plugins.
- Multilingue : toutes les chaînes via `getLang("plugins.<key>.*")`.
- Sécurisé : vérifiez clés API et permissions avant usage.

Structure minimale
```javascript
const { getLang } = require('../lib/utils/language');
const config = require('../config');
module.exports = {
  command: { pattern: 'cmd|alias', desc: getLang('plugins.my.desc'), type: 'misc' },
  async execute(message, query) {
    if (!query) return await message.reply(getLang('plugins.my.usage'));
    try { await message.react('⏳'); /* logique */ await message.react('✅'); }
    catch(e){ await message.react('❌'); console.error(e); await message.reply(`❌ ${e.message}`); }
  }
}
```

Multilingue
- Ajouter les clés dans chaque `lang/*.json` sous `plugins.my` (desc, usage, error, success).
- Utiliser `getLang('plugins.my.key')` dans le code.

Dépendances & compatibilité
- Préférer dépendances existantes (voir `package.json`).
- Tester localement, pinnez la version si instable.
- Node 20+ requis.

Bonnes pratiques rapides
- Toujours try/catch autour des appels asynchrones.
- Valider l'entrée et vérifier `message.hasMedia` ou permissions de groupe.
- Nettoyer les fichiers temporaires.
- Réagir avec emojis (⏳, ✅, ❌) pour feedback utilisateur.

Checklist avant soumission
- Fichier `plugins/*.js` exporte `command` + `execute`.
- Toutes les chaînes utilisent `getLang` et sont ajoutées aux `lang/*.json`.
- Variables d'environnement documentées et non incluses en dur.
- Tests : privé/groupe, admin/non-admin, langues.

Si vous voulez, je peux générer un plugin exemple complet (avec traductions) adapté à une fonctionnalité précise.

-- Fin du guide concis
  },
};
```

### Exemple 2 : Plugin avec API Externe

```javascript
const { getLang } = require("../lib/utils/language");
const axios = require("axios");

module.exports = {
  command: {
    pattern: "weather|meteo",
    desc: getLang("plugins.weather.desc"),
    type: "info",
  },

  async execute(message, query) {
    if (!query) {
      return await message.reply(getLang("plugins.weather.usage"));
    }

    try {
      await message.react("⏳");

      const API_KEY = process.env.WEATHER_API_KEY;
      if (!API_KEY) {
        return await message.reply(
          "❌ Clé API météo non configurée. Définissez WEATHER_API_KEY dans config.env"
        );
      }

      const response = await axios.get(
        `https://api.weatherapi.com/v1/current.json`,
        {
          params: {
            key: API_KEY,
            q: query,
            lang: "fr",
          },
        }
      );

      const data = response.data;
      const result = `🌤️ *Météo pour ${data.location.name}*\n\n` +
        `🌡️ Température: ${data.current.temp_c}°C\n` +
        `💨 Vent: ${data.current.wind_kph} km/h\n` +
        `💧 Humidité: ${data.current.humidity}%\n` +
        `☁️ Condition: ${data.current.condition.text}`;

      await message.react("✅");
      await message.reply(result);

    } catch (error) {
      await message.react("❌");
      console.error("Erreur météo:", error);
      await message.reply(`❌ Erreur: ${error.message}`);
    }
  },
};
```

### Exemple 3 : Plugin avec Traitement de Média

```javascript
const { getLang } = require("../lib/utils/language");
const sharp = require("sharp");

module.exports = {
  command: {
    pattern: "blur|flou",
    desc: getLang("plugins.blur.desc"),
    type: "media",
  },

  async execute(message, query) {
    try {
      // Vérifier si un média est présent
      let buffer;

      if (message.quoted && message.quoted.message?.imageMessage) {
        buffer = await message.client
          .getSocket()
          .downloadMediaMessage(message.quoted);
      } else if (message.hasMedia && message.type === "imageMessage") {
        buffer = await message.downloadMedia();
      } else {
        return await message.reply(
          getLang("plugins.common.reply_to_image")
        );
      }

      if (!buffer) {
        return await message.reply("❌ Échec du téléchargement du média");
      }

      await message.react("⏳");

      // Intensité du flou (par défaut: 10)
      const blurIntensity = parseInt(query) || 10;

      // Appliquer le flou
      const blurredBuffer = await sharp(buffer)
        .blur(blurIntensity)
        .toBuffer();

      await message.sendImage(blurredBuffer, `Flou appliqué (intensité: ${blurIntensity})`);
      await message.react("✅");

    } catch (error) {
      await message.react("❌");
      console.error("Erreur blur:", error);
      await message.reply(`❌ Erreur: ${error.message}`);
    }
  },
};
```

### Exemple 4 : Plugin avec Vérification de Permissions

```javascript
const { getLang } = require("../lib/utils/language");
const config = require("../config");

module.exports = {
  command: {
    pattern: "announce|annonce",
    desc: getLang("plugins.announce.desc"),
    type: "group",
    fromMe: true,  // Uniquement pour sudo
    onlyGroup: true,  // Uniquement dans les groupes
  },

  async execute(message, query) {
    if (!query) {
      return await message.reply(
        getLang("plugins.announce.usage")
      );
    }

    try {
      // Vérifier si le bot est admin
      const isBotAdmin = await message.isBotAdmin();
      if (!isBotAdmin) {
        return await message.reply(
          getLang("plugins.common.not_admin")
        );
      }

      await message.react("📢");

      // Récupérer les métadonnées du groupe
      const metadata = await message.getGroupMetadata();
      
      // Créer le message avec mentions de tous les membres
      const participants = metadata.participants.map(p => p.id);
      const text = `📢 *ANNONCE*\n\n${query}\n\n` +
        participants.map(jid => `@${jid.split('@')[0]}`).join(' ');

      await message.client.getSocket().sendMessage(
        message.jid,
        { text, mentions: participants }
      );

      await message.react("✅");

    } catch (error) {
      await message.react("❌");
      console.error("Erreur announce:", error);
      await message.reply(`❌ Erreur: ${error.message}`);
    }
  },
};
```

### Exemple 5 : Plugin avec Gestion d'État

```javascript
const { getLang } = require("../lib/utils/language");

// État global (attention : partagé entre tous les chats)
const gameState = new Map();

module.exports = {
  command: {
    pattern: "guess|deviner",
    desc: getLang("plugins.guess.desc"),
    type: "fun",
  },

  async execute(message, query) {
    const chatId = message.jid;

    // Démarrer un nouveau jeu
    if (query === "start") {
      const randomNumber = Math.floor(Math.random() * 100) + 1;
      gameState.set(chatId, {
        number: randomNumber,
        attempts: 0,
        maxAttempts: 10,
      });

      return await message.reply(
        `🎮 *Jeu de devinette*\n\n` +
        `J'ai choisi un nombre entre 1 et 100.\n` +
        `Vous avez 10 tentatives pour deviner!\n\n` +
        `Utilisez: .guess <nombre>`
      );
    }

    // Arrêter le jeu
    if (query === "stop") {
      gameState.delete(chatId);
      return await message.reply("🛑 Jeu arrêté.");
    }

    // Vérifier si un jeu est en cours
    const game = gameState.get(chatId);
    if (!game) {
      return await message.reply(
        "❌ Aucun jeu en cours. Utilisez `.guess start` pour commencer."
      );
    }

    // Deviner
    const guess = parseInt(query);
    if (isNaN(guess) || guess < 1 || guess > 100) {
      return await message.reply(
        "❌ Veuillez entrer un nombre entre 1 et 100."
      );
    }

    game.attempts++;

    if (guess === game.number) {
      gameState.delete(chatId);
      return await message.reply(
        `🎉 *Bravo!* Vous avez trouvé le nombre ${game.number} en ${game.attempts} tentative(s)!`
      );
    }

    if (game.attempts >= game.maxAttempts) {
      const number = game.number;
      gameState.delete(chatId);
      return await message.reply(
        `😔 *Perdu!* Le nombre était ${number}. Utilisez `.guess start` pour rejouer.`
      );
    }

    const hint = guess < game.number ? "plus grand" : "plus petit";
    const remaining = game.maxAttempts - game.attempts;

    await message.reply(
      `${guess < game.number ? "⬆️" : "⬇️"} C'est ${hint}!\n` +
      `Tentatives restantes: ${remaining}`
    );
  },
};
```

---

## Bonnes Pratiques

### 1. Gestion des Erreurs

✅ **Bon** :
```javascript
try {
  await message.react("⏳");
  const result = await someAsyncOperation();
  await message.react("✅");
  await message.reply(result);
} catch (error) {
  await message.react("❌");
  console.error("Erreur:", error);
  await message.reply(`❌ Erreur: ${error.message}`);
}
```

❌ **Mauvais** :
```javascript
const result = await someAsyncOperation();  // Pas de try-catch
await message.reply(result);
```

### 2. Validation des Entrées

✅ **Bon** :
```javascript
if (!query) {
  return await message.reply(getLang("plugins.monplugin.usage"));
}

if (!message.hasMedia) {
  return await message.reply(getLang("plugins.common.reply_to_image"));
}
```

❌ **Mauvais** :
```javascript
// Pas de validation - risque de crash
const result = processQuery(query);
```

### 3. Réactions Utilisateur

✅ **Bon** :
```javascript
await message.react("⏳");  // Traitement en cours
// ... opération ...
await message.react("✅");  // Succès
```

ou en cas d'erreur :
```javascript
await message.react("❌");  // Échec
```

### 4. Messages Multilingues

✅ **Bon** :
```javascript
const description = getLang("plugins.monplugin.desc");
await message.reply(getLang("plugins.monplugin.success"));
```

❌ **Mauvais** :
```javascript
await message.reply("Opération réussie");  // Texte en dur
```

### 5. Configuration et Clés API

✅ **Bon** :
```javascript
const API_KEY = config.MONSERVICE_API_KEY || process.env.MONSERVICE_API_KEY;
if (!API_KEY) {
  return await message.reply(
    "❌ Clé API non configurée. Définissez MONSERVICE_API_KEY dans config.env"
  );
}
```

❌ **Mauvais** :
```javascript
const API_KEY = "ma_cle_en_dur";  // Ne jamais mettre de clés en dur!
```

### 6. Nettoyage des Ressources

✅ **Bon** :
```javascript
const tempFile = "/tmp/temp_" + Date.now() + ".jpg";
try {
  await fs.writeFile(tempFile, buffer);
  // ... traitement ...
} finally {
  await fs.unlink(tempFile).catch(() => {});  // Nettoyage
}
```

### 7. Performance

✅ **Bon** :
```javascript
// Utiliser des limites
if (buffer.length > 100 * 1024 * 1024) {  // 100MB
  return await message.reply("❌ Fichier trop volumineux (max: 100MB)");
}
```

✅ **Bon** :
```javascript
// Timeout pour les requêtes HTTP
const response = await axios.get(url, { timeout: 30000 });  // 30s
```

### 8. Logs et Débogage

✅ **Bon** :
```javascript
const pino = require("pino");
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

logger.info("Plugin exécuté", { user: message.sender, command: "mycommand" });
logger.error("Erreur API", { error: error.message, stack: error.stack });
```

---

## Checklist de Validation

Avant de soumettre votre plugin, vérifiez :

### ✅ Structure et Code

- [ ] Le fichier est dans `plugins/` avec l'extension `.js`
- [ ] Le module exporte `command` et `execute`
- [ ] Le pattern est défini et unique
- [ ] Le type de commande est approprié
- [ ] Les permissions (`fromMe`, `onlyGroup`, `onlyPm`) sont correctes
- [ ] Gestion des erreurs avec try-catch
- [ ] Validation des paramètres d'entrée
- [ ] Nettoyage des ressources temporaires

### ✅ Multilingue

- [ ] Utilisation de `getLang()` pour tous les textes
- [ ] Traductions ajoutées dans **TOUS** les fichiers `lang/*.json`
- [ ] Clés de traduction cohérentes et bien nommées
- [ ] Messages d'erreur traduits

### ✅ Dépendances

- [ ] Vérification des versions des packages
- [ ] Installation des dépendances avec `yarn add` ou `npm install`
- [ ] Compatibilité Node.js >= 20.0.0 vérifiée
- [ ] Pas de dépendances inutiles ou en doublon

### ✅ API et Configuration

- [ ] Clés API stockées dans `config.env` (jamais en dur)
- [ ] Vérification de la présence des clés API avant utilisation
- [ ] Messages d'erreur clairs si clés manquantes
- [ ] Documentation des variables d'environnement nécessaires

### ✅ Expérience Utilisateur

- [ ] Réactions emoji pour indiquer l'état (⏳, ✅, ❌)
- [ ] Messages d'aide/usage clairs
- [ ] Gestion des cas d'erreur avec messages explicites
- [ ] Timeout pour les opérations longues

### ✅ Tests

- [ ] Test avec différents types d'entrées
- [ ] Test avec des entrées invalides
- [ ] Test dans un groupe et en privé
- [ ] Test avec et sans permissions admin
- [ ] Test dans différentes langues

### ✅ Documentation

- [ ] Commentaires dans le code pour les parties complexes
- [ ] Description claire dans le pattern `desc`
- [ ] Exemples d'utilisation dans les messages d'aide

---

## 📚 Ressources Supplémentaires

### Documentation Officielle

- [Baileys (WhatsApp Web API)](https://github.com/WhiskeySockets/Baileys)
- [Node.js Documentation](https://nodejs.org/docs/latest/api/)
- [Sharp (Image Processing)](https://sharp.pixelplumbing.com/)
- [FFmpeg (Video/Audio)](https://ffmpeg.org/documentation.html)

### Outils Utiles

- **Traduction** : [Google Translate](https://translate.google.com/), [DeepL](https://www.deepl.com/)
- **Test de Regex** : [Regex101](https://regex101.com/)
- **Validation JSON** : [JSONLint](https://jsonlint.com/)
- **NPM Package Search** : [NPM](https://www.npmjs.com/)

### Debugging

```bash
# Mode debug
LOG_LEVEL=debug node index.js

# Voir les logs en temps réel
pm2 logs open-whatsapp-bot --lines 100
```

---

## 🤝 Contribution

Pour soumettre votre plugin :

1. Testez localement avec la checklist complète
2. Créez une Pull Request sur GitHub
3. Incluez une description claire des fonctionnalités
4. Ajoutez des captures d'écran si pertinent
5. Documentez les nouvelles variables d'environnement

---

## 📝 Template Rapide

Copiez ce template pour démarrer rapidement :

```javascript
const { getLang } = require("../lib/utils/language");
const config = require("../config");

/**
 * [NOM] - [DESCRIPTION]
 */
module.exports = {
  command: {
    pattern: "moncommand|alias",
    desc: getLang("plugins.monplugin.desc"),
    type: "misc",
    fromMe: false,
    onlyGroup: false,
    onlyPm: false,
  },

  async execute(message, query) {
    // Validation
    if (!query) {
      return await message.reply(getLang("plugins.monplugin.usage"));
    }

    try {
      await message.react("⏳");

      // TODO: Votre logique ici

      await message.react("✅");
      await message.reply("Résultat");

    } catch (error) {
      await message.react("❌");
      console.error("Erreur:", error);
      await message.reply(`❌ Erreur: ${error.message}`);
    }
  },
};
```

---

**Bonne création de plugins ! 🚀**

Pour toute question ou suggestion, ouvrez une issue sur GitHub : [OpenWhatsappBot](https://github.com/Starland9/OpenWhatsappBot)

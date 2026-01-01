# 📱 Guide Complet OpenWhatsappBot

> **Un assistant WhatsApp intelligent pour tous !**

Bienvenue dans le guide complet d'OpenWhatsappBot. Que vous soyez un utilisateur débutant, un administrateur de groupe, ou un développeur, ce guide vous accompagnera pas à pas.

---

## 📖 Table des Matières

1. [C'est quoi OpenWhatsappBot ?](#-cest-quoi-openwhatsappbot-)
2. [Pour qui est ce bot ?](#-pour-qui-est-ce-bot-)
3. [Démarrage Rapide](#-démarrage-rapide)
4. [Toutes les Commandes](#-toutes-les-commandes)
5. [Cas d'Usage Concrets](#-cas-dusage-concrets)
6. [Guide pour Administrateurs de Groupes](#-guide-pour-administrateurs-de-groupes)
7. [Fonctionnalités Avancées](#-fonctionnalités-avancées)
8. [Questions Fréquentes](#-questions-fréquentes)
9. [Guide Développeur](#-guide-développeur)

---

## 🤖 C'est quoi OpenWhatsappBot ?

**OpenWhatsappBot** est un assistant automatique pour WhatsApp qui peut :

- 💬 **Répondre automatiquement** aux messages avec une IA intelligente
- 📥 **Télécharger des vidéos/musiques** depuis YouTube, Instagram, TikTok...
- 🎨 **Créer des stickers** à partir de vos photos
- 🌍 **Traduire** des messages dans toutes les langues
- 📊 **Gérer vos groupes** WhatsApp (modération, statistiques...)
- 🎮 **Jouer à des quiz** et jeux interactifs
- ⏰ **Créer des rappels** et listes de tâches
- Et bien plus encore !

### 💡 En termes simples

Imaginez avoir un assistant personnel disponible 24h/24 sur WhatsApp qui peut :
- Répondre aux gens quand vous êtes occupé
- Télécharger cette vidéo TikTok que vous avez vue
- Créer un sticker de votre photo préférée
- Traduire un message en arabe ou en anglais
- Vous rappeler d'aller chercher le pain à 18h

---

## 👥 Pour qui est ce bot ?

### 👴👵 Pour les Seniors (Grands-parents, personnes moins technophiles)

**Ce que vous pouvez faire facilement :**

| Besoin | Commande | Exemple |
|--------|----------|---------|
| Vérifier la météo | `.meteo Paris` | Donne la température et le temps |
| Traduire un message | `.trt Bonjour` | Traduit dans votre langue |
| Créer un rappel | `.remind add 30 Prendre médicament` | Vous rappelle dans 30 min |
| Demander quelque chose à l'IA | `.gemini Comment faire une tarte ?` | Répond à vos questions |

### 👨‍👩‍👧‍👦 Pour les Familles

**Ce que vous pouvez faire :**

| Besoin | Commande | Exemple |
|--------|----------|---------|
| Créer des stickers rigolos | `.sticker` (sur une photo) | Transforme la photo en sticker |
| Jouer au quiz en famille | `.quiz start` | Lance un quiz de culture générale |
| Télécharger une vidéo YouTube | `.ytdl lien` | Télécharge la vidéo |
| Jeu Action ou Vérité | `.av` | Pour les soirées en famille |

### 🧑‍🎓 Pour les Étudiants

**Ce que vous pouvez faire :**

| Besoin | Commande | Exemple |
|--------|----------|---------|
| Aide aux devoirs avec IA | `.gemini Explique le théorème de Pythagore` | Explications claires |
| Créer des tâches | `.task add Réviser maths lundi` | Gestionnaire de tâches |
| Rechercher des images | `.img photosynthèse schéma` | Trouve des images |
| Traduire pour les cours | `.trt en Hello how are you` | Traduction instantanée |

### 👨‍💼 Pour les Professionnels

**Ce que vous pouvez faire :**

| Besoin | Commande | Exemple |
|--------|----------|---------|
| Réponse automatique IA | Activer `.ar on` | Répond quand vous êtes occupé |
| Créer des PDF | `.pdf Contenu du document` | Génère un fichier PDF |
| Actualités du jour | `.news fr` | Dernières nouvelles en français |
| Cours des cryptos | `.crypto bitcoin` | Prix en temps réel |

### 👥 Pour les Administrateurs de Groupes

**Ce que vous pouvez faire :**

| Besoin | Commande | Exemple |
|--------|----------|---------|
| Mentionner tout le monde | `.tag Important !` | Notifie tous les membres |
| Expulser un membre | `.kick @membre` | Retire quelqu'un du groupe |
| Créer un sondage | `.vote Resto demain? Pizza, Sushi, Burger` | Sondage interactif |
| Statistiques du groupe | `.stats` | Voir l'activité |

---

## 🚀 Démarrage Rapide

### Comment utiliser le bot ?

1. **Toutes les commandes commencent par un point** `.`
2. **Écrivez la commande** suivie de votre texte
3. **Envoyez** et attendez la réponse

### Vos premières commandes

```
.ping              → Vérifier que le bot fonctionne
.help              → Voir l'aide
.menu              → Liste de toutes les commandes
.alive             → Voir l'état du bot
```

### Exemples pratiques

```
.gemini Raconte-moi une blague
.meteo Lyon
.trt en Bonjour tout le monde
.sticker (en réponse à une image)
```

---

## 📋 Toutes les Commandes

### 🎯 Commandes de Base

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.ping` | Vérifie si le bot répond | `.ping` |
| `.alive` | Affiche l'état du bot | `.alive` |
| `.help` | Affiche l'aide | `.help` |
| `.menu` | Liste toutes les commandes | `.menu` |

---

### 🤖 Intelligence Artificielle

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.gemini` | Discuter avec Google Gemini | `.gemini Qu'est-ce que le réchauffement climatique ?` |
| `.gpt` | Discuter avec ChatGPT | `.gpt Écris-moi un poème` |
| `.imagen` | Générer une image avec l'IA | `.imagen Un chat sur la lune` |

**💡 Astuce :** Vous pouvez aussi envoyer une image et demander à l'IA de la décrire !

```
(Répondre à une image) .gemini Que vois-tu sur cette image ?
```

---

### 📥 Téléchargements

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.ytdl` | Télécharger vidéo YouTube | `.ytdl https://youtube.com/watch?v=...` |
| `.yta` | Télécharger audio YouTube | `.yta https://youtube.com/watch?v=...` |
| `.yts` | Rechercher sur YouTube | `.yts Maroon 5 Sugar` |
| `.insta` | Télécharger depuis Instagram | `.insta https://instagram.com/reel/...` |
| `.dl` | Télécharger depuis TikTok, Facebook, Twitter... | `.dl https://tiktok.com/...` |
| `.apk` | Télécharger une application Android | `.apk WhatsApp` |
| `.pinterest` | Télécharger depuis Pinterest | `.pinterest https://pin...` |

**📌 Plateformes supportées par `.dl` :**
- TikTok
- Facebook
- Twitter/X
- Instagram
- Threads
- Snapchat
- Et plus encore !

---

### 🎵 Musique & Sons

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.music` | Rechercher et télécharger musique | `.music Shape of You` |
| `.song` | Alias pour music | `.song Bohemian Rhapsody` |
| `.lyrics` | Obtenir les paroles | `.lyrics Ed Sheeran Perfect` |
| `.tts` | Convertir texte en voix | `.tts Bonjour, comment allez-vous ?` |
| `.transcribe` | Transcrire un audio en texte | (répondre à un vocal) `.transcribe` |

---

### 🎨 Création & Médias

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.sticker` | Créer un sticker | (répondre à image/vidéo) `.sticker` |
| `.convert` | Convertir des médias | (répondre à média) `.convert png` |
| `.topng` | Convertir en PNG | (répondre à image) `.topng` |
| `.tojpg` | Convertir en JPG | (répondre à image) `.tojpg` |
| `.topdf` | Convertir en PDF | (répondre à image) `.topdf` |
| `.tomp3` | Convertir en MP3 | (répondre à vidéo) `.tomp3` |
| `.qr` | Générer un QR code | `.qr https://monsite.com` |
| `.pdf` | Créer un PDF | `.pdf Mon document texte` |
| `.fancy` | Texte stylisé | `.fancy Mon texte cool` |

---

### 🌍 Traduction & Langues

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.trt` | Traduire du texte | `.trt es Bonjour comment ça va` |
| `.trt` | Traduire en anglais (défaut) | `.trt Bonjour` |

**🌐 Codes de langues courants :**
| Code | Langue | Code | Langue |
|------|--------|------|--------|
| `fr` | Français | `en` | Anglais |
| `es` | Espagnol | `de` | Allemand |
| `ar` | Arabe | `zh` | Chinois |
| `pt` | Portugais | `it` | Italien |
| `ru` | Russe | `ja` | Japonais |

---

### 🌤️ Météo & Infos

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.weather` ou `.meteo` | Météo d'une ville | `.meteo Paris` |
| `.news` | Actualités | `.news fr` |
| `.crypto` | Prix des cryptomonnaies | `.crypto bitcoin` |
| `.stock` | Cours des actions | `.stock AAPL` |
| `.fact` | Fait aléatoire | `.fact` |
| `.quote` | Citation inspirante | `.quote` |
| `.joke` | Blague | `.joke` |

---

### 🔍 Recherche

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.image` ou `.img` | Rechercher des images | `.img coucher de soleil` |
| `.gif` | Rechercher des GIFs | `.gif chat drôle` |
| `.reddit` | Contenu Reddit | `.reddit memes` |

---

### 🎮 Jeux & Divertissement

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.quiz start` | Démarrer un quiz | `.quiz start` |
| `.quiz hint` | Obtenir un indice | `.quiz hint` |
| `.quiz stop` | Arrêter le quiz | `.quiz stop` |
| `.guess start` | Jeu de devinette (1-100) | `.guess start` |
| `.av` | Action ou Vérité | `.av` |
| `.joke` | Une blague | `.joke` |
| `.fact` | Un fait intéressant | `.fact` |

---

### ⏰ Productivité

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.task add` | Ajouter une tâche | `.task add Faire les courses` |
| `.task list` | Voir mes tâches | `.task list` |
| `.task done 1` | Marquer tâche 1 comme faite | `.task done 1` |
| `.task delete 1` | Supprimer la tâche 1 | `.task delete 1` |
| `.remind add` | Créer un rappel | `.remind add 60 Appeler maman` |
| `.remind list` | Voir mes rappels | `.remind list` |
| `.afk` | Mode absent | `.afk Je reviens dans 1h` |
| `.notify add` | Notification sur mot-clé | `.notify add urgent` |

---

### 👥 Gestion de Groupe

| Commande | Description | Qui peut l'utiliser |
|----------|-------------|---------------------|
| `.tag` | Mentionner tous les membres | Admins |
| `.tagall` | Alias pour tag | Admins |
| `.kick @user` | Expulser un membre | Admins |
| `.promote @user` | Promouvoir en admin | Admins |
| `.demote @user` | Rétrograder un admin | Admins |
| `.warn @user` | Avertir un membre | Admins |
| `.vote` | Créer un sondage | Tous |
| `.stats` | Statistiques du groupe | Tous |
| `.welcome` | Message de bienvenue | Admins |
| `.goodbye` | Message d'au revoir | Admins |
| `.ban` | Désactiver le bot | Propriétaire |
| `.unban` | Réactiver le bot | Propriétaire |

---

### 👁️ Messages Éphémères (View Once)

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.vv` | Envoyer en view once | (répondre à média) `.vv` |
| `.getvv` | Récupérer un view once | (répondre à view once) `.getvv` |
| `.setvv` | Configurer view once auto | `.setvv on` |

---

### 🔧 Commandes Avancées (Propriétaire)

| Commande | Description | Exemple |
|----------|-------------|---------|
| `.ar` | Répondeur automatique IA | `.ar on` |
| `.antidelete` | Anti-suppression de messages | `.antidelete p` |
| `.getantidelete` | Voir config anti-delete | `.getantidelete` |
| `.filter` | Ajouter une réponse auto | `.filter salut Bonjour à toi !` |
| `.delfilter` | Supprimer un filtre | `.delfilter salut` |
| `.setcmd` | Lier sticker à commande | `.setcmd .ping` |
| `.getcmd` | Voir commandes stickers | `.getcmd` |
| `.delcmd` | Supprimer commande sticker | `.delcmd` |
| `.update` | Mettre à jour le bot | `.update` |
| `.exec` | Exécuter du code (danger) | Réservé aux développeurs |
| `.exportcontacts` | Exporter les contacts | `.exportcontacts` |

---

## 💼 Cas d'Usage Concrets

### 📱 Scénario 1 : Répondeur Automatique Intelligent

**Situation :** Vous êtes en réunion et ne pouvez pas répondre aux messages.

**Solution :**
```
.ar on
.ar personality Tu es mon assistant personnel. Dis aux gens que je suis occupé et que je répondrai bientôt. Sois poli et professionnel.
```

Maintenant, le bot répond automatiquement à vos contacts privés !

---

### 🎉 Scénario 2 : Soirée Quiz en Groupe

**Situation :** Vous voulez animer votre groupe d'amis.

**Solution :**
```
.tag 🎮 Qui est prêt pour un quiz ?

.quiz start

(Les membres répondent)

.quiz hint

.quiz stop
```

---

### 📺 Scénario 3 : Télécharger une Vidéo TikTok

**Situation :** Quelqu'un partage un TikTok et vous voulez le sauvegarder.

**Solution :**
```
.dl https://www.tiktok.com/@user/video/123456789
```

Le bot télécharge la vidéo sans filigrane !

---

### 👵 Scénario 4 : Aide pour Grand-Mère

**Situation :** Mamie veut savoir le temps qu'il fera demain.

**Solution :**
```
.meteo Nice
```

Le bot répond :
> 🌤️ **Nice, France**
> Température : 18°C
> Temps : Ensoleillé
> Humidité : 45%

---

### 📚 Scénario 5 : Aide aux Devoirs

**Situation :** Votre enfant ne comprend pas un exercice de maths.

**Solution :**
```
.gemini Explique-moi comment résoudre l'équation 2x + 5 = 15 étape par étape
```

L'IA explique clairement :
> Pour résoudre 2x + 5 = 15 :
> 1. On soustrait 5 des deux côtés : 2x = 10
> 2. On divise par 2 : x = 5
> La solution est x = 5 ✓

---

### 🎵 Scénario 6 : Télécharger de la Musique

**Situation :** Vous voulez écouter une chanson hors ligne.

**Solution :**
```
.music Adele Hello
```

ou directement depuis YouTube :
```
.yta https://youtube.com/watch?v=...
```

---

## 👨‍💼 Guide pour Administrateurs de Groupes

### Configuration de Base

#### 1. Message de Bienvenue
```
.welcome on
.welcome Bienvenue @user dans notre groupe ! 🎉 N'oublie pas de lire les règles.
```

#### 2. Message d'Au Revoir
```
.goodbye on
.goodbye @user nous a quittés. À bientôt ! 👋
```

#### 3. Créer des Filtres Automatiques
```
.filter règles 📜 Voici les règles du groupe :
1. Respectez tout le monde
2. Pas de spam
3. Pas de liens douteux

.filter admin @admin Voici l'admin du groupe !
```

### Modération

#### Avertir un Membre
```
.warn @membre
```
Au bout de 3 avertissements, le membre peut être expulsé.

#### Expulser un Membre
```
.kick @membre
```

#### Créer un Sondage
```
.vote On fait quoi ce weekend ? Ciné, Resto, Bowling
```

### Statistiques
```
.stats
```
Affiche :
- Nombre de messages par membre
- Heures les plus actives
- Mots les plus utilisés

---

## ⚙️ Fonctionnalités Avancées

### 🔄 Répondeur Automatique (IA)

Le bot peut répondre automatiquement à vos messages privés grâce à l'IA.

**Activer :**
```
.ar on
```

**Personnaliser la personnalité :**
```
.ar personality Tu es un assistant professionnel qui répond toujours poliment. Garde les réponses courtes.
```

**Ignorer certains contacts :**
```
.ar ignore add 33612345678
.ar ignore list
.ar ignore remove 33612345678
```

**Désactiver :**
```
.ar off
```

---

### 🛡️ Anti-Suppression de Messages

Récupérez les messages que les gens suppriment !

**Activer :**
```
.antidelete p    → Envoyer vers votre chat privé
.antidelete g    → Envoyer dans le même groupe
.antidelete null → Désactiver
```

**Vérifier le statut :**
```
.getantidelete
```

---

### 🏷️ Stickers Intelligents

Associez des commandes à vos stickers !

**Ajouter une commande à un sticker :**
1. Envoyez le sticker
2. Répondez avec `.setcmd .ping`

Maintenant, chaque fois que vous envoyez ce sticker, le bot exécute `.ping` !

---

### 📢 Notifications sur Mots-Clés

Soyez alerté quand quelqu'un mentionne des mots importants.

```
.notify add urgent
.notify add meeting
.notify add @votreNom
.notify list
.notify remove urgent
```

---

## ❓ Questions Fréquentes

### ❔ Le bot ne répond pas, que faire ?

1. Vérifiez que le bot est en ligne : `.ping`
2. Assurez-vous d'utiliser le bon préfixe (`.`)
3. Vérifiez que le bot n'est pas banni dans ce chat

### ❔ Comment savoir quelles commandes existent ?

```
.menu    → Liste complète
.help    → Aide générale
```

### ❔ Qui peut utiliser certaines commandes ?

- **Tous** : Commandes de base, téléchargements, jeux
- **Admins de groupe** : Modération, kick, promote
- **Propriétaire (Sudo)** : Configuration avancée, ar, antidelete

### ❔ C'est gratuit ?

Oui ! Le bot est open-source et gratuit. Certaines fonctionnalités nécessitent des clés API (voir section développeur).

### ❔ Mes données sont-elles sécurisées ?

- Les conversations IA sont stockées localement
- Aucune donnée n'est partagée avec des tiers (sauf les API IA)
- Vous pouvez effacer l'historique à tout moment

### ❔ Comment créer mon propre bot ?

Voir la section [Guide Développeur](#-guide-développeur) ci-dessous !

---

## 👨‍💻 Guide Développeur

### 🔧 Installation

#### Prérequis
- **Node.js** 20 ou supérieur
- **FFmpeg** (pour le traitement média)
- **Git**

#### Étapes

```bash
# 1. Cloner le projet
git clone https://github.com/Starland9/OpenWhatsappBot
cd OpenWhatsappBot

# 2. Installer les dépendances
yarn install

# 3. Configurer l'environnement
cp config.env.example config.env
nano config.env  # Éditer avec vos valeurs

# 4. Démarrer le bot
yarn dev        # Mode développement
yarn start      # Mode production (PM2)
```

### 📝 Configuration (config.env)

```env
# === OBLIGATOIRE ===
SESSION_ID=             # Laissez vide, généré au premier scan QR
PREFIX=.                # Préfixe des commandes
SUDO=33612345678        # Votre numéro WhatsApp (sans +)

# === COMPORTEMENT ===
ALWAYS_ONLINE=false     # Toujours afficher "en ligne"
AUTO_READ=true          # Marquer les messages comme lus
AUTO_STATUS_VIEW=true   # Voir automatiquement les statuts
AUTO_STATUS_REACT=false # Réagir aux statuts avec emoji

# === CLÉS API (optionnel selon fonctionnalités) ===
GEMINI_API_KEY=         # Pour .gemini et le répondeur auto
OPENAI_API_KEY=         # Pour .gpt et transcription
WEATHER_API_KEY=        # Pour .weather
NEWS_API_KEY=           # Pour .news
UNSPLASH_API_KEY=       # Pour .img
GIPHY_API_KEY=          # Pour .gif

# === BASE DE DONNÉES ===
DATABASE_URL=           # PostgreSQL URL (ou vide pour SQLite)

# === LANGUE ===
BOT_LANG=fr             # Langue du bot (fr, en, es, ar...)
```

### 🔑 Obtenir les Clés API

| Service | Utilité | Lien |
|---------|---------|------|
| **Gemini** | IA, répondeur auto | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| **OpenAI** | ChatGPT, transcription | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Weather** | Météo | [weatherapi.com](https://www.weatherapi.com/signup.aspx) |
| **News** | Actualités | [newsapi.org](https://newsapi.org/register) |
| **Unsplash** | Images | [unsplash.com/developers](https://unsplash.com/developers) |

### 🧩 Créer un Plugin

Créez un fichier dans `plugins/monplugin.js` :

```javascript
const { getLang } = require("../lib/utils/language");

module.exports = {
  command: {
    pattern: "hello|salut",  // Commandes (séparées par |)
    desc: "Dit bonjour",      // Description
    type: "fun",              // Catégorie
    fromMe: false,            // Réservé au propriétaire ?
    onlyGroup: false,         // Groupe uniquement ?
    onlyPm: false,            // Messages privés uniquement ?
  },
  
  async execute(message, args) {
    // args = texte après la commande
    
    // Répondre simplement
    await message.reply(`Bonjour ${args || "ami"} ! 👋`);
    
    // Répondre avec une image
    // await message.sendImage(buffer, { caption: "Voilà !" });
    
    // Répondre avec un sticker
    // await message.sendSticker(buffer);
    
    // Réagir au message
    // await message.react("👍");
  }
};
```

### 📁 Structure du Projet

```
OpenWhatsappBot/
├── index.js              # Point d'entrée
├── config.js             # Gestion de la configuration
├── config.env            # Variables d'environnement
├── lib/
│   ├── baileys/
│   │   └── client.js     # Client WhatsApp
│   ├── classes/
│   │   └── Message.js    # Abstraction des messages
│   ├── database/
│   │   └── models/       # Modèles Sequelize
│   ├── plugins/
│   │   ├── loader.js     # Chargement des plugins
│   │   └── registry.js   # Registre des commandes
│   └── utils/            # Utilitaires divers
├── plugins/              # Tous les plugins/commandes
├── lang/                 # Fichiers de traduction
└── docs/                 # Documentation
```

### 🐳 Déploiement Docker

```bash
# Construire et lancer
docker-compose up -d

# Voir les logs
docker-compose logs -f

# Arrêter
docker-compose down
```

### ☁️ Déploiement Cloud

Le bot supporte :
- **Heroku** : `heroku.yml` inclus
- **Render** : Configuration via variables d'env
- **Koyeb** : Support natif
- **VPS** : Utiliser PM2 avec `yarn start`

---

## 🎯 Récapitulatif des Commandes par Catégorie

| Catégorie | Commandes |
|-----------|-----------|
| **Base** | `ping`, `alive`, `help`, `menu` |
| **IA** | `gemini`, `gpt`, `imagen` |
| **Téléchargements** | `ytdl`, `yta`, `yts`, `insta`, `dl`, `apk`, `pinterest` |
| **Musique** | `music`, `song`, `lyrics`, `tts`, `transcribe` |
| **Médias** | `sticker`, `convert`, `topng`, `tojpg`, `topdf`, `tomp3`, `qr`, `pdf`, `fancy` |
| **Traduction** | `trt` |
| **Info** | `weather`, `meteo`, `news`, `crypto`, `stock`, `fact`, `quote`, `joke` |
| **Recherche** | `image`, `img`, `gif`, `reddit` |
| **Jeux** | `quiz`, `guess`, `av` |
| **Productivité** | `task`, `remind`, `afk`, `notify` |
| **Groupe** | `tag`, `kick`, `promote`, `demote`, `warn`, `vote`, `stats`, `welcome`, `goodbye` |
| **View Once** | `vv`, `getvv`, `setvv` |
| **Admin** | `ar`, `antidelete`, `filter`, `setcmd`, `update`, `ban`, `unban` |

---

## 🌟 Conclusion

OpenWhatsappBot est un outil puissant et polyvalent qui peut s'adapter à tous les besoins :

- 👴 **Pour les seniors** : Commandes simples pour la météo, les rappels, les traductions
- 👨‍👩‍👧‍👦 **Pour les familles** : Stickers, jeux, téléchargements
- 🧑‍🎓 **Pour les étudiants** : IA pour les devoirs, traductions, notes
- 👨‍💼 **Pour les pros** : Répondeur automatique, PDF, actualités
- 👨‍💻 **Pour les développeurs** : Architecture modulaire, plugins faciles à créer

**Besoin d'aide ?** Rejoignez la communauté ou consultez le [dépôt GitHub](https://github.com/Starland9/OpenWhatsappBot).

---

*Documentation créée avec ❤️ pour OpenWhatsappBot*
*Dernière mise à jour : Décembre 2024*

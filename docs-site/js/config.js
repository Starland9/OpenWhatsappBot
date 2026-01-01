/**
 * Configuration - Site settings and data
 */

const CONFIG = {
  siteName: "OpenWhatsappBot",
  version: "2.0.0",
  github: "https://github.com/Starland9/OpenWhatsappBot",
  prefix: ".",

  // Theme
  defaultTheme: "light",

  // Languages available
  languages: ["fr", "en", "es", "ar", "hi", "pt"],
  defaultLang: "fr",
};

// Commands data organized by category
const COMMANDS_DATA = {
  base: {
    icon: "🎯",
    title: "Commandes de Base",
    description: "Les commandes essentielles pour commencer",
    commands: [
      {
        name: "ping",
        desc: "Vérifie le temps de réponse du bot",
        usage: ".ping",
        example: ".ping",
      },
      {
        name: "alive",
        desc: "Affiche l'état du bot et les infos système",
        usage: ".alive",
        example: ".alive",
      },
      {
        name: "help",
        desc: "Affiche l'aide générale",
        usage: ".help",
        example: ".help",
      },
      {
        name: "menu",
        desc: "Liste toutes les commandes disponibles",
        usage: ".menu",
        example: ".menu",
      },
    ],
  },
  ai: {
    icon: "🤖",
    title: "Intelligence Artificielle",
    description: "Discutez avec des IA avancées",
    commands: [
      {
        name: "gemini",
        desc: "Discuter avec Google Gemini (supporte les images)",
        usage: ".gemini <question>",
        example: ".gemini Explique la photosynthèse",
      },
      {
        name: "gpt",
        desc: "Discuter avec ChatGPT",
        usage: ".gpt <question>",
        example: ".gpt Écris-moi un poème sur la nature",
      },
      {
        name: "imagen",
        desc: "Générer une image avec l'IA",
        usage: ".imagen <description>",
        example: ".imagen Un chat astronaute sur la lune",
      },
    ],
  },
  downloads: {
    icon: "📥",
    title: "Téléchargements",
    description: "Téléchargez des médias depuis diverses plateformes",
    commands: [
      {
        name: "ytdl",
        desc: "Télécharger une vidéo YouTube",
        usage: ".ytdl <url>",
        example: ".ytdl https://youtube.com/watch?v=...",
      },
      {
        name: "yta",
        desc: "Télécharger l'audio d'une vidéo YouTube",
        usage: ".yta <url>",
        example: ".yta https://youtube.com/watch?v=...",
      },
      {
        name: "yts",
        desc: "Rechercher sur YouTube",
        usage: ".yts <recherche>",
        example: ".yts Daft Punk Around the World",
      },
      {
        name: "insta",
        desc: "Télécharger depuis Instagram",
        usage: ".insta <url>",
        example: ".insta https://instagram.com/reel/...",
      },
      {
        name: "dl",
        desc: "Télécharger depuis TikTok, Facebook, Twitter...",
        usage: ".dl <url>",
        example: ".dl https://tiktok.com/@user/video/...",
      },
      {
        name: "apk",
        desc: "Télécharger une application Android",
        usage: ".apk <nom>",
        example: ".apk WhatsApp",
      },
      {
        name: "pinterest",
        desc: "Télécharger depuis Pinterest",
        usage: ".pinterest <url>",
        example: ".pinterest https://pin.it/...",
      },
    ],
  },
  music: {
    icon: "🎵",
    title: "Musique & Audio",
    description: "Recherchez et téléchargez de la musique",
    commands: [
      {
        name: "music",
        desc: "Rechercher et télécharger de la musique",
        usage: ".music <chanson>",
        example: ".music Bohemian Rhapsody",
      },
      {
        name: "lyrics",
        desc: "Obtenir les paroles d'une chanson",
        usage: ".lyrics <artiste - chanson>",
        example: ".lyrics Queen - Bohemian Rhapsody",
      },
      {
        name: "tts",
        desc: "Convertir du texte en voix",
        usage: ".tts <texte>",
        example: ".tts Bonjour, comment allez-vous ?",
      },
      {
        name: "transcribe",
        desc: "Transcrire un message vocal en texte",
        usage: "(répondre à un vocal) .transcribe",
        example: "(répondre à vocal) .transcribe",
      },
    ],
  },
  media: {
    icon: "🎨",
    title: "Médias & Création",
    description: "Créez des stickers, convertissez des fichiers",
    commands: [
      {
        name: "sticker",
        desc: "Créer un sticker depuis une image/vidéo",
        usage: "(répondre à média) .sticker",
        example: "(répondre à image) .sticker",
      },
      {
        name: "convert",
        desc: "Convertir des médias entre formats",
        usage: "(répondre à média) .convert <format>",
        example: "(répondre à image) .convert png",
      },
      {
        name: "topng",
        desc: "Convertir en PNG",
        usage: "(répondre à image) .topng",
        example: "(répondre à image) .topng",
      },
      {
        name: "tojpg",
        desc: "Convertir en JPG",
        usage: "(répondre à image) .tojpg",
        example: "(répondre à image) .tojpg",
      },
      {
        name: "topdf",
        desc: "Convertir en PDF",
        usage: "(répondre à image) .topdf",
        example: "(répondre à image) .topdf",
      },
      {
        name: "tomp3",
        desc: "Convertir en MP3",
        usage: "(répondre à vidéo) .tomp3",
        example: "(répondre à vidéo) .tomp3",
      },
      {
        name: "qr",
        desc: "Générer un QR code",
        usage: ".qr <texte ou url>",
        example: ".qr https://example.com",
      },
      {
        name: "pdf",
        desc: "Créer un document PDF",
        usage: ".pdf <contenu>",
        example: ".pdf Mon document texte",
      },
      {
        name: "fancy",
        desc: "Transformer le texte en styles fancy",
        usage: ".fancy <texte>",
        example: ".fancy Hello World",
      },
    ],
  },
  translate: {
    icon: "🌍",
    title: "Traduction",
    description: "Traduisez du texte dans toutes les langues",
    commands: [
      {
        name: "trt",
        desc: "Traduire du texte",
        usage: ".trt [lang] <texte>",
        example: ".trt en Bonjour le monde",
      },
    ],
  },
  info: {
    icon: "📰",
    title: "Informations",
    description: "Météo, actualités, crypto, et plus",
    commands: [
      {
        name: "weather / meteo",
        desc: "Obtenir la météo d'une ville",
        usage: ".meteo <ville>",
        example: ".meteo Paris",
      },
      {
        name: "news",
        desc: "Dernières actualités",
        usage: ".news [pays]",
        example: ".news fr",
      },
      {
        name: "crypto",
        desc: "Prix des cryptomonnaies",
        usage: ".crypto <nom>",
        example: ".crypto bitcoin",
      },
      {
        name: "stock",
        desc: "Cours des actions",
        usage: ".stock <symbole>",
        example: ".stock AAPL",
      },
      {
        name: "fact",
        desc: "Fait intéressant aléatoire",
        usage: ".fact",
        example: ".fact",
      },
      {
        name: "quote",
        desc: "Citation inspirante",
        usage: ".quote",
        example: ".quote",
      },
      { name: "joke", desc: "Une blague", usage: ".joke", example: ".joke" },
    ],
  },
  search: {
    icon: "🔍",
    title: "Recherche",
    description: "Recherchez des images et GIFs",
    commands: [
      {
        name: "image / img",
        desc: "Rechercher des images",
        usage: ".img <recherche>",
        example: ".img coucher de soleil",
      },
      {
        name: "gif",
        desc: "Rechercher des GIFs",
        usage: ".gif <recherche>",
        example: ".gif chat drôle",
      },
      {
        name: "reddit",
        desc: "Contenu depuis Reddit",
        usage: ".reddit <subreddit>",
        example: ".reddit memes",
      },
    ],
  },
  games: {
    icon: "🎮",
    title: "Jeux & Divertissement",
    description: "Quiz, jeux et activités amusantes",
    commands: [
      {
        name: "quiz",
        desc: "Jouer au quiz de culture générale",
        usage: ".quiz start / .quiz hint / .quiz stop",
        example: ".quiz start",
      },
      {
        name: "guess",
        desc: "Jeu de devinette (1-100)",
        usage: ".guess start / .guess <nombre>",
        example: ".guess start",
      },
      { name: "av", desc: "Action ou Vérité", usage: ".av", example: ".av" },
    ],
  },
  productivity: {
    icon: "⏰",
    title: "Productivité",
    description: "Tâches, rappels et notifications",
    commands: [
      {
        name: "task",
        desc: "Gestionnaire de tâches",
        usage: ".task add/list/done/delete",
        example: ".task add Faire les courses",
      },
      {
        name: "remind",
        desc: "Créer des rappels",
        usage: ".remind add <minutes> <message>",
        example: ".remind add 30 Appeler maman",
      },
      {
        name: "afk",
        desc: "Mode absent",
        usage: ".afk [raison]",
        example: ".afk Je reviens dans 1h",
      },
      {
        name: "notify",
        desc: "Notifications sur mots-clés",
        usage: ".notify add/list/remove",
        example: ".notify add urgent",
      },
    ],
  },
  group: {
    icon: "👥",
    title: "Gestion de Groupe",
    description: "Outils d'administration pour les groupes",
    commands: [
      {
        name: "tag / tagall",
        desc: "Mentionner tous les membres",
        usage: ".tag [message]",
        example: ".tag Réunion importante !",
      },
      {
        name: "kick",
        desc: "Expulser un membre",
        usage: ".kick @membre",
        example: ".kick @Jean",
      },
      {
        name: "promote",
        desc: "Promouvoir en admin",
        usage: ".promote @membre",
        example: ".promote @Marie",
      },
      {
        name: "demote",
        desc: "Rétrograder un admin",
        usage: ".demote @membre",
        example: ".demote @Pierre",
      },
      {
        name: "warn",
        desc: "Avertir un membre",
        usage: ".warn @membre",
        example: ".warn @Paul",
      },
      {
        name: "vote",
        desc: "Créer un sondage",
        usage: ".vote Question? Option1, Option2...",
        example: ".vote Resto demain? Pizza, Sushi, Burger",
      },
      {
        name: "stats",
        desc: "Statistiques du groupe",
        usage: ".stats",
        example: ".stats",
      },
      {
        name: "welcome",
        desc: "Message de bienvenue",
        usage: ".welcome on/off ou .welcome <message>",
        example: ".welcome Bienvenue @user !",
      },
      {
        name: "goodbye",
        desc: "Message d'au revoir",
        usage: ".goodbye on/off",
        example: ".goodbye on",
      },
    ],
  },
  viewonce: {
    icon: "👁️",
    title: "Messages Éphémères",
    description: "Gérer les messages view once",
    commands: [
      {
        name: "vv",
        desc: "Envoyer en mode view once",
        usage: "(répondre à média) .vv",
        example: "(répondre à média) .vv",
      },
      {
        name: "getvv",
        desc: "Récupérer un message view once",
        usage: "(répondre à view once) .getvv",
        example: "(répondre à view once) .getvv",
      },
      {
        name: "setvv",
        desc: "Configurer view once automatique",
        usage: ".setvv on/off",
        example: ".setvv on",
      },
    ],
  },
  admin: {
    icon: "🔧",
    title: "Administration (Propriétaire)",
    description: "Commandes réservées au propriétaire du bot",
    commands: [
      {
        name: "ar",
        desc: "Répondeur automatique IA",
        usage: ".ar on/off/status/personality",
        example: ".ar on",
      },
      {
        name: "antidelete",
        desc: "Récupérer les messages supprimés",
        usage: ".antidelete p/g/null",
        example: ".antidelete p",
      },
      {
        name: "filter",
        desc: "Ajouter une réponse automatique",
        usage: ".filter <mot> <réponse>",
        example: ".filter salut Bonjour !",
      },
      {
        name: "delfilter",
        desc: "Supprimer un filtre",
        usage: ".delfilter <mot>",
        example: ".delfilter salut",
      },
      {
        name: "setcmd",
        desc: "Lier un sticker à une commande",
        usage: "(répondre à sticker) .setcmd <cmd>",
        example: ".setcmd .ping",
      },
      {
        name: "ban",
        desc: "Désactiver le bot dans un chat",
        usage: ".ban",
        example: ".ban",
      },
      {
        name: "unban",
        desc: "Réactiver le bot",
        usage: ".unban",
        example: ".unban",
      },
      {
        name: "update",
        desc: "Mettre à jour le bot",
        usage: ".update",
        example: ".update",
      },
    ],
  },
};

// User profiles for the "Who is this for" section
const USER_PROFILES = [
  {
    icon: "👴",
    title: "Seniors",
    subtitle: "Grands-parents, personnes moins technophiles",
    description: "Des commandes simples pour le quotidien",
    commands: [
      ".meteo Paris",
      ".remind add 30 Médicament",
      ".gemini Comment faire une tarte ?",
      ".trt Bonjour",
    ],
  },
  {
    icon: "👨‍👩‍👧‍👦",
    title: "Familles",
    subtitle: "Parents et enfants",
    description: "Du divertissement pour toute la famille",
    commands: [".sticker", ".quiz start", ".ytdl", ".av"],
  },
  {
    icon: "🧑‍🎓",
    title: "Étudiants",
    subtitle: "Collégiens, lycéens, universitaires",
    description: "Aide aux devoirs et productivité",
    commands: [".gemini Explique...", ".task add", ".trt en", ".img"],
  },
  {
    icon: "👨‍💼",
    title: "Professionnels",
    subtitle: "Entrepreneurs, employés",
    description: "Automatisation et information",
    commands: [".ar on", ".news fr", ".crypto bitcoin", ".pdf"],
  },
];

// FAQ data
const FAQ_DATA = [
  {
    question: "Comment utiliser le bot ?",
    answer:
      "Toutes les commandes commencent par un point (.). Écrivez simplement la commande suivie de votre texte. Par exemple: .ping pour vérifier que le bot fonctionne.",
  },
  {
    question: "Le bot ne répond pas, que faire ?",
    answer:
      "Vérifiez d'abord avec .ping si le bot est en ligne. Assurez-vous d'utiliser le bon préfixe (.) et que le bot n'est pas banni dans ce chat.",
  },
  {
    question: "Qui peut utiliser les commandes d'admin ?",
    answer:
      "Les commandes d'administration (comme .ar, .antidelete) sont réservées au propriétaire du bot (configuré via SUDO dans config.env).",
  },
  {
    question: "C'est gratuit ?",
    answer:
      "Oui ! OpenWhatsappBot est 100% open-source et gratuit. Certaines fonctionnalités nécessitent des clés API gratuites.",
  },
  {
    question: "Comment créer mon propre bot ?",
    answer:
      "Clonez le dépôt GitHub, installez Node.js 20+, configurez votre config.env, et lancez avec yarn start. Consultez la section Développeurs pour plus de détails.",
  },
  {
    question: "Mes données sont-elles sécurisées ?",
    answer:
      "Toutes les données sont stockées localement sur votre serveur. Seules les requêtes IA sont envoyées aux API externes (Gemini, OpenAI).",
  },
];

// Export for use in other modules
if (typeof module !== "undefined" && module.exports) {
  module.exports = { CONFIG, COMMANDS_DATA, USER_PROFILES, FAQ_DATA };
}

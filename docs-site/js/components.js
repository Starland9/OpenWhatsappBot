/**
 * Page Components - HTML templates for each page
 */

const Pages = {
  /**
   * Home page
   */
  home() {
    return `
            <!-- Hero Section -->
            <section class="hero">
                <div class="hero-content">
                    <span class="hero-badge">
                        <span>🚀</span>
                        <span>Version 2.0 - Open Source</span>
                    </span>
                    <h1 class="hero-title">
                        Votre Assistant <span class="highlight">WhatsApp</span> Intelligent
                    </h1>
                    <p class="hero-description">
                        Un bot WhatsApp puissant, gratuit et open-source. Téléchargez des vidéos, discutez avec l'IA, gérez vos groupes et bien plus encore.
                    </p>
                    <div class="hero-actions">
                        <a href="#" class="btn btn-primary btn-lg" data-page="getting-started">
                            🚀 Commencer
                        </a>
                        <a href="#" class="btn btn-secondary btn-lg" data-page="commands">
                            📋 Voir les commandes
                        </a>
                    </div>
                    <div class="hero-stats">
                        <div class="stat">
                            <div class="stat-value">60+</div>
                            <div class="stat-label">Commandes</div>
                        </div>
                        <div class="stat">
                            <div class="stat-value">11</div>
                            <div class="stat-label">Langues</div>
                        </div>
                        <div class="stat">
                            <div class="stat-value">100%</div>
                            <div class="stat-label">Gratuit</div>
                        </div>
                    </div>
                </div>
            </section>

            <!-- Features Section -->
            <section class="section">
                <div class="container">
                    <div class="section-header">
                        <h2 class="section-title">Tout ce dont vous avez besoin</h2>
                        <p class="section-subtitle">Des fonctionnalités puissantes pour tous les utilisateurs</p>
                    </div>
                    <div class="features-grid">
                        ${Components.featureCard(
                          "🤖",
                          "IA Avancée",
                          "Discutez avec ChatGPT et Gemini, analysez des images, générez du contenu."
                        )}
                        ${Components.featureCard(
                          "📥",
                          "Téléchargements",
                          "YouTube, Instagram, TikTok, Facebook... Téléchargez depuis toutes les plateformes."
                        )}
                        ${Components.featureCard(
                          "🎨",
                          "Création de Stickers",
                          "Transformez vos photos et vidéos en stickers personnalisés."
                        )}
                        ${Components.featureCard(
                          "🌍",
                          "Traduction",
                          "Traduisez instantanément dans plus de 100 langues."
                        )}
                        ${Components.featureCard(
                          "👥",
                          "Gestion de Groupes",
                          "Modérez, créez des sondages, envoyez des annonces."
                        )}
                        ${Components.featureCard(
                          "⏰",
                          "Productivité",
                          "Tâches, rappels, notifications personnalisées."
                        )}
                    </div>
                </div>
            </section>

            <!-- Who is this for Section -->
            <section class="section" style="background-color: var(--bg-secondary);">
                <div class="container">
                    <div class="section-header">
                        <h2 class="section-title">Pour qui est ce bot ?</h2>
                        <p class="section-subtitle">Que vous soyez débutant ou expert, il y a quelque chose pour vous</p>
                    </div>
                    <div class="profiles-grid">
                        ${USER_PROFILES.map((p) =>
                          Components.profileCard(p)
                        ).join("")}
                    </div>
                </div>
            </section>

            <!-- Quick Start Section -->
            <section class="section">
                <div class="container">
                    <div class="section-header">
                        <h2 class="section-title">Commencez en 3 étapes</h2>
                    </div>
                    <div class="content-container">
                        <div class="steps-container">
                            <div class="steps-line"></div>
                            ${Components.step(
                              1,
                              "Installez le bot",
                              "Clonez le dépôt et installez les dépendances avec yarn install."
                            )}
                            ${Components.step(
                              2,
                              "Configurez",
                              "Copiez config.env.example vers config.env et ajoutez vos clés API."
                            )}
                            ${Components.step(
                              3,
                              "Lancez !",
                              "Démarrez avec yarn start et scannez le QR code avec WhatsApp."
                            )}
                        </div>
                        <div style="text-align: center; margin-top: var(--space-8);">
                            <a href="#" class="btn btn-primary btn-lg" data-page="getting-started">
                                Voir le guide complet →
                            </a>
                        </div>
                    </div>
                </div>
            </section>

            <!-- CTA Section -->
            <section class="section" style="background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-dark) 100%); color: white;">
                <div class="container" style="text-align: center;">
                    <h2 style="color: white; margin-bottom: var(--space-4);">Prêt à commencer ?</h2>
                    <p style="color: rgba(255,255,255,0.9); margin-bottom: var(--space-8); font-size: var(--text-lg);">
                        Rejoignez des milliers d'utilisateurs qui utilisent OpenWhatsappBot
                    </p>
                    <div style="display: flex; gap: var(--space-4); justify-content: center; flex-wrap: wrap;">
                        <a href="https://github.com/Starland9/OpenWhatsappBot" target="_blank" class="btn btn-lg" style="background: white; color: var(--color-primary);">
                            ⭐ Star sur GitHub
                        </a>
                        <a href="#" class="btn btn-lg" style="background: rgba(255,255,255,0.2); color: white; border: 2px solid white;" data-page="developers">
                            📖 Documentation
                        </a>
                    </div>
                </div>
            </section>
        `;
  },

  /**
   * Getting Started page
   */
  "getting-started"() {
    return `
            <section class="section">
                <div class="container">
                    <div class="content-container">
                        <h1 style="margin-bottom: var(--space-2);">🚀 Démarrage Rapide</h1>
                        <p style="font-size: var(--text-lg); color: var(--text-secondary); margin-bottom: var(--space-8);">
                            Suivez ce guide pour installer et configurer votre bot en quelques minutes.
                        </p>

                        <!-- Prerequisites -->
                        <h2 style="margin-bottom: var(--space-4);">📋 Prérequis</h2>
                        <div class="card" style="margin-bottom: var(--space-8);">
                            <div class="feature-list">
                                ${Components.featureItem(
                                  "Node.js 20 ou supérieur"
                                )}
                                ${Components.featureItem("Git installé")}
                                ${Components.featureItem(
                                  "FFmpeg (pour le traitement média)"
                                )}
                                ${Components.featureItem("Un compte WhatsApp")}
                            </div>
                        </div>

                        <!-- Installation Steps -->
                        <h2 style="margin-bottom: var(--space-6);">📦 Installation</h2>
                        <div class="steps-container" style="margin-bottom: var(--space-12);">
                            <div class="steps-line"></div>
                            
                            <div class="step">
                                <div class="step-number">1</div>
                                <div class="step-content">
                                    <h3 class="step-title">Cloner le dépôt</h3>
                                    <p class="step-desc">Téléchargez le code source depuis GitHub</p>
                                    ${Components.codeBlock(
                                      "bash",
                                      "git clone https://github.com/Starland9/OpenWhatsappBot\ncd OpenWhatsappBot"
                                    )}
                                </div>
                            </div>
                            
                            <div class="step">
                                <div class="step-number">2</div>
                                <div class="step-content">
                                    <h3 class="step-title">Installer les dépendances</h3>
                                    <p class="step-desc">Installez toutes les librairies nécessaires</p>
                                    ${Components.codeBlock(
                                      "bash",
                                      "yarn install"
                                    )}
                                </div>
                            </div>
                            
                            <div class="step">
                                <div class="step-number">3</div>
                                <div class="step-content">
                                    <h3 class="step-title">Configurer l'environnement</h3>
                                    <p class="step-desc">Créez votre fichier de configuration</p>
                                    ${Components.codeBlock(
                                      "bash",
                                      "cp config.env.example config.env"
                                    )}
                                    <p class="step-desc" style="margin-top: var(--space-3);">Éditez ensuite config.env avec vos paramètres :</p>
                                    ${Components.codeBlock(
                                      "env",
                                      "PREFIX=.\nSUDO=33612345678\nGEMINI_API_KEY=votre_cle_api\nBOT_LANG=fr"
                                    )}
                                </div>
                            </div>
                            
                            <div class="step">
                                <div class="step-number">4</div>
                                <div class="step-content">
                                    <h3 class="step-title">Lancer le bot</h3>
                                    <p class="step-desc">Démarrez le bot et scannez le QR code</p>
                                    ${Components.codeBlock(
                                      "bash",
                                      "yarn dev    # Mode développement\nyarn start  # Mode production (PM2)"
                                    )}
                                </div>
                            </div>
                        </div>

                        <!-- First Commands -->
                        <h2 style="margin-bottom: var(--space-4);">🎯 Vos premières commandes</h2>
                        <p style="margin-bottom: var(--space-4);">Une fois le bot lancé, testez ces commandes :</p>
                        
                        <div class="grid-2" style="margin-bottom: var(--space-8);">
                            ${Components.commandQuick(
                              ".ping",
                              "Vérifie que le bot répond"
                            )}
                            ${Components.commandQuick(
                              ".help",
                              "Affiche l'aide"
                            )}
                            ${Components.commandQuick(
                              ".menu",
                              "Liste toutes les commandes"
                            )}
                            ${Components.commandQuick(
                              ".gemini Bonjour !",
                              "Discute avec l'IA"
                            )}
                        </div>

                        <!-- Tips -->
                        <h2 style="margin-bottom: var(--space-4);">💡 Conseils</h2>
                        <div class="alert alert-info">
                            <span class="alert-icon">💡</span>
                            <div class="alert-content">
                                <div class="alert-title">Préfixe</div>
                                <p style="margin: 0;">Toutes les commandes commencent par un point (.). Vous pouvez le changer dans config.env.</p>
                            </div>
                        </div>
                        <div class="alert alert-success">
                            <span class="alert-icon">✅</span>
                            <div class="alert-content">
                                <div class="alert-title">Clés API gratuites</div>
                                <p style="margin: 0;">La plupart des API ont des plans gratuits suffisants pour un usage personnel.</p>
                            </div>
                        </div>

                        <div style="text-align: center; margin-top: var(--space-8);">
                            <a href="#" class="btn btn-primary btn-lg" data-page="commands">
                                Voir toutes les commandes →
                            </a>
                        </div>
                    </div>
                </div>
            </section>
        `;
  },

  /**
   * Commands page
   */
  commands() {
    return `
            <section class="section" style="padding-top: var(--space-8);">
                <div class="container">
                    <h1 style="margin-bottom: var(--space-2);">📋 Toutes les Commandes</h1>
                    <p style="font-size: var(--text-lg); color: var(--text-secondary); margin-bottom: var(--space-8);">
                        Plus de 60 commandes pour tous vos besoins
                    </p>

                    <div class="commands-layout">
                        <!-- Sidebar Navigation -->
                        <aside class="commands-sidebar">
                            <nav class="commands-nav">
                                <div class="commands-nav-title">Catégories</div>
                                ${Object.entries(COMMANDS_DATA)
                                  .map(
                                    ([key, data]) => `
                                    <a href="#category-${key}" class="commands-nav-link" data-category="${key}">
                                        <span>${data.icon}</span>
                                        <span>${data.title}</span>
                                    </a>
                                `
                                  )
                                  .join("")}
                            </nav>
                        </aside>

                        <!-- Commands Content -->
                        <div class="commands-content">
                            ${Object.entries(COMMANDS_DATA)
                              .map(
                                ([key, data]) => `
                                <div class="command-category" id="category-${key}">
                                    <div class="command-category-header">
                                        <span class="command-category-icon">${
                                          data.icon
                                        }</span>
                                        <h2 class="command-category-title">${
                                          data.title
                                        }</h2>
                                    </div>
                                    <p style="margin-bottom: var(--space-4); color: var(--text-secondary);">${
                                      data.description
                                    }</p>
                                    
                                    ${data.commands
                                      .map((cmd) => Components.commandCard(cmd))
                                      .join("")}
                                </div>
                            `
                              )
                              .join("")}
                        </div>
                    </div>
                </div>
            </section>
        `;
  },

  /**
   * Features page
   */
  features() {
    return `
            <section class="section">
                <div class="container">
                    <div class="content-container">
                        <h1 style="margin-bottom: var(--space-2);">✨ Fonctionnalités</h1>
                        <p style="font-size: var(--text-lg); color: var(--text-secondary); margin-bottom: var(--space-8);">
                            Découvrez tout ce que peut faire OpenWhatsappBot
                        </p>

                        <!-- AI Auto Responder -->
                        <div class="card" style="margin-bottom: var(--space-6);">
                            <h3 style="display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4);">
                                <span style="font-size: var(--text-2xl);">🤖</span>
                                Répondeur Automatique IA
                            </h3>
                            <p>Le bot peut répondre automatiquement à vos messages privés avec une IA intelligente (Gemini).</p>
                            <div class="feature-list" style="margin: var(--space-4) 0;">
                                ${Components.featureItem(
                                  "Réponses contextuelles (se souvient des 10 derniers messages)"
                                )}
                                ${Components.featureItem(
                                  "Personnalité personnalisable"
                                )}
                                ${Components.featureItem(
                                  "Liste d'ignorés pour certains contacts"
                                )}
                                ${Components.featureItem(
                                  "Anti-ban intégré (délais naturels, simulation de frappe)"
                                )}
                            </div>
                            ${Components.codeBlock(
                              "text",
                              ".ar on                    # Activer\n.ar personality Tu es...  # Personnaliser\n.ar ignore add 336...     # Ignorer un numéro"
                            )}
                        </div>

                        <!-- Anti Delete -->
                        <div class="card" style="margin-bottom: var(--space-6);">
                            <h3 style="display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4);">
                                <span style="font-size: var(--text-2xl);">🛡️</span>
                                Anti-Suppression
                            </h3>
                            <p>Récupérez les messages que les gens suppriment avant que vous ne les lisiez.</p>
                            ${Components.codeBlock(
                              "text",
                              ".antidelete p     # Envoyer vers votre chat privé\n.antidelete g     # Garder dans le même groupe\n.antidelete null  # Désactiver"
                            )}
                        </div>

                        <!-- Auto Status -->
                        <div class="card" style="margin-bottom: var(--space-6);">
                            <h3 style="display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4);">
                                <span style="font-size: var(--text-2xl);">👁️</span>
                                Visualiseur de Status Automatique
                            </h3>
                            <p>Le bot peut automatiquement voir et réagir aux statuts WhatsApp.</p>
                            <div class="feature-list" style="margin: var(--space-4) 0;">
                                ${Components.featureItem(
                                  "Vue automatique de tous les statuts"
                                )}
                                ${Components.featureItem(
                                  "Réaction avec emojis aléatoires"
                                )}
                                ${Components.featureItem(
                                  "Configurable via config.env"
                                )}
                            </div>
                        </div>

                        <!-- Sticker Commands -->
                        <div class="card" style="margin-bottom: var(--space-6);">
                            <h3 style="display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4);">
                                <span style="font-size: var(--text-2xl);">🏷️</span>
                                Commandes par Sticker
                            </h3>
                            <p>Associez des commandes à vos stickers favoris pour les exécuter d'un simple envoi.</p>
                            ${Components.codeBlock(
                              "text",
                              "# Répondre à un sticker avec:\n.setcmd .ping\n\n# Maintenant ce sticker exécute .ping !"
                            )}
                        </div>

                        <!-- Filters -->
                        <div class="card" style="margin-bottom: var(--space-6);">
                            <h3 style="display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4);">
                                <span style="font-size: var(--text-2xl);">🔄</span>
                                Filtres Auto-Réponse
                            </h3>
                            <p>Créez des réponses automatiques pour des mots-clés spécifiques.</p>
                            ${Components.codeBlock(
                              "text",
                              ".filter salut Bonjour ! Comment puis-je aider ?\n.filter règles 📜 Voici les règles du groupe...\n.delfilter salut  # Supprimer un filtre"
                            )}
                        </div>

                        <!-- Multi-language -->
                        <div class="card">
                            <h3 style="display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4);">
                                <span style="font-size: var(--text-2xl);">🌐</span>
                                Support Multilingue
                            </h3>
                            <p>Le bot est disponible en 11 langues :</p>
                            <div style="display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-4);">
                                <span class="badge">🇫🇷 Français</span>
                                <span class="badge">🇬🇧 English</span>
                                <span class="badge">🇪🇸 Español</span>
                                <span class="badge">🇸🇦 العربية</span>
                                <span class="badge">🇮🇳 हिन्दी</span>
                                <span class="badge">🇧🇩 বাংলা</span>
                                <span class="badge">🇮🇩 Indonesian</span>
                                <span class="badge">🇷🇺 Русский</span>
                                <span class="badge">🇹🇷 Türkçe</span>
                                <span class="badge">🇵🇰 اردو</span>
                                <span class="badge">🇧🇷 Português</span>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
        `;
  },

  /**
   * Developers page
   */
  developers() {
    return `
            <section class="section">
                <div class="container">
                    <div class="content-container">
                        <h1 style="margin-bottom: var(--space-2);">👨‍💻 Guide Développeur</h1>
                        <p style="font-size: var(--text-lg); color: var(--text-secondary); margin-bottom: var(--space-8);">
                            Tout ce qu'il faut savoir pour contribuer ou personnaliser le bot
                        </p>

                        <!-- Architecture -->
                        <h2 style="margin-bottom: var(--space-4);">🏗️ Architecture</h2>
                        <div class="card" style="margin-bottom: var(--space-8);">
                            ${Components.codeBlock(
                              "text",
                              "OpenWhatsappBot/\n├── index.js              # Point d'entrée\n├── config.js             # Gestion de la configuration\n├── config.env            # Variables d'environnement\n├── lib/\n│   ├── baileys/\n│   │   └── client.js     # Client WhatsApp\n│   ├── classes/\n│   │   └── Message.js    # Abstraction des messages\n│   ├── database/\n│   │   └── models/       # Modèles Sequelize\n│   ├── plugins/\n│   │   ├── loader.js     # Chargement des plugins\n│   │   └── registry.js   # Registre des commandes\n│   └── utils/            # Utilitaires divers\n├── plugins/              # Tous les plugins/commandes\n└── lang/                 # Fichiers de traduction"
                            )}
                        </div>

                        <!-- Create Plugin -->
                        <h2 style="margin-bottom: var(--space-4);">🧩 Créer un Plugin</h2>
                        <p style="margin-bottom: var(--space-4);">Créez un fichier dans <code>plugins/monplugin.js</code> :</p>
                        ${Components.codeBlock(
                          "javascript",
                          `const { getLang } = require("../lib/utils/language");

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
    await message.reply(\`Bonjour \${args || "ami"} ! 👋\`);
    
    // Autres méthodes disponibles :
    // await message.sendImage(buffer, { caption: "..." });
    // await message.sendSticker(buffer);
    // await message.react("👍");
  }
};`
                        )}

                        <!-- Message Class -->
                        <h2 style="margin-top: var(--space-8); margin-bottom: var(--space-4);">📨 Classe Message</h2>
                        <p style="margin-bottom: var(--space-4);">Méthodes principales disponibles dans <code>message</code> :</p>
                        
                        <div class="table-wrapper" style="margin-bottom: var(--space-8);">
                            <table class="table-enhanced">
                                <thead>
                                    <tr>
                                        <th>Méthode</th>
                                        <th>Description</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr><td><code>reply(text)</code></td><td>Répondre avec du texte</td></tr>
                                    <tr><td><code>sendImage(buffer, options)</code></td><td>Envoyer une image</td></tr>
                                    <tr><td><code>sendVideo(buffer, options)</code></td><td>Envoyer une vidéo</td></tr>
                                    <tr><td><code>sendAudio(buffer, options)</code></td><td>Envoyer un audio</td></tr>
                                    <tr><td><code>sendSticker(buffer)</code></td><td>Envoyer un sticker</td></tr>
                                    <tr><td><code>sendDocument(buffer, options)</code></td><td>Envoyer un document</td></tr>
                                    <tr><td><code>react(emoji)</code></td><td>Réagir au message</td></tr>
                                    <tr><td><code>downloadMedia()</code></td><td>Télécharger le média du message</td></tr>
                                    <tr><td><code>isSudo()</code></td><td>Vérifier si c'est le propriétaire</td></tr>
                                    <tr><td><code>isBotAdmin()</code></td><td>Vérifier si le bot est admin</td></tr>
                                </tbody>
                            </table>
                        </div>

                        <!-- API Keys -->
                        <h2 style="margin-bottom: var(--space-4);">🔑 Clés API</h2>
                        <div class="table-wrapper" style="margin-bottom: var(--space-8);">
                            <table class="table-enhanced">
                                <thead>
                                    <tr>
                                        <th>Service</th>
                                        <th>Variable</th>
                                        <th>Lien</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr><td>Google Gemini</td><td><code>GEMINI_API_KEY</code></td><td><a href="https://aistudio.google.com/app/apikey" target="_blank">Obtenir</a></td></tr>
                                    <tr><td>OpenAI</td><td><code>OPENAI_API_KEY</code></td><td><a href="https://platform.openai.com/api-keys" target="_blank">Obtenir</a></td></tr>
                                    <tr><td>Weather API</td><td><code>WEATHER_API_KEY</code></td><td><a href="https://www.weatherapi.com/signup.aspx" target="_blank">Obtenir</a></td></tr>
                                    <tr><td>News API</td><td><code>NEWS_API_KEY</code></td><td><a href="https://newsapi.org/register" target="_blank">Obtenir</a></td></tr>
                                    <tr><td>Unsplash</td><td><code>UNSPLASH_API_KEY</code></td><td><a href="https://unsplash.com/developers" target="_blank">Obtenir</a></td></tr>
                                </tbody>
                            </table>
                        </div>

                        <!-- Deployment -->
                        <h2 style="margin-bottom: var(--space-4);">🚀 Déploiement</h2>
                        
                        <div class="tabs">
                            <button class="tab active" data-tab="deploy-pm2">PM2</button>
                            <button class="tab" data-tab="deploy-docker">Docker</button>
                            <button class="tab" data-tab="deploy-heroku">Heroku</button>
                        </div>
                        
                        <div class="tab-panels">
                            <div class="tab-content" id="deploy-pm2">
                                ${Components.codeBlock(
                                  "bash",
                                  "# Démarrer avec PM2\nyarn start\n\n# Voir les logs\npm2 logs\n\n# Arrêter\nyarn stop"
                                )}
                            </div>
                            <div class="tab-content" id="deploy-docker" style="display: none;">
                                ${Components.codeBlock(
                                  "bash",
                                  "# Construire et lancer\ndocker-compose up -d\n\n# Voir les logs\ndocker-compose logs -f\n\n# Arrêter\ndocker-compose down"
                                )}
                            </div>
                            <div class="tab-content" id="deploy-heroku" style="display: none;">
                                ${Components.codeBlock(
                                  "bash",
                                  "# Créer l'app Heroku\nheroku create mon-bot\n\n# Configurer les variables\nheroku config:set GEMINI_API_KEY=xxx\n\n# Déployer\ngit push heroku master"
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </section>
        `;
  },

  /**
   * FAQ page
   */
  faq() {
    return `
            <section class="section">
                <div class="container">
                    <div class="faq-section">
                        <h1 style="margin-bottom: var(--space-2);">❓ Questions Fréquentes</h1>
                        <p style="font-size: var(--text-lg); color: var(--text-secondary); margin-bottom: var(--space-8);">
                            Trouvez rapidement les réponses à vos questions
                        </p>

                        <div class="accordion">
                            ${FAQ_DATA.map(
                              (item, i) => `
                                <div class="accordion-item ${
                                  i === 0 ? "open" : ""
                                }">
                                    <button class="accordion-header">
                                        <span>${item.question}</span>
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M6 9l6 6 6-6"></path>
                                        </svg>
                                    </button>
                                    <div class="accordion-content">
                                        <div class="accordion-body">
                                            ${item.answer}
                                        </div>
                                    </div>
                                </div>
                            `
                            ).join("")}
                        </div>

                        <div class="card" style="margin-top: var(--space-8); text-align: center;">
                            <h3 style="margin-bottom: var(--space-2);">Vous ne trouvez pas votre réponse ?</h3>
                            <p style="margin-bottom: var(--space-4);">Posez votre question sur GitHub Discussions</p>
                            <a href="https://github.com/Starland9/OpenWhatsappBot/discussions" target="_blank" class="btn btn-primary">
                                Poser une question
                            </a>
                        </div>
                    </div>
                </div>
            </section>
        `;
  },

  /**
   * Changelog page
   */
  changelog() {
    return `
            <section class="section">
                <div class="container">
                    <div class="content-container">
                        <h1 style="margin-bottom: var(--space-2);">📝 Changelog</h1>
                        <p style="font-size: var(--text-lg); color: var(--text-secondary); margin-bottom: var(--space-8);">
                            Historique des mises à jour
                        </p>

                        <div class="changelog-item">
                            <div class="changelog-version">
                                <span class="changelog-version-number">v2.0.0</span>
                                <span class="badge badge-primary">Dernière</span>
                                <span class="changelog-date">Décembre 2024</span>
                            </div>
                            <ul class="changelog-list">
                                <li>✨ Nouveau site de documentation interactif</li>
                                <li>🤖 Répondeur automatique avec Gemini AI</li>
                                <li>🌍 Support de 11 langues</li>
                                <li>📥 Téléchargeur universel (TikTok, Instagram, YouTube...)</li>
                                <li>🎮 Nouveaux jeux : Quiz, Action ou Vérité</li>
                                <li>⚡ Optimisation CPU (-70% d'utilisation)</li>
                                <li>🛡️ Système anti-ban pour le répondeur auto</li>
                            </ul>
                        </div>

                        <div class="changelog-item">
                            <div class="changelog-version">
                                <span class="changelog-version-number">v1.5.0</span>
                                <span class="changelog-date">Novembre 2024</span>
                            </div>
                            <ul class="changelog-list">
                                <li>🎨 Création de stickers améliorée</li>
                                <li>👥 Outils de gestion de groupe</li>
                                <li>📊 Statistiques de groupe</li>
                                <li>🔔 Système de notifications</li>
                            </ul>
                        </div>
                    </div>
                </div>
            </section>
        `;
  },

  /**
   * 404 Not Found page
   */
  notFound() {
    return `
            <div class="error-page">
                <div class="error-code">404</div>
                <h2>Page non trouvée</h2>
                <p class="error-message">La page que vous recherchez n'existe pas.</p>
                <a href="#" class="btn btn-primary" data-page="home">Retour à l'accueil</a>
            </div>
        `;
  },
};

// Make available globally
window.Pages = Pages;

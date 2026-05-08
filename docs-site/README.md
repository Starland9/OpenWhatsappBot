# 📚 OpenWhatsappBot - Site de Documentation

Site de documentation interactif et moderne pour OpenWhatsappBot.

## 🏗️ Structure

```
docs-site/
├── index.html              # Page principale (SPA)
├── css/
│   ├── variables.css       # Variables CSS (couleurs, espacements, etc.)
│   ├── base.css           # Styles de base et reset
│   ├── components.css     # Composants réutilisables (boutons, cartes, etc.)
│   ├── layout.css         # Mise en page (header, footer, grilles)
│   ├── pages.css          # Styles spécifiques aux pages
│   └── responsive.css     # Media queries pour le responsive
├── js/
│   ├── config.js          # Configuration et données des commandes
│   ├── utils.js           # Fonctions utilitaires
│   ├── ui-components.js   # Composants UI réutilisables
│   ├── components.js      # Templates HTML des pages
│   ├── search.js          # Fonctionnalité de recherche
│   ├── router.js          # Navigation SPA (Single Page App)
│   └── app.js             # Initialisation de l'application
└── assets/
    └── favicon.svg        # Icône du site
```

## 🚀 Lancer le site

### Option 1 : Serveur local simple

```bash
# Avec Python 3
cd docs-site
python -m http.server 8080

# Avec Node.js (npx)
npx serve .

# Avec PHP
php -S localhost:8080
```

Puis ouvrir : http://localhost:8080

### Option 2 : Ouvrir directement

Ouvrez simplement `index.html` dans votre navigateur.

> ⚠️ Certains navigateurs bloquent les requêtes locales. Utilisez un serveur local pour une meilleure expérience.

## ✨ Fonctionnalités

- 🌙 **Mode sombre/clair** - Bascule automatique ou manuelle
- 🔍 **Recherche instantanée** - Ctrl+K ou clic sur l'icône
- 📱 **Responsive** - Fonctionne sur mobile, tablette et desktop
- ⚡ **SPA** - Navigation fluide sans rechargement
- 🎨 **Design moderne** - Interface épurée et accessible

## 📝 Personnalisation

### Ajouter une commande

Éditez `js/config.js` et ajoutez dans la catégorie appropriée :

```javascript
COMMANDS_DATA.base.commands.push({
    name: 'macommande',
    desc: 'Description de la commande',
    usage: '.macommande <argument>',
    example: '.macommande test'
});
```

### Ajouter une page

1. Ajoutez la fonction dans `js/components.js` :

```javascript
Pages['ma-page'] = function() {
    return `
        <section class="section">
            <div class="container">
                <h1>Ma Page</h1>
            </div>
        </section>
    `;
};
```

2. Ajoutez le lien de navigation dans `index.html`

### Modifier les couleurs

Éditez `css/variables.css` :

```css
:root {
    --color-primary: #25D366;  /* Couleur principale */
    --color-secondary: #075E54;
    /* ... */
}
```

## 🌐 Déploiement

Le site est statique et peut être déployé sur :

- **GitHub Pages** : Poussez dans le dépôt et activez Pages
- **Netlify** : Glissez-déposez le dossier
- **Vercel** : Connectez votre dépôt
- **N'importe quel hébergeur** : Uploadez les fichiers

## 📄 Licence

MIT - Utilisez librement !

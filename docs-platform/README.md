# OpenWhatsappBot Documentation Platform

Modern, interactive documentation website for OpenWhatsappBot built with Next.js and Nextra.

## 🌟 Features

- **📚 Comprehensive Documentation** - Complete guides, API reference, and examples
- **🔍 Full-Text Search** - Powered by Nextra's built-in search
- **🌓 Dark Mode** - Automatic theme switching
- **📱 Mobile Responsive** - Optimized for all devices
- **⚡ Fast Performance** - Static site generation with Next.js
- **🎨 WhatsApp Theme** - Custom styling with WhatsApp green (#25D366)
- **🌐 SEO Optimized** - Meta tags and Open Graph support

## 🚀 Quick Start

### Prerequisites

- Node.js 20.0.0 or higher
- npm or yarn

### Installation

```bash
cd docs-platform
npm install
```

### Development

Start the development server:

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000)

### Build

Create a production build:

```bash
npm run build
```

### Start Production Server

```bash
npm start
```

## 📁 Project Structure

```
docs-platform/
├── pages/              # Documentation pages (MDX)
│   ├── index.mdx       # Homepage
│   ├── getting-started/
│   │   ├── installation.mdx
│   │   ├── configuration.mdx
│   │   ├── first-steps.mdx
│   │   └── deployment.mdx
│   ├── plugins/        # Plugin documentation
│   ├── api-reference/  # API docs
│   ├── guides/         # Tutorials
│   └── examples/       # Code examples
├── public/             # Static assets
├── styles/             # Global styles
├── theme.config.jsx    # Nextra theme configuration
└── next.config.mjs     # Next.js configuration
```

## ✍️ Writing Documentation

### Creating a New Page

1. Create a new `.mdx` file in the appropriate directory under `pages/`
2. Add the page to the corresponding `_meta.js` file for navigation

Example:

```mdx
# My New Page

This is my documentation content.

## Code Example

```javascript
console.log('Hello, World!')
```
```

### Navigation Structure

Edit `_meta.js` files to control navigation:

```javascript
// pages/_meta.js
export default {
  index: 'Home',
  'getting-started': 'Getting Started',
  plugins: 'Plugins'
}
```

## 🚀 Deployment

### Vercel (Recommended)

1. Push your code to GitHub
2. Import project in [Vercel](https://vercel.com)
3. Deploy automatically

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Starland9/OpenWhatsappBot/tree/main/docs-platform)

### Netlify

```bash
# Build command
npm run build

# Publish directory
.next
```

## 📝 Content Management

### Adding Documentation

1. **Getting Started**: Guides for new users
2. **Plugins**: Plugin usage and configuration
3. **API Reference**: Developer API docs
4. **Guides**: Step-by-step tutorials
5. **Examples**: Code examples and use cases

## 🤝 Contributing

Contributions welcome! To contribute documentation:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally with `npm run dev`
5. Build to ensure no errors: `npm run build`
6. Submit a pull request

## 📄 License

MIT License - see main repository LICENSE file

## 🙏 Credits

- Built with [Next.js](https://nextjs.org/)
- Documentation framework: [Nextra](https://nextra.site/)
- Hosting: [Vercel](https://vercel.com/)

## 📞 Support

- **Documentation Issues**: [GitHub Issues](https://github.com/Starland9/OpenWhatsappBot/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Starland9/OpenWhatsappBot/discussions)

---

Built with ❤️ for the OpenWhatsappBot community


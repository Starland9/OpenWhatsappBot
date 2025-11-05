# Deploying the Documentation Platform

This guide covers deploying the OpenWhatsappBot documentation platform to various hosting providers.

## Prerequisites

- GitHub repository access
- Node.js 20.0.0+ installed locally
- Documentation platform built successfully

## Deployment Options

### Option 1: Vercel (Recommended)

Vercel is the recommended hosting platform for Next.js applications.

#### Automatic Deployment

1. **Sign up/Login to Vercel**
   - Visit [vercel.com](https://vercel.com)
   - Sign up with GitHub

2. **Import Project**
   - Click "New Project"
   - Select your GitHub repository
   - Select the `docs-platform` directory as the root

3. **Configure Project**
   - **Framework Preset**: Next.js
   - **Root Directory**: `docs-platform`
   - **Build Command**: `npm run build`
   - **Output Directory**: `.next`

4. **Deploy**
   - Click "Deploy"
   - Wait for deployment to complete
   - Your site will be live at `https://your-project.vercel.app`

#### Custom Domain

1. Go to Project Settings → Domains
2. Add your custom domain
3. Configure DNS records as instructed
4. SSL certificate is automatically provisioned

#### Environment Variables

If needed, add environment variables in Project Settings → Environment Variables:

```env
NEXT_PUBLIC_SITE_URL=https://docs.openwhatsappbot.com
```

### Option 2: Netlify

Deploy to Netlify for an alternative hosting solution.

#### Setup

1. **Login to Netlify**
   - Visit [netlify.com](https://netlify.com)
   - Sign up with GitHub

2. **New Site from Git**
   - Click "Add new site"
   - Choose "Import an existing project"
   - Connect to GitHub
   - Select your repository

3. **Configure Build**
   - **Base directory**: `docs-platform`
   - **Build command**: `npm run build`
   - **Publish directory**: `docs-platform/.next`

4. **Deploy**
   - Click "Deploy site"
   - Site will be live at `https://random-name.netlify.app`

#### Custom Domain

1. Go to Domain Settings
2. Add custom domain
3. Configure DNS
4. SSL auto-provisioned

### Option 3: GitHub Pages

Deploy as a static site to GitHub Pages.

#### Configuration

1. **Update next.config.mjs**:

```javascript
export default withNextra({
  output: 'export',
  images: {
    unoptimized: true,
  },
  basePath: '/docs',  // If using project page
})
```

2. **Add export script** to package.json:

```json
{
  "scripts": {
    "export": "next build"
  }
}
```

3. **Build and Export**:

```bash
cd docs-platform
npm run build
```

4. **Deploy to gh-pages branch**:

```bash
# Install gh-pages
npm install -D gh-pages

# Add deploy script to package.json
{
  "scripts": {
    "deploy": "gh-pages -d .next"
  }
}

# Deploy
npm run deploy
```

5. **Configure GitHub Pages**:
   - Go to repository Settings → Pages
   - Source: gh-pages branch
   - Save

### Option 4: Docker Deployment

Deploy using Docker containers.

#### Dockerfile

Create `Dockerfile` in docs-platform:

```dockerfile
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

CMD ["npm", "start"]
```

#### Build and Run

```bash
# Build image
docker build -t openwhatsappbot-docs .

# Run container
docker run -p 3000:3000 openwhatsappbot-docs
```

#### Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3.8'

services:
  docs:
    build: ./docs-platform
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    restart: unless-stopped
```

Run:

```bash
docker-compose up -d
```

### Option 5: Self-Hosted VPS

Deploy to your own server.

#### Prerequisites

- Ubuntu 20.04+ server
- Domain name (optional)
- Root/sudo access

#### Installation

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2
npm install -g pm2

# Clone repository
git clone https://github.com/Starland9/OpenWhatsappBot
cd OpenWhatsappBot/docs-platform

# Install dependencies
npm install

# Build
npm run build

# Start with PM2
pm2 start npm --name "docs-platform" -- start

# Save PM2 configuration
pm2 save

# Setup startup script
pm2 startup
```

#### Nginx Reverse Proxy

Install and configure Nginx:

```bash
# Install Nginx
sudo apt install -y nginx

# Create configuration
sudo nano /etc/nginx/sites-available/docs
```

Add configuration:

```nginx
server {
    listen 80;
    server_name docs.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable and restart:

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/docs /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

#### SSL with Let's Encrypt

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d docs.yourdomain.com

# Auto-renewal is configured automatically
```

## CI/CD Setup

### GitHub Actions

The repository includes a GitHub Actions workflow for automated deployment.

#### Required Secrets

Add these secrets to your GitHub repository (Settings → Secrets):

- `VERCEL_TOKEN` - Vercel access token
- `VERCEL_ORG_ID` - Your Vercel organization ID
- `VERCEL_PROJECT_ID` - Your Vercel project ID

#### Workflow Features

- Automatic build on push to main
- Linting check
- Build verification
- Automatic deployment to Vercel

### Manual Deployment

To deploy manually:

```bash
# Build
cd docs-platform
npm run build

# Deploy using Vercel CLI
npx vercel --prod
```

## Post-Deployment

### Verification

1. **Check Homepage**: Visit your deployed URL
2. **Test Navigation**: Click through different pages
3. **Test Search**: Use the search functionality
4. **Mobile Test**: Check responsive design
5. **Dark Mode**: Toggle and verify theme switching

### Performance

Check performance with Lighthouse:

1. Open Chrome DevTools
2. Go to Lighthouse tab
3. Generate report
4. Aim for 90+ scores

### Monitoring

Set up monitoring:

1. **Vercel Analytics**: Automatically enabled on Vercel
2. **Google Analytics**: Add tracking ID
3. **Uptime Monitoring**: Use services like UptimeRobot

## Troubleshooting

### Build Failures

```bash
# Clear cache
rm -rf .next node_modules
npm install
npm run build
```

### Port Already in Use

```bash
# Find and kill process
lsof -ti:3000 | xargs kill -9

# Or use different port
PORT=3001 npm start
```

### Module Not Found

```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

## Updating Documentation

### Content Updates

1. Edit `.mdx` files in `pages/`
2. Commit and push changes
3. Automatic deployment triggers (if CI/CD enabled)

### Dependency Updates

```bash
# Check for updates
npm outdated

# Update dependencies
npm update

# Test build
npm run build
```

## Best Practices

1. **Always test locally** before deploying
2. **Use environment variables** for configuration
3. **Enable HTTPS** for production
4. **Set up monitoring** and analytics
5. **Configure CDN** for static assets
6. **Regular backups** of content
7. **Keep dependencies updated**

## Support

Need help with deployment?

- [Vercel Documentation](https://vercel.com/docs)
- [Next.js Deployment](https://nextjs.org/docs/deployment)
- [GitHub Discussions](https://github.com/Starland9/OpenWhatsappBot/discussions)

---

Your documentation platform is ready to serve users worldwide! 🚀

# Rapport des dépendances (US7)

Généré le 2026-10-27 à partir du diff `package.json` entre `master` et `001-audit-fix-commands`. Versions vérifiées sur le registre npm le même jour ; contrôle : `node tools/check-unused-deps.js` → 0 dépendance inutilisée.

| Paquet | Avant | Après | Action | Note |
| --- | --- | --- | --- | --- |
| `@distube/ytdl-core` | ^4.16.12 | — | Retirée | inutilisé |
| `@google/genai` | ^2.8.0 | ^2.31.0 | Mise à jour |  |
| `@google/generative-ai` | ^0.24.1 | — | Remplacée | inutilisé, déprécié (remplacé par @google/genai) |
| `@hapi/boom` | ^10.0.1 | ^10.0.1 | Inchangée (déjà à jour) |  |
| `@ryuu-reinzz/button-helper` | 2.2.3 | 2.2.3 | Inchangée (déjà à jour) |  |
| `@vitalets/google-translate-api` | ^9.2.1 | ^9.2.1 | Inchangée (déjà à jour) |  |
| `audio-decode` | ^2.1.3 | — | Retirée | inutilisé |
| `axios` | ^1.18.0 | ^1.20.0 | Mise à jour | 1.21.0 publiée < 24 h : mise en quarantaine par Yarn, à monter après le 2026-10-28 |
| `baileys` | ^7.0.0-rc13 | 7.0.0-rc14 | Exception (préversion) | exception FR-026 : la lignée 7.x n’existe qu’en préversion ; 6.7 (legacy) casserait le bot |
| `browser-id3-writer` | ^6.3.1 | — | Retirée | inutilisé |
| `cheerio` | ^1.2.0 | — | Retirée | inutilisé |
| `cookie` | ^1.1.1 | — | Retirée | inutilisé |
| `cron` | ^4.4.0 | — | Retirée | plus utilisé (rappels gérés par lib/utils/scheduler.js) |
| `dotenv` | ^17.4.2 | ^18.0.9 | Mise à jour majeure |  |
| `fastq` | ^1.20.1 | — | Retirée | inutilisé |
| `file-type` | ^22.0.1 | ^22.2.0 | Mise à jour |  |
| `fluent-ffmpeg` | ^2.1.3 | — | Remplacée | déprécié → remplacé par lib/utils/ffmpeg.js (execFile, sans shell) |
| `form-data` | ^4.0.6 | — | Retirée | inutilisé |
| `fs-extra` | ^11.3.5 | — | Retirée | inutilisé |
| `google-tts-api` | ^2.0.2 | ^2.0.2 | Inchangée (déjà à jour) |  |
| `googleapis` | ^173.0.0 | — | Retirée | inutilisé |
| `heroku-client` | ^3.1.2 | — | Retirée | inutilisé |
| `html-entities` | ^2.6.0 | ^2.6.0 | Inchangée (déjà à jour) |  |
| `jimp` | ^1.6.1 | — | Retirée | inutilisé |
| `link-preview-js` | ^3.0.0 | — | Retirée | inutilisé |
| `luxon` | — | ^3.7.2 | Ajoutée | fuseaux horaires du planificateur de rappels |
| `moment` | ^2.30.1 | — | Retirée | inutilisé |
| `node-fetch` | ^3.3.2 | — | Retirée | inutilisé (fetch natif de Node 24) |
| `node-webpmux` | ^3.2.1 | ^3.2.1 | Inchangée (déjà à jour) |  |
| `openai` | ^6.42.0 | ^7.45.0 | Mise à jour majeure | 7.45.1 publiée < 24 h : mise en quarantaine par Yarn, à monter après le 2026-10-28 |
| `pdfkit` | ^0.19.1 | ^0.20.2 | Mise à jour |  |
| `pg` | ^8.21.0 | ^8.23.1 | Mise à jour |  |
| `pino` | ^10.3.1 | ^10.4.0 | Mise à jour |  |
| `pino-pretty` | ^13.1.3 | ^13.2.0 | Mise à jour |  |
| `play-dl` | ^1.9.7 | — | Remplacée | abandonné (2023), bloquait sur HTTP 429 → remplacé par le binaire yt-dlp |
| `pm2` | ^7.0.1 | ^7.1.1 | Mise à jour |  |
| `qrcode` | ^1.5.4 | ^1.5.4 | Inchangée (déjà à jour) |  |
| `qrcode-reader` | ^1.0.4 | — | Retirée | inutilisé |
| `qrcode-terminal` | ^0.12.0 | ^0.12.0 | Inchangée (déjà à jour) |  |
| `sequelize` | ^6.37.8 | ^6.37.8 | Inchangée (déjà à jour) |  |
| `sharp` | ^0.35.1 | ^0.35.5 | Mise à jour |  |
| `simple-git` | ^3.36.0 | ^4.0.2 | Mise à jour majeure |  |
| `sqlite3` | ^6.0.1 | ^6.0.1 | Inchangée (déjà à jour) |  |
| `translate-google-api` | ^1.0.4 | — | Retirée | inutilisé |
| `youtubei.js` | ^17.0.1 | — | Retirée | inutilisé |

Dépendances système : `ffmpeg` (inchangé) et **`yt-dlp`** (nouveau, installé dans l’image Docker à sa dernière version ; `.update now` tente `yt-dlp -U`).

Implicites conservées : `pg`, `sqlite3` (dialectes Sequelize), `pino-pretty` (transport de logs), `pm2` (scripts).

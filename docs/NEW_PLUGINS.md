# New Plugins Added - OpenWhatsappBot

This document lists all the new plugins that have been created based on the WhatsBixby repository.

## Created Plugins (20 total)

### 1. Search & Download (7 plugins)
- **lyrics.js** - Search and display song lyrics from multiple APIs
- **instagram.js** - Download Instagram posts, reels, and stories
- **pinterest.js** - Search and download Pinterest images
- **reddit.js** - Search Reddit posts and subreddits
- **apkdownload.js** - Download Android APK files from Aptoide
- **fancy.js** - Generate fancy text in 10 different styles
- **tts.js** - Text-to-speech conversion with multi-language support

### 2. Group Admin (5 plugins)
- **setwelcome.js** - Set custom welcome messages for groups
- **goodbye.js** - Set custom goodbye messages for groups  
- **warnuser.js** - Warning system with auto-kick on limit
- **addfilter.js** - Create custom auto-reply filters
- **delfilter.js** - Remove auto-reply filters

### 3. Owner/Admin (3 plugins)
- **banchat.js** - Deactivate bot in specific chats (owner only)
- **unbanchat.js** - Reactivate bot in banned chats (owner only)
- **eval.js** - Execute JavaScript code (DANGEROUS - owner only)

### 4. Utility (2 plugins)
- **pdfmaker.js** - Create PDF from text or convert images to PDF
- **afk.js** - Set AFK status with auto-response when mentioned

### 5. Entertainment (3 plugins)
- **joke.js** - Get random jokes from multiple APIs
- **fact.js** - Get random interesting facts
- **quote.js** - Get inspirational quotes

## Plugin Features

### Common Features Across All Plugins:
- ✅ Error handling with try-catch blocks
- ✅ User-friendly error messages
- ✅ Reaction emojis for status feedback
- ✅ Help messages when no args provided
- ✅ Integration with existing Message class
- ✅ Support for quoted messages where applicable
- ✅ Timeout handling for API requests

### Advanced Features:

#### AFK Plugin
- Automatically responds when owner is mentioned
- Tracks time since AFK
- Shows custom reason
- Auto-deactivates when owner sends a message

#### Warning System
- Configurable warn limit (from config.js)
- Auto-kick on limit reached
- Warning reset functionality
- Persistent storage with Sequelize

#### Filter System
- Pattern-based auto-replies
- Group-specific filters
- Easy add/delete/list operations
- Database persistence

#### Instagram Downloader
- Multiple API fallbacks for reliability
- Supports posts, reels, and stories
- Auto-detects video vs image
- Error handling for private accounts

#### TTS (Text-to-Speech)
- Multi-language support (50+ languages)
- Custom language syntax: {lang}
- Google TTS integration
- Character limit protection

#### Fancy Text
- 10 different text styles
- Unicode transformations
- "all" option to see all styles
- Bold, Italic, Circled, Squared, etc.

#### PDF Maker
- Text to PDF conversion
- Image to PDF conversion
- Custom formatting with PDFKit
- Temporary file cleanup

## Integration Notes

### Database Models Used:
- **Warn** - For warning system
- **Filter** - For auto-reply filters
- **Group** - For welcome/goodbye messages

### Config Variables Used:
- `WARN_LIMIT` - Maximum warnings before kick
- `WARN_MESSAGE` - Warning message template
- `WARN_KICK_MESSAGE` - Kick message template

### Dependencies Required:
All dependencies are already in package.json:
- axios - HTTP requests
- google-tts-api - Text-to-speech
- pdfkit - PDF generation
- sequelize - Database ORM

## Testing Recommendations

1. **Search Plugins** - Test with various queries
2. **Admin Plugins** - Test in group with bot as admin
3. **Download Plugins** - Test with valid URLs
4. **Filter System** - Test pattern matching
5. **Warning System** - Test kick functionality
6. **AFK System** - Test mention responses

## Future Enhancements

Potential additions based on WhatsBixby:
- vote.js - Enhanced polling system
- bgmbot.js - Background music bot
- stalk.js - Social media stalking/info
- toggle.js - Toggle bot features
- updater.js - Bot auto-updater
- vars.js - Environment variable management
- document.js - Document manipulation tools
- gfx.js - Advanced image manipulation
- holiday.js - Holiday information

## Command Examples

```
.afk Going to sleep
.lyrics Shape of You
.fancy 5 Hello World
.insta https://instagram.com/p/xxx
.pinterest cats
.reddit r/memes
.tts {es} Hola Mundo
.warn (reply to user)
.filter hi=Hello there!
.pdf This is my document
.joke
.fact
.quote
```

## Notes

- All plugins follow OpenWhatsappBot architecture
- Compatible with @whiskeysockets/baileys
- Use existing Message class methods
- Integrated with existing database models
- Language support via getLang() utility
- Sudo/admin checks where appropriate

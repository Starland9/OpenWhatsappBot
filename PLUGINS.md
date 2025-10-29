# New Plugins Documentation

This document describes the 15 new plugins added to OpenWhatsappBot with multimodal support.

## 🌐 Plugin 1: Translation (translate)

**Command:** `.translate`, `.tr`, `.tl`

**Description:** Automatically translate messages to any language using Google Translate API.

**Usage:**
```
.translate <text>              # Auto-translate to English
.translate <lang> <text>       # Translate to specific language  
Reply to message: .translate <lang>
```

**Examples:**
```
.translate Hello world
.translate fr Hello world
Reply to a message and type: .translate es
```

**Multimodal:** Works with text messages and captions.

---

## ✅ Plugin 2: Task Manager & Reminders (task, reminder)

**Commands:** `.task`, `.todo`, `.reminder`, `.remind`

**Description:** Create and manage tasks, set timed reminders.

**Usage:**
```
# Tasks
.task add <text>          # Add a new task
.task list                # Show all tasks
.task done <number>       # Mark task as complete
.task delete <number>     # Remove a task
.task clear               # Clear all tasks

# Reminders
.remind add <minutes> <text>  # Set a reminder
.remind list                  # Show active reminders
.remind cancel <number>       # Cancel a reminder
```

**Examples:**
```
.task add Buy groceries
.task list
.task done 1
.remind add 30 Team meeting
```

---

## 🌤️ Plugin 3: Weather (weather)

**Commands:** `.weather`, `.meteo`, `.clima`

**Description:** Get current weather information for any location using WeatherAPI.

**Usage:**
```
.weather <city name>
```

**Examples:**
```
.weather London
.weather New York
.weather Tokyo
```

**Requires:** `WEATHER_API_KEY` from [weatherapi.com](https://www.weatherapi.com/)

---

## 🎮 Plugin 4: Quiz & Games (quiz, guess)

**Commands:** `.quiz`, `.trivia`, `.guess`, `.game`

**Description:** Play interactive quiz games and number guessing games.

**Usage:**
```
# Quiz Game
.quiz start               # Start a quiz
.quiz hint                # Get a hint
.quiz <answer>            # Submit answer
.quiz stop                # Stop quiz

# Guessing Game
.guess start              # Start guessing game (1-100)
.guess <number>           # Make a guess
.guess stop               # Stop game
```

**Examples:**
```
.quiz start
.quiz hint
.quiz Paris
.guess start
.guess 50
```

---

## 🖼️ Plugin 5: Image & GIF Search (image, gif)

**Commands:** `.image`, `.img`, `.gif`, `.giphy`

**Description:** Search and send images from Unsplash or GIFs from Giphy.

**Usage:**
```
.image <search term>      # Search and send image
.gif <search term>        # Search and send GIF
```

**Examples:**
```
.image sunset
.image mountain landscape
.gif happy dance
.gif celebration
```

**Requires:** 
- `UNSPLASH_API_KEY` from [unsplash.com/developers](https://unsplash.com/developers)
- `GIPHY_API_KEY` from [developers.giphy.com](https://developers.giphy.com/) (optional, uses public key)

---

## 📊 Plugin 6: Polls (poll)

**Commands:** `.poll`, `.vote`, `.survey`

**Description:** Create interactive polls in groups (uses native WhatsApp polls when available).

**Usage:**
```
.poll Question? Option1, Option2, Option3
```

**Examples:**
```
.poll Best color? Red, Blue, Green, Yellow
.poll What time for meeting? 2pm, 3pm, 4pm
```

**Note:** Group-only command.

---

## 📈 Plugin 7: Message Analytics (stats)

**Commands:** `.stats`, `.analytics`, `.groupstats`

**Description:** View group message statistics and word frequency analysis.

**Usage:**
```
.stats                    # Show message statistics
.stats words              # Show word frequency
.stats reset              # Reset statistics (admin only)
```

**Note:** Group-only command. Automatically tracks messages over time.

---

## 📰 Plugin 8: News & Alerts (news, crypto, stock)

**Commands:** `.news`, `.crypto`, `.bitcoin`, `.stock`

**Description:** Get latest news, cryptocurrency prices, and stock quotes.

**Usage:**
```
.news [country]           # Get top news (default: US)
.crypto <name>            # Get crypto price
.stock <symbol>           # Get stock quote
```

**Examples:**
```
.news
.news fr
.crypto bitcoin
.crypto ethereum
.stock AAPL
.stock TSLA
```

**Requires:**
- `NEWS_API_KEY` from [newsapi.org](https://newsapi.org/)
- `ALPHA_VANTAGE_KEY` from [alphavantage.co](https://www.alphavantage.co/)

---

## 🎤 Plugin 9: Voice Processing (transcribe, tts)

**Commands:** `.transcribe`, `.totext`, `.tts`, `.speak`

**Description:** Convert voice to text using OpenAI Whisper, and text to speech using Google TTS.

**Usage:**
```
.transcribe               # Reply to voice message to transcribe
.tts <text>               # Convert text to speech
Reply to text: .tts       # Convert replied message to speech
```

**Examples:**
```
Reply to voice note: .transcribe
.tts Hello, how are you today?
Reply to text message: .tts
```

**Requires:** `OPENAI_API_KEY` for transcription

**Multimodal:** Processes voice messages, generates audio.

---

## 🔄 Plugin 10: File Converter (convert)

**Commands:** `.convert`, `.topng`, `.tojpg`, `.topdf`, `.tomp3`

**Description:** Convert files between different formats.

**Usage:**
```
.convert <format>         # Reply to media
.topng                    # Convert image to PNG
.tojpg                    # Convert image to JPG
.topdf                    # Convert image to PDF
.tomp3                    # Convert video/audio to MP3
```

**Examples:**
```
Reply to image: .topng
Reply to image: .topdf
Reply to video: .tomp3
Reply to image: .convert jpg
```

**Supported conversions:**
- Image: PNG ↔ JPG ↔ WEBP
- Image → PDF
- Video → MP3
- Audio format conversions

**Multimodal:** Processes images, videos, audio files.

---

## 🤖 Plugin 11: Enhanced ChatGPT (Multimodal AI)

**Commands:** `.gpt`, `.ai`, `.chatgpt`

**Description:** Enhanced ChatGPT with image analysis support using GPT-4 Vision.

**Usage:**
```
.gpt <question>           # Ask a question
Reply to image: .gpt <question>  # Analyze image
```

**Examples:**
```
.gpt What is Node.js?
.gpt Explain quantum computing
Reply to image: .gpt What's in this image?
Reply to image: .gpt Describe this in detail
```

**Requires:** `OPENAI_API_KEY`

**Multimodal:** Can analyze images along with text queries.

---

## 🎵 Plugin 12: Music Search (music, spotify, lyrics)

**Commands:** `.music`, `.song`, `.spotify`, `.lyrics`

**Description:** Search for music on iTunes/Spotify and get song lyrics.

**Usage:**
```
.music <song name>        # Search music
.spotify <song name>      # Search on Spotify
.lyrics <artist - song>   # Get lyrics
```

**Examples:**
```
.music Shape of You
.spotify Bohemian Rhapsody
.lyrics Ed Sheeran - Shape of You
.lyrics Queen - Bohemian Rhapsody
```

**Requires (optional):**
- `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` for Spotify search

---

## 🔔 Plugin 13: Smart Notifications (notify)

**Commands:** `.notify`, `.alert`, `.watch`

**Description:** Get notified when specific keywords are mentioned in any chat.

**Usage:**
```
.notify add <keyword>     # Add keyword to watch
.notify list              # Show all keywords
.notify remove <keyword>  # Stop watching keyword
.notify on/off            # Enable/disable notifications
.notify clear             # Clear all keywords
```

**Examples:**
```
.notify add important
.notify add urgent
.notify list
.notify remove important
.notify off
```

**Features:**
- Cross-chat notifications
- Rate limiting (max 1 notification per keyword per 5 minutes)
- Private notification delivery

---

## 🎨 Multimodal Support

All plugins are designed with multimodal support in mind:

### Enhanced Message.js Methods

New methods added to the Message class:

```javascript
// Send various media types
message.sendDocument(buffer, options)
message.sendVoice(buffer, options)
message.sendPoll(question, options)
message.sendLocation(lat, lon, caption)
message.sendContact(contacts)

// Media information
message.getMediaType()           // Returns: image, video, audio, document, sticker
message.hasMediaType(type)       // Check specific media type
message.getMediaExtension()      // Get file extension
```

### Media Processing Utilities

New utilities in `lib/utils/media.js`:

```javascript
const media = require('./lib/utils/media');

// Image processing
await media.convertImage(buffer, 'png')
await media.resizeImage(buffer, width, height)
await media.compressImage(buffer, quality)
await media.createThumbnail(buffer, size)
await media.getImageMetadata(buffer)

// Video/Audio processing
await media.videoToAudio(buffer, 'mp3')
await media.convertAudio(buffer, 'mp3')
await media.getVideoDuration(buffer)
await media.trimVideo(buffer, startTime, duration)

// File detection
await media.getFileType(buffer)
```

---

## 🔑 API Keys Configuration

Add these to your `config.env` file:

```env
# Core AI
OPENAI_API_KEY=your_openai_key
GEMINI_API_KEY=your_gemini_key

# Weather
WEATHER_API_KEY=your_weatherapi_key

# Images
UNSPLASH_API_KEY=your_unsplash_key
GIPHY_API_KEY=your_giphy_key  # Optional

# News & Finance
NEWS_API_KEY=your_newsapi_key
ALPHA_VANTAGE_KEY=your_alphavantage_key

# Music
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
```

### Where to Get API Keys

1. **OpenAI:** [platform.openai.com](https://platform.openai.com/api-keys)
2. **Gemini:** [makersuite.google.com](https://makersuite.google.com/app/apikey)
3. **Weather:** [weatherapi.com](https://www.weatherapi.com/signup.aspx) (Free tier: 1M calls/month)
4. **Unsplash:** [unsplash.com/developers](https://unsplash.com/developers) (Free: 50 requests/hour)
5. **Giphy:** [developers.giphy.com](https://developers.giphy.com/) (Free tier available)
6. **News:** [newsapi.org](https://newsapi.org/register) (Free: 100 requests/day)
7. **Alpha Vantage:** [alphavantage.co/support/#api-key](https://www.alphavantage.co/support/#api-key) (Free: 25 requests/day)
8. **Spotify:** [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) (Free tier available)

---

## 📝 Notes

- Most plugins work in both private and group chats unless marked as "Group-only"
- Some plugins require API keys to function (marked with "Requires:")
- All plugins support multiple languages (translations in `lang/*.json`)
- Plugins automatically handle errors with user-friendly messages
- Rate limiting and resource cleanup are handled automatically

---

## 🚀 Usage Tips

1. **Start with free APIs:** Many plugins work with free API tiers
2. **Test in private first:** Test new commands in private chat before using in groups
3. **Check API limits:** Monitor your API usage to stay within free tiers
4. **Use multimodal features:** Try replying to images, videos, and audio with commands
5. **Set up notifications:** Use `.notify` to get alerts for important keywords

---

## 🛠️ Development

All plugins follow the standard OpenWhatsappBot plugin structure:

```javascript
module.exports = {
  command: {
    pattern: "command|alias",
    desc: getLang("plugins.plugin.desc"),
    type: "category",
  },
  async execute(message, query) {
    // Plugin logic
  }
};
```

For detailed plugin development guidelines, see the agent instructions in the repository.

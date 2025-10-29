const { Innertube } = require('youtubei.js')

/**
 * YouTube Download command - Download videos/audio from YouTube
 */
module.exports = {
  command: {
    pattern: 'ytdl|ytv|yta',
    desc: 'Download YouTube video or audio',
    type: 'download'
  },
  
  async execute(message, query) {
    if (!query) {
      return await message.reply('❌ Please provide a YouTube URL\n\nExample: .ytdl https://youtube.com/watch?v=...')
    }
    
    try {
      await message.react('⏳')
      
      const isAudio = message.body.toLowerCase().startsWith('.yta')
      
      const youtube = await Innertube.create()
      
      // Extract video ID from URL
      let videoId
      try {
        const url = new URL(query)
        videoId = url.searchParams.get('v') || url.pathname.split('/').pop()
      } catch {
        videoId = query
      }
      
      const info = await youtube.getInfo(videoId)
      
      if (!info) {
        await message.react('❌')
        return await message.reply('❌ Failed to get video information')
      }
      
      const title = info.basic_info.title
      const duration = info.basic_info.duration
      const thumbnail = info.basic_info.thumbnail?.[0]?.url
      
      await message.reply(`📥 *Downloading...*\n\n*Title:* ${title}\n*Duration:* ${duration}s\n*Type:* ${isAudio ? 'Audio' : 'Video'}`)
      
      // Download
      const format = isAudio 
        ? info.chooseFormat({ type: 'audio', quality: 'best' })
        : info.chooseFormat({ type: 'video+audio', quality: 'best', format: 'mp4' })
      
      if (!format) {
        await message.react('❌')
        return await message.reply('❌ No suitable format found')
      }
      
      const stream = await format.download()
      const chunks = []
      
      for await (const chunk of stream) {
        chunks.push(chunk)
      }
      
      const buffer = Buffer.concat(chunks)
      
      // Check size limit (200MB default)
      const sizeMB = buffer.length / 1024 / 1024
      if (sizeMB > 200) {
        await message.react('❌')
        return await message.reply(`❌ File too large: ${sizeMB.toFixed(2)}MB (Max: 200MB)`)
      }
      
      // Send file
      if (isAudio) {
        await message.sendAudio(buffer, {
          mimetype: 'audio/mp4',
          fileName: `${title}.mp3`
        })
      } else {
        await message.sendVideo(buffer, title, {
          mimetype: 'video/mp4',
          fileName: `${title}.mp4`
        })
      }
      
      await message.react('✅')
      
    } catch (error) {
      await message.react('❌')
      console.error('YouTube download error:', error)
      await message.reply(`❌ Error: ${error.message}`)
    }
  }
}

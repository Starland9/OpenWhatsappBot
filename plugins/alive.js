const config = require('../config')
const os = require('os')

/**
 * Alive command - Show bot status
 */
module.exports = {
  command: {
    pattern: 'alive',
    desc: 'Check if bot is alive',
    type: 'general'
  },
  
  async execute(message) {
    const uptime = process.uptime()
    const hours = Math.floor(uptime / 3600)
    const minutes = Math.floor((uptime % 3600) / 60)
    const seconds = Math.floor(uptime % 60)
    
    const memoryUsage = process.memoryUsage()
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem
    
    const status = `╭━━━『 *BOT STATUS* 』━━━
│
│ *Version:* ${config.VERSION}
│ *Uptime:* ${hours}h ${minutes}m ${seconds}s
│ *Memory:* ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB / ${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)}MB
│ *System:* ${(usedMem / 1024 / 1024 / 1024).toFixed(2)}GB / ${(totalMem / 1024 / 1024 / 1024).toFixed(2)}GB
│ *Platform:* ${os.platform()}
│ *Node:* ${process.version}
│
╰━━━━━━━━━━━━━━━━━━━

✅ *Bot is alive and running!*`
    
    await message.reply(status)
  }
}

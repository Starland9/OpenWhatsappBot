/**
 * Kick command - Remove member from group
 */
module.exports = {
  command: {
    pattern: 'kick',
    desc: 'Remove member from group',
    type: 'group',
    onlyGroup: true
  },
  
  async execute(message) {
    if (!message.isGroup) {
      return await message.reply('❌ This command can only be used in groups')
    }
    
    // Check if sender is admin
    const isSenderAdmin = await message.isSenderAdmin()
    if (!isSenderAdmin && !message.isSudo()) {
      return await message.reply('❌ Only group admins can use this command')
    }
    
    // Check if bot is admin
    const isBotAdmin = await message.isBotAdmin()
    if (!isBotAdmin) {
      return await message.reply('❌ Bot must be admin to kick members')
    }
    
    // Get target user from mentions or quoted message
    let target
    
    if (message.mentions && message.mentions.length > 0) {
      target = message.mentions[0]
    } else if (message.quoted) {
      target = message.quoted.sender
    } else {
      return await message.reply('❌ Please mention a user or reply to their message')
    }
    
    try {
      await message.kick(target)
      await message.reply(`✅ Kicked @${target.split('@')[0]}`, {
        mentions: [target]
      })
    } catch (error) {
      console.error('Kick error:', error)
      await message.reply(`❌ Failed to kick: ${error.message}`)
    }
  }
}

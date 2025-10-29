/**
 * Tag command - Tag all group members
 */
module.exports = {
  command: {
    pattern: 'tag|tagall',
    desc: 'Tag all group members',
    type: 'group',
    onlyGroup: true
  },
  
  async execute(message, text) {
    if (!message.isGroup) {
      return await message.reply('❌ This command can only be used in groups')
    }
    
    // Check if sender is admin
    const isSenderAdmin = await message.isSenderAdmin()
    if (!isSenderAdmin && !message.isSudo()) {
      return await message.reply('❌ Only group admins can use this command')
    }
    
    try {
      const metadata = await message.getGroupMetadata()
      
      if (!metadata) {
        return await message.reply('❌ Failed to get group information')
      }
      
      const participants = metadata.participants.map(p => p.id)
      const messageText = text || '📢 *Group Tag*'
      
      await message.client.getSocket().sendMessage(message.jid, {
        text: `${messageText}\n\n`,
        mentions: participants
      })
      
    } catch (error) {
      console.error('Tag error:', error)
      await message.reply(`❌ Error: ${error.message}`)
    }
  }
}

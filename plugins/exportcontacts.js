const moment = require('moment')

/**
 * Export contacts plugin
 * Usage:
 *  .exportcontacts         -> export as CSV (default)
 *  .exportcontacts csv     -> explicit csv
 *  .exportcontacts vcf     -> export as vCard (.vcf)
 * Restricted to bot owner (sudo)
 */

module.exports = {
  command: {
    pattern: 'exportcontacts|contacts',
    desc: 'Exporter la liste des contacts en CSV/VCF',
    type: 'utility',
    ownerOnly: true,
  },

  async execute(message, argsString) {
    try {
      // Allow only sudo users
      if (!message.isSudo()) {
        return await message.reply('❌ Commande réservée au propriétaire du bot')
      }

      await message.react('⏳')

      // Determine export format
      const format = (argsString || 'csv').trim().toLowerCase()
      if (!['csv', 'vcf'].includes(format)) {
        return await message.reply(
          '❌ Format invalide - utilisez `csv` ou `vcf` (e.g., `.exportcontacts vcf`)'
        )
      }

      const client = message.client
      const socket = client.getSocket()
      // Check for group export request
      const args = (argsString || '').trim().split(/\s+/).filter(Boolean);
      const isGroupExport = args[0] && args[0].toLowerCase() === 'group';

      // If group export requested, attempt to fetch group members
      if (isGroupExport) {
        // If no group id provided, and executed inside a group, use current group
        let groupJid = args[1] || null
        if (!groupJid && message.isGroup) {
          groupJid = message.jid
        }

        if (!groupJid) {
          return await message.reply('❌ Indiquez le group JID ou invoquez la commande depuis le groupe (ex: `.exportcontacts group`)')
        }

        try {
          const metadata = await client.getSocket().groupMetadata(groupJid)
          const participants = metadata?.participants || []
          if (participants.length === 0) {
            return await message.reply('❌ Aucun participant trouvé dans ce groupe')
          }

          // Map to contacts-like objects
          const groupContacts = participants.map((p) => ({
            jid: p.id,
            displayName: p.notify || p.subject || '',
            isAdmin: !!p.admin,
          }))

          contacts = groupContacts
        } catch (err) {
          console.error('Group export error:', err)
          return await message.reply(`❌ Impossible de récupérer les infos du groupe: ${err.message}`)
        }
      }

      // Attempt to read contacts from store (only when not group export)
      let contacts = []
      if (!isGroupExport) {

      // Preferred: in-memory store used by the client
      if (client.store && client.store.contacts) {
        const storeContacts = client.store.contacts
        if (typeof storeContacts === 'object') {
          // Possibly Map-like or plain object
          if (typeof storeContacts.entries === 'function') {
            contacts = Array.from(storeContacts.values())
          } else {
            contacts = Object.values(storeContacts)
          }
        }
      }

      // Fallback: socket has contacts (Baileys 5/6 )
      if ((!contacts || contacts.length === 0) && socket && socket.contacts) {
        contacts = Object.values(socket.contacts || {})
      }

      if (!contacts || contacts.length === 0) {
        return await message.reply('❌ Aucune donnée de contacts disponible (le store est vide)')
      }

      // Normalize list & filter out groups/broadcast
      contacts = contacts
        .map((c) => {
          // Support both Map value and direct objects
          const jid = c.id || c.jid || c.key || c?.key?.remoteJid || ''
          const displayName = c.name || c.notify || c.vname || c.short || c.verifiedName || ''
          const imgUrl = c.imgUrl || c.picture || ''
          const isBusiness = c?.isBusiness || c?.isBusinessAccount || false
          const status = c?.status || c?.about || ''
          return { ...c, jid, displayName, imgUrl, isBusiness, status }
        })
        .filter((c) => c.jid && !c.jid.endsWith('@g.us') && c.jid !== 'status@broadcast')

      if (contacts.length === 0) {
        return await message.reply('❌ Aucun contact trouvé (excluant les groupes)')
      }
      }

      // Build CSV or vCard
      const timestamp = moment().format('YYYYMMDD-HHmmss')
      if (format === 'csv') {
        const header = ['jid', 'number', 'displayName', 'notify', 'short', 'imgUrl', 'isBusiness', 'status']
        const rows = [header.join(',')]

        const escape = (v) => {
          if (v === null || v === undefined) return ''
          const s = String(v)
          // Escape double quotes
          const escaped = s.replace(/\"/g, '""')
          // Wrap in quotes if contains comma, newline, or quotes
          if (/[",\n]/.test(escaped)) {
            return '"' + escaped.replace(/"/g, '""') + '"'
          }
          return escaped
        }

        for (const c of contacts) {
          const number = c.jid.split('@')[0]
          const row = [
            escape(c.jid),
            escape(number),
            escape(c.displayName || ''),
            escape(c.notify || ''),
            escape(c.short || ''),
            escape(c.imgUrl || ''),
            escape(c.isBusiness ? 'TRUE' : 'FALSE'),
            escape(c.status || ''),
          ]
          rows.push(row.join(','))
        }

        const csvContent = rows.join('\n')
        const buffer = Buffer.from(csvContent)

        await message.sendDocument(buffer, {
          fileName: `contacts-${timestamp}.csv`,
          mimetype: 'text/csv',
          caption: `📥 Export des contacts (${contacts.length})`,
        })
        await message.react('✅')
      } else {
        // vCard
        const lines = []
        for (const c of contacts) {
          const number = c.jid.split('@')[0]
          const name = c.displayName || number
          lines.push('BEGIN:VCARD')
          lines.push('VERSION:3.0')
          // Escape commas and semicolons in name
          const safeName = String(name).replace(/[,;]/g, ' ')
          lines.push(`FN:${safeName}`)
          // Add number
          lines.push(`TEL;TYPE=CELL:${number}`)
          if (c.status) {
            const safeStatus = String(c.status).replace(/\n/g, ' ')
            lines.push(`NOTE:${safeStatus}`)
          }
          if (c.imgUrl) {
            lines.push(`URL:${c.imgUrl}`)
          }
          lines.push('END:VCARD')
        }

        const vcfContent = lines.join('\n')
        const buffer = Buffer.from(vcfContent)

        await message.sendDocument(buffer, {
          fileName: `contacts-${timestamp}.vcf`,
          mimetype: 'text/vcard',
          caption: `📥 Export des contacts (${contacts.length})`,
        })
        await message.react('✅')
      }
    } catch (error) {
      console.error('ExportContacts error:', error)
      await message.reply(`❌ Erreur: ${error.message}`)
      await message.react('❌')
    }
  },
}

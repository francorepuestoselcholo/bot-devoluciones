import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@adiwajshing/baileys'
import express from 'express'
import { google } from 'googleapis'
import fs from 'fs'

const app = express()
app.use(express.json())

app.get('/', (req, res) => res.send('🤖 Bot de Devoluciones activo'))

const startBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const sock = makeWASocket({ auth: state })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) startBot()
    } else if (connection === 'open') {
      console.log('✅ Bot conectado a WhatsApp')
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''

    if (text.toLowerCase() === 'hola') {
      await sock.sendMessage(from, { text: '👋 ¡Hola! Soy el *Bot de Devoluciones*. Escribí "menu" para ver las opciones.' })
    } else if (text.toLowerCase() === 'menu') {
      await sock.sendMessage(from, { text: '1️⃣ Registrar nueva devolución\n2️⃣ Consultar devoluciones\n3️⃣ Ver estado\n4️⃣ Ver proveedores\n\nSeleccioná una opción:' })
    }
  })
}

startBot()
app.listen(3000, () => console.log('Servidor escuchando en puerto 3000'))

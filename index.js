import express from "express";
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import qrcode from "qrcode";

const app = express();
const PORT = process.env.PORT || 10000;

let lastQR = null;

app.get("/", (req, res) => {
  res.send(`
    <h2>🤖 Bot de devoluciones activo</h2>
    <p>${lastQR ? `<img src="${lastQR}" width="250" />` : "Esperando código QR..."}</p>
    <meta http-equiv="refresh" content="10">
  `);
});

app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));

async function startBot() {
  console.log("Iniciando conexión con WhatsApp...");

  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update;

    if (qr) {
      console.log("📱 Se generó un nuevo código QR");
      lastQR = await qrcode.toDataURL(qr);
    }

    if (connection === "close") {
      console.log("❌ Conexión cerrada, intentando reconectar...");
      startBot();
    } else if (connection === "open") {
      console.log("✅ Conexión establecida con WhatsApp");
      lastQR = null;
    }
  });
}

startBot();

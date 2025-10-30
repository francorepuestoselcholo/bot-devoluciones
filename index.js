import express from "express";
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import qrcode from "qrcode";

const app = express();
const PORT = process.env.PORT || 10000;

let lastQR = null;

app.get("/", (req, res) => {
  res.send(`
    <h2>🤖 Bot de devoluciones activo</h2>
    ${
      lastQR
        ? `
        <p>Escaneá este código QR para vincular WhatsApp:</p>
        <img src="${lastQR}" width="250" />
        <p><a href="${lastQR}" target="_blank">🔗 Abrir QR en nueva pestaña</a></p>
      `
        : "<p>Esperando código QR...</p>"
    }
    <meta http-equiv="refresh" content="10">
  `);
});

app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));

async function startBot() {
  console.log("Iniciando conexión con WhatsApp...");

  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update;

    if (qr) {
      console.log("📱 Se generó un nuevo código QR");
      lastQR = await qrcode.toDataURL(qr);
      console.log("🌐 URL QR:", lastQR.substring(0, 80) + "..."); // muestra parte del enlace
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

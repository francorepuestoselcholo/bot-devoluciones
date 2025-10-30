import express from "express";
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import qrcode from "qrcode";

const app = express();
const PORT = process.env.PORT || 10000;

let lastQR = null;
let connectionStatus = "waiting_qr"; // "waiting_qr", "connected", "reconnecting"

// Página principal (vista web del QR)
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

// 🆕 Endpoint /qr → Devuelve solo la imagen PNG
app.get("/qr", async (req, res) => {
  if (!lastQR) {
    res.status(404).send("Esperando código QR...");
  } else {
    const base64Data = lastQR.replace(/^data:image\/png;base64,/, "");
    const img = Buffer.from(base64Data, "base64");
    res.writeHead(200, {
      "Content-Type": "image/png",
      "Content-Length": img.length
    });
    res.end(img);
  }
});

// 🆕 Endpoint /status → Devuelve el estado actual del bot
app.get("/status", (req, res) => {
  let message;
  if (connectionStatus === "connected") {
    message = "✅ Bot conectado a WhatsApp";
  } else if (connectionStatus === "reconnecting") {
    message = "♻️ Intentando reconexión...";
  } else {
    message = "📱 Esperando que escanees el código QR";
  }

  res.json({
    status: connectionStatus,
    message
  });
});

app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));

// 🚀 Inicializa la conexión con WhatsApp
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
      connectionStatus = "waiting_qr";
      lastQR = await qrcode.toDataURL(qr);
      console.log("🌐 QR actualizado, visible en / y /qr");
    }

    if (connection === "close") {
      console.log("❌ Conexión cerrada, intentando reconectar...");
      connectionStatus = "reconnecting";
      startBot();
    } else if (connection === "open") {
      console.log("✅ Conexión establecida con WhatsApp");
      connectionStatus = "connected";
      lastQR = null;
    }
  });
}

startBot();

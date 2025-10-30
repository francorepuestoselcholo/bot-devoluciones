import express from "express";
import * as baileys from "@adiwajshing/baileys";
import qrcode from "qrcode";

const lib = baileys.default || baileys;
const makeWASocket = lib.makeWASocket || lib.default?.makeWASocket;
const useMultiFileAuthState = lib.useMultiFileAuthState || lib.default?.useMultiFileAuthState;

const app = express();
const PORT = process.env.PORT || 10000;

let lastQR = null;

app.get("/", (req, res) => {
  res.send(`<h2>🤖 Bot de devoluciones activo</h2>
  <p>${lastQR ? `<img src="${lastQR}" width="250" />` : "Esperando código QR..."}</p>`);
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
      // Genera la imagen del QR para mostrarla en la web
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

startBot();import express from "express";
import baileys from "@adiwajshing/baileys";

const { default: makeWASocket, useMultiFileAuthState } = baileys;


// --- Servidor web ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => res.send("Bot de devoluciones activo ✅"));
app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));

// --- Bot de WhatsApp ---
async function startBot() {
  console.log("Iniciando conexión con WhatsApp...");

  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      console.log("❌ Conexión cerrada, intentando reconectar...");
      startBot();
    } else if (connection === "open") {
      console.log("✅ Conexión establecida con WhatsApp");
    }
  });
}

startBot();

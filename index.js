import express from "express";
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

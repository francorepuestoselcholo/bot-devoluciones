import express from "express";
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import qrcode from "qrcode";

const app = express();
const PORT = process.env.PORT || 10000;

let lastQR = null;
let status = "iniciando";

// Página principal
app.get("/", (req, res) => {
  res.send(`
    <h2>🤖 Bot de devoluciones activo</h2>
    <p>Estado: <b>${status}</b></p>
    ${
      lastQR
        ? `<img src="${lastQR}" width="250" alt="QR de WhatsApp"/><p>Escaneá este código desde WhatsApp → Dispositivos vinculados</p>`
        : "<p>Esperando generación de código QR...</p>"
    }
    <meta http-equiv="refresh" content="10">
  `);
});

// Endpoint para ver solo el QR (directo)
app.get("/qr", (req, res) => {
  if (!lastQR) return res.status(404).send("QR no disponible todavía");
  const base64Data = lastQR.replace(/^data:image\/png;base64,/, "");
  const img = Buffer.from(base64Data, "base64");
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": img.length,
  });
  res.end(img);
});

// Endpoint de estado JSON
app.get("/status", (req, res) => {
  res.json({ status });
});

app.listen(PORT, () =>
  console.log(`✅ Servidor escuchando en puerto ${PORT}`)
);

async function startBot() {
  console.log("Iniciando conexión con WhatsApp...");

  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // desactivado, lo manejamos con la web
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update;

    if (qr) {
      console.log("📱 Se generó un nuevo código QR");
      status = "esperando_qr";
      lastQR = await qrcode.toDataURL(qr);
    }

    if (connection === "close") {
      console.log("❌ Conexión cerrada, intentando reconectar...");
      status = "reconectando";
      startBot();
    } else if (connection === "open") {
      console.log("✅ Conectado correctamente a WhatsApp");
      status = "conectado";
      lastQR = null;
    }
  });
}

startBot();

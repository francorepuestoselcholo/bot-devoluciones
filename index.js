import express from "express";
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import qrcode from "qrcode";

const app = express();
const PORT = process.env.PORT || 10000;

let lastQR = null;
let connectionStatus = "waiting_qr"; // waiting_qr, connected, reconnecting

// Página principal con QR dinámico y botón de descarga
app.get("/", (req, res) => {
  res.send(`
    <h2>🤖 Bot de devoluciones activo</h2>
    <div id="qr-container">
      <p>Esperando código QR...</p>
    </div>
    <p>Estado del bot: <span id="status">${connectionStatus}</span></p>
    <p id="download-container"></p>

    <script>
      async function fetchQR() {
        try {
          const resp = await fetch('/qr-status');
          const data = await resp.json();
          const container = document.getElementById('qr-container');
          const statusElem = document.getElementById('status');
          const downloadContainer = document.getElementById('download-container');

          statusElem.textContent = data.status;

          if (data.qr) {
            container.innerHTML = '<img id="qr-image" src="' + data.qr + '" width="250" />';
            downloadContainer.innerHTML = '<a id="download-btn" href="' + data.qr + '" download="QR_WA.png">💾 Descargar QR</a>';
          } else {
            container.innerHTML = "<p>Esperando código QR...</p>";
            downloadContainer.innerHTML = "";
          }
        } catch (err) {
          console.error(err);
        }
      }

      setInterval(fetchQR, 2000); // actualiza cada 2 segundos
      fetchQR();
    </script>
  `);
});

// Endpoint /qr – devuelve la imagen PNG pura
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

// Endpoint /status – devuelve JSON con estado
app.get("/status", (req, res) => {
  let message;
  if (connectionStatus === "connected") message = "✅ Bot conectado a WhatsApp";
  else if (connectionStatus === "reconnecting") message = "♻️ Intentando reconexión...";
  else message = "📱 Esperando que escanees el código QR";

  res.json({ status: connectionStatus, message });
});

// Endpoint /qr-status – QR + estado para la página dinámica
app.get("/qr-status", (req, res) => {
  res.json({
    qr: lastQR,
    status: connectionStatus
  });
});

app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));

// Inicialización del bot
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
      console.log("🌐 QR actualizado – revisá /, /qr y el botón Descargar QR");
    }

    if (connection === "close") {
      console.log("❌ Conexión cerrada, intentando reconectar...");
      connectionStatus = "reconnecting";
      setTimeout(startBot, 5000); // Reconexión automática
    } else if (connection === "open") {
      console.log("✅ Conexión establecida con WhatsApp");
      connectionStatus = "connected";
      lastQR = null;
    }
  });
}

startBot();

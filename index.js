import express from "express";
import { promises as fs } from "fs";
import makeWASocket, { 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion,
    DisconnectReason,
    delay
} from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import P from "pino"; // Usamos pino para logs avanzados de Baileys

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_FILE = 'logs.txt';

// Configuración del dueño del bot (¡DEBES CAMBIAR ESTO!)
// Formato: 54911xxxxxxxx@s.whatsapp.net (incluye código de país y código de área)
const OWNER_NUMBER_JID = "5492914193006@s.whatsapp.net";

// Variables de estado global
let lastQR = null;
let status = "iniciando";
let socket = null; // Referencia global al socket de Baileys

/**
 * Función auxiliar para guardar logs en un archivo local.
 * @param {string} message Mensaje a registrar.
 */
async function appendLog(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    try {
        await fs.appendFile(LOG_FILE, logEntry, 'utf8');
    } catch (e) {
        console.error('Error al guardar log:', e);
    }
}

// --- CONFIGURACIÓN DEL SERVIDOR EXPRESS ---

// Endpoint: Página principal con estado y QR
app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Bot de Repuestos El Cholo</title>
            <meta http-equiv="refresh" content="10">
            <style>
                body { font-family: sans-serif; text-align: center; padding: 20px; background-color: #f7f7f7; }
                .status-box { padding: 10px; border-radius: 8px; margin: 20px auto; max-width: 400px; }
                .status-conectado { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
                .status-qr { background-color: #fff3cd; color: #856404; border: 1px solid #ffeeba; }
                .status-reconectando { background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
                img { border: 5px solid #fff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            </style>
        </head>
        <body>
            <h2>🤖 Bot de Devoluciones de Repuestos El Cholo</h2>
            ${
                status === "conectado"
                ? `<div class="status-box status-conectado">✅ Estado: <b>Conectado</b>. Bot activo.</div>`
                : status === "esperando_qr"
                ? `<div class="status-box status-qr">⏳ Estado: <b>Esperando QR</b>. Escanee abajo.</div>`
                : `<div class="status-box status-reconectando">❌ Estado: <b>${status}</b>. Intentando conectar...</div>`
            }

            ${
                lastQR
                ? `
                    <p>Escaneá este código desde WhatsApp → **Dispositivos Vinculados**</p>
                    <img src="${lastQR}" width="250" alt="Código QR de WhatsApp"/>
                    <p><small>Esta página se actualizará automáticamente.</small></p>
                `
                : status !== "conectado" ? "<p>Esperando generación de código QR...</p>" : ""
            }
        </body>
        </html>
    `);
});

// Endpoint: Devuelve solo la imagen del QR
app.get("/qr", (req, res) => {
    if (!lastQR) {
        return res.status(404).send("QR no disponible todavía");
    }
    // La expresión regular /^data:image\/png;base64,/ es segura y correcta para este caso.
    const base64Data = lastQR.replace(/^data:image\/png;base64,/, "");
    const img = Buffer.from(base64Data, "base64");
    res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": img.length,
    });
    res.end(img);
});

// Endpoint: Estado en formato JSON
app.get("/status", (req, res) => {
    res.json({ status });
});

app.listen(PORT, () =>
    console.log(`✅ Servidor Express escuchando en http://localhost:${PORT} (o puerto ${PORT} de Render)`)
);

// --- LÓGICA DEL BOT DE WHATSAPP CON BAILEYS ---

async function startBot() {
    console.log("\nIniciando conexión con WhatsApp (Repuestos El Cholo)...");

    // 1. Manejo de estado de autenticación (persistencia)
    const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
    const { version } = await fetchLatestBaileysVersion();
    
    console.log(`Versión de Baileys: ${version.join(".")}`);

    socket = makeWASocket({
        auth: state,
        logger: P({ level: "error" }), // Logger para reducir el ruido en consola
        printQRInTerminal: false, // El QR se muestra en la web
        browser: ["Repuestos El Cholo Bot", "Chrome", "22.04.4"],
        version,
        shouldSyncHistory: (c) => true, // Sincronizar historial para mejor UX
    });

    // 2. Evento para guardar credenciales (sesión)
    socket.ev.on("creds.update", saveCreds);

    // 3. Evento de conexión y reconexión
    socket.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("📱 Se generó un nuevo código QR. Escanealo en la web.");
            status = "esperando_qr";
            // Generar el Data URL del QR para mostrarlo en la web
            qrcode.toDataURL(qr)
                .then(url => {
                    lastQR = url;
                })
                .catch(err => console.error("Error al generar QR:", err));
        }

        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            
            console.log("❌ Conexión cerrada. Razón:", lastDisconnect.error?.output?.statusCode, shouldReconnect ? 'Intentando reconectar...' : 'Sesión cerrada, elimine auth_info y reinicie.');
            appendLog(`Conexión cerrada. Razón: ${lastDisconnect.error?.output?.statusCode}. Reintentando: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                status = "reconectando";
                // Espera un momento antes de reintentar para evitar spam
                delay(5000); 
                startBot();
            } else {
                status = "desconectado_permanente";
                lastQR = null;
            }

        } else if (connection === "open") {
            console.log("✅ Conectado correctamente a WhatsApp. Bot de Repuestos El Cholo activo.");
            status = "conectado";
            lastQR = null; // Limpiar QR una vez conectado
        }
    });
    
    // 4. Lógica de mensajes del bot
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        
        // Ignorar mensajes sin contenido, de estado o del bot mismo.
        if (!m.message || m.key.fromMe || m.key.remoteJid === 'status@broadcast') return;

        const from = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
        const lowerText = text.toLowerCase().trim();

        console.log(`[MSG] Recibido de ${from}: "${text.substring(0, 30)}..."`);
        
        // a) Guardar log del mensaje
        await appendLog(`Mensaje recibido de ${from}: "${text}"`);
        
        // b) Respuestas automáticas
        let responseText = '';

        if (lowerText === 'hola') {
            responseText = '👋 Hola, soy el asistente de devoluciones de Repuestos El Cholo. ¿En qué puedo ayudarte?';
        } else if (lowerText.includes('devolución') || lowerText.includes('devolucion')) {
            responseText = '📦 Para iniciar una devolución, por favor envíanos una foto del repuesto y el número de factura.';
        }

        if (responseText) {
            await socket.sendMessage(from, { text: responseText });
            console.log(`[BOT] Respuesta enviada a ${from}.`);
        }

        // c) Notificación al dueño
        if (OWNER_NUMBER_JID && from !== OWNER_NUMBER_JID) {
            await socket.sendMessage(OWNER_NUMBER_JID, { 
                text: `🔔 *Nuevo Mensaje de Cliente*\n\nDe: ${from}\nMensaje: "${text}"` 
            });
            console.log(`[NOTIF] Notificación enviada al dueño.`);
        }
    });

    return socket;
}

// Iniciar el bot
startBot();

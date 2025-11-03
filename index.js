import { promises as fs } from "fs";
import { Telegraf } from "telegraf";
import express from "express";

// --- CONFIGURACIÓN CRÍTICA: LECTURA DE VARIABLES DE ENTORNO ---
// Render inyectará estos valores automáticamente.
const BOT_TOKEN = process.env.BOT_TOKEN; 
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID; 

// Verificación obligatoria de credenciales
if (!BOT_TOKEN) {
    throw new Error("FATAL: BOT_TOKEN no está definido en las variables de entorno.");
}
if (!OWNER_CHAT_ID) {
    console.warn("ADVERTENCIA: OWNER_CHAT_ID no está definido. El bot funcionará, pero no enviará notificaciones al dueño.");
}

const LOG_FILE = 'logs.txt';
// Usamos process.env.PORT, que Render define automáticamente
const PORT = process.env.PORT || 3000; 

// Inicialización del bot
const bot = new Telegraf(BOT_TOKEN);

// Inicialización de Express (para mantener el servicio de Render vivo)
const app = express();
let botStatus = "iniciando";

/**
 * Función auxiliar para guardar logs en un archivo local.
 * @param {string} message Mensaje a registrar.
 */
async function appendLog(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}\n`;
    try {
        // En Render, los archivos persistirán temporalmente en el disco,
        // pero se borrarán en el próximo despliegue, lo cual es típico para logs.
        await fs.appendFile(LOG_FILE, logEntry, 'utf8');
    } catch (e) {
        console.error('Error al guardar log:', e);
    }
}

// --- ENDPOINTS HTTP DE ESTADO (Para Render) ---

// Endpoint: Página principal con estado (no hay QR en Telegram)
app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Bot de Repuestos El Cholo (Telegram)</title>
            <meta http-equiv="refresh" content="10">
            <style>
                body { font-family: sans-serif; text-align: center; padding: 20px; background-color: #f7f7f7; }
                .status-box { padding: 10px; border-radius: 8px; margin: 20px auto; max-width: 400px; }
                .status-active { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            </style>
        </head>
        <body>
            <h2>🤖 Bot de Telegram de Repuestos El Cholo</h2>
            <div class="status-box status-active">✅ Estado: <b>${botStatus}</b>. El bot está escuchando.</div>
            <p>El bot de Telegram no necesita escanear QR.</p>
            <p>Comprueba los logs de Render para ver la actividad del bot.</p>
        </body>
        </html>
    `);
});

// Endpoint: Estado en formato JSON
app.get("/status", (req, res) => {
    res.json({ status: botStatus });
});

// Iniciar servidor Express
app.listen(PORT, () =>
    console.log(`✅ Servidor Express escuchando en puerto ${PORT}`)
);

// --- LÓGICA DEL BOT DE TELEGRAM ---

// 1. Manejo del comando /start o mensaje "hola"
bot.start((ctx) => {
    const welcomeMessage = "👋 Hola, soy el asistente de devoluciones de Repuestos El Cholo. ¿En qué puedo ayudarte?";
    ctx.reply(welcomeMessage);
    console.log(`[BOT] Respuesta de bienvenida enviada a chat ${ctx.chat.id}`);
});

// 2. Manejo de la palabra clave "devolución"
bot.hears(['devolucion', 'devolución'], (ctx) => {
    const returnInstructions = "📦 Para iniciar una devolución, por favor envíanos una foto del repuesto y el número de factura.";
    ctx.reply(returnInstructions);
    console.log(`[BOT] Instrucciones de devolución enviadas a chat ${ctx.chat.id}`);
});

// 3. Manejo de cualquier otro mensaje (el core del bot)
bot.on('text', async (ctx) => {
    const message = ctx.message.text;
    const chatId = ctx.chat.id;
    const sender = ctx.from.first_name || 'Cliente';

    console.log(`[MSG] Recibido de ${sender} (${chatId}): "${message.substring(0, 30)}..."`);
    
    // a) Guardar log del mensaje
    await appendLog(`Mensaje recibido de ${sender} (${chatId}): "${message}"`);

    // b) Notificación al dueño
    if (OWNER_CHAT_ID && String(chatId) !== OWNER_CHAT_ID) {
        const notificationText = `🔔 *Nuevo Mensaje de Cliente (Telegram)*\n\nDe: ${sender} (ID: \`${chatId}\`)\nMensaje: "${message}"`;
        try {
            // Usamos `bot.telegram.sendMessage` para enviar al ID del dueño
            await bot.telegram.sendMessage(OWNER_CHAT_ID, notificationText, { parse_mode: 'Markdown' });
            console.log(`[NOTIF] Notificación enviada al dueño.`);
        } catch (e) {
            console.error('Error al enviar notificación al dueño. Verifica el OWNER_CHAT_ID.', e.message);
        }
    }
});


// 4. Iniciar el bot y el Long Polling (método de conexión de Telegraf)
async function startTelegramBot() {
    try {
        await bot.launch();
        botStatus = "conectado";
        console.log("✅ Bot de Telegram (Repuestos El Cholo) iniciado. Escuchando mensajes...");
    } catch (error) {
        botStatus = "error";
        console.error("❌ Error al iniciar el bot de Telegram:", error.message);
    }
}

// Iniciar el bot de Telegram
startTelegramBot();

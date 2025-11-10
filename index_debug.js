// === BOT DEVOLUCIONES (DEBUG AVANZADO - CommonJS) ===
// Optimizado: asincronismo total + logs detallados + detección de retardos

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const PDFDocument = require('pdfkit');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');

dotenv.config();

// === CONFIGURACIÓN ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_FILE = './gen-lang-client-0104843305-3b7345de7ec0.json';
const GMAIL_USER = 'francorepuestoeslcholo@gmail.com';
const GMAIL_PASS = process.env.GMAIL_APP_PASS;
const PORT = process.env.PORT || 3000;
const LOGO_PATH = './REPUESTOS EL CHOLO LOGO.png';
const DRIVE_FOLDER_ID = '1ByMDQDSWku135s1SwForGtWvyl2gcRSM';
const LOG_FILE = 'logs.txt';

let sheetsClient = null;
let driveClient = null;
let sheetsInitialized = false;
let botStatus = 'iniciando';

// === HELPERS ===
async function log(msg, type = 'INFO') {
  const ts = new Date().toISOString();
  const text = `[${ts}] [${type}] ${msg}\n`;
  await fsp.appendFile(LOG_FILE, text).catch(() => {});
  console.log(text.trim());
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function measure(label, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - start;
    if (elapsed > 2000) await log(`⚠️ Acción lenta: ${label} (${elapsed}ms)`, 'WARN');
    else await log(`✅ ${label} completado (${elapsed}ms)`);
    return result;
  } catch (e) {
    await log(`❌ Error en ${label}: ${e.message}`, 'ERROR');
    console.error(e);
    throw e;
  }
}

// === INICIALIZACIÓN GOOGLE ===
async function initSheets() {
  await log('Inicializando Google Sheets...');
  try {
    const keyFileContent = await fsp.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8');
    const key = JSON.parse(keyFileContent);
    const privateKey = key.private_key.replace(/\\n/g, '\n');

    const jwt = new google.auth.JWT(key.client_email, null, privateKey, [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]);

    await jwt.authorize();
    sheetsClient = google.sheets({ version: 'v4', auth: jwt });
    driveClient = google.drive({ version: 'v3', auth: jwt });
    sheetsInitialized = true;
    await log('✅ Google API inicializado correctamente');
  } catch (e) {
    await log(`Fallo en initSheets: ${e.message}`, 'ERROR');
  }
}

async function ensureLocalFolders() {
  const base = path.join(__dirname, 'tickets');
  const remitentes = ['ElCholo', 'Ramirez', 'Tejada'];
  for (const r of remitentes) {
    const dir = path.join(base, r);
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
  }
  await log('📁 Carpetas locales aseguradas');
}

// === PDF ===
async function generateTicketPDF(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const RED = '#C8102E';
      const BLUE = '#0B3B70';
      try {
        const logo = fs.readFileSync(LOGO_PATH);
        doc.image(logo, 40, 40, { width: 120 });
      } catch {
        doc.fillColor(RED).fontSize(10).text('REPUESTOS EL CHOLO (Logo faltante)', 40, 40);
      }

      doc.fillColor(BLUE).fontSize(20).font('Helvetica-Bold').text('Ticket de Devolución', { align: 'right' });
      doc.moveDown(1);
      doc.fontSize(12).fillColor('black').text(`Fecha: ${new Date().toLocaleString()}`);
      doc.text(`Remitente: ${data.remitente}`);
      doc.text(`Proveedor: ${data.proveedor}`);
      doc.text(`Código: ${data.codigo}`);
      doc.text(`Descripción: ${data.descripcion}`);
      doc.text(`Cantidad: ${data.cantidad}`);
      doc.text(`Motivo: ${data.motivo}`);
      doc.text(`N° Remito/Factura: ${data.remito}`);
      doc.text(`Fecha factura: ${data.fechaFactura}`);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// === MAIL ===
async function sendMailWithPDF(buffer, filename, data) {
  await measure('Envío de correo', async () => {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_PASS }
    });

    const html = `
      <h2>Nuevo Ticket de Devolución</h2>
      <p>Remitente: <b>${data.remitente}</b></p>
      <p>Proveedor: <b>${data.proveedor}</b></p>
      <p>Motivo: ${data.motivo}</p>
      <p>Se adjunta el ticket en PDF.</p>`;

    await transporter.sendMail({
      from: `"Repuestos El Cholo" <${GMAIL_USER}>`,
      to: 'info@repuestoselcholo.com.ar',
      subject: `Nueva devolución registrada - ${data.proveedor}`,
      html,
      attachments: [{ filename, content: buffer }]
    });
  });
}

// === BOT ===
const bot = new Telegraf(BOT_TOKEN);
bot.use((new LocalSession({ database: 'session_db.json' })).middleware());

const mainKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('📦 Registrar devolución', 'registro')],
  [Markup.button.callback('🎟️ Ticket', 'ver_tickets')],
  [Markup.button.callback('🔍 Consultar devoluciones', 'consultar')],
  [Markup.button.callback('🏢 Ver proveedores', 'ver_proveedores')],
  [Markup.button.callback('➕ Agregar proveedor', 'agregar_proveedor')]
]);

const remitenteKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('1️⃣ El Cholo Repuestos (CUIT: 30716341026)', 'remitente_ElCholo')],
  [Markup.button.callback('2️⃣ Ramirez Cesar y Lois Gustavo S.H. (CUIT: 30711446806)', 'remitente_Ramirez')],
  [Markup.button.callback('3️⃣ Tejada Carlos y Gomez Juan S.H. (CUIT: 30709969699)', 'remitente_Tejada')],
  [Markup.button.callback('↩️ Volver', 'main')]
]);

bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  if (ms > 2000) await log(`⚠️ Acción lenta (${ms}ms): ${ctx.updateType}`, 'WARN');
});

bot.catch(async (err, ctx) => {
  await log(`💥 Error en update (${ctx.updateType}): ${err.message}`, 'ERROR');
});

// === COMMANDS ===
bot.start(async ctx => {
  await log(`Usuario ${ctx.from?.first_name} inició /start`);
  await ctx.reply('👋 ¡Hola! Soy el Bot de Devoluciones. ¿Qué querés hacer?', { reply_markup: mainKeyboard.reply_markup });
});

bot.command('help', async ctx => {
  const helpText = `
Comandos disponibles:
/start - Mostrar menú principal
/help - Mostrar esta ayuda
/generartickets - Generar PDF de devoluciones manuales`;
  await ctx.reply(helpText);
});

bot.action('main', async ctx => {
  try { await ctx.answerCbQuery(); } catch {}
  await ctx.reply('Menú principal:', { reply_markup: mainKeyboard.reply_markup });
});

// === FLUJO: TICKETS ===
bot.action('ver_tickets', async ctx => {
  try { await ctx.answerCbQuery(); } catch {}
  const remitentes = Markup.inlineKeyboard([
    [Markup.button.callback('El Cholo', 'tickets_ElCholo')],
    [Markup.button.callback('Tejada', 'tickets_Tejada')],
    [Markup.button.callback('Ramirez', 'tickets_Ramirez')],
    [Markup.button.callback('↩️ Volver', 'main')]
  ]);
  await ctx.reply('Seleccioná el remitente para ver sus tickets:', remitentes);
});

bot.action(/tickets_(.+)/, async ctx => {
  const remitente = ctx.match[1];
  await measure(`Listar tickets de ${remitente}`, async () => {
    const folder = path.join(__dirname, 'tickets', remitente);
    const exists = fs.existsSync(folder);
    if (!exists) return ctx.reply('No hay tickets disponibles.');
    const files = (await fsp.readdir(folder)).filter(f => f.endsWith('.pdf')).slice(-5).reverse();
    if (!files.length) return ctx.reply('No hay tickets disponibles.');
    await Promise.all(files.map(async f => ctx.replyWithDocument({ source: path.join(folder, f) })));
  });
  await ctx.reply('Menú principal:', { reply_markup: mainKeyboard.reply_markup });
});

// === EXPRESS SERVER ===
const app = express();
app.get('/', (req, res) => res.send('Bot de devoluciones activo.'));
app.listen(PORT, () => log(`Servidor Express escuchando en puerto ${PORT}`));

// === INICIO ===
(async () => {
  await ensureLocalFolders();
  await initSheets();
  await bot.launch();
  botStatus = 'conectado';
  await log('🤖 Bot de Telegram iniciado correctamente');
})();

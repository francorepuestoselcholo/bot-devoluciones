// === BOT DEVOLUCIONES - COMMONJS VERSION FINAL ===
// (Simplificado: sin teclado visual, Tickets limitados a 5, correcciones de texto)

const fs = require('fs');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const PDFDocument = require('pdfkit');
const { google } = require('googleapis');
const axios = require('axios');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const path = require('path');

dotenv.config();

// === CONFIG ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_FILE = './gen-lang-client-0104843305-3b7345de7ec0.json';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const PORT = process.env.PORT || 3000;
const LOG_FILE = 'logs.txt';
const LOGO_PATH = './REPUESTOS EL CHOLO LOGO.png';
const DRIVE_FOLDER_ID = '1ByMDQDSWku135s1SwForGtWvyl2gcRSM';
const GMAIL_USER = 'francorepuestoeslcholo@gmail.com';
const GMAIL_PASS = process.env.GMAIL_APP_PASS;

// === EXPRESS ===
const app = express();
let botStatus = 'iniciando';
let sheetsInitialized = false;
let sheetsClient = null;
let driveClient = null;

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

// === HELP ===
bot.command('help', async ctx => {
  const helpText = `
Comandos disponibles:
/start - Mostrar menú principal
/help - Mostrar esta ayuda
/generartickets - Generar PDF de todas las devoluciones manuales`;
  await ctx.reply(helpText);
});

// === FUNCIONES BASE ===
async function appendLog(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}
`);
}

async function initSheets() {
  console.log('Inicializando Google Sheets y Drive...');
  try {
    const keyFileContent = fs.readFileSync(GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8');
    const key = JSON.parse(keyFileContent);
    const privateKey = key.private_key.replace(/\n/g, '
');

    const jwt = new google.auth.JWT(key.client_email, null, privateKey, [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]);

    await jwt.authorize();
    sheetsClient = google.sheets({ version: 'v4', auth: jwt });
    driveClient = google.drive({ version: 'v3', auth: jwt });
    sheetsInitialized = true;
    console.log('✅ Google API inicializado');
  } catch (e) {
    console.error('Error al inicializar Google API:', e.message);
  }
}

function ensureLocalFolders() {
  const base = path.join(__dirname, 'tickets');
  const remitentes = ['ElCholo', 'Ramirez', 'Tejada'];
  if (!fs.existsSync(base)) fs.mkdirSync(base);
  remitentes.forEach(r => {
    const dir = path.join(base, r);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  });
}

// === GENERAR PDF ===
async function generateTicketPDF(data) {
  return new Promise(async (resolve, reject) => {
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
    } catch (err) { reject(err); }
  });
}

// === MAIL ===
async function sendMailWithPDF(buffer, filename, data) {
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
}

// === MENU ===
bot.start(async ctx => {
  ctx.session = {};
  await ctx.reply('👋 ¡Hola! Soy el Bot de Devoluciones. ¿Qué querés hacer?', { reply_markup: mainKeyboard.reply_markup });
});

bot.action('main', async ctx => {
  try { await ctx.answerCbQuery(); } catch {}
  await ctx.reply('Menú principal:', { reply_markup: mainKeyboard.reply_markup });
});

// === FLUJO: REGISTRO ===
// (se mantiene sin teclado visual)

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
  try { await ctx.answerCbQuery(); } catch {}
  const remitente = ctx.match[1];
  const folder = path.join(__dirname, 'tickets', remitente);
  if (!fs.existsSync(folder)) return ctx.reply('No hay tickets disponibles.');
  const files = fs.readdirSync(folder).filter(f => f.endsWith('.pdf')).slice(-5).reverse();
  if (!files.length) return ctx.reply('No hay tickets disponibles.');
  for (const file of files) {
    await ctx.replyWithDocument({ source: path.join(folder, file) });
  }
  await ctx.reply('Menú principal:', { reply_markup: mainKeyboard.reply_markup });
});

// === EXPRESS SERVER ===
app.get('/', (req, res) => res.send('Bot de devoluciones activo.'));
app.listen(PORT, () => console.log(`Servidor Express en puerto ${PORT}`));

// === INICIO ===
(async () => {
  ensureLocalFolders();
  await initSheets();
  await bot.launch();
  botStatus = 'conectado (polling)';
  console.log('✅ Bot iniciado correctamente');
})();
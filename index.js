// index.js - CommonJS final (reemplazar archivo actual)
// Requerimientos:
// npm install telegraf telegraf-session-local pdfkit googleapis axios dotenv nodemailer

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const PDFDocument = require('pdfkit');
const { google } = require('googleapis');
const axios = require('axios');
const nodemailer = require('nodemailer');
require('dotenv').config();

// --- CONFIG/ENV ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null;
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1BFGsZaUwvxV4IbGgXNOp5IrMYLVn-czVYpdxTleOBgo';
const GOOGLE_SERVICE_ACCOUNT_FILE = "./gen-lang-client-0104843305-3b7345de7ec0.json";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const LOG_FILE = "logs.txt";
const PORT = process.env.PORT || 3000;
const LOGO_PATH = "./REPUESTOS EL CHOLO LOGO.png";
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const DRIVE_PARENT_FOLDER_ID = "1ByMDQDSWku135s1SwForGtWvyl2gcRSM";
const TICKETS_BASE = path.join(__dirname, 'tickets');

// Mail config (Gmail App Password)
const MAIL_USER = process.env.MAIL_USER || '';
const MAIL_PASS = process.env.MAIL_PASS || '';
const INTERNAL_NOTIFY_EMAIL = 'info@repuestoselcholo.com.ar';

// Allowed users (IDs) - set in .env: ALLOWED_USERS=123456789,987654321
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

// --- Sanity checks ---
if (!BOT_TOKEN) throw new Error("FATAL: BOT_TOKEN no definido en variables de entorno.");

// --- Express (status page) ---
const app = express();
let botStatus = "iniciando";
let sheetsErrorDetail = "Intentando inicializar Google Sheets...";
app.get("/", (req, res) => {
  res.send(`<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10"></head><body style="font-family: Arial, Helvetica, sans-serif; padding:20px;"><h2>🤖 Bot de Telegram - Repuestos El Cholo</h2><div>Estado: <b>${botStatus}</b></div><p>El bot escucha mensajes por Telegram.</p></body></html>`);
});
app.get("/status", (req, res) => res.json({ status: botStatus, sheetsStatus: sheetsInitialized ? "OK" : sheetsErrorDetail }));
app.listen(PORT, () => console.log(`Express escuchando en ${PORT}`));

// --- Bot y sesión ---
const bot = new Telegraf(BOT_TOKEN);
bot.use((new LocalSession({ database: 'session_db.json' })).middleware());

// --- Security middleware: sólo usuarios autorizados pueden interactuar ---
bot.use(async (ctx, next) => {
  try {
    const uid = String(ctx.from?.id || '');
    if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(uid)) {
      // Responder sólo cuando inician conversación o envían mensaje
      try { await ctx.reply("🚫 No tenés autorización para usar este bot."); } catch(e){}
      return; // no continue
    }
    return next();
  } catch (e) {
    console.error("Error en middleware de seguridad:", e && e.message);
    return next();
  }
});

// --- Keyboards & constants ---
const remitenteKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('1️⃣ El Cholo Repuestos (CUIT: 30-71634102-6)', 'remitente_ElCholo')],
  [Markup.button.callback('2️⃣ Ramirez Cesar y Lois Gustavo S.H. (CUIT: 30-71144680-6)', 'remitente_Ramirez')],
  [Markup.button.callback('3️⃣ Tejada Carlos y Gomez Juan S.H. (CUIT: 30-70996969-9)', 'remitente_Tejada')],
  [Markup.button.callback('↩️ Volver', 'main')]
]);

const mainKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('📦 Registrar devolución', 'registro')],
  [Markup.button.callback('🔍 Consultar devoluciones', 'consultar')],
  [Markup.button.callback('🎟️ Ticket', 'ver_tickets'), Markup.button.callback('🏢 Ver proveedores', 'ver_proveedores')],
  [Markup.button.callback('➕ Agregar proveedor', 'agregar_proveedor')]
]);

// --- Google Sheets ---
let sheetsClient = null;
let sheetsInitialized = false;

async function initSheets() {
  sheetsErrorDetail = "Cargando...";
  if (!SHEET_ID) {
    sheetsErrorDetail = "SHEET_ID no definido.";
    console.warn("⚠️ Advertencia: SHEET_ID no está definido. La funcionalidad de Google Sheets estará deshabilitada.");
    return;
  }
  try {
    console.log("Intentando leer credenciales desde archivo local para Sheets...");
    const keyFileContent = await fsp.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, "utf8");
    const key = JSON.parse(keyFileContent);
    if (!key || !key.client_email || !key.private_key) throw new Error("Credenciales JSON incompletas o mal formadas.");
    const privateKey = key.private_key.replace(/\\n/g, '\n');
    const jwt = new google.auth.JWT(key.client_email, null, privateKey, ["https://www.googleapis.com/auth/spreadsheets"]);
    await jwt.authorize();
    sheetsClient = google.sheets({ version: "v4", auth: jwt });
    await ensureSheetTabs(["ElCholo","Ramirez","Tejada","Proveedores"]);
    sheetsInitialized = true;
    sheetsErrorDetail = "OK";
    console.log("✅ Google Sheets inicializado correctamente.");
  } catch (e) {
    sheetsErrorDetail = e.message.includes('ENOENT') ? `ARCHIVO NO ENCONTRADO (${GOOGLE_SERVICE_ACCOUNT_FILE})` : `FALLO DE AUTENTICACIÓN: ${e.message}`;
    console.warn(`⚠️ Error al inicializar Google Sheets: ${e.message}`);
    sheetsInitialized = false;
    sheetsClient = null;
  }
}

async function ensureSheetTabs(tabNames) {
  if (!sheetsClient) return;
  try {
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existing = (meta.data.sheets || []).map(s => s.properties.title);
    const requests = tabNames.filter(t => !existing.includes(t)).map(title => ({ addSheet: { properties: { title } } }));
    if (requests.length) await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
    const headers = ["Fecha","Proveedor","Código Producto","Descripción","Cantidad","Motivo","N° Remito/Factura","Fecha Factura","UsuarioID"];
    for (const t of tabNames) {
      try {
        const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${t}!A1:I1` });
        if (!resp.data.values || resp.data.values.length === 0) {
          await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: `${t}!A1:I1`,
            valueInputOption: "RAW",
            requestBody: { values: [headers] }
          });
        }
      } catch (e) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${t}!A1:I1`,
          valueInputOption: "RAW",
          requestBody: { values: [headers] }
        }).catch(()=>{});
      }
    }
  } catch (e) {
    console.error("Error en ensureSheetTabs:", e.message);
  }
}

async function appendRowToSheet(tab, row) {
  if (!sheetsInitialized) throw new Error("Sheets no inicializado o deshabilitado.");
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:I`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

async function readProviders() {
  if (!sheetsInitialized) return [];
  const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Proveedores!A2:A` }).catch(()=>({ data: { values: [] }}));
  const vals = resp.data.values || [];
  return vals.map(v=>v[0]).filter(Boolean);
}

async function addProvider(name) {
  if (!sheetsInitialized) throw new Error("Sheets no inicializado o deshabilitado.");
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `Proveedores!A:A`,
    valueInputOption: "RAW",
    requestBody: { values: [[name]] }
  });
}

// --- Logging helper ---
async function appendLog(message) {
  const ts = new Date().toISOString();
  await fsp.appendFile(LOG_FILE, `[${ts}] ${message}\n`).catch(()=>{});
}

// --- PDF generator ---
async function generateTicketPDF(data) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const chunks = [];
      doc.on("data", c=>chunks.push(c));
      doc.on("end", ()=>resolve(Buffer.concat(chunks)));

      const RED = "#C8102E";
      const BLUE = "#0B3B70";

      try {
        const logo = fs.readFileSync(LOGO_PATH);
        doc.image(logo, 40, 40, { width: 120 });
      } catch(e){
        doc.fillColor(RED).fontSize(10).text("REPUESTOS EL CHOLO (Logo Faltante)", 40, 40);
      }

      doc.fillColor(BLUE).fontSize(20).font("Helvetica-Bold").text("Ticket de Devolución", { align: "right" });
      doc.moveDown(0.5);
      doc.fillColor("black").fontSize(11).font("Helvetica");
      doc.text(`Fecha registro: ${new Date().toLocaleString()}`, { align: "right" });
      doc.moveDown(1);

      const startY = doc.y;
      doc.rect(40, startY, 515, 180).strokeColor(RED).lineWidth(1).stroke();
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor(BLUE).text(`Remitente: `, 50, startY + 10, { continued: true }).fillColor("black").text(`${data.remitenteDisplay}`);
      doc.moveDown(0.3);
      doc.fillColor(BLUE).text(`Proveedor: `, { continued: true }).fillColor("black").text(`${data.proveedor}`);
      doc.moveDown(0.3);
      doc.fillColor(BLUE).text(`Código: `, { continued: true }).fillColor("black").text(`${data.codigo}`);
      doc.moveDown(0.3);
      doc.fillColor(BLUE).text(`Descripción: `, { continued: true }).fillColor("black").text(`${data.descripcion}`);
      doc.moveDown(0.3);
      doc.fillColor(BLUE).text(`Cantidad: `, { continued: true }).fillColor("black").text(`${data.cantidad}`);
      doc.moveDown(0.3);
      doc.fillColor(BLUE).text(`Motivo: `, { continued: true }).fillColor("black").text(`${data.motivo}`);
      doc.moveDown(0.3);
      doc.fillColor(BLUE).text(`N° Remito/Factura: `, { continued: true }).fillColor("black").text(`${data.remito}`);
      doc.moveDown(0.3);
      doc.fillColor(BLUE).text(`Fecha factura: `, { continued: true }).fillColor("black").text(`${data.fechaFactura}`);

      doc.moveDown(2);
      doc.fillColor("gray").fontSize(10).text("Gracias por registrar la devolución. Conservá este ticket para seguimiento.", { align: "center" });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// --- Google Drive integration ---
let driveClient = null;

async function initDrive() {
  try {
    console.log("Iniciando Google Drive...");
    const keyFileContent = await fsp.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, "utf8");
    const key = JSON.parse(keyFileContent);
    const privateKey = key.private_key.replace(/\\n/g, '\n');
    const jwt = new google.auth.JWT(key.client_email, null, privateKey, [
      "https://www.googleapis.com/auth/drive"
    ]);
    await jwt.authorize();
    driveClient = google.drive({ version: "v3", auth: jwt });
    console.log("✅ Google Drive inicializado correctamente.");
  } catch (e) {
    console.error("❌ Error inicializando Drive:", e.message);
    driveClient = null;
  }
}

/**
 * Sube archivo a Drive en subcarpeta por remitente (la crea si no existe).
 * Devuelve URL público o null.
 */
async function uploadToDrive(remitente, filePath, fileName) {
  if (!driveClient) return null;
  try {
    const q = `'${DRIVE_PARENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and name='${remitente}' and trashed=false`;
    const folderList = await driveClient.files.list({ q, fields: "files(id, name)" });
    let folderId;
    if (folderList.data.files && folderList.data.files.length > 0) {
      folderId = folderList.data.files[0].id;
    } else {
      const folder = await driveClient.files.create({
        resource: { name: remitente, mimeType: 'application/vnd.google-apps.folder', parents: [DRIVE_PARENT_FOLDER_ID] },
        fields: "id"
      });
      folderId = folder.data.id;
    }

    const media = { mimeType: 'application/pdf', body: fs.createReadStream(filePath) };
    const res = await driveClient.files.create({
      resource: { name: fileName, parents: [folderId] },
      media,
      fields: 'id'
    });

    const fileId = res.data.id;
    await driveClient.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
    const publicUrl = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
    await appendLog(`Archivo subido a Drive (${remitente}): ${publicUrl}`);
    return publicUrl;
  } catch (e) {
    console.error("Error subiendo a Drive:", e.message);
    return null;
  }
}

// --- Mailer (nodemailer) ---
let mailTransporter = null;
function initMailer() {
  if (!MAIL_USER || !MAIL_PASS) {
    console.warn('⚠️ MAIL_USER o MAIL_PASS no configurados. Emails no se enviarán.');
    return;
  }
  mailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: MAIL_USER, pass: MAIL_PASS }
  });
}

// send mail with attachment (html)
async function sendEmailWithAttachment(remitenteDisplay, toEmail, filePath, fileName, ticketData, driveUrl) {
  if (!mailTransporter) {
    console.warn("Mailer no inicializado. No se envía correo.");
    return false;
  }
  try {
    const subject = `📦 Nueva devolución - ${remitenteDisplay} - ${ticketData.proveedor}`;
    const html = `
      <div style="font-family:Arial,sans-serif">
        <img src="cid:logo" width="180" alt="Repuestos El Cholo"><br><br>
        <h2 style="color:#0B3B70">Nueva devolución registrada</h2>
        <p>Se ha registrado una nueva devolución en el sistema:</p>
        <ul>
          <li><b>Remitente:</b> ${remitenteDisplay}</li>
          <li><b>Proveedor:</b> ${ticketData.proveedor}</li>
          <li><b>Código:</b> ${ticketData.codigo}</li>
          <li><b>Descripción:</b> ${ticketData.descripcion}</li>
          <li><b>Cantidad:</b> ${ticketData.cantidad}</li>
          <li><b>Motivo:</b> ${ticketData.motivo}</li>
          <li><b>Remito/Factura:</b> ${ticketData.remito}</li>
          <li><b>Fecha factura:</b> ${ticketData.fechaFactura}</li>
        </ul>
        ${driveUrl ? `<p>Archivo en Drive: <a href="${driveUrl}">${driveUrl}</a></p>` : ''}
        <p>El ticket PDF se adjunta a este correo.</p>
        <p>--<br>Bot de Devoluciones<br><b style="color:#C8102E">Repuestos El Cholo</b></p>
      </div>
    `;

    const attachments = [
      { filename: fileName, path: filePath },
    ];
    if (fs.existsSync(LOGO_PATH)) {
      attachments.push({ filename: path.basename(LOGO_PATH), path: LOGO_PATH, cid: 'logo' });
    }

    const info = await mailTransporter.sendMail({
      from: `"Repuestos El Cholo" <${MAIL_USER}>`,
      to: toEmail,
      cc: INTERNAL_NOTIFY_EMAIL,
      subject,
      html,
      attachments
    });
    await appendLog(`Email enviado a ${toEmail} (ticket: ${fileName}). MessageId: ${info.messageId}`);
    return true;
  } catch (e) {
    console.error("Error enviando email:", e && e.message);
    await appendLog(`Fallo envío email a ${toEmail}: ${e && e.message}`);
    return false;
  }
}

// --- helper: replyMain ---
const replyMain = async (ctx) => {
  try {
    ctx.session = ctx.session || {};
    ctx.session.step = 'main_menu';
    return ctx.reply("Menú principal:", { reply_markup: mainKeyboard.reply_markup });
  } catch (e) {
    console.error("replyMain error:", e && e.message);
  }
};

// --- Handlers ---
bot.start(async (ctx) => {
  ctx.session = {};
  ctx.session.step = 'main_menu';
  await appendLog(`Comienzo /start chat ${ctx.chat.id}`);
  await ctx.reply("👋 Hola! Soy el bot de devoluciones. ¿Qué querés hacer?", { reply_markup: mainKeyboard.reply_markup });
});

bot.command('help', async (ctx) => {
  await ctx.reply("Soy el Bot de Devoluciones de Repuestos El Cholo. Comandos:\n/start - Menú\n/help - Ayuda", mainKeyboard.reply_markup);
});

bot.action('main', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  await replyMain(ctx);
});

// Registro flow start
bot.action('registro', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  ctx.session.flow = 'registro';
  ctx.session.step = 'chooseRemitente';
  await ctx.reply("¿A qué empresa corresponde la devolución?", { reply_markup: remitenteKeyboard.reply_markup });
});

// remitente selection
bot.action(/remitente_(.+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const remitenteAlias = ctx.match[1]; // ElCholo, Ramirez, Tejada
  ctx.session.remitente = remitenteAlias;
  // remitente display completo con CUIT
  const remitenteDisplay = {
    ElCholo: 'El Cholo Repuestos (CUIT: 30-71634102-6)',
    Ramirez: 'Ramirez Cesar y Lois Gustavo S.H. (CUIT: 30-71144680-6)',
    Tejada: 'Tejada Carlos y Gomez Juan S.H. (CUIT: 30-70996969-9)'
  }[remitenteAlias] || remitenteAlias;
  ctx.session.remitenteDisplay = remitenteDisplay;
  ctx.session.step = 'chooseProveedor';

  const provs = await readProviders();
  let buttons = [];
  (provs.slice(0,10)).forEach((p,i)=> buttons.push([Markup.button.callback(`${i+1}. ${p}`, `prov_${i}`)]));
  buttons.push([Markup.button.callback('Escribir otro proveedor', 'prov_other')]);
  buttons.push([Markup.button.callback('↩️ Cancelar', 'main')]);

  let msg = `Remitente elegido: *${remitenteDisplay}*\nElegí proveedor (o escribí uno):`;
  if (!sheetsInitialized) {
    msg = `Remitente elegido: *${remitenteDisplay}*\n⚠️ La integración con Sheets está deshabilitada. Escribí el nombre del proveedor.`;
    ctx.session.step = 'proveedor_manual';
    return ctx.editMessageText(msg, { parse_mode: 'Markdown' });
  }
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(buttons).reply_markup });
  ctx.session.provList = provs;
});

// proveedor select
bot.action(/prov_(\d+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const idx = Number(ctx.match[1]);
  const prov = ctx.session.provList?.[idx];
  ctx.session.proveedor = prov || 'N/D';
  ctx.session.step = 'codigo';
  await ctx.editMessageText(`Proveedor seleccionado: *${ctx.session.proveedor}*.\nEnviá el *código del producto* (texto).`, { parse_mode: 'Markdown' });
});

bot.action('prov_other', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  ctx.session.step = 'proveedor_manual';
  await ctx.editMessageText("Escribí el nombre del proveedor (texto).");
});

bot.action('agregar_proveedor', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  if (!sheetsInitialized) {
    await ctx.reply("❌ Función no disponible. La integración con Google Sheets está deshabilitada.", mainKeyboard.reply_markup);
    return replyMain(ctx);
  }
  ctx.session.flow = 'agregar_proveedor';
  ctx.session.step = 'nuevo_proveedor';
  await ctx.editMessageText("Escribí el *nombre del proveedor* que querés agregar:", { parse_mode: 'Markdown' });
});

// consultar devoluciones
bot.action('consultar', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  if (!sheetsInitialized) {
    await ctx.reply("❌ Función no disponible. La integración con Google Sheets está deshabilitada.", mainKeyboard.reply_markup);
    return replyMain(ctx);
  }
  await ctx.reply("Buscando últimas devoluciones (las últimas 5 de cada remitente). Esto puede tardar un segundo...");
  const tabs = ["ElCholo","Ramirez","Tejada"];
  let messages = [];
  for (const t of tabs) {
    try {
      const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${t}!A2:I` });
      const rows = (resp.data.values || []).slice(-5).reverse();
      if (rows.length) messages.push(`*${t}*:\n` + rows.map(r=>`• ${r[0]} - ${r[1]} - ${r[4]}u - ${r[6] || 'sin nro'}`).join("\n"));
    } catch(e){
      console.error(`Error leyendo pestaña ${t}:`, e.message);
    }
  }
  if (!messages.length) await ctx.reply("No se encontraron devoluciones.");
  else await ctx.reply(messages.join("\n\n"), { parse_mode: 'Markdown' });
  await replyMain(ctx);
});

// ver proveedores
bot.action('ver_proveedores', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  if (!sheetsInitialized) {
    await ctx.reply("❌ Función no disponible. La integración con Google Sheets está deshabilitada.", mainKeyboard.reply_markup);
    return replyMain(ctx);
  }
  const provs = await readProviders();
  if (!provs.length) { await ctx.reply("No hay proveedores cargados."); return replyMain(ctx); }
  const formatted = provs.map((p,i)=> `${i+1}. ${p}`).join("\n");
  await ctx.reply(`Proveedores:\n${formatted}`);
  await replyMain(ctx);
});

// ver tickets: muestra remitentes
bot.action('ver_tickets', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('1️⃣ El Cholo Repuestos (CUIT: 30-71634102-6)', 'tickets_ElCholo')],
    [Markup.button.callback('2️⃣ Tejada Carlos y Gomez Juan S.H. (CUIT: 30-70996969-9)', 'tickets_Tejada')],
    [Markup.button.callback('3️⃣ Ramirez Cesar y Lois Gustavo S.H. (CUIT: 30-71144680-6)', 'tickets_Ramirez')],
    [Markup.button.callback('↩️ Volver', 'main')]
  ]);
  await ctx.reply("Seleccioná el remitente para ver sus tickets:", keyboard);
});

// listar tickets locales para remitente
bot.action(/^tickets_(.+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const remitente = ctx.match[1];
  const dirPath = path.join(TICKETS_BASE, remitente);
  try {
    const files = await fsp.readdir(dirPath).catch(()=>[]);
    if (!files || files.length === 0) {
      await ctx.reply(`📂 No hay tickets guardados para ${remitente}.`);
      return replyMain(ctx);
    }
    const available = files.slice(-50).reverse();
    const keyboard = available.map(f => [Markup.button.callback(f, `download_${remitente}_${f}`)]);
    keyboard.push([Markup.button.callback('↩️ Volver', 'ver_tickets')]);
    await ctx.reply(`Tickets disponibles para *${remitente}*:\nSeleccioná uno para descargar.`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (e) {
    console.error("Error listando tickets:", e && e.message);
    await ctx.reply(`📂 No hay tickets guardados para ${remitente}.`);
  }
});

// download ticket
bot.action(/^download_(.+)_(.+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const remitente = ctx.match[1];
  const fileName = ctx.match[2];
  const filePath = path.join(TICKETS_BASE, remitente, fileName);
  try {
    await ctx.replyWithDocument({ source: filePath });
  } catch (e) {
    console.error("Error enviando PDF:", e && e.message);
    await ctx.reply("⚠️ No se pudo enviar el ticket. Puede que el archivo no exista localmente.");
  }
  await replyMain(ctx);
});

// MAIN text handler
bot.on('text', async (ctx) => {
  const text = ctx.message.text?.trim();
  const chatId = ctx.chat.id;
  const userName = ctx.from?.first_name || ctx.from?.username || `User${chatId}`;
  await appendLog(`Mensaje de ${userName} (${chatId}): ${text}`);
  const s = ctx.session || {};

  // agregar proveedor
  if (s.flow === 'agregar_proveedor' && s.step === 'nuevo_proveedor') {
    if (!sheetsInitialized) {
      await ctx.reply("❌ No se puede agregar el proveedor. La integración con Google Sheets está deshabilitada.", mainKeyboard.reply_markup);
      return replyMain(ctx);
    }
    const name = text;
    try {
      await addProvider(name);
      await ctx.reply(`✅ Proveedor *${name}* agregado.`, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error("Error al agregar proveedor:", e && e.message);
      await ctx.reply("Ocurrió un error al agregar el proveedor.");
    }
    ctx.session = {};
    return replyMain(ctx);
  }

  // flujo de registro
  if (s.flow === 'registro' || s.step) {
    // proveedor manual
    if (s.step === 'proveedor_manual') {
      ctx.session.proveedor = text;
      ctx.session.step = 'codigo';
      await ctx.reply("Perfecto. Ahora enviá el código del producto.");
      return;
    }
    if (s.step === 'codigo') {
      ctx.session.codigo = text;
      ctx.session.step = 'descripcion';
      await ctx.reply("Descripción del producto:");
      return;
    }
    if (s.step === 'descripcion') {
      ctx.session.descripcion = text;
      ctx.session.step = 'cantidad';
      await ctx.reply("Ingresá la cantidad (solo números):");
      return;
    }
    if (s.step === 'cantidad') {
      if (!/^\d+$/.test(text)) {
        await ctx.reply("⚠️ Ingresá solo números para la cantidad.");
        return;
      }
      ctx.session.cantidad = text;
      ctx.session.step = 'motivo';
      await ctx.reply("Motivo de la devolución:");
      return;
    }
    if (s.step === 'motivo') {
      ctx.session.motivo = text;
      ctx.session.step = 'remito';
      await ctx.reply("Número de remito/factura:");
      return;
    }
    if (s.step === 'remito') {
      // permitimos números y guiones y barras
      if (!/^[\dA-Za-z\-\/]+$/.test(text)) {
        await ctx.reply("⚠️ Por favor ingresá un número válido (solo dígitos, guiones o barras).");
        return;
      }
      ctx.session.remito = text;
      ctx.session.step = 'fechaFactura';
      await ctx.reply("Fecha de factura (DD/MM/AAAA): Ej: 25/11/2025");
      return;
    }
    if (s.step === 'fechaFactura') {
      // normalizamos y validamos fecha sin depender de new Date()
      const raw = text.trim().replace(/[.\-]/g, '/');
      const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!match) {
        await ctx.reply("⚠️ Fecha inválida. Usá el formato DD/MM/AAAA (ej: 25/11/2025).");
        return;
      }
      const dd = parseInt(match[1], 10);
      const mm = parseInt(match[2], 10);
      const yyyy = parseInt(match[3], 10);
      if (dd < 1 || dd > 31 || mm < 1 || mm > 12 || yyyy < 1900) {
        await ctx.reply("⚠️ Fecha inválida. Revisá día/mes/año e intentá de nuevo.");
        return;
      }
      // control básico de días por mes (no es exhaustivo para años bisiestos, pero razonable)
      const daysInMonth = [31, ( (yyyy%4===0 && yyyy%100!==0) || (yyyy%400===0) ) ? 29 : 28, 31,30,31,30,31,31,30,31,30,31];
      if (dd > daysInMonth[mm-1]) {
        await ctx.reply("⚠️ Fecha inválida para ese mes. Reingresá la fecha.");
        return;
      }
      ctx.session.fechaFactura = `${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${yyyy}`;
      ctx.session.step = 'pre_confirm';

      // Mostrar resumen y preguntar si quiere enviar por correo (antes de confirmar)
      const summary = `*Resumen de la devolución:*

Remitente: *${ctx.session.remitenteDisplay}*
Proveedor: *${ctx.session.proveedor}*
Código: ${ctx.session.codigo}
Descripción: ${ctx.session.descripcion}
Cantidad: ${ctx.session.cantidad}
Motivo: ${ctx.session.motivo}
N° Remito/Factura: ${ctx.session.remito}
Fecha factura: ${ctx.session.fechaFactura}
      `;
      // Pregunta de envío
      const askEmailKb = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Sí, enviar por correo', 'email_yes')],
        [Markup.button.callback('❌ No, solo guardar', 'email_no')],
        [Markup.button.callback('✏️ Cancelar', 'main')]
      ]);
      await ctx.reply(summary, { parse_mode: 'Markdown' });
      await ctx.reply("¿Deseás enviar la devolución por correo electrónico?", askEmailKb.reply_markup);
      return;
    }

    // si estamos en el paso de ingresar email destino
    if (s.step === 'email_destino') {
      const email = text;
      // validación básica de correo
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        await ctx.reply("⚠️ Email inválido. Ingresalo nuevamente (ej: cliente@dominio.com).");
        return;
      }
      ctx.session.emailDestino = email;
      ctx.session.step = 'confirm';
      // mostrar botones de confirmación final
      const confirmationKeyboard = Markup.inlineKeyboard([
        Markup.button.callback('✅ Confirmar y guardar','confirm_save'),
        Markup.button.callback('✏️ Cancelar','main')
      ]).reply_markup;
      await ctx.reply(`Correo destino: ${email}\nAhora confirmá para guardar la devolución.`, { reply_markup: confirmationKeyboard, parse_mode: 'Markdown' });
      return;
    }
  }

  // Fallback Gemini AI (si está configurado)
  if (GEMINI_API_KEY) {
    try {
      const payload = {
        contents: [{ parts: [{ text: text }] }],
        systemInstruction: {
          parts: [{ text: "Eres un asistente amigable y formal que responde preguntas generales, pero siempre sugiere usar el menú principal para las funciones del bot de devoluciones de Repuestos El Cholo." }]
        },
        generationConfig: { maxOutputTokens: 256 }
      };
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;
      const aiResp = await axios.post(apiUrl, payload);
      const reply = aiResp.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Perdón, no entendí. Podés usar el menú.";
      await ctx.reply(reply, mainKeyboard.reply_markup);
      return;
    } catch (e) {
      console.error("--- Error Gemini ---", e && (e.response?.data || e.message));
      if (e.response) {
        await ctx.reply(`⚠️ Error de API: ${e.response.status}. Revisa la consola para detalle.`, mainKeyboard.reply_markup);
      } else if (e.request) {
        await ctx.reply("⚠️ Error de red: No se pudo contactar al asistente.", mainKeyboard.reply_markup);
      } else {
        await ctx.reply("⚠️ Error interno del asistente. Revisa la consola.", mainKeyboard.reply_markup);
      }
      return;
    }
  }

  // fallback general
  await ctx.reply("No entendí eso. Por favor, usá los botones del menú principal o escribí /start.", mainKeyboard.reply_markup);
});

// Actions for email choice
bot.action('email_yes', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  ctx.session.step = 'email_destino';
  await ctx.reply("Ingresá la dirección de correo del destinatario (ej: cliente@dominio.com):");
});

bot.action('email_no', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  ctx.session.emailDestino = null;
  ctx.session.step = 'confirm';
  const confirmationKeyboard = Markup.inlineKeyboard([
    Markup.button.callback('✅ Confirmar y guardar','confirm_save'),
    Markup.button.callback('✏️ Cancelar','main')
  ]).reply_markup;
  await ctx.reply("No se enviará por correo. Confirmá para guardar la devolución.", { reply_markup: confirmationKeyboard, parse_mode: 'Markdown' });
});

// confirm_save: guarda en Sheets (si disponible), genera PDF, guarda localmente, sube a Drive, envia al usuario y si corresponde envia email
bot.action('confirm_save', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const s = ctx.session;
  if (!s || !s.remitente) {
    await ctx.reply("No hay datos para guardar. Volvé al menú.", mainKeyboard.reply_markup);
    return replyMain(ctx);
  }

  const tab = s.remitente;
  const row = [ new Date().toLocaleString("es-AR", { timeZone: 'America/Argentina/Buenos_Aires' }), s.proveedor||'', s.codigo||'', s.descripcion||'', s.cantidad||'', s.motivo||'', s.remito||'', s.fechaFactura||'', String(ctx.chat.id) ];

  let sheetsError = false;
  try {
    if (sheetsInitialized) {
      await appendRowToSheet(tab, row);
      await ctx.reply("✅ Devolución registrada correctamente en Google Sheets.");
      await appendLog(`Devolución guardada en ${tab} por ${ctx.from?.first_name} (${ctx.chat.id})`);
    } else {
      sheetsError = true;
      await ctx.reply("⚠️ La integración con Google Sheets está deshabilitada. La información NO se registró en la hoja.");
    }
  } catch (err) {
    console.error("Error guardando en Sheets:", err && err.message);
    sheetsError = true;
    await ctx.reply("⚠️ Atención: Ocurrió un error al guardar en Google Sheets. La información no se registró en la hoja.");
  }

  // Solo si Sheets fue OK (no sheetsError) continuamos con PDF + Drive + email según tu requisito
  if (!sheetsError) {
    try {
      const ticketData = {
        remitente: tab,
        remitenteDisplay: s.remitenteDisplay,
        proveedor: s.proveedor,
        codigo: s.codigo,
        descripcion: s.descripcion,
        cantidad: s.cantidad,
        motivo: s.motivo,
        remito: s.remito,
        fechaFactura: s.fechaFactura,
        usuario: ctx.from?.first_name || ctx.from?.username || String(ctx.chat.id)
      };

      const pdfBuf = await generateTicketPDF(ticketData);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const folderPath = path.join(TICKETS_BASE, tab);
      const fileName = `ticket_${(s.proveedor||'sinProveedor').replace(/\s+/g,'_')}_${timestamp}.pdf`;
      const filePath = path.join(folderPath, fileName);

      await fsp.mkdir(folderPath, { recursive: true });
      await fsp.writeFile(filePath, pdfBuf);

      // Enviar PDF al usuario (siempre)
      try {
        await ctx.replyWithDocument({ source: filePath, filename: fileName }, { caption: "🎟️ Aquí está tu ticket de devolución." });
      } catch (e) {
        console.error("Error enviando PDF al usuario:", e && e.message);
      }

      // Subir a Drive (no bloqueante)
      const driveUrl = await uploadToDrive(tab, filePath, fileName);
      if (driveUrl) {
        await ctx.reply(`☁️ Ticket guardado en Drive:\n${driveUrl}`);
      }

      // Enviar email si el usuario solicitó (emailDestino) y mailer está configurado
      if (s.emailDestino) {
        const sendOk = await sendEmailWithAttachment(s.remitenteDisplay, s.emailDestino, filePath, fileName, ticketData, driveUrl);
        if (sendOk) {
          await ctx.reply(`📧 Correo enviado a ${s.emailDestino} (copia a ${INTERNAL_NOTIFY_EMAIL}).`);
        } else {
          await ctx.reply("⚠️ No se pudo enviar el correo. Revisá la configuración de MAIL_USER/MAIL_PASS.");
        }
      }

    } catch (e) {
      console.error("Error generando/enviando PDF:", e && e.message);
      await ctx.reply("⚠️ Atención: Error al generar/enviar el ticket PDF. Revisa los logs.");
    }
  }

  ctx.session = {};
  return replyMain(ctx);
});

// --- init / launch ---
(async () => {
  console.log("🛠️ Inicializando Google Sheets, Drive y Mailer...");
  await initSheets();
  await initDrive();
  initMailer();

  if (WEBHOOK_URL) {
    const secretPath = `/telegraf/${BOT_TOKEN}`;
    app.use(bot.webhookCallback(secretPath));
    try {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}${secretPath}`);
      console.log(`✅ Bot en modo Webhook.`);
      botStatus = "conectado (webhook)";
    } catch (e) {
      console.error("Error al setear webhook:", e && e.message);
    }
  } else {
    try {
      console.warn("⚠️ WEBHOOK_URL no definido. Usando Telegraf Polling...");
      await bot.launch();
      botStatus = "conectado (polling)";
    } catch (e) {
      console.error("Error launching bot (polling):", e && e.message);
    }
  }

  process.once('SIGINT', ()=>bot.stop('SIGINT'));
  process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
  console.log("✅ Bot de Telegram iniciado.");
})();

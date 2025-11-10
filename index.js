// index.js - CommonJS final (versión con mejoras solicitadas)
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

// -------------- CONFIG / ENV ----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null;
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const GOOGLE_SERVICE_ACCOUNT_FILE = "./gen-lang-client-0104843305-3b7345de7ec0.json";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const LOG_FILE = "logs.txt";
const PORT = process.env.PORT || 3000;
const LOGO_PATH = "./REPUESTOS EL CHOLO LOGO.png";
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const DRIVE_PARENT_FOLDER_ID = "1ByMDQDSWku135s1SwForGtWvyl2gcRSM";
const TICKETS_BASE = path.join(__dirname, 'tickets');

// Mail config
const MAIL_USER = process.env.MAIL_USER || '';
const MAIL_PASS = process.env.MAIL_PASS || '';
const INTERNAL_NOTIFY_EMAIL = 'info@repuestoselcholo.com.ar';

// Allowed users (IDs) - set in .env: ALLOWED_USERS=123456789,987654321
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

// Sanity
if (!BOT_TOKEN) throw new Error("FATAL: BOT_TOKEN no definido en variables de entorno.");

// Ensure tickets base exists
(async () => {
  try { await fsp.mkdir(TICKETS_BASE, { recursive: true }); } catch(e){ console.warn("No se pudo crear carpeta tickets:", e.message); }
})();

// -------------- Express (status) ----------------
const app = express();
let botStatus = "iniciando";
let sheetsErrorDetail = "Intentando inicializar Google Sheets...";
app.get("/", (req, res) => {
  res.send(`<html><head><meta charset="utf-8"></head><body style="font-family: Arial; padding:20px;"><h2>🤖 Bot Repuestos El Cholo</h2><div>Estado: <b>${botStatus}</b></div></body></html>`);
});
app.get("/status", (req, res) => res.json({ status: botStatus, sheetsStatus: sheetsInitialized ? "OK" : sheetsErrorDetail }));
app.listen(PORT, () => console.log(`Express escuchando en ${PORT}`));

// -------------- Bot & Session ----------------
const bot = new Telegraf(BOT_TOKEN);
bot.use((new LocalSession({ database: 'session_db.json' })).middleware());

// Security middleware - only allowed users
bot.use(async (ctx, next) => {
  try {
    const uid = String(ctx.from?.id || '');
    if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(uid)) {
      try { await ctx.reply("🚫 No tenés autorización para usar este bot."); } catch(e){}
      return;
    }
    return next();
  } catch (e) {
    console.error("Middleware security error:", e && e.message);
    return next();
  }
});

// -------------- Keyboards & Constants ------------
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

// -------------- Google Sheets ----------------
let sheetsClient = null;
let sheetsInitialized = false;

// Ensure Proveedores sheet header: Nombre | Correo | Dirección
async function normalizeProveedoresSheet() {
  if (!sheetsClient) return;
  try {
    // Check if sheet exists
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheetNames = (meta.data.sheets || []).map(s => s.properties.title);
    if (!sheetNames.includes('Proveedores')) {
      // create sheet Proveedores
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'Proveedores' } } }] }
      });
    }
    // Set headers (A1:C1)
    const headers = [['Nombre','Correo','Direccion']];
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Proveedores!A1:C1',
      valueInputOption: 'RAW',
      requestBody: { values: headers }
    });
  } catch (e) {
    console.error("normalizeProveedoresSheet error:", e && e.message);
  }
}

async function initSheets() {
  sheetsErrorDetail = "Cargando...";
  if (!SHEET_ID) {
    sheetsErrorDetail = "SHEET_ID no definido.";
    console.warn("⚠️ SHEET_ID no está definido. Sheets deshabilitado.");
    return;
  }
  try {
    console.log("Intentando leer credenciales desde archivo local para Sheets...");
    const keyFileContent = await fsp.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, "utf8");
    const key = JSON.parse(keyFileContent);
    if (!key || !key.client_email || !key.private_key) throw new Error("Credenciales JSON inválidas.");
    const privateKey = key.private_key.replace(/\\n/g, '\n');
    const jwt = new google.auth.JWT(key.client_email, null, privateKey, ["https://www.googleapis.com/auth/spreadsheets","https://www.googleapis.com/auth/drive"]);
    await jwt.authorize();
    sheetsClient = google.sheets({ version: "v4", auth: jwt });
    // Ensure tabs and proveedores header
    await ensureSheetTabs(["ElCholo","Ramirez","Tejada","Proveedores"]);
    await normalizeProveedoresSheet();
    sheetsInitialized = true;
    sheetsErrorDetail = "OK";
    console.log("✅ Google Sheets inicializado correctamente.");
  } catch (e) {
    sheetsErrorDetail = e.message.includes('ENOENT') ? `ARCHIVO NO ENCONTRADO (${GOOGLE_SERVICE_ACCOUNT_FILE})` : `FALLO: ${e.message}`;
    console.warn("Error initSheets:", e && e.message);
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
    if (requests.length) {
      await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
    }
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
    console.error("ensureSheetTabs error:", e && e.message);
  }
}

async function appendRowToSheet(tab, row) {
  if (!sheetsInitialized) throw new Error("Sheets no inicializado.");
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:I`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

async function readProvidersFull() {
  if (!sheetsInitialized) return [];
  const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Proveedores!A2:C` }).catch(()=>({ data: { values: [] }}));
  const vals = resp.data.values || [];
  // normalize rows to objects
  return vals.map((r, idx) => ({ rowIndex: idx+2, nombre: r[0]||'', correo: r[1]||'', direccion: r[2]||'' }));
}

async function findProviderRowByName(name) {
  const list = await readProvidersFull();
  // try exact match, then case-insensitive contains
  const exact = list.find(p => (p.nombre||'').toString().trim().toLowerCase() === (name||'').trim().toLowerCase());
  if (exact) return exact;
  const contains = list.find(p => (p.nombre||'').toString().toLowerCase().includes((name||'').trim().toLowerCase()));
  return contains || null;
}

async function updateProviderEmail(rowIndex, email) {
  if (!sheetsInitialized) throw new Error("Sheets no inicializado.");
  // Update B column (Correo) at rowIndex
  const range = `Proveedores!B${rowIndex}`;
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[email]] }
  });
}

// -------------- Logging ----------------
async function appendLog(message) {
  const ts = new Date().toISOString();
  await fsp.appendFile(LOG_FILE, `[${ts}] ${message}\n`).catch(()=>{});
}

// -------------- PDF generator ----------------
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
        if (fs.existsSync(LOGO_PATH)) {
          doc.image(LOGO_PATH, 40, 40, { width: 120 });
        } else {
          doc.fillColor(RED).fontSize(10).text("REPUESTOS EL CHOLO (Logo Faltante)", 40, 40);
        }
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

// -------------- Google Drive ----------------
let driveClient = null;
async function initDrive() {
  try {
    console.log("Iniciando Google Drive...");
    const keyFileContent = await fsp.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, "utf8");
    const key = JSON.parse(keyFileContent);
    const privateKey = key.private_key.replace(/\\n/g, '\n');
    const jwt = new google.auth.JWT(key.client_email, null, privateKey, ["https://www.googleapis.com/auth/drive"]);
    await jwt.authorize();
    driveClient = google.drive({ version: "v3", auth: jwt });
    console.log("✅ Google Drive inicializado correctamente.");
  } catch (e) {
    console.error("Error initDrive:", e && e.message);
    driveClient = null;
  }
}

async function ensureDriveFolderForRemitente(remitente) {
  if (!driveClient) return null;
  try {
    const q = `'${DRIVE_PARENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and name='${remitente}' and trashed=false`;
    const list = await driveClient.files.list({ q, fields: "files(id, name)" });
    if (list.data.files && list.data.files.length > 0) return list.data.files[0].id;
    const folder = await driveClient.files.create({
      resource: { name: remitente, mimeType: 'application/vnd.google-apps.folder', parents: [DRIVE_PARENT_FOLDER_ID] },
      fields: "id"
    });
    return folder.data.id;
  } catch (e) {
    console.error("ensureDriveFolderForRemitente error:", e && e.message);
    return null;
  }
}

async function uploadToDrive(remitente, filePath, fileName) {
  if (!driveClient) return null;
  try {
    const folderId = await ensureDriveFolderForRemitente(remitente);
    if (!folderId) return null;
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
    console.error("uploadToDrive error:", e && e.message);
    return null;
  }
}

// -------------- Mailer ----------------
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
    const attachments = [{ filename: fileName, path: filePath }];
    if (fs.existsSync(LOGO_PATH)) attachments.push({ filename: path.basename(LOGO_PATH), path: LOGO_PATH, cid: 'logo' });
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
    console.error("sendEmail error:", e && e.message);
    await appendLog(`Fallo envío email a ${toEmail}: ${e && e.message}`);
    return false;
  }
}

// -------------- Helpers & replyMain ---------------
const replyMain = async (ctx) => {
  try {
    ctx.session = ctx.session || {};
    ctx.session.step = 'main_menu';
    return ctx.reply("Menú principal:", { reply_markup: mainKeyboard.reply_markup });
  } catch (e) { console.error("replyMain error:", e && e.message); }
};

// -------------- Handlers ----------------
bot.start(async (ctx) => {
  ctx.session = {};
  ctx.session.step = 'main_menu';
  await appendLog(`Comienzo /start chat ${ctx.chat.id}`);
  await ctx.reply("👋 Hola! Soy el bot de devoluciones. ¿Qué querés hacer?", { reply_markup: mainKeyboard.reply_markup });
});

// /help command (shows commands)
bot.command('help', async (ctx) => {
  const text = `📋 Comandos disponibles:
/start - Muestra el menú principal
/help - Muestra esta ayuda
/generartickets - Genera tickets PDF pendientes desde Sheets y los sube a Drive
/listaproveedores - Lista proveedores y sus correos
/status - Muestra estado del bot y Sheets`;
  await ctx.reply(text);
});

// list providers quick command
bot.command('listaproveedores', async (ctx) => {
  const provs = await readProvidersFull();
  if (!provs.length) return ctx.reply("No hay proveedores cargados.");
  const formatted = provs.map(p => `• ${p.nombre} — ${p.correo || 'sin correo'}`).join("\n");
  await ctx.reply(`Proveedores:\n${formatted}`);
});

// /generartickets command - generates missing tickets (and uploads to Drive)
bot.command('generartickets', async (ctx) => {
  // only allowed users
  const uid = String(ctx.from?.id || '');
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(uid)) {
    return ctx.reply("🚫 No autorizado para ejecutar este comando.");
  }
  if (!sheetsInitialized) return ctx.reply("❌ Sheets no inicializado.");
  await ctx.reply("🔄 Generando tickets desde Sheets. Esto puede tardar...");
  let totalCreated = 0;
  const tabs = ["ElCholo","Ramirez","Tejada"];
  for (const t of tabs) {
    try {
      const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${t}!A2:I` });
      const rows = resp.data.values || [];
      for (let i = 0; i < rows.length; i++) {
        const rowIdx = i + 2;
        const row = rows[i];
        const fecha = row[0] || '';
        const proveedor = row[1] || '';
        const codigo = row[2] || '';
        const descripcion = row[3] || '';
        const cantidad = row[4] || '';
        const motivo = row[5] || '';
        const remito = row[6] || '';
        const fechaFactura = row[7] || '';
        // Unique filename using sheet, row number and provider
        const stamp = (fecha || new Date().toISOString()).toString().replace(/[:. ]/g,'-');
        const safeProv = (proveedor||'sinProv').replace(/\s+/g,'_').replace(/[^\w\-]/g,'');
        const fileName = `ticket_row${rowIdx}_${safeProv}_${stamp}.pdf`;
        const folderPath = path.join(TICKETS_BASE, t);
        const filePath = path.join(folderPath, fileName);
        // If file already exists skip
        const exists = await fsp.access(filePath).then(()=>true).catch(()=>false);
        if (exists) continue;
        // generate
        await fsp.mkdir(folderPath, { recursive: true });
        const ticketData = { remitente: t, remitenteDisplay: t, proveedor, codigo, descripcion, cantidad, motivo, remito, fechaFactura, usuario: 'sheet' };
        const pdfBuf = await generateTicketPDF(ticketData);
        await fsp.writeFile(filePath, pdfBuf);
        // upload to Drive
        try { await uploadToDrive(t, filePath, fileName); } catch(e){ console.warn("upload error:", e && e.message); }
        totalCreated++;
      }
    } catch (e) {
      console.error("generartickets error reading tab", t, e && e.message);
    }
  }
  await ctx.reply(`✅ Se generaron ${totalCreated} tickets nuevos y se subieron a Drive (si Drive estaba configurado).`);
});

// ----------------- Flow: registro -----------------
bot.action('registro', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  ctx.session.flow = 'registro';
  ctx.session.step = 'chooseRemitente';
  await ctx.reply("¿A qué empresa corresponde la devolución?", { reply_markup: remitenteKeyboard.reply_markup });
});

bot.action(/remitente_(.+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const remitenteAlias = ctx.match[1];
  ctx.session.remitente = remitenteAlias;
  ctx.session.remitenteDisplay = {
    ElCholo: 'El Cholo Repuestos (CUIT: 30-71634102-6)',
    Ramirez: 'Ramirez Cesar y Lois Gustavo S.H. (CUIT: 30-71144680-6)',
    Tejada: 'Tejada Carlos y Gomez Juan S.H. (CUIT: 30-70996969-9)'
  }[remitenteAlias] || remitenteAlias;
  ctx.session.step = 'chooseProveedor';
  const provs = await readProvidersFull();
  let buttons = [];
  (provs.slice(0,10)).forEach((p,i)=> buttons.push([Markup.button.callback(`${i+1}. ${p.nombre}`, `prov_${i}`)]));
  buttons.push([Markup.button.callback('Escribir otro proveedor', 'prov_other')]);
  buttons.push([Markup.button.callback('↩️ Cancelar', 'main')]);
  let msg = `Remitente: *${ctx.session.remitenteDisplay}*\nElegí proveedor (o escribí uno):`;
  if (!sheetsInitialized) {
    msg = `Remitente: *${ctx.session.remitenteDisplay}*\n⚠️ Sheets deshabilitado. Escribí el nombre del proveedor.`;
    ctx.session.step = 'proveedor_manual';
    return ctx.editMessageText(msg, { parse_mode: 'Markdown' });
  }
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(buttons).reply_markup });
  ctx.session.provList = provs;
});

bot.action(/prov_(\d+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const idx = Number(ctx.match[1]);
  const provObj = ctx.session.provList?.[idx];
  ctx.session.proveedor = provObj?.nombre || provObj || 'N/D';
  ctx.session.proveedorRow = provObj?.rowIndex || null; // useful to update email later
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
    await ctx.reply("❌ Función no disponible. Sheets deshabilitado.", mainKeyboard.reply_markup);
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
    await ctx.reply("❌ Función no disponible. Sheets deshabilitado.", mainKeyboard.reply_markup);
    return replyMain(ctx);
  }
  await ctx.reply("Buscando últimas devoluciones (las últimas 5 de cada remitente)...");
  const tabs = ["ElCholo","Ramirez","Tejada"];
  let messages = [];
  for (const t of tabs) {
    try {
      const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${t}!A2:I` });
      const rows = (resp.data.values || []).slice(-5).reverse();
      if (rows.length) messages.push(`*${t}*:\n` + rows.map(r=>`• ${r[0]} - ${r[1]} - ${r[4]}u - ${r[6] || 'sin nro'}`).join("\n"));
    } catch(e){
      console.error(`Error leyendo pestaña ${t}:`, e && e.message);
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
    await ctx.reply("❌ Función no disponible. Sheets deshabilitado.", mainKeyboard.reply_markup);
    return replyMain(ctx);
  }
  const provs = await readProvidersFull();
  if (!provs.length) { await ctx.reply("No hay proveedores cargados."); return replyMain(ctx); }
  const formatted = provs.map((p,i)=> `${i+1}. ${p.nombre} — ${p.correo || 'sin correo'}`).join("\n");
  await ctx.reply(`Proveedores:\n${formatted}`);
  await replyMain(ctx);
});

// ver tickets -> remitentes
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

bot.action(/^tickets_(.+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const remitente = ctx.match[1];
  const dirPath = path.join(TICKETS_BASE, remitente);
  const files = await fsp.readdir(dirPath).catch(()=>[]);
  if (!files || files.length === 0) { await ctx.reply(`📂 No hay tickets guardados para ${remitente}.`); return replyMain(ctx); }
  const available = files.slice(-50).reverse();
  const keyboard = available.map(f => [Markup.button.callback(f, `download_${remitente}_${f}`)]);
  keyboard.push([Markup.button.callback('↩️ Volver', 'ver_tickets')]);
  await ctx.reply(`Tickets disponibles para *${remitente}*:\nSeleccioná uno para descargar.`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
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

// MAIN text handler (add provider, registro flow, email input, etc.)
bot.on('text', async (ctx) => {
  const text = ctx.message.text?.trim();
  const chatId = ctx.chat.id;
  const userName = ctx.from?.first_name || ctx.from?.username || `User${chatId}`;
  await appendLog(`Mensaje de ${userName} (${chatId}): ${text}`);
  const s = ctx.session || {};

  // agregar proveedor
  if (s.flow === 'agregar_proveedor' && s.step === 'nuevo_proveedor') {
    if (!sheetsInitialized) {
      await ctx.reply("❌ No se puede agregar el proveedor. Sheets deshabilitado.", mainKeyboard.reply_markup);
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

  // registro flow
  if (s.flow === 'registro' || s.step) {
    if (s.step === 'proveedor_manual') {
      ctx.session.proveedor = text;
      ctx.session.proveedorRow = null;
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
      if (!/^\d+$/.test(text)) { await ctx.reply("⚠️ Ingresá solo números para la cantidad."); return; }
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
      if (!/^[\dA-Za-z\-\/]+$/.test(text)) { await ctx.reply("⚠️ Por favor ingresá un número válido."); return; }
      ctx.session.remito = text;
      ctx.session.step = 'fechaFactura';
      await ctx.reply("Fecha de factura (DD/MM/AAAA): Ej: 25/11/2025");
      return;
    }
    if (s.step === 'fechaFactura') {
      const raw = text.trim().replace(/[.\-]/g, '/');
      const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!match) { await ctx.reply("⚠️ Fecha inválida. Usá DD/MM/AAAA."); return; }
      const dd = parseInt(match[1],10), mm = parseInt(match[2],10), yyyy = parseInt(match[3],10);
      if (dd<1||dd>31||mm<1||mm>12||yyyy<1900) { await ctx.reply("⚠️ Fecha inválida. Reingresá."); return; }
      const daysInMonth = [31, ((yyyy%4===0&&yyyy%100!==0)|| (yyyy%400===0))?29:28,31,30,31,30,31,31,30,31,30,31];
      if (dd > daysInMonth[mm-1]) { await ctx.reply("⚠️ Fecha inválida para ese mes."); return; }
      ctx.session.fechaFactura = `${String(dd).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${yyyy}`;
      ctx.session.step = 'pre_confirm';

      // Show summary and ask email question (buttons)
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
      const askEmailKb = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Sí','email_yes'), Markup.button.callback('❌ No','email_no')],
        [Markup.button.callback('✏️ Cancelar','main')]
      ]);
      await ctx.reply(summary, { parse_mode: 'Markdown' });
      await ctx.reply("¿Deseás enviar la devolución por correo electrónico?", askEmailKb.reply_markup);
      return;
    }

    // Input for emailDestino (when user chose to enter new)
    if (s.step === 'email_destino') {
      const email = text;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { await ctx.reply("⚠️ Email inválido. Ingresalo nuevamente."); return; }
      ctx.session.emailDestino = email;
      // If provider exists in providers sheet, update its email
      if (ctx.session.proveedor) {
        try {
          const prov = await findProviderRowByName(ctx.session.proveedor);
          if (prov) {
            await updateProviderEmail(prov.rowIndex, email);
            await appendLog(`Proveedor ${prov.nombre} actualizado con email ${email}`);
          } else {
            // Optionally add to providers sheet
            await addProviderRow(ctx.session.proveedor, email, '');
            await appendLog(`Proveedor ${ctx.session.proveedor} agregado con email ${email}`);
          }
        } catch (e) {
          console.error("Error actualizando proveedor con email:", e && e.message);
        }
      }

      ctx.session.step = 'confirm';
      const confirmationKeyboard = Markup.inlineKeyboard([
        Markup.button.callback('✅ Confirmar y guardar','confirm_save'),
        Markup.button.callback('✏️ Cancelar','main')
      ]).reply_markup;
      await ctx.reply(`Correo destino: ${email}\nConfirmá para guardar la devolución.`, { reply_markup: confirmationKeyboard, parse_mode: 'Markdown' });
      return;
    }
  }

  // fallback Gemini (if configured)
  if (GEMINI_API_KEY) {
    try {
      const payload = {
        contents: [{ parts: [{ text }] }],
        systemInstruction: {
          parts: [{ text: "Eres un asistente amigable que redirige al menú principal para funciones del bot." }]
        },
        generationConfig: { maxOutputTokens: 256 }
      };
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;
      const aiResp = await axios.post(apiUrl, payload);
      const reply = aiResp.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Perdón, no entendí. Usá el menú.";
      await ctx.reply(reply, mainKeyboard.reply_markup);
      return;
    } catch (e) { console.error("Gemini error:", e && e.message); }
  }

  await ctx.reply("No entendí eso. Usá los botones del menú o escribí /help.", mainKeyboard.reply_markup);
});

// email_yes handler: check provider email and offer options
bot.action('email_yes', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const provName = ctx.session.proveedor;
  if (!provName) {
    ctx.session.step = 'email_destino';
    await ctx.reply("No pude identificar el proveedor. Ingresá el correo del destinatario:");
    return;
  }
  // find provider email
  const prov = await findProviderRowByName(provName);
  if (prov && prov.correo) {
    // show options: use saved or enter another
    ctx.session.step = 'choose_email_option';
    ctx.session.providerRow = prov.rowIndex || null;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback(`📧 Usar: ${prov.correo}`, `use_saved_email_${prov.rowIndex}`)],
      [Markup.button.callback('✏️ Ingresar otro correo', 'enter_new_email')],
      [Markup.button.callback('↩️ Cancelar', 'main')]
    ]);
    await ctx.reply(`Se encontró correo para *${prov.nombre}*: ${prov.correo}`, { parse_mode: 'Markdown', reply_markup: kb.reply_markup });
  } else {
    // no email -> ask to enter
    ctx.session.step = 'email_destino';
    await ctx.reply("No hay correo guardado para este proveedor. Ingresá la dirección de correo del destinatario:");
  }
});

// use saved email action
bot.action(/^use_saved_email_(\d+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const rowIndex = Number(ctx.match[1]);
  // read providers to get email
  const list = await readProvidersFull();
  const prov = list.find(p => p.rowIndex === rowIndex);
  if (!prov || !prov.correo) {
    await ctx.reply("No se encontró el correo guardado. Ingresá uno nuevo.");
    ctx.session.step = 'email_destino';
    return;
  }
  ctx.session.emailDestino = prov.correo;
  ctx.session.step = 'confirm';
  const confirmationKeyboard = Markup.inlineKeyboard([
    Markup.button.callback('✅ Confirmar y guardar','confirm_save'),
    Markup.button.callback('✏️ Cancelar','main')
  ]).reply_markup;
  await ctx.reply(`Se usará el correo: ${prov.correo}\nConfirmá para guardar la devolución.`, { reply_markup: confirmationKeyboard, parse_mode: 'Markdown' });
});

// enter_new_email action
bot.action('enter_new_email', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  ctx.session.step = 'email_destino';
  await ctx.reply("Ingresá la dirección de correo del destinatario:");
});

// email_no action -> don't send email
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

// confirm_save: save to sheet, generate pdf, save local, upload drive, send pdf, send email if requested
bot.action('confirm_save', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch(e) {}
  const s = ctx.session;
  if (!s || !s.remitente) { await ctx.reply("No hay datos para guardar."); return replyMain(ctx); }
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
      await ctx.reply("⚠️ Sheets deshabilitado. No se guardó en la hoja.");
    }
  } catch (err) {
    console.error("Error guardando en Sheets:", err && err.message);
    sheetsError = true;
    await ctx.reply("⚠️ Ocurrió un error al guardar en Google Sheets.");
  }

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

      // send pdf to user
      try { await ctx.replyWithDocument({ source: filePath, filename: fileName }, { caption: "🎟️ Aquí está tu ticket de devolución." }); } catch(e){ console.error("Error enviar pdf:", e && e.message); }

      // upload to drive
      const driveUrl = await uploadToDrive(tab, filePath, fileName);
      if (driveUrl) await ctx.reply(`☁️ Ticket guardado en Drive:\n${driveUrl}`);

      // if emailDestino present, send email (and update provider email if necessary)
      if (s.emailDestino) {
        // If provider row known and empty, update provider email
        try {
          if (s.proveedorRow && (! (await findProviderRowByName(s.proveedor))?.correo)) {
            await updateProviderEmail(s.proveedorRow, s.emailDestino);
          }
        } catch(e){ console.warn("No se actualizó proveedor:", e && e.message); }

        const sendOk = await sendEmailWithAttachment(s.remitenteDisplay, s.emailDestino, filePath, fileName, ticketData, driveUrl);
        if (sendOk) await ctx.reply(`📧 Correo enviado a ${s.emailDestino} (cc: ${INTERNAL_NOTIFY_EMAIL}).`);
        else await ctx.reply("⚠️ No se pudo enviar el correo. Revisá MAIL_USER/MAIL_PASS.");
      }

    } catch (e) {
      console.error("Error generando/enviando PDF:", e && e.message);
      await ctx.reply("⚠️ Error al generar/enviar el ticket PDF.");
    }
  }

  ctx.session = {};
  return replyMain(ctx);
});

// -------------- Init (Sheets/Drive/Mailer) --------------
(async () => {
  console.log("Inicializando Sheets, Drive y Mailer...");
  await initSheets();
  await initDrive();
  initMailer();
  // Launch bot
  if (WEBHOOK_URL) {
    const secretPath = `/telegraf/${BOT_TOKEN}`;
    app.use(bot.webhookCallback(secretPath));
    try { await bot.telegram.setWebhook(`${WEBHOOK_URL}${secretPath}`); botStatus = "conectado (webhook)"; } catch(e){ console.error("Webhook error:", e && e.message); }
  } else {
    try { await bot.launch(); botStatus = "conectado (polling)"; } catch(e){ console.error("Launch error:", e && e.message); }
  }
  process.once('SIGINT', ()=>bot.stop('SIGINT'));
  process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
  console.log("✅ Bot iniciado.");
})();

// ------------- Utility functions to add provider row --------------
async function addProviderRow(nombre, correo, direccion) {
  if (!sheetsInitialized) throw new Error("Sheets no inicializado.");
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `Proveedores!A:C`,
    valueInputOption: "RAW",
    requestBody: { values: [[nombre || '', correo || '', direccion || '']] }
  });
}

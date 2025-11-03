import { promises as fs } from "fs";
import express from "express";
import { Telegraf, Markup, session } from "telegraf";
import PDFDocument from "pdfkit";
import { google } from "googleapis";
import axios from "axios";

// --- CONFIG/ENV ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null;
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "1BFGsZaUwvxV4IbCgXNOp5IrMYLVn-czVYpdxTleOBgo";
const GOOGLE_SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "./gen-lang-client-0104843305-b3e3d726d218.json";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const LOG_FILE = "logs.txt";
const PORT = process.env.PORT || 3000;
const LOGO_PATH = "./REPUESTOS EL CHOLO LOGO.png";

if (!BOT_TOKEN) throw new Error("FATAL: BOT_TOKEN no definido en variables de entorno.");

// --- Express ---
const app = express();
let botStatus = "iniciando";
app.get("/", (req, res) => {
  res.send(`<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10"></head><body style="font-family: Arial, Helvetica, sans-serif; padding:20px;"><h2>🤖 Bot de Telegram - Repuestos El Cholo</h2><div>Estado: <b>${botStatus}</b></div><p>El bot escucha mensajes por Telegram.</p></body></html>`);
});
app.get("/status", (req, res) => res.json({ status: botStatus }));
app.listen(PORT, () => console.log(`Express escuchando en ${PORT}`));

// --- Bot ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());
const remitenteKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('1️⃣ El Cholo Repuestos (CUIT: 30716341026)', 'remitente_ElCholo')],
  [Markup.button.callback('2️⃣ Ramirez Cesar y Lois Gustavo S.H. (CUIT: 30711446806)', 'remitente_Ramirez')],
  [Markup.button.callback('3️⃣ Tejada Carlos y Gomez Juan S.H. (CUIT: 30709969699)', 'remitente_Tejada')],
  [Markup.button.callback('↩️ Volver', 'main')]
]);
const mainKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('📦 Registrar devolución', 'registro')],
  [Markup.button.callback('🔍 Consultar devoluciones', 'consultar')],
  [Markup.button.callback('📋 Ver estado', 'ver_estado'), Markup.button.callback('🏢 Ver proveedores', 'ver_proveedores')],
  [Markup.button.callback('➕ Agregar proveedor', 'agregar_proveedor')]
]);

// --- Google Sheets ---
let sheetsClient = null;
async function initSheets() {
  try {
    const key = JSON.parse(await fs.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, "utf8"));
    const jwt = new google.auth.JWT(key.client_email, null, key.private_key, ["https://www.googleapis.com/auth/spreadsheets"]);
    await jwt.authorize();
    sheetsClient = google.sheets({ version: "v4", auth: jwt });
    await ensureSheetTabs(["ElCholo","Ramirez","Tejada","Proveedores"]);
    console.log("✅ Google Sheets inicializado.");
  } catch (e) {
    console.warn("⚠️ No se pudo inicializar Google Sheets:", e.message);
  }
}

async function ensureSheetTabs(tabNames) {
  if (!sheetsClient) return;
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = (meta.data.sheets || []).map(s => s.properties.title);
  const requests = tabNames.filter(t => !existing.includes(t)).map(title => ({ addSheet: { properties: { title } } }));
  if (requests.length) {
    await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  }
  // ensure headers
  for (const t of tabNames) {
    try {
      const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${t}!A1:I1` });
      if (!resp.data.values || resp.data.values.length === 0) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${t}!A1:I1`,
          valueInputOption: "RAW",
          requestBody: { values: [["Fecha","Proveedor","Código Producto","Descripción","Cantidad","Motivo","N° Remito/Factura","Fecha Factura","UsuarioID"]] }
        });
      }
    } catch (e) {
      // set headers if any error (sheet may be empty)
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${t}!A1:I1`,
        valueInputOption: "RAW",
        requestBody: { values: [["Fecha","Proveedor","Código Producto","Descripción","Cantidad","Motivo","N° Remito/Factura","Fecha Factura","UsuarioID"]] }
      }).catch(()=>{});
    }
  }
}

async function appendRowToSheet(tab, row) {
  if (!sheetsClient) throw new Error("Sheets no inicializado");
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:I`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

async function readProviders() {
  if (!sheetsClient) return [];
  const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Proveedores!A2:A` }).catch(()=>({ data: { values: [] }}));
  const vals = resp.data.values || [];
  return vals.map(v=>v[0]).filter(Boolean);
}

async function addProvider(name) {
  if (!sheetsClient) throw new Error("Sheets no inicializado");
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `Proveedores!A:A`,
    valueInputOption: "RAW",
    requestBody: { values: [[name]] }
  });
}

// --- Helpers ---
async function appendLog(message) {
  const ts = new Date().toISOString();
  await fs.appendFile(LOG_FILE, `[${ts}] ${message}\n`).catch(()=>{});
}

// PDF ticket generator (estético: red + dark blue)
async function generateTicketPDF(data) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const chunks = [];
      doc.on("data", c=>chunks.push(c));
      doc.on("end", ()=>resolve(Buffer.concat(chunks)));

      const RED = "#C8102E";
      const BLUE = "#0B3B70";

      // logo
      try {
        const logo = await fs.readFile(LOGO_PATH);
        doc.image(logo, 40, 40, { width: 120 });
      } catch(e){}

      doc.fillColor(BLUE).fontSize(20).font("Helvetica-Bold").text("Ticket de Devolución", { align: "right" });
      doc.moveDown(0.5);
      doc.fillColor("black").fontSize(11).font("Helvetica");
      doc.text(`Fecha registro: ${new Date().toLocaleString()}`, { align: "right" });
      doc.moveDown(1);

      // box with details
      const startY = doc.y;
      doc.rect(40, startY, 515, 180).strokeColor(RED).lineWidth(1).stroke();
      doc.moveDown(0.5);
      doc.fontSize(12).fillColor(BLUE).text(`Remitente: `, 50, startY + 10, { continued: true }).fillColor("black").text(`${data.remitente}`);
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
    } catch (err) { reject(err); }
  });
}

// --- Flows/keyboards ---
const replyMain = async (ctx) => { ctx.session = {}; return ctx.reply("Menú principal:", mainKeyboard); };

bot.start(async (ctx) => {
  ctx.session = {};
  await appendLog(`Comienzo /start chat ${ctx.chat.id}`);
  await ctx.reply("👋 Hola! Soy el bot de devoluciones. ¿Qué querés hacer?", mainKeyboard);
});

bot.action('main', async (ctx)=>{ await ctx.answerCbQuery(); await replyMain(ctx); });
bot.action('registro', async (ctx)=>{ await ctx.answerCbQuery(); ctx.session.flow='registro'; ctx.session.step='chooseRemitente'; await ctx.editMessageText("¿A qué empresa corresponde la devolución?", remitenteKeyboard); });

bot.action(/remitente_(.+)/, async (ctx)=>{
  await ctx.answerCbQuery();
  const remitente = ctx.match[1];
  ctx.session.remitente = remitente;
  ctx.session.step = 'chooseProveedor';
  const provs = await readProviders();
  let buttons = [];
  (provs.slice(0,10)).forEach((p,i)=> buttons.push([Markup.button.callback(`${i+1}. ${p}`, `prov_${i}`)]));
  buttons.push([Markup.button.callback('Escribir otro proveedor', 'prov_other')]);
  buttons.push([Markup.button.callback('↩️ Cancelar', 'main')]);
  await ctx.editMessageText(`Remitente elegido: *${remitente}*\nElegí proveedor (o escribí uno):`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  ctx.session.provList = provs;
});

bot.action(/prov_(\d+)/, async (ctx)=>{
  await ctx.answerCbQuery();
  const idx = Number(ctx.match[1]);
  const prov = ctx.session.provList?.[idx];
  ctx.session.proveedor = prov || 'N/D';
  ctx.session.step = 'codigo';
  await ctx.editMessageText(`Proveedor seleccionado: *${ctx.session.proveedor}*.\nEnviá el *código del producto* (texto).`, { parse_mode: 'Markdown' });
});

bot.action('prov_other', async (ctx)=>{ await ctx.answerCbQuery(); ctx.session.step='proveedor_manual'; await ctx.editMessageText("Escribí el nombre del proveedor (texto)."); });

bot.action('agregar_proveedor', async (ctx)=>{ await ctx.answerCbQuery(); ctx.session.flow='agregar_proveedor'; ctx.session.step='nuevo_proveedor'; await ctx.editMessageText("Escribí el *nombre del proveedor* que querés agregar:", { parse_mode: 'Markdown' }); });

bot.action('consultar', async (ctx)=>{
  await ctx.answerCbQuery();
  await ctx.reply("Buscando últimas devoluciones (las últimas 5 de cada remitente). Esto puede tardar un segundo...");
  const tabs = ["ElCholo","Ramirez","Tejada"];
  let messages = [];
  for (const t of tabs) {
    try {
      const resp = await (sheetsClient ? sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${t}!A2:I` }) : Promise.resolve({ data: { values: [] } }));
      const rows = (resp.data.values || []).slice(-5).reverse();
      if (rows.length) messages.push(`*${t}*:\n` + rows.map(r=>`• ${r[0]} - ${r[1]} - ${r[4]}u - ${r[6] || 'sin nro'}`).join("\n"));
    } catch(e){}
  }
  if (!messages.length) await ctx.reply("No se encontraron devoluciones.");
  else await ctx.reply(messages.join("\n\n"), { parse_mode: 'Markdown' });
});

bot.action('ver_proveedores', async (ctx)=>{ await ctx.answerCbQuery(); const provs = await readProviders(); if (!provs.length) return ctx.reply("No hay proveedores cargados."); const formatted = provs.map((p,i)=> `${i+1}. ${p}`).join("\n"); await ctx.reply(`Proveedores:\n${formatted}`); });

bot.action('ver_estado', async (ctx)=>{ await ctx.answerCbQuery(); await ctx.reply(`Estado del bot: ${botStatus}`); });

bot.on('text', async (ctx)=>{
  const text = ctx.message.text?.trim();
  const chatId = ctx.chat.id;
  const userName = ctx.from?.first_name || ctx.from?.username || `User${chatId}`;
  await appendLog(`Mensaje de ${userName} (${chatId}): ${text}`);
  const s = ctx.session || {};

  if (s.flow === 'agregar_proveedor' && s.step === 'nuevo_proveedor') {
    const name = text;
    await addProvider(name);
    await ctx.reply(`✅ Proveedor *${name}* agregado.`, { parse_mode: 'Markdown' });
    ctx.session = {};
    return replyMain(ctx);
  }

  if (s.flow === 'registro' || s.step) {
    if (s.step === 'proveedor_manual') { ctx.session.proveedor = text; ctx.session.step = 'codigo'; return ctx.reply("Perfecto. Ahora enviá el código del producto."); }
    if (s.step === 'codigo') { ctx.session.codigo = text; ctx.session.step = 'descripcion'; return ctx.reply("Descripción del producto:"); }
    if (s.step === 'descripcion') { ctx.session.descripcion = text; ctx.session.step = 'cantidad'; return ctx.reply("Cantidad (número):"); }
    if (s.step === 'cantidad') { ctx.session.cantidad = text; ctx.session.step = 'motivo'; return ctx.reply("Motivo de la devolución:"); }
    if (s.step === 'motivo') { ctx.session.motivo = text; ctx.session.step = 'remito'; return ctx.reply("Número de remito/factura:"); }
    if (s.step === 'remito') { ctx.session.remito = text; ctx.session.step = 'fechaFactura'; return ctx.reply("Fecha de factura (DD/MM/AAAA):"); }
    if (s.step === 'fechaFactura') {
      ctx.session.fechaFactura = text;
      const summary = `*Resumen de la devolución:*

Remitente: *${ctx.session.remitente}*
Proveedor: *${ctx.session.proveedor}*
Código: ${ctx.session.codigo}
Descripción: ${ctx.session.descripcion}
Cantidad: ${ctx.session.cantidad}
Motivo: ${ctx.session.motivo}
N° Remito/Factura: ${ctx.session.remito}
Fecha factura: ${ctx.session.fechaFactura}
      `;
      ctx.session.step = 'confirm';
      return ctx.reply(summary, Markup.inlineKeyboard([ Markup.button.callback('✅ Confirmar y guardar','confirm_save'), Markup.button.callback('✏️ Cancelar','main') ]).extra({ parse_mode: 'Markdown' }));
    }
  }

  // fallback: Gemini AI
  if (GEMINI_API_KEY) {
    try {
      const aiResp = await axios.post("https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateText?key=" + GEMINI_API_KEY, {
        "prompt": text,
        "maxOutputTokens": 256
      });
      const reply = aiResp.data?.candidates?.[0]?.output || "Perdón, no entendí. Podés usar el menú.";
      await ctx.reply(reply);
      return;
    } catch (e) {
      console.error("Error Gemini:", e.message);
    }
  }

  await ctx.reply("No entendí eso — elegí una opción:", mainKeyboard);
});

bot.action('confirm_save', async (ctx)=>{
  await ctx.answerCbQuery();
  const s = ctx.session;
  if (!s || !s.remitente) return ctx.reply("No hay datos para guardar. Volvé al menú.", mainKeyboard);
  const tab = s.remitente;
  const row = [ new Date().toLocaleString(), s.proveedor||'', s.codigo||'', s.descripcion||'', s.cantidad||'', s.motivo||'', s.remito||'', s.fechaFactura||'', String(ctx.chat.id) ];
  try {
    await appendRowToSheet(tab, row);
    await ctx.reply("✅ Devolución registrada correctamente.");
    await appendLog(`Devolución guardada en ${tab} por ${ctx.from?.first_name} (${ctx.chat.id})`);

    const ticketData = { remitente: tab, proveedor: s.proveedor, codigo: s.codigo, descripcion: s.descripcion, cantidad: s.cantidad, motivo: s.motivo, remito: s.remito, fechaFactura: s.fechaFactura, usuario: ctx.from?.first_name || ctx.from?.username || String(ctx.chat.id) };
    const pdfBuf = await generateTicketPDF(ticketData);

    if (OWNER_CHAT_ID) {
      try {
        await bot.telegram.sendDocument(OWNER_CHAT_ID, { source: pdfBuf, filename: `ticket_${Date.now()}.pdf` }, { caption: `Nueva devolución registrada en ${tab}` });
      } catch(e){ console.error("Error enviando notificación al owner:", e.message); }
    }

    ctx.session = {};
    return replyMain(ctx);
  } catch (err) {
    console.error("Error guardando en Sheets:", err.message);
    await ctx.reply("Ocurrió un error al guardar. Avisá al administrador.");
    return replyMain(ctx);
  }
});

// init and launch
(async ()=>{
  try { await initSheets(); } catch(e){ console.warn("Sheets init failed:", e.message); }
  await bot.launch();
  botStatus = "conectado";
  console.log("✅ Bot de Telegram iniciado.");
})();

process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));

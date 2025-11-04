import { promises as fs } from "fs";
import express from "express";
import { Telegraf, Markup } from "telegraf"; 
import LocalSession from 'telegraf-session-local'; 
import PDFDocument from "pdfkit";
import { google } from "googleapis";
import axios from "axios";

// --- CONFIG/ENV ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null;

// ID de la hoja de cálculo
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "1BFGsZaUwvxV4IbGgXNOp5IrMYLVn-czVYpdxTleOBgo"; // ID de ejemplo

// Credenciales: SE ESPERA QUE ESTE ARCHIVO ESTÉ EN EL DISCO (subido como Secret File)
const GOOGLE_SERVICE_ACCOUNT_FILE = "./gen-lang-client-0104843305-3b7345de7ec0.json"; 

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const LOG_FILE = "logs.txt";
const PORT = process.env.PORT || 3000;
const LOGO_PATH = "./REPUESTOS EL CHOLO LOGO.png"; // RUTA DEL LOGO (DEBE ESTAR SUBIDO)
// NUEVA CONFIGURACIÓN: URL pública para Webhooks
const WEBHOOK_URL = process.env.WEBHOOK_URL; 

if (!BOT_TOKEN) throw new Error("FATAL: BOT_TOKEN no definido en variables de entorno.");

// --- Express ---
const app = express();
let botStatus = "iniciando";
let sheetsErrorDetail = "Intentando inicializar Google Sheets...";

app.get("/", (req, res) => {
  res.send(`<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10"></head><body style="font-family: Arial, Helvetica, sans-serif; padding:20px;"><h2>🤖 Bot de Telegram - Repuestos El Cholo</h2><div>Estado: <b>${botStatus}</b></div><p>El bot escucha mensajes por Telegram.</p></body></html>`);
});
app.get("/status", (req, res) => res.json({ status: botStatus, sheetsStatus: sheetsInitialized ? "OK" : sheetsErrorDetail }));
app.listen(PORT, () => console.log(`Express escuchando en ${PORT}`));

// --- Bot ---
const bot = new Telegraf(BOT_TOKEN);

// Middleware de sesión con persistencia
bot.use(
  (new LocalSession({ 
    database: 'session_db.json' 
  })).middleware()
);

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
let sheetsInitialized = false;

async function initSheets() {
  sheetsErrorDetail = "Cargando...";
  if (!SHEET_ID) {
    sheetsErrorDetail = "SHEET_ID no definido.";
    console.warn("⚠️ Advertencia: SHEET_ID no está definido. La funcionalidad de Google Sheets estará deshabilitada.");
    return;
  }
  
  let key;
  
  try {
      console.log("Intentando leer credenciales desde archivo local...");
      const keyFileContent = await fs.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, "utf8");
      key = JSON.parse(keyFileContent);

      if (!key || !key.client_email || !key.private_key) {
          throw new Error("Credenciales JSON incompletas o mal formadas.");
      }
      
      // FIX CRÍTICO: SANITIZACIÓN DE CLAVE PRIVADA
      const privateKey = key.private_key.replace(/\\n/g, '\n'); 

      const jwt = new google.auth.JWT(key.client_email, null, privateKey, ["https://www.googleapis.com/auth/spreadsheets"]);
      await jwt.authorize();
      sheetsClient = google.sheets({ version: "v4", auth: jwt });
      
      // Aseguramos que las pestañas existan
      await ensureSheetTabs(["ElCholo","Ramirez","Tejada","Proveedores"]);
      
      sheetsInitialized = true;
      sheetsErrorDetail = "OK";
      console.log("✅ Google Sheets inicializado correctamente.");
  } catch (e) {
    // Si falla, solo advertir y deshabilitar Sheets.
    sheetsErrorDetail = e.message.includes('ENOENT') 
      ? `ARCHIVO NO ENCONTRADO (${GOOGLE_SERVICE_ACCOUNT_FILE})`
      : `FALLO DE AUTENTICACIÓN: ${e.message}`;
    
    console.warn(`⚠️ Error CRÍTICO al inicializar Google Sheets. Funcionalidad DESHABILITADA: ${e.message}`);
    sheetsInitialized = false;
    sheetsClient = null;
  }
}

async function ensureSheetTabs(tabNames) {
  if (!sheetsInitialized) return;
  try {
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existing = (meta.data.sheets || []).map(s => s.properties.title);
    const requests = tabNames.filter(t => !existing.includes(t)).map(title => ({ addSheet: { properties: { title } } }));
    
    if (requests.length) {
      await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
    }
    
    // ensure headers
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
        // set headers if any error (sheet may be empty)
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
  // Lectura de proveedores, ignora el encabezado (A2:A)
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
        // LECTURA DEL LOGO: ESTO ES CRÍTICO. DEBE ESTAR SUBIDO.
        const logo = await fs.readFile(LOGO_PATH);
        doc.image(logo, 40, 40, { width: 120 });
      } catch(e){
        // Si el logo falla, no fallamos todo el PDF, solo usamos texto como fallback
        console.warn(`Advertencia: No se pudo cargar el logo en ${LOGO_PATH}. Asegúrate de que el archivo esté subido: ${e.message}`);
        doc.fillColor(RED).fontSize(10).text("REPUESTOS EL CHOLO (Logo Faltante)", 40, 40);
      }

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

// Función central para enviar el menú, ahora usa el método `reply` para mayor compatibilidad
const replyMain = async (ctx) => { 
  ctx.session = {}; // Resetear sesión
  ctx.session.step = 'main_menu'; // Establecer un estado inicial seguro
  // Uso explícito de `reply` con las opciones del teclado
  return ctx.reply("Menú principal:", {
    reply_markup: mainKeyboard.reply_markup
  });
};

bot.start(async (ctx) => {
  ctx.session = {};
  ctx.session.step = 'main_menu'; // Establecer un estado inicial seguro
  await appendLog(`Comienzo /start chat ${ctx.chat.id}`);
  // Usamos `ctx.reply` con las opciones del teclado.
  await ctx.reply("👋 Hola! Soy el bot de devoluciones. ¿Qué querés hacer?", {
    reply_markup: mainKeyboard.reply_markup
  });
});

// Nuevo Handler: Comando /help (solicitado)
bot.command('help', async (ctx) => {
  await ctx.reply("Soy el Bot de Devoluciones de Repuestos El Cholo. Solo respondo a los comandos y botones del menú.\n\nComandos:\n/start - Muestra el menú principal.\n/help - Muestra esta ayuda.\n\nPara interactuar, usá los botones del Menú Principal.", mainKeyboard.reply_markup);
});


bot.action('main', async (ctx)=>{ 
  try{ await ctx.answerCbQuery(); } catch(e){} 
  // Al volver al menú principal desde una acción, usamos `replyMain` que siempre envía un mensaje nuevo
  await replyMain(ctx); 
});

bot.action('registro', async (ctx)=>{ 
  try{ 
    // Siempre intentamos responder a la consulta de callback para evitar el estado de "cargando"
    await ctx.answerCbQuery(); 
  } catch(e){} 
  
  ctx.session.flow='registro'; 
  ctx.session.step='chooseRemitente'; 
  
  // *** CAMBIO CRÍTICO: Usamos ctx.reply en lugar de ctx.editMessageText ***
  // Esto envía un mensaje nuevo, asegurando que el teclado de empresas aparezca.
  await ctx.reply("¿A qué empresa corresponde la devolución?", { 
      reply_markup: remitenteKeyboard.reply_markup 
  }); 
});

bot.action(/remitente_(.+)/, async (ctx)=>{
  try{ await ctx.answerCbQuery(); } catch(e){} 
  const remitente = ctx.match[1];
  ctx.session.remitente = remitente;
  ctx.session.step = 'chooseProveedor';
  
  const provs = await readProviders(); // Lee proveedores (maneja si Sheets no está inicializado)
  let buttons = [];
  // Solo mostramos los primeros 10 proveedores
  (provs.slice(0,10)).forEach((p,i)=> buttons.push([Markup.button.callback(`${i+1}. ${p}`, `prov_${i}`)]));
  
  buttons.push([Markup.button.callback('Escribir otro proveedor', 'prov_other')]);
  buttons.push([Markup.button.callback('↩️ Cancelar', 'main')]);
  
  let msg = `Remitente elegido: *${remitente}*\nElegí proveedor (o escribí uno):`;
  if (!sheetsInitialized) {
    msg = `Remitente elegido: *${remitente}*\n⚠️ La integración con Sheets está deshabilitada. Escribí el nombre del proveedor.`;
    ctx.session.step = 'proveedor_manual'; 
    return ctx.editMessageText(msg, { parse_mode: 'Markdown' });
  }

  // Aquí sí podemos usar editMessageText porque estamos en una acción de callback.
  await ctx.editMessageText(msg, { 
    parse_mode: 'Markdown', 
    reply_markup: Markup.inlineKeyboard(buttons).reply_markup 
  });
  ctx.session.provList = provs;
});

bot.action(/prov_(\d+)/, async (ctx)=>{
  try{ await ctx.answerCbQuery(); } catch(e){} 
  const idx = Number(ctx.match[1]);
  const prov = ctx.session.provList?.[idx];
  ctx.session.proveedor = prov || 'N/D';
  ctx.session.step = 'codigo';
  await ctx.editMessageText(`Proveedor seleccionado: *${ctx.session.proveedor}*.\nEnviá el *código del producto* (texto).`, { parse_mode: 'Markdown' });
});

bot.action('prov_other', async (ctx)=>{ 
  try{ await ctx.answerCbQuery(); } catch(e){} 
  ctx.session.step='proveedor_manual'; 
  await ctx.editMessageText("Escribí el nombre del proveedor (texto)."); 
});

bot.action('agregar_proveedor', async (ctx)=>{ 
  try{ await ctx.answerCbQuery(); } catch(e){} 
  if (!sheetsInitialized) {
    return ctx.reply("❌ Función no disponible. La integración con Google Sheets está deshabilitada.", mainKeyboard.reply_markup);
  }
  ctx.session.flow='agregar_proveedor'; 
  ctx.session.step='nuevo_proveedor'; 
  await ctx.editMessageText("Escribí el *nombre del proveedor* que querés agregar:", { parse_mode: 'Markdown' }); 
});

bot.action('consultar', async (ctx)=>{
  try { await ctx.answerCbQuery(); } catch(e) { console.warn("Callback query timed out (consultar).", e.message); }
  
  if (!sheetsInitialized) {
    return ctx.reply("❌ Función no disponible. La integración con Google Sheets está deshabilitada.", mainKeyboard.reply_markup);
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
});

bot.action('ver_proveedores', async (ctx)=>{ 
  try{ await ctx.answerCbQuery(); } catch(e){} 
  if (!sheetsInitialized) {
    return ctx.reply("❌ Función no disponible. La integración con Google Sheets está deshabilitada.", mainKeyboard.reply_markup);
  }

  const provs = await readProviders(); 
  if (!provs.length) return ctx.reply("No hay proveedores cargados."); 
  const formatted = provs.map((p,i)=> `${i+1}. ${p}`).join("\n"); 
  await ctx.reply(`Proveedores:\n${formatted}`); 
});

bot.action('ver_estado', async (ctx)=>{ 
  try{ await ctx.answerCbQuery(); } catch(e){} 
  let sheetsStatus = sheetsInitialized ? "✅ Habilitada" : `❌ Deshabilitada. Detalle: ${sheetsErrorDetail}`;
  await ctx.reply(`Estado del bot: ${botStatus}\nIntegración con Sheets: ${sheetsStatus}`); 
});

bot.on('text', async (ctx)=>{
  const text = ctx.message.text?.trim();
  const chatId = ctx.chat.id;
  const userName = ctx.from?.first_name || ctx.from?.username || `User${chatId}`;
  await appendLog(`Mensaje de ${userName} (${chatId}): ${text}`);
  const s = ctx.session || {};

  if (s.flow === 'agregar_proveedor' && s.step === 'nuevo_proveedor') {
    if (!sheetsInitialized) {
      return ctx.reply("❌ No se puede agregar el proveedor. La integración con Google Sheets está deshabilitada.", mainKeyboard.reply_markup);
    }
    const name = text;
    try {
      await addProvider(name);
      await ctx.reply(`✅ Proveedor *${name}* agregado.`, { parse_mode: 'Markdown' });
    } catch(e) {
      console.error("Error al agregar proveedor:", e.message);
      await ctx.reply("Ocurrió un error al agregar el proveedor.");
    }
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
      
      return ctx.reply(summary, 
        Markup.inlineKeyboard([ 
          Markup.button.callback('✅ Confirmar y guardar','confirm_save'), 
          Markup.button.callback('✏️ Cancelar','main') 
        ]).reply_markup, 
        { parse_mode: 'Markdown' }
      );
    }
  }

  // fallback: Gemini AI
  if (GEMINI_API_KEY) {
    try {
      // Cambio CRÍTICO: 'config' ha sido cambiado a 'generationConfig'
      const payload = {
          contents: [{ parts: [{ text: text }] }],
          // Añadimos un systemInstruction para darle contexto de bot de repuestos
          systemInstruction: {
              parts: [{ text: "Eres un asistente amigable y formal que responde preguntas generales, pero siempre sugiere usar el menú principal para las funciones del bot de devoluciones de Repuestos El Cholo." }]
          },
          generationConfig: {
            maxOutputTokens: 256
          }
      };

      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;

      const aiResp = await axios.post(apiUrl, payload);

      const reply = aiResp.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Perdón, no entendí. Podés usar el menú.";
      
      await ctx.reply(reply, mainKeyboard.reply_markup); 
      
      return;
    } catch (e) {
      console.error("--- Error en la llamada a Gemini ---");
      if (e.response) {
        // El servidor respondió con un código de estado fuera de 2xx
        console.error(`Error Gemini: Status ${e.response.status}. Data:`, e.response.data);
        // Si el status es 400, la data debería decir si es por API key o estructura de payload.
        await ctx.reply(`⚠️ Error de API: No pude procesar tu solicitud con el asistente (código ${e.response.status}). Por favor, revisá la consola para el detalle del error.`, mainKeyboard.reply_markup);
      } else if (e.request) {
        // La solicitud fue hecha pero no hubo respuesta
        console.error("Error Gemini: No se recibió respuesta del servidor.", e.message);
        await ctx.reply("⚠️ Error de red: No pude contactar al asistente. Revisa la conexión.", mainKeyboard.reply_markup);
      } else {
        // Otros errores (ej. configuración de Axios)
        console.error("Error Gemini:", e.message);
        await ctx.reply("⚠️ Error interno del asistente. Revisa la consola.", mainKeyboard.reply_markup);
      }
      return;
    }
  }

  // Fallback si no está en un flujo y Gemini no respondió o no está configurado
  await ctx.reply("No entendí eso. Por favor, usá los botones del menú principal, que están *debajo* del último mensaje que te envié, o escribí /start.", mainKeyboard.reply_markup);
});

bot.action('confirm_save', async (ctx)=>{
  try { await ctx.answerCbQuery(); } catch(e) { console.warn("Callback query timed out (confirm_save).", e.message); }
  
  const s = ctx.session;
  if (!s || !s.remitente) return ctx.reply("No hay datos para guardar. Volvé al menú.", mainKeyboard.reply_markup);
  
  const tab = s.remitente;
  const row = [ new Date().toLocaleString(), s.proveedor||'', s.codigo||'', s.descripcion||'', s.cantidad||'', s.motivo||'', s.remito||'', s.fechaFactura||'', String(ctx.chat.id) ];

  let sheetsError = false;
  
  if (sheetsInitialized) {
    try {
      await appendRowToSheet(tab, row);
      await ctx.reply("✅ Devolución registrada correctamente en Google Sheets.");
      await appendLog(`Devolución guardada en ${tab} por ${ctx.from?.first_name} (${ctx.chat.id})`);
    } catch (err) {
      console.error("Error guardando en Sheets:", err.message);
      sheetsError = true;
      await ctx.reply("⚠️ Atención: Ocurrió un error al guardar en Google Sheets. La información no se registró en la hoja. Avisá al administrador.");
    }
  } else {
    // Si Sheets no está inicializado, notificamos, pero el flujo continua para generar el PDF.
    await ctx.reply("⚠️ La integración con Google Sheets está deshabilitada. La información NO se registró en la hoja.");
  }

  // Generación y envío del PDF (siempre intentamos generar el PDF independientemente del Sheets)
  try {
    const ticketData = { remitente: tab, proveedor: s.proveedor, codigo: s.codigo, descripcion: s.descripcion, cantidad: s.cantidad, motivo: s.motivo, remito: s.remito, fechaFactura: s.fechaFactura, usuario: ctx.from?.first_name || ctx.from?.username || String(ctx.chat.id) };
    const pdfBuf = await generateTicketPDF(ticketData);

    if (OWNER_CHAT_ID) {
      try {
        await bot.telegram.sendDocument(OWNER_CHAT_ID, { source: pdfBuf, filename: `ticket_${Date.now()}.pdf` }, { caption: `Nueva devolución registrada en ${tab} (Registro en Sheets: ${sheetsError ? 'FALLÓ' : sheetsInitialized ? 'OK' : 'OFF'}).` });
      } catch(e){ console.error("Error enviando notificación al owner:", e.message); }
    }
    
    if (!sheetsError) { // Si el registro de Sheets fue OK o si Sheets estaba deshabilitado, enviamos el mensaje final de éxito del flujo.
      await ctx.reply("Recordá conservar tu ticket PDF para seguimiento.");
    }

  } catch(e) {
    console.error("Error generando/enviando PDF:", e.message);
    // Solo enviamos un mensaje adicional de error si Sheets *también* falló. Si Sheets funcionó, solo el PDF falló, que ya está registrado.
    if (sheetsError || !sheetsInitialized) {
        await ctx.reply("❌ Error al generar el ticket PDF. Avisá al administrador.");
    } else {
        await ctx.reply("⚠️ Atención: Error al generar el ticket PDF. La devolución fue registrada en Google Sheets, pero el ticket no pudo generarse.");
    }
  }

  ctx.session = {};
  return replyMain(ctx);
});

// init and launch
(async ()=>{
  // Inicializamos Sheets primero...
  await initSheets(); 

  if (WEBHOOK_URL) {
      // Modo Webhook (Recomendado para producción para evitar error 409)
      const secretPath = `/telegraf/${BOT_TOKEN}`; 
      
      // 1. Configurar Express para escuchar las actualizaciones de Telegram
      // IMPORTANTE: Asegúrate de que Express esté configurado para parsear JSON si usas Telegraf > 4.10.0
      // En este caso, Telegraf lo maneja internamente con bot.webhookCallback(path)
      app.use(bot.webhookCallback(secretPath));
      
      // 2. Establecer el webhook en Telegram
      await bot.telegram.setWebhook(`${WEBHOOK_URL}${secretPath}`);
      
      console.log(`✅ Bot en modo Webhook. Escuchando en ${WEBHOOK_URL}${secretPath}`);
      botStatus = "conectado (webhook)";
  } else {
      // Modo Polling (Usado para desarrollo, puede causar error 409 en despliegues con múltiples procesos)
      console.warn("⚠️ WEBHOOK_URL no definido. Usando Telegraf Polling. Si ocurre un error 409, definí WEBHOOK_URL en tu entorno de despliegue.");
      await bot.launch();
      botStatus = "conectado (polling)";
  }

  console.log("✅ Bot de Telegram iniciado.");
  
  // SOLUCIÓN: Adjuntar los manejadores de detención SÓLO después de que el bot se haya iniciado correctamente.
  process.once('SIGINT', ()=>bot.stop('SIGINT'));
  process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
})();

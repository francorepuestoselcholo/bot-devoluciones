import { promises as fs } from "fs";
import path from "path";
import express from "express";
import { Telegraf, Markup } from "telegraf";
import TelegrafLocalSession from "telegraf-session-local";
import PDFDocument from "pdfkit";
import { google } from "googleapis";
import axios from "axios";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

// === CONFIGURACIÓN GENERAL ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
// El archivo de credenciales del Service Account (debe estar en el disco)
const GOOGLE_SERVICE_ACCOUNT_FILE = './gen-lang-client-0104843305-3b7345de7ec0.json'; 
const PORT = process.env.PORT || 3000;
const LOG_FILE = 'logs.txt';
const LOGO_PATH = './REPUESTOS EL CHOLO LOGO.png'; // Ruta de la imagen del logo
const DRIVE_FOLDER_ID = '1ByMDQDSWku135s1SwForGtWvyl2gcRSM'; 
const GMAIL_USER = process.env.MAIL_USER; 
const GMAIL_PASS = process.env.MAIL_PASS; 
// Lista de IDs de Telegram permitidos para usar el bot
const ALLOWED_USERS = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',').map(id => id.trim()) : [];

if (!BOT_TOKEN) throw new Error("FATAL: BOT_TOKEN no definido.");

// === EXPRESS & ESTADO ===
const app = express();
let botStatus = 'iniciando';
let sheetsInitialized = false;
let sheetsClient = null;
let driveClient = null;
let transporter = null;

// === BOT SETUP ===
const bot = new Telegraf(BOT_TOKEN);
// Middleware para manejar la sesión local (para el flujo paso a paso)
const localSession = new TelegrafLocalSession({ database: path.resolve(process.cwd(), 'session_db.json') });
bot.use(localSession.middleware());

// Middleware de autenticación: Verifica si el usuario está en la lista de permitidos
bot.use(async (ctx, next) => {
    const userId = String(ctx.from?.id);
    if (!userId || ALLOWED_USERS.length === 0) {
        // Permitir si no hay lista de usuarios definida (modo desarrollo)
        await next();
    } else if (ALLOWED_USERS.includes(userId)) {
        await next();
    } else {
        console.log(`Acceso denegado a usuario: ${userId}`);
        await ctx.reply("⛔ Acceso denegado. Contactá al administrador.");
    }
});


// === TECLADOS ===
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

const motivosKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('❌ Mal Pedido', 'motivo_Mal_Pedido'), Markup.button.callback('🔨 Fallado', 'motivo_Fallado')],
  [Markup.button.callback('📦 Error de Envío', 'motivo_Error_Envio'), Markup.button.callback('✏️ Otro Motivo', 'motivo_Otro')],
]);


// === FUNCIONES BASE ===

async function appendLog(msg) {
  const ts = new Date().toISOString();
  await fs.appendFile(LOG_FILE, `[${ts}] ${msg}\n`, 'utf8');
}

// Inicializa el transportador de correo Nodemailer
function initMailer() {
    if (!GMAIL_USER || !GMAIL_PASS) {
        console.warn('⚠️ GMAIL_USER o GMAIL_PASS no configurados. El envío de correos estará deshabilitado.');
        return;
    }
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER, pass: GMAIL_PASS }
    });
    console.log('✅ Nodemailer inicializado.');
}

// Inicializa el cliente de Google Sheets y Drive
async function initSheets() {
  console.log('Inicializando Google Sheets y Drive...');
  try {
    const keyFileContent = await fs.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8');
    const key = JSON.parse(keyFileContent);
    const privateKey = key.private_key.replace(/\\n/g, '\n'); 

    // Autenticación JWT con los scopes necesarios
    const jwt = new google.auth.JWT(
        key.client_email, 
        null, 
        privateKey, 
        [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive'
        ]
    );

    await jwt.authorize();
    sheetsClient = google.sheets({ version: 'v4', auth: jwt });
    driveClient = google.drive({ version: 'v3', auth: jwt });
    sheetsInitialized = true;
    console.log('✅ Google API inicializado (Sheets y Drive)');
  } catch (e) {
    console.error('❌ Error al inicializar Google API. Asegurate que GOOGLE_SERVICE_ACCOUNT_FILE exista y sea válido:', e.message);
  }
}

// Añade una fila de datos a una hoja específica
async function appendRowToSheet(sheetName, rowData) {
  if (!sheetsInitialized || !sheetsClient) {
    throw new Error("El cliente de Google Sheets no está inicializado o falló.");
  }

  const response = await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:A`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [rowData] },
  });
  return response;
}

// Crea las carpetas locales para guardar los tickets si no existen
function ensureLocalFolders() {
  const base = path.join(process.cwd(), 'tickets');
  const remitentes = ['ElCholo', 'Ramirez', 'Tejada'];
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  remitentes.forEach(r => {
    const dir = path.join(base, r);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  });
  console.log('✅ Carpetas locales de tickets aseguradas.');
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
        const logo = await fs.readFile(LOGO_PATH); 
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

// === ENVIAR CORREO ===
async function sendMailWithPDF(buffer, filename, data) {
  if (!transporter) {
    console.warn('Correo no enviado: El transportador de correo no está inicializado.');
    return;
  }
  
  const html = `
  <h2>Nuevo Ticket de Devolución Registrado</h2>
  <p>Remitente: <b>${data.remitente}</b></p>
  <p>Proveedor: <b>${data.proveedor}</b></p>
  <p>Motivo: ${data.motivo}</p>
  <p>Código: ${data.codigo}</p>
  <p>Cantidad: ${data.cantidad}</p>
  <p>Se adjunta el ticket en PDF.</p>`;

  await transporter.sendMail({
    from: `"Repuestos El Cholo Bot" <${GMAIL_USER}>`,
    to: 'info@repuestoselcholo.com.ar', 
    subject: `Nueva devolución registrada - ${data.proveedor}`,
    html,
    attachments: [{ filename, content: buffer }]
  });
}


// === HANDLERS DEL BOT ===

// /start
bot.start(async ctx => {
  ctx.session = {};
  await ctx.reply('👋 ¡Hola! Soy el Bot de Devoluciones. ¿Qué querés hacer?', { reply_markup: mainKeyboard.reply_markup });
});

// Volver al menú principal
bot.action('main', async ctx => {
  try { await ctx.answerCbQuery(); } catch {}
  ctx.session = {};
  await ctx.reply('Menú principal:', { reply_markup: mainKeyboard.reply_markup });
});

// /help
bot.command('help', async ctx => {
  const helpText = `
Comandos disponibles:
/start - Mostrar menú principal
/help - Mostrar esta ayuda`;
  await ctx.reply(helpText);
});

// --- FLUJO DE REGISTRO: Inicio ---
bot.action('registro', async ctx => {
  try { await ctx.answerCbQuery(); } catch {}
  ctx.session.step = 'awaiting_remitente';
  ctx.session.data = {};
  await ctx.reply('Seleccioná el remitente:', { reply_markup: remitenteKeyboard.reply_markup });
});

// --- FLUJO DE REGISTRO: Remitente seleccionado ---
bot.action(/^remitente_(.+)/, async ctx => {
  try { await ctx.answerCbQuery(); } catch {}
  const remitenteKey = ctx.match[1];
  const remitentesMap = {
    'ElCholo': 'El Cholo Repuestos',
    'Ramirez': 'Ramirez Cesar y Lois Gustavo S.H.',
    'Tejada': 'Tejada Carlos y Gomez Juan S.H.'
  };
  const remitenteName = remitentesMap[remitenteKey] || 'Desconocido';
  
  ctx.session.data.remitenteKey = remitenteKey;
  ctx.session.data.remitente = remitenteName;
  ctx.session.step = 'awaiting_proveedor';

  await ctx.editMessageText(`Remitente seleccionado: ${remitenteName}.`);
  await ctx.reply("Ingresá el nombre del **Proveedor**:", { parse_mode: 'Markdown' });
});

// --- FLUJO DE REGISTRO: Motivo seleccionado ---
bot.action(/^motivo_(.+)/, async ctx => {
  try { await ctx.answerCbQuery(); } catch {}
  const motivoKey = ctx.match[1];
  
  if (motivoKey === 'Otro') {
    ctx.session.step = 'awaiting_otro_motivo';
    await ctx.editMessageText("Ingresá el **motivo específico**:", { parse_mode: 'Markdown' });
  } else {
    ctx.session.data.motivo = motivoKey.replace(/_/g, ' ');
    ctx.session.step = 'awaiting_remito';
    await ctx.editMessageText(`Motivo seleccionado: ${ctx.session.data.motivo}.`);
    await ctx.reply("Ingresá el **N° Remito/Factura**:", { parse_mode: 'Markdown' });
  }
});

// --- GUARDAR DEVOLUCIÓN: Confirmación y proceso final ---
bot.action("guardar_devolucion", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  await ctx.editMessageText("⏳ Procesando devolución. Esperá un momento...");

  const s = ctx.session.data;
  const tab = "DEVOLUCIONES";
  const username = ctx.from?.first_name || ctx.from?.username || String(ctx.chat.id);
  const pdfFilename = `ticket_${s.remitenteKey}_${new Date().toISOString().replace(/:/g, '-')}.pdf`;

  if (!sheetsInitialized || !sheetsClient) {
    await ctx.reply("🚨 ERROR CRÍTICO: El bot no pudo conectarse a Google Sheets. Verificá los logs del servidor.");
    ctx.session = {};
    return;
  }

  // Estructura de la fila para Google Sheets
  const row = [
    new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
    username,
    s.remitente || "",
    s.proveedor || "",
    s.codigo || "",
    s.descripcion || "",
    s.cantidad || "",
    s.motivo || "",
    s.remito || "",
    s.fechaFactura || "",
    String(ctx.chat.id),
  ];

  let pdfBuffer = null;
  
  try {
    // 1. Generar PDF
    pdfBuffer = await generateTicketPDF(s);
    
    // 2. Guardar en Sheets
    await appendRowToSheet(tab, row);
    await appendLog(`Devolución guardada en Sheets por ${username} (${ctx.chat.id})`);
    
    // 3. Guardar PDF localmente (para 'ver_tickets' posteriores)
    const localPath = path.join(process.cwd(), 'tickets', s.remitenteKey, pdfFilename);
    await fs.writeFile(localPath, pdfBuffer);
    
    // 4. Enviar PDF al usuario
    await ctx.replyWithDocument(
      { source: pdfBuffer, filename: pdfFilename },
      { caption: `✅ ¡Listo! Aquí está tu ticket para **${s.proveedor}**.`, parse_mode: 'Markdown'}
    );
    
    // 5. Enviar por correo (Si está configurado)
    await sendMailWithPDF(pdfBuffer, pdfFilename, s);
    await appendLog(`Ticket enviado por correo y a usuario: ${pdfFilename}`);

    await ctx.reply("Recordá conservar tu ticket PDF para seguimiento. Menú principal:", { reply_markup: mainKeyboard.reply_markup });

  } catch (err) {
    console.error("❌ ERROR CRÍTICO en guardar_devolucion:", err.message);
    
    // Notificación de error al usuario
    if (pdfBuffer) {
      await ctx.reply("⚠️ El ticket PDF fue generado, pero *falló el registro en Sheets o el envío por correo*. ¡Avisá al administrador!", { parse_mode: 'Markdown' });
    } else {
      await ctx.reply("🚨 Ocurrió un error al guardar o generar el ticket. Por favor, intentá nuevamente desde /start.");
    }
  }

  ctx.session = {};
});


// Manejo del flujo de texto (debe ir DESPUÉS de los 'action' handlers)
bot.on('text', async (ctx, next) => {
  const step = ctx.session?.step;
  const text = ctx.message.text.trim();
  const data = ctx.session.data;

  // Si el mensaje es para un flujo específico, lo manejamos
  if (step === 'awaiting_proveedor') {
    data.proveedor = text;
    ctx.session.step = 'awaiting_codigo';
    return ctx.reply("Ingresá el **código** del artículo:", { parse_mode: 'Markdown' });

  } else if (step === 'awaiting_codigo') {
    data.codigo = text;
    ctx.session.step = 'awaiting_descripcion';
    return ctx.reply("Ingresá la **descripción**:", { parse_mode: 'Markdown' });

  } else if (step === 'awaiting_descripcion') {
    data.descripcion = text;
    ctx.session.step = 'awaiting_cantidad';
    return ctx.reply("Ingresá la **cantidad**:", { parse_mode: 'Markdown' });

  } else if (step === 'awaiting_cantidad') {
    // Validar que sea un número
    if (!isNaN(parseInt(text)) && isFinite(text)) {
        data.cantidad = text;
        ctx.session.step = 'awaiting_motivo';
        return ctx.reply("Seleccioná el **motivo** de la devolución:", { reply_markup: motivosKeyboard.reply_markup, parse_mode: 'Markdown' });
    } else {
        return ctx.reply("❌ Cantidad inválida. Ingresá solo números:", { parse_mode: 'Markdown' });
    }

  } else if (step === 'awaiting_otro_motivo') {
    data.motivo = text;
    ctx.session.step = 'awaiting_remito';
    return ctx.reply("Ingresá el **N° Remito/Factura**:", { parse_mode: 'Markdown' });

  } else if (step === 'awaiting_remito') {
    data.remito = text;
    ctx.session.step = 'awaiting_fechaFactura';
    return ctx.reply("Ingresá la **Fecha de Factura** (ej: DD/MM/AAAA):", { parse_mode: 'Markdown' });

  } else if (step === 'awaiting_fechaFactura') {
    data.fechaFactura = text;
    ctx.session.step = 'confirm_and_save';

    const resumen = `\n\n*Resumen*\nRemitente: ${data.remitente}\nProveedor: ${data.proveedor}\nCódigo: ${data.codigo}\nDescripción: ${data.descripcion}\nCantidad: ${data.cantidad}\nMotivo: ${data.motivo}\nRemito/Factura: ${data.remito}\nFecha Factura: ${data.fechaFactura}`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirmar y Guardar', 'guardar_devolucion')],
      [Markup.button.callback('❌ Cancelar', 'main')],
    ]);

    return ctx.reply(
      `Datos listos para guardar: ${resumen}\n\n¿Deseás confirmar la devolución?`,
      { reply_markup: keyboard.reply_markup, parse_mode: 'Markdown' }
    );
  }

  // Si no estamos en un flujo, pasamos al manejador por defecto (al final)
  await next();
});


// --- FLUJO: TICKETS (Ver tickets recientes) ---
bot.action('ver_tickets', async ctx => {
  try { await ctx.answerCbQuery(); } catch {}
  const remitentes = Markup.inlineKeyboard([
    [Markup.button.callback('El Cholo', 'tickets_ElCholo')],
    [Markup.button.callback('Tejada', 'tickets_Tejada')],
    [Markup.button.callback('Ramirez', 'tickets_Ramirez')],
    [Markup.button.callback('↩️ Volver', 'main')]
  ]);
  await ctx.reply('Seleccioná el remitente para ver sus tickets (últimos 5):', remitentes);
});

bot.action(/tickets_(.+)/, async ctx => {
  try { await ctx.answerCbQuery(); } catch {}
  const remitente = ctx.match[1];
  const folder = path.join(process.cwd(), 'tickets', remitente); 
  
  try {
    const files = await fs.readdir(folder); 
    // Filtra PDFs, toma los últimos 5 y los invierte (para ver el más nuevo primero)
    const pdfFiles = files.filter(f => f.endsWith('.pdf')).slice(-5).reverse();
    
    if (!pdfFiles.length) return ctx.reply(`No hay tickets disponibles para ${remitente}.`);
    
    await ctx.reply(`Enviando los últimos ${pdfFiles.length} tickets de **${remitente}**...`, { parse_mode: 'Markdown'});
    
    for (const file of pdfFiles) {
      const buffer = await fs.readFile(path.join(folder, file)); 
      await ctx.replyWithDocument({ source: buffer, filename: file });
    }
    
  } catch (e) {
      console.error(`Error leyendo tickets para ${remitente}:`, e.message);
      return ctx.reply('Ocurrió un error al intentar leer los tickets. Asegurate que los archivos PDF existan localmente.');
  }
  
  await ctx.reply('Menú principal:', { reply_markup: mainKeyboard.reply_markup });
});


// --- Funcionalidades No Implementadas (Menú de Fallback) ---
bot.action(['consultar', 'ver_proveedores', 'agregar_proveedor'], async ctx => {
    try { await ctx.answerCbQuery(); } catch {}
    await ctx.reply('Esta funcionalidad no está implementada aún. Usá "Registrar devolución".', { reply_markup: mainKeyboard.reply_markup });
});


// Handler de texto por defecto si nada anterior lo manejó
bot.on('text', async (ctx) => {
    // Este es un fallback si el mensaje de texto no fue manejado por los flujos.
    return ctx.reply("⚠️ No entendí, por favor usá el menú.", {
        reply_markup: mainKeyboard.reply_markup,
    });
});


// === INICIO DEL BOT ===
app.get('/', (req, res) => res.send(`Bot de devoluciones activo. Estado: ${botStatus}`));

(async () => {
  try {
    ensureLocalFolders();
    initMailer();
    await initSheets();
    
    app.listen(PORT, () => {
        console.log(`🚀 Servidor Express en puerto ${PORT}`);
    });

    await bot.launch();
    botStatus = 'conectado (polling)';
    console.log('✅ Bot iniciado correctamente');

    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));

  } catch (error) {
    console.error('❌ Error fatal durante la inicialización:', error.message);
    botStatus = 'fallido';
  }
})();
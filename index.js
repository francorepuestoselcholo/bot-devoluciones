import { promises as fs } from "fs";
import { Telegraf, Markup } from "telegraf";
import LocalSession from "telegraf-session-local";
import PDFDocument from "pdfkit";
import { google } from "googleapis";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// --- CONFIG / ENV ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null;
const SHEET_ID =
  process.env.GOOGLE_SHEET_ID ||
  "1BFGsZaUwvxV4IbGgXNOp5IrMYLVn-czVYpdxTleOBgo";
const GOOGLE_SERVICE_ACCOUNT_FILE =
  "./gen-lang-client-0104843305-3b7345de7ec0.json";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const LOG_FILE = "logs.txt";
const LOGO_PATH = "./REPUESTOS EL CHOLO LOGO.png";

if (!BOT_TOKEN)
  throw new Error("FATAL: BOT_TOKEN no definido en variables de entorno.");

// --- GLOBALES ---
let sheets;
let sheetsInitialized = false;
let sheetsError = false;

// --- CONFIGURAR BOT ---
const bot = new Telegraf(BOT_TOKEN);
const localSession = new LocalSession({ database: "session_db.json" });
bot.use(localSession.middleware());

// --- FUNCIONES AUXILIARES ---

async function appendLog(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  try {
    await fs.appendFile(LOG_FILE, logEntry, "utf8");
  } catch (err) {
    console.error("Error escribiendo en el log:", err.message);
  }
}

// Genera un PDF simple de ejemplo
async function generateTicketPDF(data) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const buffers = [];
    doc.on("data", buffers.push.bind(buffers));
    doc.on("end", () => {
      const pdfBuffer = Buffer.concat(buffers);
      resolve(pdfBuffer);
    });

    doc.fontSize(16).text("TICKET DE DEVOLUCI¨®N", { align: "center" });
    doc.moveDown();
    doc.fontSize(10).text(`Proveedor: ${data.proveedor}`);
    doc.text(`C¨®digo: ${data.codigo}`);
    doc.text(`Descripci¨®n: ${data.descripcion}`);
    doc.text(`Cantidad: ${data.cantidad}`);
    doc.text(`Motivo: ${data.motivo}`);
    doc.text(`Remito: ${data.remito}`);
    doc.text(`Fecha Factura: ${data.fechaFactura}`);
    doc.end();
  });
}

async function replyMain(ctx) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("Registrar Devoluci¨®n", "registrar_devolucion")],
  ]);
  return ctx.reply("Seleccion¨¢ una opci¨®n:", keyboard);
}

// --- GOOGLE SHEETS ---

async function initSheets() {
  try {
    const EXAMPLE_SHEET_ID =
      "1BFGsZaUwvxV4IbGgXNOp5IrMYLVn-czVYpdxTleOBgo";
    if (SHEET_ID === EXAMPLE_SHEET_ID) {
      console.error(
        "? ERROR: Est¨¢s usando el ID de hoja de c¨¢lculo de EJEMPLO. Reemplazalo por tu ID real en la variable SHEET_ID."
      );
      sheetsError = true;
      return;
    }

    const credentials = JSON.parse(
      await fs.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, "utf8")
    );

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    sheets = google.sheets({ version: "v4", auth });
    sheetsInitialized = true;
    console.log("? Google Sheets inicializado correctamente.");
  } catch (error) {
    console.error("? ERROR FATAL al inicializar Google Sheets:", error.message);
    console.error("?? FALL¨® LA CONEXI¨®N A SHEETS. Verific¨¢:");
    console.error("   1. Que el archivo de credenciales existe:", GOOGLE_SERVICE_ACCOUNT_FILE);
    console.error("   2. Que compartiste la hoja con el email del servicio de cuenta.");
    console.error("   3. Que el SHEET_ID es correcto.");
    sheetsError = true;
    sheetsInitialized = false;
  }
}

async function appendRowToSheet(sheetName, rowData) {
  if (!sheetsInitialized || sheetsError || !sheets) {
    throw new Error("El cliente de Google Sheets no est¨¢ inicializado o fall¨®.");
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:A`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [rowData] },
  });
}

// --- HANDLERS DEL BOT ---

bot.start(replyMain);

bot.action("registrar_devolucion", (ctx) => {
  ctx.session.step = "awaiting_proveedor";
  ctx.session.data = {};
  return ctx.reply("Ingres¨¢ el nombre del proveedor:");
});

bot.on("text", async (ctx) => {
  const step = ctx.session?.step;
  const text = ctx.message.text.trim();

  if (step === "awaiting_proveedor") {
    ctx.session.data.proveedor = text;
    ctx.session.step = "awaiting_codigo";
    return ctx.reply("Ingres¨¢ el c¨®digo del art¨ªculo:");
  } else if (step === "awaiting_codigo") {
    ctx.session.data.codigo = text;
    ctx.session.step = "awaiting_descripcion";
    return ctx.reply("Ingres¨¢ la descripci¨®n:");
  } else if (step === "awaiting_descripcion") {
    ctx.session.data.descripcion = text;
    ctx.session.step = "awaiting_cantidad";
    return ctx.reply("Ingres¨¢ la cantidad:");
  } else if (step === "awaiting_cantidad") {
    ctx.session.data.cantidad = text;
    ctx.session.step = "awaiting_motivo";
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("? Mal Pedido", "motivo_Mal_Pedido")],
      [Markup.button.callback("?? Fallado", "motivo_Fallado")],
      [Markup.button.callback("?? Error de Env¨ªo", "motivo_Error_Env¨ªo")],
    ]);
    return ctx.reply("Seleccion¨¢ el motivo de la devoluci¨®n:", keyboard);
  }

  return ctx.reply("Comando desconocido. Us¨¢ /start para iniciar.");
});

bot.action(/^motivo_/, (ctx) => {
  const motivo = ctx.match[0].substring(7).replace(/_/g, " ");
  ctx.session.data.motivo = motivo;
  ctx.session.step = "awaiting_remito";
  ctx.editMessageReplyMarkup(null);
  return ctx.reply(`Motivo seleccionado: ${motivo}. Ahora ingres¨¢ el n¨²mero de remito:`);
});

bot.on("text", async (ctx) => {
  if (ctx.session?.step === "awaiting_remito") {
    ctx.session.data.remito = ctx.message.text.trim();
    ctx.session.step = "awaiting_fechaFactura";
    return ctx.reply("Ingres¨¢ la fecha de la factura (ej: DD/MM/AAAA):");
  } else if (ctx.session?.step === "awaiting_fechaFactura") {
    ctx.session.data.fechaFactura = ctx.message.text.trim();
    ctx.session.step = "confirm_and_save";

    const s = ctx.session.data;
    const resumen = `\n\nResumen:\nProveedor: ${s.proveedor}\nC¨®digo: ${s.codigo}\nDescripci¨®n: ${s.descripcion}\nCantidad: ${s.cantidad}\nMotivo: ${s.motivo}\nRemito: ${s.remito}\nFecha Factura: ${s.fechaFactura}`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("? Confirmar y Guardar", "guardar_devolucion")],
      [Markup.button.callback("?? Cancelar", "cancelar")],
    ]);

    return ctx.reply(
      `Datos listos para guardar: ${resumen}\n\n?Dese¨¢s confirmar la devoluci¨®n?`,
      keyboard
    );
  }
});

bot.action("cancelar", (ctx) => {
  ctx.session = {};
  return replyMain(ctx);
});

bot.action("guardar_devolucion", async (ctx) => {
  const s = ctx.session.data;
  const tab = "DEVOLUCIONES";

  if (sheetsError) {
    await ctx.editMessageText(
      "? ERROR CR¨ªTICO: El bot no pudo conectarse a Google Sheets. Verific¨¢ los logs del servidor para ver el error de autenticaci¨®n o permisos."
    );
    ctx.session = {};
    return replyMain(ctx);
  }

  const row = [
    new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
    ctx.from?.first_name || ctx.from?.username || String(ctx.chat.id),
    s.proveedor || "",
    s.codigo || "",
    s.descripcion || "",
    s.cantidad || "",
    s.motivo || "",
    s.remito || "",
    s.fechaFactura || "",
    String(ctx.chat.id),
  ];

  let pdfSent = false;

  try {
    await appendRowToSheet(tab, row);
    await ctx.editMessageText("? Devoluci¨®n registrada correctamente. Generando ticket...");
    await appendLog(`Devoluci¨®n guardada en ${tab} por ${ctx.from?.first_name} (${ctx.chat.id})`);

    const pdfBuf = await generateTicketPDF({
      remitente: tab,
      ...s,
      usuario: ctx.from?.first_name || ctx.from?.username || String(ctx.chat.id),
    });

    await ctx.replyWithDocument(
      { source: pdfBuf, filename: `ticket_${Date.now()}.pdf` },
      { caption: "Aqu¨ª est¨¢ tu ticket de devoluci¨®n." }
    );
    pdfSent = true;

    if (OWNER_CHAT_ID) {
      try {
        await bot.telegram.sendDocument(
          OWNER_CHAT_ID,
          { source: pdfBuf, filename: `ticket_${Date.now()}_owner.pdf` },
          { caption: `Nueva devoluci¨®n registrada en ${tab} (registro en Sheets OK).` }
        );
      } catch (e) {
        console.error("Error enviando notificaci¨®n al owner:", e.message);
      }
    }

    await ctx.reply("Record¨¢ conservar tu ticket PDF para seguimiento.");
  } catch (err) {
    console.error("? ERROR CR¨ªTICO en guardar_devolucion:", err.message);
    let userMessage = "? Ocurri¨® un error al guardar o enviar el ticket. ";
    if (err.message.includes("Google Sheets no est¨¢ inicializado")) {
      userMessage += "*Verific¨¢ la configuraci¨®n del servidor y los permisos de Sheets.*";
    } else if (err.message.includes("API")) {
      userMessage += "*El guardado en Google Sheets fall¨®*. Revis¨¢ los permisos del servicio de cuenta.";
    } else {
      userMessage += "Avis¨¢ al administrador. (Error gen¨¦rico)";
    }

    if (pdfSent) {
      await ctx.reply(
        "?? El ticket PDF fue enviado, pero el *registro en Google Sheets fall¨®*. Avis¨¢ al administrador."
      );
    } else {
      await ctx.reply(userMessage);
    }
  }

  ctx.session = {};
  return replyMain(ctx);
});

// --- INICIO DEL BOT ---
(async () => {
  console.log("??? Inicializando Google Sheets...");
  await initSheets();

  console.log("?? Bot de Telegram iniciando en modo Polling (Local). Presiona Ctrl+C para detener.");
  await bot.launch();

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  console.log("? Bot de Telegram iniciado correctamente.");
})();

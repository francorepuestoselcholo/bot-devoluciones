import { promises as fs } from "fs";
import { Telegraf, Markup } from "telegraf"; 
import LocalSession from 'telegraf-session-local'; 
import PDFDocument from "pdfkit";
import { google } from "googleapis";
import axios from "axios";

// --- CONFIG/ENV ---
const BOT_TOKEN = process.env.BOT_TOKEN; 
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null; // ID del chat del administrador

// 🛑 ¡ATENCIÓN! REEMPLAZA ESTO con el ID real de tu hoja de cálculo.
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "1BFGsZaUwvxV4IbGgXNOp5IrMYLVn-czVYpdxTleOBgo"; 
// Credenciales: Este archivo debe estar en la misma carpeta.
const GOOGLE_SERVICE_ACCOUNT_FILE = "./gen-lang-client-0104843305-3b7345de7ec0.json"; 

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;
const LOG_FILE = "logs.txt";
const LOGO_PATH = "./REPUESTOS EL CHOLO LOGO.png"; // RUTA DEL LOGO (DEBE ESTAR SUBIDO)

if (!BOT_TOKEN) throw new Error("FATAL: BOT_TOKEN no definido en variables de entorno.");

// --- GLOBALES Y CLIENTES ---
let sheets;
let sheetsInitialized = false;
let sheetsError = false;

const bot = new Telegraf(BOT_TOKEN);
// Usamos telegraf-session-local para guardar el estado de la conversación (la sesión)
const localSession = new LocalSession({ database: 'session_db.json' });
bot.use(localSession.middleware());

// --- FUNCIONES DE LOG Y UTILIDAD ---

/**
 * Añade un mensaje al archivo de log (logs.txt).
 * @param {string} message Mensaje a loguear.
 */
async function appendLog(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  try {
    await fs.appendFile(LOG_FILE, logEntry, 'utf8');
  } catch (err) {
    console.error("Error escribiendo en el log:", err.message);
  }
}

/**
 * Genera un buffer de PDF para el ticket de devolución.
 * (MOCK: Asumo que esta función existe en tu código completo)
 */
async function generateTicketPDF(data) {
    // --- MOCK DE PDF ---
    return new Promise((resolve) => {
        const doc = new PDFDocument();
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
            const pdfBuffer = Buffer.concat(buffers);
            resolve(pdfBuffer);
        });

        doc.fontSize(16).text('TICKET DE DEVOLUCIÓN', { align: 'center' });
        doc.moveDown();
        doc.fontSize(10).text(`Proveedor: ${data.proveedor}`);
        doc.text(`Código: ${data.codigo}`);
        doc.text(`Descripción: ${data.descripcion}`);
        doc.end();
    });
}

/**
 * Responde con el menú principal.
 */
async function replyMain(ctx) {
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("Registrar Devolución", "registrar_devolucion")]
    ]);
    return ctx.reply("Seleccioná una opción:", keyboard);
}


// --- FUNCIONES DE GOOGLE SHEETS (CRÍTICAS PARA LA CONEXIÓN) ---

/**
 * Función que inicializa el cliente de Google Sheets.
 */
async function initSheets() {
  // 1. Cargar las credenciales del archivo JSON
  try {
    const EXAMPLE_SHEET_ID = "1BFGsZaUwvxV4IbGgXNOp5IrMYLVn-czVYpdxTleOBgo";
    if (SHEET_ID === EXAMPLE_SHEET_ID) {
        console.error("❌ ERROR: Estás usando el ID de hoja de cálculo de EJEMPLO. Reemplázalo por tu ID real en la variable SHEET_ID.");
        sheetsError = true;
        return;
    }

    const credentials = JSON.parse(await fs.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, "utf8"));
    
    // 2. Autenticar usando Google Service Account
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    // 3. Crear el cliente de Sheets
    sheets = google.sheets({ version: "v4", auth });
    sheetsInitialized = true;
    console.log("✅ Google Sheets inicializado correctamente.");

  } catch (error) {
    console.error("❌ ERROR FATAL al inicializar Google Sheets:", error.message);
    console.error("⛔️ FALLÓ LA CONEXIÓN A SHEETS. Verificá:");
    console.error("   1. Que el archivo de credenciales existe: " + GOOGLE_SERVICE_ACCOUNT_FILE);
    console.error("   2. Que compartiste la hoja de cálculo con el email de la cuenta de servicio.");
    console.error("   3. Que el SHEET_ID es correcto.");
    sheetsError = true;
    sheetsInitialized = false;
  }
}

/**
 * Función que añade una fila de datos a la hoja de cálculo de Google.
 * @param {string} sheetName Nombre de la pestaña (ej. 'DEVOLUCIONES')
 * @param {Array<string|number>} rowData Array de valores a insertar.
 */
async function appendRowToSheet(sheetName, rowData) {
  if (!sheetsInitialized || sheetsError || !sheets) {
    throw new Error("El cliente de Google Sheets no está inicializado o falló.");
  }
  
  // Esta es la llamada a la API que realiza el guardado
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:A`, // Rango abierto para añadir la nueva fila al final
    valueInputOption: "USER_ENTERED",
    resource: {
      values: [rowData],
    },
  });
}

// --- HANDLERS DEL BOT ---

bot.start(replyMain);

bot.action("registrar_devolucion", (ctx) => {
    // Inicia el proceso de recolección de datos
    ctx.session.step = 'awaiting_proveedor';
    ctx.session.data = {};
    return ctx.reply("Ingresá el nombre del proveedor:");
});

// Mock de la lógica de pasos (solo para que sea runnable)
bot.on('text', async (ctx) => {
    const step = ctx.session?.step;
    const text = ctx.message.text.trim();

    if (step === 'awaiting_proveedor') {
        ctx.session.data.proveedor = text;
        ctx.session.step = 'awaiting_codigo';
        return ctx.reply("Ingresá el código del artículo:");
    } else if (step === 'awaiting_codigo') {
        ctx.session.data.codigo = text;
        ctx.session.step = 'awaiting_descripcion';
        return ctx.reply("Ingresá la descripción:");
    } else if (step === 'awaiting_descripcion') {
        ctx.session.data.descripcion = text;
        ctx.session.step = 'awaiting_cantidad';
        return ctx.reply("Ingresá la cantidad:");
    } else if (step === 'awaiting_cantidad') {
        ctx.session.data.cantidad = text;
        ctx.session.step = 'awaiting_motivo';
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("❌ Mal Pedido", "motivo_Mal_Pedido")],
            [Markup.button.callback("🔧 Fallado", "motivo_Fallado")],
            [Markup.button.callback("📦 Error de Envío", "motivo_Error_Envío")]
        ]);
        return ctx.reply("Seleccioná el motivo de la devolución:", keyboard);
    } 
    // Si no es un paso de recolección, puede ser un comando desconocido o texto libre
    return ctx.reply("Comando desconocido. Usá /start para iniciar.");
});


// Manejador para los motivos predefinidos (buttons)
bot.action(/^motivo_/, (ctx) => {
    // Extrae el motivo del callback_data, quitando el prefijo 'motivo_'
    const motivo = ctx.match[0].substring(7).replace(/_/g, ' '); 
    ctx.session.data.motivo = motivo;
    ctx.session.step = 'awaiting_remito';
    // Se elimina el teclado inline después de la selección
    ctx.editMessageReplyMarkup(null); 
    return ctx.reply(`Motivo seleccionado: ${motivo}. Ahora ingresá el número de remito:`);
});

// Manejador para el remito
bot.on('text', async (ctx) => {
    if (ctx.session?.step === 'awaiting_remito') {
        ctx.session.data.remito = ctx.message.text.trim();
        ctx.session.step = 'awaiting_fechaFactura';
        return ctx.reply("Ingresá la fecha de la factura (ej: DD/MM/AAAA):");
    } else if (ctx.session?.step === 'awaiting_fechaFactura') {
        ctx.session.data.fechaFactura = ctx.message.text.trim();
        ctx.session.step = 'confirm_and_save'; // Cambio de paso
        
        const s = ctx.session.data;
        const resumen = `\n\nResumen:\nProveedor: ${s.proveedor}\nCódigo: ${s.codigo}\nDesc.: ${s.descripcion}\nCant.: ${s.cantidad}\nMotivo: ${s.motivo}\nRemito: ${s.remito}\nFecha Factura: ${s.fechaFactura}`;
        
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback("✅ Confirmar y Guardar", "guardar_devolucion")],
            [Markup.button.callback("🔄 Cancelar", "cancelar")]
        ]);

        return ctx.reply(`Datos listos para guardar: ${resumen}\n\n¿Deseas confirmar la devolución?`, keyboard);
    }
    // Si el texto llega aquí y no está en un estado específico, lo ignora o maneja en el listener genérico.
});

// Manejador de cancelación
bot.action("cancelar", (ctx) => {
    ctx.session = {};
    return replyMain(ctx);
});

// --- EL MANEJADOR DE GUARDADO FINAL (AQUÍ ESTABA EL POSIBLE FALLO) ---

bot.action("guardar_devolucion", async (ctx) => {
  const s = ctx.session.data;
  const tab = "DEVOLUCIONES"; 

  // 🛑 NUEVA VERIFICACIÓN DE CONEXIÓN
  if (sheetsError) {
    await ctx.editMessageText("❌ ERROR CRÍTICO: El bot no pudo conectarse a Google Sheets. Verificá los logs del servidor para ver el error de autenticación/permisos.");
    ctx.session = {};
    return replyMain(ctx);
  }

  // Estructura de la fila a guardar (Asegúrate de que coincida con tus columnas en Sheets)
  const row = [ 
    new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }), // Columna A: Timestamp 
    ctx.from?.first_name || ctx.from?.username || String(ctx.chat.id), // Columna B: Usuario de Telegram
    s.proveedor || '', 
    s.codigo || '', 
    s.descripcion || '', 
    s.cantidad || '', 
    s.motivo || '', 
    s.remito || '', 
    s.fechaFactura || '', 
    String(ctx.chat.id) 
  ];

  let pdfSent = false;
  
  try {
    // 1. Guardar en Google Sheets (Si esto falla, se va al catch)
    await appendRowToSheet(tab, row);
    
    await ctx.editMessageText("✅ Devolución registrada correctamente. Generando ticket..."); // Edita el mensaje de confirmación
    await appendLog(`Devolución guardada en ${tab} por ${ctx.from?.first_name} (${ctx.chat.id})`);

    // 2. Generar y enviar el ticket PDF
    const ticketData = { 
        remitente: tab, 
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

    // Envío al usuario
    await ctx.replyWithDocument({ source: pdfBuf, filename: `ticket_${Date.now()}.pdf` }, { caption: "Aquí está tu ticket de devolución." });
    pdfSent = true;
    
    // Envío al OWNER (Notificación)
    if (OWNER_CHAT_ID) {
      try {
        await bot.telegram.sendDocument(OWNER_CHAT_ID, { source: pdfBuf, filename: `ticket_${Date.now()}_owner.pdf` }, { caption: `Nueva devolución registrada en ${tab} (Registro en Sheets: OK).` });
      } catch(e){ console.error("Error enviando notificación al owner:", e.message); }
    }
    
    await ctx.reply("Recordá conservar tu ticket PDF para seguimiento.");

  } catch(err) {
    // 3. Manejo de Error
    console.error("❌ ERROR CRÍTICO en guardar_devolucion:", err.message);
    
    let userMessage = "❌ Ocurrió un error al guardar o enviar el ticket. ";
    if (err.message.includes("Google Sheets no está inicializado")) {
        userMessage += "*Verificá la configuración del servidor y los permisos de Sheets.*";
    } else if (err.message.includes("API")) {
        userMessage += "*El guardado en Google Sheets falló*. Revisá los permisos del Servicio de Cuenta en tu hoja.";
    } else {
        userMessage += "Avisá al administrador. (Error genérico)";
    }
    
    if (pdfSent) { // Si el PDF se envió, pero el guardado falló.
         await ctx.reply("⚠️ El ticket PDF fue enviado, pero el *registro en Google Sheets falló*. Avisá al administrador.");
    } else {
        await ctx.reply(userMessage);
    }
  }

  // Limpieza y vuelta al menú principal
  ctx.session = {};
  return replyMain(ctx);
});


// --- INICIO EN MODO POLLING ---
(async ()=>{\n  console.log("🛠️ Inicializando Google Sheets...");
  // Inicializamos Sheets primero
  await initSheets(); 
  
  // No necesitamos Express, solo iniciamos el bot directamente.
  console.log("🚀 Bot de Telegram iniciando en modo Polling (Local). Presiona Ctrl+C para detener.");
  
  // La función launch() de Telegraf inicia el Polling.
  await bot.launch();

  // Aseguramos que el bot se detenga correctamente al recibir una señal de interrupción
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  console.log("✅ Bot de Telegram iniciado.");
})();
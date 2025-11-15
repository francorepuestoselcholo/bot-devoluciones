import { promises as fs } from "fs";
import express from "express";
import { Telegraf, Markup } from "telegraf"; 
import LocalSession from 'telegraf-session-local'; 
import PDFDocument from "pdfkit";
import { google } from "googleapis";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

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
const DRIVE_PARENT_FOLDER_ID = process.env.DRIVE_PARENT_FOLDER_ID || "1ByMDQDSWku135s1SwH48cI7P8Iq1B7R7"; // ID de carpeta de Drive de ejemplo
const EMAIL_RECEPTOR = process.env.EMAIL_RECEPTOR || "email@ejemplo.com"; // Email para enviar PDFs

if (!BOT_TOKEN) throw new Error("FATAL: BOT_TOKEN no definido en .env");

// --- UTILS/LOGGING ---
let logStream;
const getTimestamp = () => new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

const ensureLocalFolders = async () => {
  try {
    if (!fs.existsSync("./logs")) await fs.mkdir("./logs");
    if (!fs.existsSync("./temp_pdfs")) await fs.mkdir("./temp_pdfs");
    logStream = fs.createWriteStream(path.join("./logs", LOG_FILE), { flags: "a" });
    await fs.copyFile("./REPUESTOS EL CHOLO LOGO.png", "./temp_pdfs/REPUESTOS EL CHOLO LOGO.png");
  } catch (err) {
    console.error(`Error asegurando carpetas locales: ${err.message}`);
  }
};

const log = async (message) => {
  const fullMessage = `[INFO - ${getTimestamp()}] ${message}`;
  console.log(fullMessage);
  if (logStream) logStream.write(`${fullMessage}\n`);
};

const errorLog = async (message) => {
  const fullMessage = `[ERROR - ${getTimestamp()}] ${message}`;
  console.error(fullMessage);
  if (logStream) logStream.write(`${fullMessage}\n`);
  // Notificar al dueño del bot en caso de error grave
  if (OWNER_CHAT_ID) {
    try {
      await bot.telegram.sendMessage(OWNER_CHAT_ID, `🚨 Error grave en el bot:\n\`\`\`${message}\`\`\``, {
        parse_mode: 'Markdown',
      });
    } catch (e) {
      console.error(`Error al intentar notificar al dueño: ${e.message}`);
    }
  }
};

// --- GOOGLE API SETUP (Sheets & Drive) ---
let googleAuth;
let sheets;
let drive;

const initSheets = async () => {
  try {
    const credentials = JSON.parse(await fs.readFile(GOOGLE_SERVICE_ACCOUNT_FILE));
    googleAuth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
    });

    sheets = google.sheets({ version: "v4", auth: googleAuth });
    drive = google.drive({ version: "v3", auth: googleAuth });
    await log("✅ Google Sheets y Drive inicializados.");
  } catch (e) {
    await errorLog(`Error al inicializar Google APIs: ${e.message}`);
    throw e;
  }
};

// --- MAILER SETUP ---
let transporter;
const initMailer = () => {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS,
    }
  });
  log("✅ Nodemailer inicializado.");
};

// --- FIREBASE/GEMINI SETUP (If applicable, though not strictly required for this specific bot logic) ---
// Not used directly in this version, kept for future expansion.

// --- TELEGRAM BOT ---
const bot = new Telegraf(BOT_TOKEN);
const localSessionMiddleware = new LocalSession({ database: "session_db.json" }); 
bot.use(localSessionMiddleware.middleware()); // Usar la sesión local

// --- KEYBOARDS ---
const mainKeyboard = Markup.keyboard([
  ["📄 Generar PDF (Venta)"],
  ["➕ Agregar Proveedor"],
  ["⚙️ Estado del Bot"],
])
.resize()
.oneTime();

const cancelKeyboard = Markup.keyboard([
  ["/cancelar"],
])
.resize()
.oneTime();

const replyMain = (ctx, message = "Volviendo al menú principal.") => {
  ctx.session = {}; // Limpia la sesión
  return ctx.reply(message, {
    reply_markup: mainKeyboard.reply_markup,
  });
};

// --- CORE FUNCTIONS ---

/**
 * 1. Genera el archivo PDF localmente.
 * @param {object} data - Datos para el PDF.
 * @returns {Promise<string>} Ruta del PDF generado.
 */
const generatePdf = async (data, filenamePrefix = "Venta") => {
  const filename = `${filenamePrefix}_${data.cliente.replace(/\s/g, "_")}_${Date.now()}.pdf`;
  const filePath = path.join("./temp_pdfs", filename);
  
  await log(`Iniciando generación de PDF en ${filePath}`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const stream = fs.createWriteStream(filePath);
    
    doc.pipe(stream);

    // Header con Logo y título
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, 50, 40, { width: 100 });
    }
    doc.fontSize(25).text("COMPROBANTE DE VENTA", { align: "right" });
    doc.moveDown();
    
    // Información del Cliente
    doc.fontSize(12).text(`Cliente: ${data.cliente}`);
    doc.text(`Fecha: ${getTimestamp().split(',')[0]}`);
    doc.moveDown();

    // Tabla de Repuestos
    const tableTop = doc.y;
    const itemX = 50;
    const cantidadX = 350;
    const precioX = 420;
    const totalX = 500;
    let currentY = tableTop;

    const drawHeader = () => {
        doc.fillColor("#000000").fontSize(12).font("Helvetica-Bold");
        doc.text("Artículo/Servicio", itemX, currentY, { width: 280, align: "left" });
        doc.text("Cant.", cantidadX, currentY, { width: 50, align: "right" });
        doc.text("Precio U.", precioX, currentY, { width: 70, align: "right" });
        doc.text("Total", totalX, currentY, { width: 70, align: "right" });
        doc.font("Helvetica").lineWidth(1).strokeColor("#AAAAAA").moveTo(itemX, currentY + 15).lineTo(550, currentY + 15).stroke();
        currentY += 20;
    };
    
    drawHeader();
    let totalVenta = 0;

    data.items.forEach(item => {
        if (currentY > 750) { // Si queda poco espacio, añade una nueva página
            doc.addPage();
            currentY = 50;
            drawHeader();
        }
        
        const subtotal = item.cantidad * item.precio;
        totalVenta += subtotal;

        doc.fillColor("#000000").fontSize(10);
        // Usamos un bloque de texto que se ajusta a la altura del contenido
        doc.text(item.nombre, itemX, currentY, { width: 280, align: "left", continued: false, height: 15, ellipsis: true });
        doc.text(item.cantidad.toString(), cantidadX, currentY, { width: 50, align: "right", continued: false });
        doc.text(`$${item.precio.toFixed(2)}`, precioX, currentY, { width: 70, align: "right", continued: false });
        doc.text(`$${subtotal.toFixed(2)}`, totalX, currentY, { width: 70, align: "right", continued: false });
        
        currentY += 20; // Espacio fijo para el siguiente ítem
    });

    // Separador y Total Final
    doc.moveDown();
    currentY = Math.max(currentY, doc.y); // Asegurar que currentY no retroceda
    
    doc.lineWidth(2).strokeColor("#000000").moveTo(itemX, currentY + 10).lineTo(550, currentY + 10).stroke();
    
    doc.moveDown(2);
    doc.fillColor("#000000").fontSize(16).font("Helvetica-Bold");
    doc.text("TOTAL FINAL:", 350, doc.y, { align: "left" });
    doc.text(`$${totalVenta.toFixed(2)}`, 450, doc.y, { align: "right", width: 100 });
    
    // Pie de página
    const footerText = "Gracias por su compra. El Cholo Repuestos.";
    doc.fontSize(8).text(footerText, 50, doc.page.height - 30, { align: "center", width: 500 });

    doc.end();

    stream.on("finish", () => {
      log(`PDF generado y guardado en ${filePath}`);
      resolve(filePath);
    });

    stream.on("error", (err) => {
      errorLog(`Error en stream de PDF: ${err.message}`);
      reject(err);
    });
  });
};

/**
 * 2. Sube el archivo a Google Drive.
 * @param {string} filePath - Ruta del archivo local.
 * @returns {Promise<string>} ID del archivo en Drive.
 */
const uploadToDrive = async (filePath) => {
  const fileName = path.basename(filePath);
  await log(`Iniciando subida de ${fileName} a Google Drive...`);

  const fileMetadata = {
    name: fileName,
    parents: [DRIVE_PARENT_FOLDER_ID],
  };

  const media = {
    mimeType: "application/pdf",
    body: fs.createReadStream(filePath),
  };

  try {
    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: "id",
    });
    const fileId = response.data.id;
    await log(`✅ Archivo subido a Drive con ID: ${fileId}`);
    return fileId;
  } catch (err) {
    await errorLog(`Error al subir a Drive: ${err.message}`);
    throw err;
  }
};

/**
 * 3. Registra la transacción en Google Sheets.
 * @param {object} data - Datos de la transacción.
 */
const recordToSheets = async (data) => {
  await log("Iniciando registro en Google Sheets...");
  const total = data.items.reduce((sum, item) => sum + item.cantidad * item.precio, 0);
  const row = [
    getTimestamp(), // Columna A: Fecha y Hora
    data.cliente,   // Columna B: Cliente
    total,          // Columna C: Total
    JSON.stringify(data.items), // Columna D: Items (detallado como JSON)
    // Se podrían agregar más campos como el ID de Drive si fuera necesario.
  ];

  try {
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Ventas!A:D", // Ajusta el nombre de la hoja si es necesario
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [row],
      },
    });
    await log(`✅ Registro de venta exitoso en Sheets. Filas actualizadas: ${response.data.updates.updatedRows}`);
  } catch (err) {
    await errorLog(`Error al registrar en Sheets: ${err.message}`);
    throw err;
  }
};

/**
 * 4. Envía el PDF por email.
 * @param {string} filePath - Ruta del archivo local.
 */
const sendEmail = async (filePath) => {
  const fileName = path.basename(filePath);
  await log(`Iniciando envío de email con archivo: ${fileName}`);

  try {
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: EMAIL_RECEPTOR,
      subject: `Nueva Venta - ${fileName}`,
      text: `Adjunto el comprobante de venta generado por el bot de Telegram. Archivo: ${fileName}`,
      attachments: [
        {
          filename: fileName,
          path: filePath,
        },
      ],
    };

    const info = await transporter.sendMail(mailOptions);
    await log(`✅ Email enviado: ${info.response}`);
  } catch (err) {
    await errorLog(`Error al enviar el email: ${err.message}`);
    throw err;
  }
};

/**
 * 5. Registra un nuevo proveedor en Google Sheets.
 * @param {object} data - Datos del proveedor.
 */
const recordProviderToSheets = async (data) => {
  await log("Iniciando registro de proveedor en Google Sheets...");
  const row = [
    getTimestamp(), 
    data.nombre,   
    data.contacto, 
    data.email,    
    data.direccion,
    data.telefono,
  ];

  try {
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Proveedores!A:F", // Asegúrate de tener una hoja llamada 'Proveedores'
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [row],
      },
    });
    await log(`✅ Registro de proveedor exitoso en Sheets. Filas actualizadas: ${response.data.updates.updatedRows}`);
  } catch (err) {
    await errorLog(`Error al registrar proveedor en Sheets: ${err.message}`);
    throw err;
  }
};

/**
 * 6. Flujo completo de confirmación y procesamiento.
 * @param {object} ctx - Contexto de Telegraf.
 * @param {object} data - Datos para la venta.
 */
const confirmAndProcessSale = async (ctx, data) => {
  let replyMessage = "✅ **Proceso completado:**\n\n";

  try {
    const filePath = await generatePdf(data);
    
    // Subir a Drive
    await uploadToDrive(filePath);
    replyMessage += "  - Subido a Google Drive\n";

    // Registrar en Sheets
    await recordToSheets(data);
    replyMessage += "  - Registrado en Google Sheets\n";

    // Enviar Email
    await sendEmail(filePath);
    replyMessage += "  - Enviado por Email\n";
    
    // Limpiar archivo local después de usarlo
    await fs.unlink(filePath);
    await log(`Archivo local ${filePath} eliminado.`);

    // Mensaje final al usuario
    await ctx.reply(replyMessage, { parse_mode: "Markdown" });

  } catch (e) {
    await errorLog(`Error en el flujo de confirmación: ${e.message}`);
    await ctx.reply(`❌ Hubo un error al procesar la solicitud. Parte del proceso puede no haberse completado. Revisa los logs. \nDetalle del Error: \`${e.message}\``, {
      parse_mode: "Markdown",
    });
  }

  ctx.session = {};
  return replyMain(ctx);
};


// --- HANDLERS (COMANDOS Y FLUJOS) ---

bot.start(async (ctx) => {
  await log(`Usuario ${ctx.from.id} inició el bot.`);
  return replyMain(ctx, "¡Hola! Soy el Bot de Ventas de Repuestos El Cholo. Usá el menú para comenzar.");
});

bot.command("cancelar", (ctx) => {
  return replyMain(ctx, "Operación cancelada. Volviendo al menú principal.");
});

// FLUSH
bot.command("flush", async (ctx) => {
    if (ctx.from.id == OWNER_CHAT_ID) {
        ctx.session = {};
        await ctx.reply("Sesión actual limpiada (flush).");
    } else {
        await ctx.reply("Comando reservado para el administrador.");
    }
});


// Estado del Bot (Admin)
let botStatus = "desconectado";
bot.hears("⚙️ Estado del Bot", async (ctx) => {
  let statusMessage = `*ESTADO DEL SISTEMA (${botStatus})*\n`;
  statusMessage += `\n*Servicios*:\n`;
  statusMessage += `  - Sheets: ${sheets ? '✅ Conectado' : '❌ Desconectado'}\n`;
  statusMessage += `  - Drive: ${drive ? '✅ Conectado' : '❌ Desconectado'}\n`;
  statusMessage += `  - Mailer: ${transporter ? '✅ Conectado' : '❌ Desconectado'}\n`;
  statusMessage += `\n*Configuración*:\n`;
  statusMessage += `  - Sheet ID: \`${SHEET_ID}\`\n`;
  statusMessage += `  - Drive Folder ID: \`${DRIVE_PARENT_FOLDER_ID}\`\n`;
  statusMessage += `  - Puerto (Express): \`${PORT}\`\n`;
  statusMessage += `  - API Key Gemini: ${GEMINI_API_KEY ? '✅ Configurada' : '❌ No configurada'}\n`;
  statusMessage += `  - Email Receptor: \`${EMAIL_RECEPTOR}\`\n`;
  
  await log(`Estado del bot solicitado por ${ctx.from.id}`);
  return ctx.reply(statusMessage, { parse_mode: "Markdown" });
});

// --- FLUJO: GENERAR PDF (Venta) ---
bot.hears("📄 Generar PDF (Venta)", async (ctx) => {
  await log(`Inicio de flujo 'generarPdf' para ${ctx.from.id}`);
  ctx.session.flow = "generarPdf";
  ctx.session.step = 1;
  ctx.session.data = { items: [] };

  const message = "Ingresá el **nombre del cliente** para la factura. (O usá /cancelar)";
  return ctx.reply(message, { 
    parse_mode: "Markdown",
    reply_markup: cancelKeyboard.reply_markup,
  });
});

bot.hears("➕ Agregar Repuesto", async (ctx) => {
  if (ctx.session.flow === "generarPdf") {
    ctx.session.step = 3;
    await ctx.reply("Ingresá el **nombre del repuesto/servicio** (ej: Filtro de Aceite).");
  } else {
    // Si no estamos en el flujo 'generarPdf', dejamos que el handler anterior o el default se encarguen.
    await next();
  }
});

bot.hears("✅ Confirmar Venta", async (ctx) => {
  if (ctx.session.flow === "generarPdf") {
    // Verificación final
    if (ctx.session.data.items.length === 0) {
      await ctx.reply("⚠️ Debés agregar al menos un repuesto antes de confirmar la venta.");
      return;
    }

    // Preparar mensaje de resumen
    let resumen = `**RESUMEN DE VENTA**\n\n`;
    resumen += `*Cliente:* ${ctx.session.data.cliente}\n\n`;
    resumen += `*Ítems:*\n`;
    let total = 0;
    ctx.session.data.items.forEach((item, index) => {
      const subtotal = item.cantidad * item.precio;
      total += subtotal;
      resumen += `  ${index + 1}. ${item.nombre} x ${item.cantidad} ($${item.precio.toFixed(2)} c/u) = *$${subtotal.toFixed(2)}*\n`;
    });
    resumen += `\n*TOTAL FINAL:* *$${total.toFixed(2)}*\n\n`;
    resumen += "⚠️ ¿Es correcto? Presioná **Confirmar Venta** para iniciar la generación de documentos y el envío por email, o /cancelar.";

    const confirmationKeyboard = Markup.keyboard([
      ["✨ Procesar y Confirmar Venta"],
      ["/cancelar"],
    ])
    .resize()
    .oneTime();

    // Cambiamos el paso para esperar la confirmación final
    ctx.session.step = "confirmacionFinal";
    return ctx.reply(resumen, { 
      parse_mode: "Markdown",
      reply_markup: confirmationKeyboard.reply_markup,
    });
  } else {
    // Si no estamos en el flujo 'generarPdf', dejamos que el handler anterior o el default se encarguen.
    await next();
  }
});

bot.hears("✨ Procesar y Confirmar Venta", async (ctx) => {
  if (ctx.session.flow === "generarPdf" && ctx.session.step === "confirmacionFinal") {
    await ctx.reply("⏱️ Procesando venta... Esto puede tardar unos segundos (Generando PDF, subiendo a Drive, registrando en Sheets y enviando email).");
    await confirmAndProcessSale(ctx, ctx.session.data);
  } else {
    // Si no estamos en el flujo correcto, ignorar o usar el handler por defecto
    await next();
  }
});

// --- FLUJO: AGREGAR PROVEEDOR ---
bot.hears("➕ Agregar Proveedor", async (ctx) => {
  await log(`Inicio de flujo 'agregarProveedor' para ${ctx.from.id}`);
  ctx.session.flow = "agregarProveedor";
  ctx.session.step = 1;
  ctx.session.data = {};

  const message = "Ingresá el **nombre del proveedor** (ej: Baterías XXX). (O usá /cancelar)";
  return ctx.reply(message, { 
    parse_mode: "Markdown",
    reply_markup: cancelKeyboard.reply_markup,
  });
});

// --- MIDDLEWARE para manejar los flujos paso a paso ---
bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  const flow = ctx.session.flow;
  let currentStep = ctx.session.step;

  // Manejo del flujo 'generarPdf'
  if (flow === "generarPdf") {
    
    // Paso 1: Cliente
    if (currentStep === 1) {
      if (text.length < 3) {
        return ctx.reply("El nombre del cliente debe tener al menos 3 caracteres.");
      }
      ctx.session.data.cliente = text;
      ctx.session.step = 2; // Esperando acción (Agregar Repuesto o Confirmar)

      const repuestoKeyboard = Markup.keyboard([
        ["➕ Agregar Repuesto"],
        ["/cancelar"],
      ])
      .resize()
      .oneTime();

      return ctx.reply(`Cliente establecido: *${text}*. Ahora agregá el primer repuesto.`, { 
        parse_mode: "Markdown",
        reply_markup: repuestoKeyboard.reply_markup,
      });
    } 
    
    // Paso 3: Nombre del Repuesto
    else if (currentStep === 3) {
      if (text.length < 2) {
        return ctx.reply("El nombre del repuesto es muy corto.");
      }
      ctx.session.data.currentItem = { nombre: text };
      ctx.session.step = 4;
      return ctx.reply(`Repuesto: *${text}*. Ingresá la **cantidad** (solo números).`, { parse_mode: "Markdown" });
    }
    
    // Paso 4: Cantidad del Repuesto
    else if (currentStep === 4) {
      const cantidad = parseInt(text);
      if (isNaN(cantidad) || cantidad <= 0) {
        return ctx.reply("⚠️ Cantidad inválida. Por favor, ingresá un número entero positivo.");
      }
      ctx.session.data.currentItem.cantidad = cantidad;
      ctx.session.step = 5;
      return ctx.reply(`Cantidad: *${cantidad}*. Ingresá el **precio unitario** (solo números, puedes usar decimales con punto o coma).`, { parse_mode: "Markdown" });
    }
    
    // Paso 5: Precio del Repuesto
    else if (currentStep === 5) {
      const precioStr = text.replace(",", ".");
      const precio = parseFloat(precioStr);

      if (isNaN(precio) || precio <= 0) {
        return ctx.reply("⚠️ Precio unitario inválido. Por favor, ingresá un número positivo.");
      }
      
      ctx.session.data.currentItem.precio = precio;
      
      // Agregar ítem completo
      ctx.session.data.items.push(ctx.session.data.currentItem);
      
      // Resumen actual y opciones
      let resumen = `✅ Ítem agregado: *${ctx.session.data.currentItem.nombre}* x ${ctx.session.data.currentItem.cantidad} a $${precio.toFixed(2)} c/u.\n\n`;
      resumen += `*Total de ítems agregados: ${ctx.session.data.items.length}.*\n\n`;
      resumen += "¿Deseas agregar **otro repuesto** o **confirmar la venta**?";

      const repuestoKeyboard = Markup.keyboard([
        ["➕ Agregar Repuesto", "✅ Confirmar Venta"],
        ["/cancelar"],
      ])
      .resize()
      .oneTime();

      // Volvemos al paso de selección de acción (Agregar/Confirmar)
      ctx.session.step = 2; 
      delete ctx.session.data.currentItem;
      return ctx.reply(resumen, { 
        parse_mode: "Markdown",
        reply_markup: repuestoKeyboard.reply_markup,
      });
    }

    // Si el usuario envía texto en el Paso 2, se ignora, debe usar los botones.
    else if (currentStep === 2) {
      return ctx.reply("⚠️ Por favor, usá los botones para *Agregar Repuesto* o /cancelar.");
    }
    
    // Si el usuario envía texto en la confirmación final, se ignora, debe usar el botón.
    else if (currentStep === "confirmacionFinal") {
       return ctx.reply("⚠️ Por favor, usá el botón *Procesar y Confirmar Venta* o /cancelar.");
    }

  } 
  
  // Manejo del flujo 'agregarProveedor'
  else if (flow === "agregarProveedor") {
    
    // Paso 1: Nombre
    if (currentStep === 1) {
      if (text.length < 3) {
        return ctx.reply("El nombre debe tener al menos 3 caracteres.");
      }
      ctx.session.data.nombre = text;
      ctx.session.step = 2;
      return ctx.reply("Ingresá un **nombre de contacto** (ej: Juan Pérez).", { parse_mode: "Markdown" });
    }
    
    // Paso 2: Contacto
    else if (currentStep === 2) {
      ctx.session.data.contacto = text;
      ctx.session.step = 3;
      return ctx.reply("Ingresá el **email** de contacto del proveedor.", { parse_mode: "Markdown" });
    }
    
    // Paso 3: Email
    else if (currentStep === 3) {
      // Validación simple de email
      if (!text.includes("@") || !text.includes(".")) {
        return ctx.reply("⚠️ Email inválido. Por favor, revisá y volvé a ingresarlo.");
      }
      ctx.session.data.email = text;
      ctx.session.step = 4;
      return ctx.reply("Ingresá la **dirección física** del proveedor.", { parse_mode: "Markdown" });
    }
    
    // Paso 4: Dirección
    else if (currentStep === 4) {
      ctx.session.data.direccion = text;
      ctx.session.step = 5;
      return ctx.reply("Ingresá el **teléfono** del proveedor.", { parse_mode: "Markdown" });
    }
    
    // Paso 5: Teléfono -> Confirmación
    else if (currentStep === 5) {
      ctx.session.data.telefono = text;
      
      // Generar resumen
      let resumen = `**RESUMEN DE PROVEEDOR**\n\n`;
      resumen += `*Nombre:* ${ctx.session.data.nombre}\n`;
      resumen += `*Contacto:* ${ctx.session.data.contacto}\n`;
      resumen += `*Email:* ${ctx.session.data.email}\n`;
      resumen += `*Dirección:* ${ctx.session.data.direccion}\n`;
      resumen += `*Teléfono:* ${ctx.session.data.telefono}\n\n`;
      resumen += "⚠️ ¿Es correcto? Presioná **Registrar Proveedor** para guardar en Sheets, o /cancelar.";

      const confirmationKeyboard = Markup.keyboard([
        ["💾 Registrar Proveedor"],
        ["/cancelar"],
      ])
      .resize()
      .oneTime();

      ctx.session.step = "confirmacionProveedor";
      return ctx.reply(resumen, { 
        parse_mode: "Markdown",
        reply_markup: confirmationKeyboard.reply_markup,
      });
    }

  } 
  
  // Si no estamos en el flujo 'agregarProveedor', dejamos que el handler anterior o el default se encarguen.
  await next();
});

bot.hears("💾 Registrar Proveedor", async (ctx) => {
  if (ctx.session.flow === "agregarProveedor" && ctx.session.step === "confirmacionProveedor") {
    await ctx.reply("⏱️ Registrando proveedor en Google Sheets...");
    
    let replyMessage = "✅ **Registro de Proveedor completado:**\n\n";

    try {
        await recordProviderToSheets(ctx.session.data);
        replyMessage += `  - Proveedor *${ctx.session.data.nombre}* registrado con éxito.\n`;
        await ctx.reply(replyMessage, { parse_mode: "Markdown" });

    } catch (e) {
        await errorLog(`Error en el flujo de proveedor: ${e.message}`);
        await ctx.reply(`❌ Hubo un error al registrar el proveedor. Revisa los logs. \nDetalle del Error: \`${e.message}\``, {
            parse_mode: "Markdown",
        });
    }

    ctx.session = {};
    return replyMain(ctx);
  } else {
    // Si no estamos en el flujo 'agregarProveedor', dejamos que el handler anterior o el default se encarguen.
    await next();
  }
});


// Handler de texto por defecto si nada anterior lo manejó
bot.on('text', async (ctx) => {
  // Este es un fallback si el mensaje de texto no fue manejado por los flujos.
  return ctx.reply("⚠️ No entendí, por favor usá el menú.", {
    reply_markup: mainKeyboard.reply_markup,
  });
});

// ---------- APP Y LANZAMIENTO ----------
const app = express();
app.get("/", (req, res) => res.send("Bot activo"));

// init and launch
(async ()=>{
  await ensureLocalFolders();
  
  // Inicializamos Sheets primero...
  await initSheets(); 
  initMailer(); // Inicializamos el mailer

  if (WEBHOOK_URL) {
    // Modo Webhook (Recomendado para producción para evitar error 409)
    const secretPath = `/telegraf/${BOT_TOKEN}`; 
    
    // 1. Configurar Express para escuchar las actualizaciones de Telegram
    app.use(bot.webhookCallback(secretPath));
    
    // 2. Establecer el webhook en Telegram
    try {
      await bot.telegram.setWebhook(`${WEBHOOK_URL}${secretPath}`);
      await log(`✅ Bot en modo Webhook. Escuchando en ${WEBHOOK_URL}${secretPath}`);
      botStatus = "conectado (webhook)";
    } catch (e) {
      await errorLog(`Error al configurar Webhook: ${e.message}`);
      botStatus = "ERROR (webhook)";
    }
  } else {
    // Modo Polling (Usado para desarrollo, puede causar error 409 en despliegues con múltiples procesos)
    await log("⚠️ WEBHOOK_URL no definido. Usando Telegraf Polling.");
    try {
      await bot.launch();
      botStatus = "conectado (polling)";
    } catch (e) {
      await errorLog(`Error al iniciar Polling: ${e.message}`);
      botStatus = "ERROR (polling)";
    }
  }

  await log(`✅ Bot de Telegram iniciado. Estado: ${botStatus}`);
  
  // Lanzar Express
  app.listen(PORT, async () => {
    await log(`🚀 Servidor Express escuchando en puerto ${PORT}`);
  });
  
  // SOLUCIÓN: Adjuntar los manejadores de detención
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
})();

// ---------- ERRORES ----------
bot.catch(async (err, ctx) => {
  // Aseguramos que el error se loguee en un solo lugar
  const errorMessage = `Unhandled error: ${err.message} en contexto de ${ctx.updateType}`;
  // Evitamos doble log si ya fue logueado en la función de confirmación.
  if (!errorMessage.includes("PDF") && !errorMessage.includes("Drive")) { 
    await errorLog(errorMessage);
  }
  // Intenta enviar un mensaje de error al usuario si es posible
  try {
    await ctx.reply("🚨 Ocurrió un error inesperado. Por favor, volvé a intentarlo desde el menú principal.", {
      reply_markup: mainKeyboard.reply_markup,
    });
  } catch (e) {
    // Si no se puede ni responder, solo loguear
    console.error("Error FATAL: No se pudo enviar mensaje de error al usuario.");
  }
});
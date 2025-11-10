// index_debug_full.js - CommonJS
// Versión con logs detallados, todos los flujos activos y conexión a Sheets + Drive + Gmail
// Requisitos:
// npm install telegraf telegraf-session-local pdfkit googleapis axios dotenv nodemailer express

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const TelegrafLocalSession = require("telegraf-session-local"); // AÑADIDO: Importar el constructor de la sesión local
const localSessionMiddleware = new TelegrafLocalSession({ database: "session_db.json" }); // MODIFICADO: Crear la instancia con un nombre distinto
const PDFDocument = require("pdfkit");
const { google } = require("googleapis");
const axios = require("axios");
const nodemailer = require("nodemailer");
require("dotenv").config();

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null;
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const GOOGLE_SERVICE_ACCOUNT_FILE = "./gen-lang-client-0104843305-3b7345de7ec0.json";
const LOG_FILE = "logs.txt";
const PORT = process.env.PORT || 3000;
const LOGO_PATH = "./REPUESTOS EL CHOLO LOGO.png";
const DRIVE_PARENT_FOLDER_ID = "1ByMDQDSWku135s1SwForGtWvyl2gcRSM";
const TICKETS_BASE = path.join(__dirname, "tickets");

const MAIL_USER = process.env.MAIL_USER || "";
const MAIL_PASS = process.env.MAIL_PASS || "";
const INTERNAL_NOTIFY_EMAIL = "info@repuestoselcholo.com.ar";

const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!BOT_TOKEN) throw new Error("FATAL: BOT_TOKEN no definido.");

// ---------- LOGGING ----------
async function appendLogRaw(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}\n`;
  try {
    await fsp.appendFile(LOG_FILE, line);
  } catch (e) {}
  console.log(line.trim());
}
const log = (m) => appendLogRaw("INFO", m);
const warn = (m) => appendLogRaw("WARN", m);
const errorLog = (m) => appendLogRaw("ERROR", m);

// ---------- GOOGLE ----------
let sheetsClient = null;
let driveClient = null;
let sheetsInitialized = false;

async function initGoogleAuth() {
  const keyRaw = await fsp.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, "utf8");
  const key = JSON.parse(keyRaw);
  const privateKey = key.private_key.replace(/\\n/g, "\n");
  const jwt = new google.auth.JWT(key.client_email, null, privateKey, [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
  ]);
  await jwt.authorize();
  return jwt;
}

async function initSheets() {
  try {
    const jwt = await initGoogleAuth();
    sheetsClient = google.sheets({ version: "v4", auth: jwt });
    driveClient = google.drive({ version: "v3", auth: jwt });
    sheetsInitialized = true;
    await log("✅ Google Sheets & Drive inicializados correctamente.");
  } catch (e) {
    sheetsInitialized = false;
    await errorLog("❌ Error inicializando Sheets/Drive: " + e.message);
  }
}

async function ensureLocalFolders() {
  await fsp.mkdir(TICKETS_BASE, { recursive: true }).catch(() => {});
  for (const r of ["ElCholo", "Ramirez", "Tejada"]) {
    await fsp.mkdir(path.join(TICKETS_BASE, r), { recursive: true }).catch(() => {});
  }
  await log("📁 Carpetas locales de tickets aseguradas");
}
// ---------- PROVEEDORES (Lectura y búsqueda en Google Sheets) ----------
async function readProviders() {
  if (!sheetsInitialized) return [];
  try {
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `Proveedores!A2:C`, // nombre, correo, direccion
    });
    const rows = resp.data.values || [];
    return rows.map(([nombre, correo, direccion]) => ({
      nombre: nombre || "",
      correo: correo || "",
      direccion: direccion || "",
    }));
  } catch (e) {
    await errorLog("Error leyendo proveedores: " + e.message);
    return [];
  }
}

async function findProviderRowByName(nombreBuscado) {
  const proveedores = await readProviders();
  return proveedores.find(p =>
    p.nombre.toLowerCase().includes(nombreBuscado.toLowerCase())
  );
}
// ---------- DRIVE Y SHEETS AUX ----------
async function uploadToDrive(remitente, filePath, fileName) {
  if (!driveClient) {
    await warn("⚠️ Drive no inicializado, no se sube archivo.");
    return null;
  }

  try {
    const folderName = remitente;
    const folderRes = await driveClient.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${DRIVE_PARENT_FOLDER_ID}' in parents and trashed=false`,
      fields: "files(id, name)",
    });

    let folderId = folderRes.data.files?.[0]?.id;
    if (!folderId) {
      const folder = await driveClient.files.create({
        requestBody: {
          name: folderName,
          mimeType: "application/vnd.google-apps.folder",
          parents: [DRIVE_PARENT_FOLDER_ID],
        },
        fields: "id",
      });
      folderId = folder.data.id;
    }

    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };
    const media = { mimeType: "application/pdf", body: fs.createReadStream(filePath) };
    const file = await driveClient.files.create({
      requestBody: fileMetadata,
      media,
      fields: "id, webViewLink",
    });

    await log(`📤 Archivo subido a Drive: ${file.data.webViewLink}`);
    return file.data.webViewLink;
  } catch (e) {
    await errorLog("Error en uploadToDrive: " + e.message);
    return null;
  }
}

async function appendRowToSheet(remitente, values) {
  if (!sheetsInitialized) return;
  const range = `${remitente}!A:I`; // cada remitente tiene su hoja
  try {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    });
    await log(`📊 Registro añadido en hoja ${remitente}`);
  } catch (e) {
    await errorLog("Error en appendRowToSheet: " + e.message);
  }
}

// ---------- PDF ----------
async function generateTicketPDF(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      const RED = "#C8102E",
        BLUE = "#0B3B70";
      if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, 40, 40, { width: 120 });
      doc.fillColor(BLUE).fontSize(18).text("Ticket de Devolución", { align: "right" });
      doc.moveDown(1);
      doc.fillColor("black").fontSize(11).text(`Fecha registro: ${new Date().toLocaleString()}`, { align: "right" });
      doc.moveDown(0.5);
      doc.rect(40, doc.y, 515, 170).strokeColor(RED).lineWidth(1).stroke();
      doc.moveDown(1);
      doc.fontSize(12);
      const line = (l, v) => doc.fillColor(BLUE).text(`${l}: `, { continued: true }).fillColor("black").text(v).moveDown(0.2);
      line("Remitente", data.remitenteDisplay);
      line("Proveedor", data.proveedor);
      line("Código", data.codigo);
      line("Descripción", data.descripcion);
      line("Cantidad", data.cantidad);
      line("Motivo", data.motivo);
      line("Remito/Factura", data.remito);
      line("Fecha factura", data.fechaFactura);
      doc.moveDown(1);
      doc.fillColor("gray").fontSize(10).text("Gracias por registrar la devolución.", { align: "center" });
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
// ---------- EMAIL ----------
let mailTransporter = null;
function initMailer() {
  if (!MAIL_USER || !MAIL_PASS) {
    warn("⚠️ MAIL_USER o MAIL_PASS no definidos — los correos están deshabilitados.");
    return;
  }
  mailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: MAIL_USER, pass: MAIL_PASS },
  });
}

async function sendEmailWithAttachment(remitenteDisplay, filePath, fileName, ticketData, driveUrl) {
  if (!mailTransporter) return warn("Mailer no inicializado, no se envió correo.");
  const html = `
  <div style="font-family:Arial,sans-serif">
    <img src="cid:logo" width="180"><h2 style="color:#0B3B70">Nueva devolución registrada</h2>
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
    ${driveUrl ? `<p>Archivo en Drive: <a href="${driveUrl}">${driveUrl}</a></p>` : ""}
    <p>El ticket PDF se adjunta a este correo.</p>
  </div>`;
  const attachments = [{ filename: fileName, path: filePath }];
  if (fs.existsSync(LOGO_PATH)) attachments.push({ filename: path.basename(LOGO_PATH), path: LOGO_PATH, cid: "logo" });
  await mailTransporter.sendMail({
    from: `"Repuestos El Cholo" <${MAIL_USER}>`,
    to: INTERNAL_NOTIFY_EMAIL,
    subject: `📦 Nueva devolución - ${remitenteDisplay} - ${ticketData.proveedor}`,
    html,
    attachments,
  });
  await log(`📧 Correo enviado a ${INTERNAL_NOTIFY_EMAIL}`);
}

// ---------- BOT ----------
const bot = new Telegraf(BOT_TOKEN);
bot.use(localSessionMiddleware.middleware()); // CORREGIDO: Usar la nueva instancia

// Seguridad: solo usuarios permitidos
bot.use(async (ctx, next) => {
  const uid = String(ctx.from?.id || "");
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(uid)) {
    await ctx.reply("🚫 No estás autorizado para usar este bot.");
    return;
  }
  await next();
});

const mainKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("📦 Registrar devolución", "registro")],
  [Markup.button.callback("🔍 Consultar devoluciones", "consultar")],
  [Markup.button.callback("🎟️ Ticket", "ver_tickets"), Markup.button.callback("🏢 Ver proveedores", "ver_proveedores")],
  [Markup.button.callback("➕ Agregar proveedor", "agregar_proveedor")],
]);

const remitenteKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("1️⃣ El Cholo Repuestos (CUIT: 30-71634102-6)", "remitente_ElCholo")],
  [Markup.button.callback("2️⃣ Ramirez Cesar y Lois Gustavo S.H. (CUIT: 30-71144680-6)", "remitente_Ramirez")],
  [Markup.button.callback("3️⃣ Tejada Carlos y Gomez Juan S.H. (CUIT: 30-70996969-9)", "remitente_Tejada")],
  [Markup.button.callback("↩️ Volver", "main")],
]);

const replyMain = async (ctx) => {
  ctx.session = {};
  ctx.session.step = "main_menu";
  await ctx.reply("Menú principal:", { reply_markup: mainKeyboard.reply_markup });
};

// ---------- COMANDOS ----------
bot.start(async (ctx) => {
  await log(`Comienzo /start chat ${ctx.chat.id}`);
  ctx.session = {};
  ctx.session.step = "main_menu";
  await ctx.reply("👋 Hola! Soy el bot de devoluciones. ¿Qué querés hacer?", {
    reply_markup: mainKeyboard.reply_markup,
  });
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "/start - Menú principal\n/help - Ayuda\n/generartickets - Regenerar PDFs\n/status - Estado del bot",
    { reply_markup: mainKeyboard.reply_markup }
  );
});

// ---------- ACCIONES ----------
bot.action("main", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch {}
  return replyMain(ctx);
});

bot.action("registro", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch {}
  ctx.session.flow = "registro";
  ctx.session.step = "chooseRemitente";
  await ctx.reply("¿A qué empresa corresponde la devolución?", {
    reply_markup: remitenteKeyboard.reply_markup,
  });
});

// FIX: Handler agregado para el botón "Consultar devoluciones"
bot.action("consultar", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  // Resetea la sesión y devuelve al menú principal
  ctx.session = {};
  ctx.session.step = "main_menu";
  await ctx.reply("🔍 La función de *Consulta de Devoluciones* está en desarrollo. Por favor, usá el menú principal para otras acciones.", {
    parse_mode: "Markdown",
    reply_markup: mainKeyboard.reply_markup,
  });
});

// ---------- SELECCIÓN DE PROVEEDORES CON PAGINACIÓN ----------
bot.action(/remitente_(.+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  const remitente = ctx.match[1];
  ctx.session.remitente = remitente;
  ctx.session.remitenteDisplay =
    {
      ElCholo: "El Cholo Repuestos (CUIT: 30-71634102-6)",
      Ramirez: "Ramirez Cesar y Lois Gustavo S.H. (CUIT: 30-71144680-6)",
      Tejada: "Tejada Carlos y Gomez Juan S.H. (CUIT: 30-70996969-9)",
    }[remitente] || remitente;

  const proveedores = await readProviders();
  if (!proveedores.length) {
    await ctx.reply("⚠️ No se encontraron proveedores en la base de datos. Agregá uno desde el menú principal.", {
      reply_markup: mainKeyboard.reply_markup,
    });
    return;
  }

  ctx.session.proveedores = proveedores;
  ctx.session.page = 0;
  ctx.session.step = "chooseProveedor";

  return showProveedoresPage(ctx, 0);
});

async function showProveedoresPage(ctx, page = 0) {
  const proveedores = ctx.session.proveedores || [];
  const perPage = 10;
  const totalPages = Math.ceil(proveedores.length / perPage);
  const start = page * perPage;
  const end = Math.min(start + perPage, proveedores.length);
  const items = proveedores.slice(start, end);

  console.log("📋 Cantidad total de proveedores:", proveedores.length);
  console.log("➡️ Mostrando página:", page, "de", totalPages);
  console.log("📦 Ejemplo proveedor:", proveedores[0]);

  // Crear botones de proveedores
  const botones = items.map((p, i) => [
    Markup.button.callback(`${start + i + 1}. ${p.nombre}`, `prov_${start + i}`)
  ]);

  // Navegación
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️ Anterior", `page_${page - 1}`));
  if (page < totalPages - 1) nav.push(Markup.button.callback("➡️ Siguiente", `page_${page + 1}`));

  if (nav.length) botones.push(nav);
  botones.push([Markup.button.callback("✏️ Escribir otro proveedor", "prov_manual")]);
  botones.push([Markup.button.callback("↩️ Volver", "main")]);

  const text = `Remitente seleccionado: *${ctx.session.remitenteDisplay}*\n\n` +
               `Página ${page + 1}/${totalPages}\n` +
               `Elegí un proveedor:`;

  try {
	  console.log("Botones generados:", botones.length);

    await ctx.reply(text, {
      parse_mode: "Markdown",
      reply_markup: Markup.inlineKeyboard(botones)
    });
  } catch (err) {
    await errorLog("Error mostrando página de proveedores: " + err.message);
  }
}

bot.action(/page_(\d+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  const page = Number(ctx.match[1]);
  await showProveedoresPage(ctx, page);
});


bot.action(/prov_(\d+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  const idx = Number(ctx.match[1]);
  const prov = ctx.session.proveedores?.[idx];
  if (!prov) return ctx.reply("⚠️ Proveedor inválido.", { reply_markup: mainKeyboard.reply_markup });
  ctx.session.proveedor = prov.nombre;
  ctx.session.step = "codigo";
  await ctx.reply(`Proveedor seleccionado: *${prov.nombre}*.\nIngresá el código del producto:`, { parse_mode: "Markdown" });
});

bot.action("prov_manual", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  ctx.session.step = "proveedor";
  await ctx.reply("Escribí el nombre del proveedor manualmente:");
});

// ---------- MANEJO DE MENSAJES DE TEXTO (REGISTRO) ----------
// Nota: La función bot.on('text') necesita un 'next()' si no está en un flujo conocido.
// La versión original ya tenía un 'bot.on('text')' que maneja el flujo de registro.
// Vamos a asegurar que solo el primer bot.on('text') existe para el flujo de registro
// y el segundo bot.on('text') para agregarProveedor.

bot.on("text", async (ctx, next) => {
  const msg = ctx.message.text?.trim();
  const step = ctx.session?.step;

  if (ctx.session.flow === "registro") {
    switch (step) {
      case "proveedor":
        ctx.session.proveedor = msg;
        ctx.session.step = "codigo";
        return ctx.reply("Ingresá el código del producto:");

      case "codigo":
        ctx.session.codigo = msg;
        ctx.session.step = "descripcion";
        return ctx.reply("Ingresá la descripción del producto:");

      case "descripcion":
        ctx.session.descripcion = msg;
        ctx.session.step = "cantidad";
        return ctx.reply("Ingresá la cantidad:");

      case "cantidad":
        ctx.session.cantidad = msg;
        ctx.session.step = "motivo";
        return ctx.reply("Ingresá el motivo de la devolución:");

      case "motivo":
        ctx.session.motivo = msg;
        ctx.session.step = "remito";
        return ctx.reply("Ingresá el número de remito/factura:");

      case "remito":
        ctx.session.remito = msg;
        ctx.session.step = "fechaFactura";
        return ctx.reply("Ingresá la fecha de factura (DD/MM/AAAA):");

      case "fechaFactura":
        // validar formato dd/mm/yyyy
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(msg)) {
          return ctx.reply("⚠️ Formato de fecha inválido. Usá DD/MM/AAAA.");
        }
        ctx.session.fechaFactura = msg;
        ctx.session.step = "confirmarEnvio";
        return ctx.reply("¿Deseas enviar la devolución por correo electrónico?", {
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("✅ Sí", "enviar_mail_si"), Markup.button.callback("❌ No", "enviar_mail_no")],
          ]),
        });

      case "esperandoCorreo":
        ctx.session.correoManual = msg;
        await log(`Correo ingresado manualmente: ${msg}`);
        return confirmarDevolucion(ctx, true);

      default:
        // Si estamos en el flujo 'registro' pero en un paso no manejado, pasamos al siguiente handler
        await next();
        return;
    }
  } else if (ctx.session.flow === "agregarProveedor") {
     // El flujo de agregarProveedor se maneja en el siguiente bot.on('text')
     await next();
     return;
  } else {
     // Si no estamos en ningún flujo, pasamos al siguiente handler
     await next();
     return;
  }
});

// ---------- FLUJO DE CONFIRMACIONES ----------
bot.action("enviar_mail_si", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  const provRow = await findProviderRowByName(ctx.session.proveedor);

  if (provRow && provRow.correo) {
    ctx.session.correoProveedor = provRow.correo;
    await ctx.reply(`Se usará el correo registrado: ${provRow.correo}`, {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("✅ Confirmar", "confirmar_envio")],
        [Markup.button.callback("✏️ Ingresar otro correo", "ingresar_otro_correo")],
      ]),
    });
  } else {
    ctx.session.step = "esperandoCorreo";
    await ctx.reply("No hay correo registrado. Ingresá el correo electrónico del proveedor:");
  }
});

bot.action("enviar_mail_no", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  await confirmarDevolucion(ctx, false);
});

bot.action("ingresar_otro_correo", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  ctx.session.step = "esperandoCorreo";
  await ctx.reply("Ingresá el correo electrónico del proveedor:");
});

bot.action("confirmar_envio", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  await confirmarDevolucion(ctx, true);
});

// ---------- FUNCIÓN PRINCIPAL DE CONFIRMACIÓN ----------
async function confirmarDevolucion(ctx, enviarMail) {
  const data = {
    remitente: ctx.session.remitente,
    remitenteDisplay: ctx.session.remitenteDisplay,
    proveedor: ctx.session.proveedor,
    codigo: ctx.session.codigo,
    descripcion: ctx.session.descripcion,
    cantidad: ctx.session.cantidad,
    motivo: ctx.session.motivo,
    remito: ctx.session.remito,
    fechaFactura: ctx.session.fechaFactura,
    usuario: ctx.from?.first_name || "",
  };

  const fileName = `ticket_${data.proveedor.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.pdf`; // Limpiar nombre para el archivo
  const localPath = path.join(TICKETS_BASE, data.remitente, fileName);

  try {
    const pdfBuffer = await generateTicketPDF(data);
    await fsp.writeFile(localPath, pdfBuffer);
    await log(`📄 Ticket generado localmente: ${localPath}`);
  } catch(e) {
    await errorLog("❌ Error generando o guardando PDF: " + e.message);
    await ctx.reply("⚠️ Error generando el ticket PDF. Revisa los logs.");
    return; // Detener flujo si el PDF falla
  }


  let driveUrl = null;
  try {
    driveUrl = await uploadToDrive(data.remitente, localPath, fileName);
  } catch (e) {
    await errorLog("❌ Error subiendo a Drive: " + e.message);
  }

  if (sheetsInitialized) {
    await appendRowToSheet(data.remitente, [
      new Date().toLocaleString(),
      data.proveedor,
      data.codigo,
      data.descripcion,
      data.cantidad,
      data.motivo,
      data.remito,
      data.fechaFactura,
      data.usuario,
    ]);
  }

  if (enviarMail) {
    await sendEmailWithAttachment(data.remitenteDisplay, localPath, fileName, data, driveUrl);
  }

  await ctx.reply(`✅ Devolución registrada correctamente.\n${driveUrl ? "📎 Archivo subido a Drive." : ""}`, {
    reply_markup: mainKeyboard.reply_markup,
  });
  ctx.session = {};
}

// ---------- TICKETS ----------
bot.action("ver_tickets", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  await ctx.reply("Seleccioná el remitente para ver los últimos tickets:", {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("El Cholo", "tickets_ElCholo")],
      [Markup.button.callback("Ramirez", "tickets_Ramirez")],
      [Markup.button.callback("Tejada", "tickets_Tejada")],
      [Markup.button.callback("↩️ Volver", "main")],
    ]),
  });
});

bot.action(/tickets_(.+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  const remitente = ctx.match[1];
  const folder = path.join(TICKETS_BASE, remitente);
  
  let files = [];
  try {
     files = (await fsp.readdir(folder)).filter((f) => f.endsWith(".pdf"));
  } catch(e) {
     await errorLog(`Error leyendo carpeta de tickets ${folder}: ${e.message}`);
     return ctx.reply("⚠️ Error al acceder a los archivos de tickets.", { reply_markup: mainKeyboard.reply_markup });
  }

  // Ordenar por fecha de modificación
  const last5 = files
    .map(file => ({
        name: file,
        path: path.join(folder, file),
        time: fs.statSync(path.join(folder, file)).mtimeMs
    }))
    .sort((a, b) => b.time - a.time)
    .slice(0, 5);

  if (!last5.length) return ctx.reply("No hay tickets disponibles.", { reply_markup: mainKeyboard.reply_markup });
  
  for (const file of last5) {
    await ctx.replyWithDocument({ source: file.path, filename: file.name });
  }
  await ctx.reply("📋 Fin de la lista de tickets.", { reply_markup: mainKeyboard.reply_markup });
});
// ---------- VER Y AGREGAR PROVEEDORES ----------
// ---------- VER PROVEEDORES (LISTADO PAGINADO) ----------
bot.action("ver_proveedores", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  const proveedores = await readProviders();
  if (!proveedores.length) {
    return ctx.reply("⚠️ No hay proveedores cargados en la base de datos.", {
      reply_markup: mainKeyboard.reply_markup,
    });
  }

  ctx.session.proveedores = proveedores;
  ctx.session.page = 0;
  ctx.session.step = "verProveedores";

  return showProveedoresListado(ctx, 0);
});

async function showProveedoresListado(ctx, page = 0) {
  const proveedores = ctx.session.proveedores || [];
  const perPage = 8;
  const totalPages = Math.ceil(proveedores.length / perPage);
  const start = page * perPage;
  const items = proveedores.slice(start, start + perPage);

  let text = `📋 *Proveedores registrados* (página ${page + 1}/${totalPages}):\n\n`;
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    text += `${start + i + 1}. *${p.nombre}*`;
    if (p.correo) text += ` (${p.correo})`;
    if (p.direccion) text += ` — ${p.direccion}`;
    text += "\n";
  }

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️ Anterior", `provlist_${page - 1}`));
  if (page < totalPages - 1) nav.push(Markup.button.callback("➡️ Siguiente", `provlist_${page + 1}`));

  const botones = [];
  if (nav.length) botones.push(nav);
  botones.push([Markup.button.callback("↩️ Volver", "main")]);

  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: Markup.inlineKeyboard(botones),
  });
}

bot.action(/provlist_(\d+)/, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  const newPage = Number(ctx.match[1]);
  ctx.session.page = newPage;
  return showProveedoresListado(ctx, newPage);
});


bot.action("agregar_proveedor", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  ctx.session.flow = "agregarProveedor";
  ctx.session.step = "nombreProveedor";
  await ctx.reply("🆕 Ingresá el *nombre* del nuevo proveedor:", { parse_mode: "Markdown" });
});

// Flujo de agregar proveedor (bot.on 'text' separado para evitar conflictos de flujo)
bot.on("text", async (ctx, next) => {
  const msg = ctx.message.text?.trim();
  if (ctx.session.flow === "agregarProveedor") {
    switch (ctx.session.step) {
      case "nombreProveedor":
        ctx.session.nuevoProveedor = { nombre: msg };
        ctx.session.step = "correoProveedor";
        return ctx.reply("📧 Ingresá el correo del proveedor (o escribí '-' si no tiene):");
      case "correoProveedor":
        ctx.session.nuevoProveedor.correo = msg === "-" ? "" : msg;
        ctx.session.step = "direccionProveedor";
        return ctx.reply("🏢 Ingresá la dirección del proveedor (o '-' si no aplica):");
      case "direccionProveedor":
        ctx.session.nuevoProveedor.direccion = msg === "-" ? "" : msg;
        if (sheetsInitialized) {
          try {
            await sheetsClient.spreadsheets.values.append({
              spreadsheetId: SHEET_ID,
              range: "Proveedores!A:C",
              valueInputOption: "USER_ENTERED",
              requestBody: {
                values: [[
                  ctx.session.nuevoProveedor.nombre,
                  ctx.session.nuevoProveedor.correo,
                  ctx.session.nuevoProveedor.direccion
                ]]
              },
            });
            await log(`✅ Nuevo proveedor agregado a Sheets: ${ctx.session.nuevoProveedor.nombre}`);
          } catch (e) {
             await errorLog("❌ Error agregando proveedor a Sheets: " + e.message);
          }
        }
        await ctx.reply("✅ Proveedor agregado correctamente.", { reply_markup: mainKeyboard.reply_markup });
        ctx.session = {};
        return;
    }
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

// ---------- APP ----------
const app = express();
app.get("/", (req, res) => res.send("Bot activo"));
app.listen(PORT, async () => {
  await log(`🚀 Servidor Express escuchando en puerto ${PORT}`);
  await ensureLocalFolders();
  await initSheets();
  initMailer();
});

// ---------- ERRORES ----------
bot.catch(async (err, ctx) => {
  // Aseguramos que el error se loguee en un solo lugar
  const errorMessage = `Unhandled error: ${err.message}`;
  // Evitamos doble log si ya fue logueado en la función de confirmación.
  if (!errorMessage.includes("PDF") && !errorMessage.includes("Drive")) { 
     await errorLog(errorMessage);
  }
  // Intenta enviar un mensaje de error al usuario si es posible
  try {
      await ctx.reply("🚨 Ocurrió un error inesperado. Por favor, volvé a intentarlo desde el menú principal.", {
          reply_markup: mainKeyboard.reply_markup,
      });
  } catch {}
});


// ---------- ARRANQUE DEL BOT ----------
bot.launch();
log("🤖 Bot iniciado correctamente.");
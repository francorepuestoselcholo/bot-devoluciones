// index_debug_full.js - CommonJS
// Debug version + full flows, connects to Google Sheets & Drive, async ops, detailed logging.
// Requirements:
// npm install telegraf telegraf-session-local pdfkit googleapis axios dotenv nodemailer

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const PDFDocument = require('pdfkit');
const { google } = require('googleapis');
const axios = require('axios');
const nodemailer = require('nodemailer');
require('dotenv').config();

// ---------- CONFIG ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null;
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const GOOGLE_SERVICE_ACCOUNT_FILE = "./gen-lang-client-0104843305-3b7345de7ec0.json";
const LOG_FILE = "logs.txt";
const PORT = process.env.PORT || 3000;
const LOGO_PATH = "./REPUESTOS EL CHOLO LOGO.png";
const DRIVE_PARENT_FOLDER_ID = "1ByMDQDSWku135s1SwForGtWvyl2gcRSM";
const TICKETS_BASE = path.join(__dirname, 'tickets');

const MAIL_USER = process.env.MAIL_USER || '';
const MAIL_PASS = process.env.MAIL_PASS || '';
const INTERNAL_NOTIFY_EMAIL = 'info@repuestoselcholo.com.ar';

const ALLOWED_USERS = (process.env.ALLOWED_USERS || '').split(',').map(s=>s.trim()).filter(Boolean);

// sanity
if (!BOT_TOKEN) throw new Error("FATAL: BOT_TOKEN not defined in .env");

// ---------- Logging & utilities ----------
async function appendLogRaw(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}\n`;
  try { await fsp.appendFile(LOG_FILE, line); } catch(e){}
  console.log(line.trim());
}
async function log(msg) { return appendLogRaw('INFO', msg); }
async function warn(msg) { return appendLogRaw('WARN', msg); }
async function errorLog(msg) { return appendLogRaw('ERROR', msg); }

async function measure(label, fn) {
  const start = Date.now();
  try {
    const res = await fn();
    const took = Date.now() - start;
    if (took > 2000) await warn(`Action slow: ${label} (${took}ms)`);
    else await log(`${label} (${took}ms)`);
    return res;
  } catch (e) {
    await errorLog(`Error in ${label}: ${e && e.message}`);
    throw e;
  }
}

// ---------- Ensure directories ----------
async function ensureLocalFolders() {
  await fsp.mkdir(TICKETS_BASE, { recursive: true }).catch(()=>{});
  const remitentes = ['ElCholo','Ramirez','Tejada'];
  for (const r of remitentes) {
    await fsp.mkdir(path.join(TICKETS_BASE, r), { recursive: true }).catch(()=>{});
  }
  await log('Local ticket folders ensured');
}

// ---------- Google Sheets & Drive init ----------
let sheetsClient = null;
let driveClient = null;
let sheetsInitialized = false;

async function initGoogleAuth() {
  return measure('initGoogleAuth', async () => {
    const keyRaw = await fsp.readFile(GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8');
    const key = JSON.parse(keyRaw);
    const privateKey = key.private_key.replace(/\\n/g, '\n');
    const jwt = new google.auth.JWT(key.client_email, null, privateKey, [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ]);
    await jwt.authorize();
    return jwt;
  });
}

async function initSheets() {
  return measure('initSheets', async () => {
    if (!SHEET_ID) {
      await warn('SHEET_ID not set. Sheets disabled.');
      sheetsInitialized = false;
      return;
    }
    try {
      const jwt = await initGoogleAuth();
      sheetsClient = google.sheets({ version: 'v4', auth: jwt });
      driveClient = google.drive({ version: 'v3', auth: jwt });
      // Ensure tabs exist and headers
      await ensureSheetTabs(['ElCholo','Ramirez','Tejada','Proveedores']);
      await normalizeProveedoresSheet();
      sheetsInitialized = true;
      await log('Google Sheets & Drive initialized');
    } catch (e) {
      sheetsInitialized = false;
      await errorLog(`initSheets failed: ${e && e.message}`);
    }
  });
}

async function ensureSheetTabs(tabNames) {
  if (!sheetsClient) return;
  try {
    const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existing = (meta.data.sheets || []).map(s=>s.properties.title);
    const requests = tabNames.filter(t=>!existing.includes(t)).map(title => ({ addSheet: { properties: { title } } }));
    if (requests.length) {
      await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
      await log(`Created missing sheets: ${requests.map(r=>Object.keys(r.addSheet.properties)[0]).join(',')}`);
    }
    const headers = ["Fecha","Proveedor","Código Producto","Descripción","Cantidad","Motivo","N° Remito/Factura","Fecha Factura","UsuarioID"];
    for (const t of tabNames.filter(t=>t!=='Proveedores')) {
      try {
        const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${t}!A1:I1` });
        if (!resp.data.values || resp.data.values.length === 0) {
          await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: `${t}!A1:I1`,
            valueInputOption: 'RAW',
            requestBody: { values: [headers] }
          });
        }
      } catch (e) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${t}!A1:I1`,
          valueInputOption: 'RAW',
          requestBody: { values: [headers] }
        }).catch(()=>{});
      }
    }
  } catch (e) {
    await errorLog('ensureSheetTabs error: ' + (e && e.message));
  }
}

async function normalizeProveedoresSheet() {
  if (!sheetsClient) return;
  try {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Proveedores!A1:C1',
      valueInputOption: 'RAW',
      requestBody: { values: [['Nombre','Correo','Direccion']] }
    });
    await log('Proveedores sheet normalized to columns Nombre|Correo|Direccion');
  } catch (e) {
    await errorLog('normalizeProveedoresSheet error: ' + (e && e.message));
  }
}

async function appendRowToSheet(tab, row) {
  return measure(`appendRowToSheet ${tab}`, async () => {
    if (!sheetsInitialized) throw new Error('Sheets not initialized');
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A:I`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] }
    });
  });
}

async function readProviders() {
  if (!sheetsInitialized) return [];
  const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Proveedores!A2:C` }).catch(()=>({ data:{ values: [] } }));
  const vals = resp.data.values || [];
  return vals.map((r, i)=>({ rowIndex: i+2, nombre: r[0]||'', correo: r[1]||'', direccion: r[2]||'' }));
}

async function findProviderRowByName(name) {
  const list = await readProviders();
  if (!name) return null;
  const exact = list.find(p => (p.nombre||'').trim().toLowerCase() === name.trim().toLowerCase());
  if (exact) return exact;
  const contains = list.find(p => (p.nombre||'').toLowerCase().includes(name.trim().toLowerCase()));
  return contains || null;
}

async function addProviderRow(nombre, correo, direccion) {
  if (!sheetsInitialized) throw new Error('Sheets not initialized');
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `Proveedores!A:C`,
    valueInputOption: 'RAW',
    requestBody: { values: [[nombre||'', correo||'', direccion||'']] }
  });
}

async function updateProviderEmail(rowIndex, email) {
  if (!sheetsInitialized) throw new Error('Sheets not initialized');
  const range = `Proveedores!B${rowIndex}`;
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [[email]] }
  });
}

// ---------- Drive helpers ----------
async function ensureDriveFolderForRemitente(remitente) {
  if (!driveClient) return null;
  try {
    const q = `'${DRIVE_PARENT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and name='${remitente}' and trashed=false`;
    const list = await driveClient.files.list({ q, fields: 'files(id,name)' });
    if (list.data.files && list.data.files.length) return list.data.files[0].id;
    const folder = await driveClient.files.create({ resource: { name: remitente, mimeType: 'application/vnd.google-apps.folder', parents:[DRIVE_PARENT_FOLDER_ID]}, fields:'id' });
    return folder.data.id;
  } catch (e) {
    await errorLog('ensureDriveFolderForRemitente error: ' + (e && e.message));
    return null;
  }
}

async function uploadToDrive(remitente, filePath, fileName) {
  return measure(`uploadToDrive ${fileName}`, async () => {
    if (!driveClient) return null;
    const folderId = await ensureDriveFolderForRemitente(remitente);
    if (!folderId) return null;
    const media = { mimeType: 'application/pdf', body: fs.createReadStream(filePath) };
    const res = await driveClient.files.create({ resource: { name: fileName, parents:[folderId] }, media, fields: 'id' });
    const fileId = res.data.id;
    await driveClient.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
    const publicUrl = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
    await log(`Uploaded to Drive: ${publicUrl}`);
    return publicUrl;
  });
}

# truncated due to size...
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import chalk from "chalk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as XLSX from "xlsx";

dotenv.config();

// =========================
//  🎨 Logger Berwarna
// =========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "bot.log");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function toPlain(value) {
  const seen = new WeakSet();
  const replacer = (_key, val) => {
    if (typeof val === "bigint") return String(val);
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack };
    }
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  };
  try {
    return JSON.parse(JSON.stringify(value, replacer));
  } catch (_) {
    return String(value);
  }
}

let FILE_LOG_ENABLED = true;
function log(level, message, meta = null) {
  const now = new Date();
  const time = now.toISOString().split("T")[1].split(".")[0];
  const text = typeof message === "string" ? message : JSON.stringify(message);
  const metaObj = meta ? toPlain(meta) : undefined;

  const metaConsole = metaObj ? chalk.gray(JSON.stringify(metaObj)) : "";
  let output;
  switch (level) {
    case "info":
      output = `${chalk.cyanBright(`[${time}] [INFO]`)} ${chalk.white(text)} ${metaConsole}`;
      break;
    case "warn":
      output = `${chalk.yellowBright(`[${time}] [WARN]`)} ${chalk.white(text)} ${metaConsole}`;
      break;
    case "error":
      output = `${chalk.redBright(`[${time}] [ERROR]`)} ${chalk.white(text)} ${metaConsole}`;
      break;
    default:
      output = `${chalk.gray(`[${time}] [LOG]`)} ${chalk.white(text)} ${metaConsole}`;
  }
  console.log(output);

  if (FILE_LOG_ENABLED) {
    const record = { t: now.toISOString(), level, msg: text };
    if (metaObj !== undefined) record.meta = metaObj;
    try {
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n");
    } catch (e) {
      FILE_LOG_ENABLED = false;
      console.warn("[logger] file logging disabled:", e?.message || e);
    }
  }
}

const logger = {
  info: (m, meta) => log("info", m, meta),
  warn: (m, meta) => log("warn", m, meta),
  error: (m, meta) => log("error", m, meta),
};

// =========================
//  🧱 Rate Limiter (per-user)
// =========================
const RATE_LIMIT_MAX = 3; // max messages
const RATE_LIMIT_WINDOW_MS = 10_000; // per 10 seconds
const userWindows = new Map(); // from -> number[] (timestamps)

function isRateLimited(userId) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const arr = userWindows.get(userId) || [];
  // drop old timestamps
  const recent = arr.filter(ts => ts >= windowStart);
  recent.push(now);
  userWindows.set(userId, recent);
  return recent.length > RATE_LIMIT_MAX;
}

// =========================
//  🤖 Inisialisasi Gemini
// =========================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// =========================
//  💬 Inisialisasi WhatsApp
// =========================
const client = new Client({
  authStrategy: new LocalAuth(),
});

const ADMIN_ID = process.env.ADMIN_ID;

// =========================
//  📚 Knowledge & FAQ
// =========================
let knowledge = [];
let faq = [];
try {
  if (fs.existsSync("./data/knowledge.json")) {
    const data = fs.readFileSync("./data/knowledge.json", "utf8");
    knowledge = data.trim() ? JSON.parse(data) : [];
  } else logger.warn("File knowledge.json tidak ditemukan.");

  if (fs.existsSync("./data/faq.json")) {
    const data = fs.readFileSync("./data/faq.json", "utf8");
    faq = data.trim() ? JSON.parse(data) : [];
  } else logger.warn("File faq.json tidak ditemukan.");
} catch (err) {
  logger.error("Gagal memuat knowledge/faq", { err });
}

// =========================
//  💾 Session Manager
// =========================
let sessions = {};
try {
  if (fs.existsSync("sessions.json")) {
    const raw = fs.readFileSync("sessions.json", "utf8");
    sessions = raw.trim() ? JSON.parse(raw) : {};
  }
} catch {
  logger.warn("sessions.json tidak valid, reset data");
}

// =========================
//  📋 Order Manager
// =========================
let orders = {};
let orderCounter = 1;

try {
  if (fs.existsSync("orders.json")) {
    const raw = fs.readFileSync("orders.json", "utf8");
    const data = raw.trim() ? JSON.parse(raw) : {};
    orders = data.orders || {};
    orderCounter = data.counter || 1;
  }
} catch {
  logger.warn("orders.json tidak valid, reset data");
}

function saveOrders() {
  const data = { orders, counter: orderCounter };
  fs.writeFileSync("orders.json", JSON.stringify(data, null, 2));
  logger.info("Orders disimpan", { count: Object.keys(orders).length });
}

function generateOrderId() {
  return `ORD-${String(orderCounter++).padStart(4, '0')}`;
}

function formatOrder(order) {
  return `📋 *${order.id}*\n` +
         `👤 Orderer: ${order.ordererName}\n` +
         `💰 Price: Rp ${order.price.toLocaleString('id-ID')}\n` +
         `📝 Details: ${order.details}\n` +
         `🔧 Work: ${order.work}\n` +
         `📊 Status: ${order.status}\n` +
         `⏰ Time: ${new Date(order.time).toLocaleString('id-ID')}\n` +
         `📅 Deadline: ${order.deadline ? new Date(order.deadline).toLocaleString('id-ID') : 'Tidak ditentukan'}`;
}

async function exportOrdersToExcel() {
  const worksheetData = [
    ['Order ID', 'Orderer Name', 'Price (Rp)', 'Details', 'Work Type', 'Status', 'Created Time', 'Deadline']
  ];
  
  Object.values(orders).forEach(order => {
    worksheetData.push([
      order.id,
      order.ordererName,
      order.price,
      order.details,
      order.work,
      order.status,
      new Date(order.time).toLocaleString('id-ID'),
      order.deadline ? new Date(order.deadline).toLocaleString('id-ID') : 'Tidak ditentukan'
    ]);
  });
  
  const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
  
  // Set column widths for better readability
  const columnWidths = [
    { wch: 12 }, // Order ID
    { wch: 20 }, // Orderer Name
    { wch: 15 }, // Price
    { wch: 40 }, // Details
    { wch: 20 }, // Work Type
    { wch: 15 }, // Status
    { wch: 20 }, // Created Time
    { wch: 20 }  // Deadline
  ];
  worksheet['!cols'] = columnWidths;
  
  // Add range for styling
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  
  // Style the header row (row 0)
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cellAddress = XLSX.utils.encode_cell({ r: 0, c: col });
    if (!worksheet[cellAddress]) continue;
    
    worksheet[cellAddress].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { fgColor: { rgb: "366092" } },
      alignment: { horizontal: "center", vertical: "center" },
      border: {
        top: { style: "thin", color: { rgb: "000000" } },
        bottom: { style: "thin", color: { rgb: "000000" } },
        left: { style: "thin", color: { rgb: "000000" } },
        right: { style: "thin", color: { rgb: "000000" } }
      }
    };
  }
  
  // Style data rows with alternating colors
  for (let row = 1; row <= range.e.r; row++) {
    const isEvenRow = row % 2 === 0;
    const backgroundColor = isEvenRow ? "F2F2F2" : "FFFFFF";
    
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
      if (!worksheet[cellAddress]) continue;
      
      // Special styling for different columns
      let cellStyle = {
        fill: { fgColor: { rgb: backgroundColor } },
        border: {
          top: { style: "thin", color: { rgb: "CCCCCC" } },
          bottom: { style: "thin", color: { rgb: "CCCCCC" } },
          left: { style: "thin", color: { rgb: "CCCCCC" } },
          right: { style: "thin", color: { rgb: "CCCCCC" } }
        },
        alignment: { vertical: "center" }
      };
      
      // Price column - right aligned and formatted
      if (col === 2) { // Price column
        cellStyle.alignment.horizontal = "right";
        cellStyle.numFmt = "#,##0";
      }
      // Status column - center aligned with color coding
      else if (col === 5) { // Status column
        cellStyle.alignment.horizontal = "center";
        const status = worksheet[cellAddress].v;
        if (status === "done") {
          cellStyle.fill.fgColor = { rgb: "C6EFCE" }; // Light green
          cellStyle.font = { color: { rgb: "006100" } };
        } else if (status === "on progress") {
          cellStyle.fill.fgColor = { rgb: "FFEB9C" }; // Light yellow
          cellStyle.font = { color: { rgb: "9C5700" } };
        } else if (status === "canceled") {
          cellStyle.fill.fgColor = { rgb: "FFC7CE" }; // Light red
          cellStyle.font = { color: { rgb: "9C0006" } };
        } else if (status === "todo") {
          cellStyle.fill.fgColor = { rgb: "E7E6E6" }; // Light gray
          cellStyle.font = { color: { rgb: "000000" } };
        }
      }
      // Details column - wrap text
      else if (col === 3) { // Details column
        cellStyle.alignment.wrapText = true;
        cellStyle.alignment.horizontal = "left";
      }
      // Other columns - left aligned
      else {
        cellStyle.alignment.horizontal = "left";
      }
      
      worksheet[cellAddress].s = cellStyle;
    }
  }
  
  // Add summary section
  const summaryRow = range.e.r + 3;
  const summaryData = [
    ['SUMMARY', '', '', '', '', '', '', ''],
    ['Total Orders:', Object.keys(orders).length, '', '', '', '', '', ''],
    ['Total Revenue:', Object.values(orders).reduce((sum, order) => sum + order.price, 0), '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['Status Breakdown:', '', '', '', '', '', '', ''],
    ['Todo:', Object.values(orders).filter(o => o.status === 'todo').length, '', '', '', '', '', ''],
    ['On Progress:', Object.values(orders).filter(o => o.status === 'on progress').length, '', '', '', '', '', ''],
    ['Done:', Object.values(orders).filter(o => o.status === 'done').length, '', '', '', '', '', ''],
    ['Canceled:', Object.values(orders).filter(o => o.status === 'canceled').length, '', '', '', '', '', '']
  ];
  
  // Add summary data
  summaryData.forEach((row, index) => {
    const rowNum = summaryRow + index;
    row.forEach((cell, colIndex) => {
      if (cell !== '') {
        const cellAddress = XLSX.utils.encode_cell({ r: rowNum, c: colIndex });
        worksheet[cellAddress] = { v: cell };
        
        // Style summary section
        if (index === 0) { // Summary header
          worksheet[cellAddress].s = {
            font: { bold: true, color: { rgb: "FFFFFF" } },
            fill: { fgColor: { rgb: "70AD47" } },
            alignment: { horizontal: "center", vertical: "center" },
            border: {
              top: { style: "thin", color: { rgb: "000000" } },
              bottom: { style: "thin", color: { rgb: "000000" } },
              left: { style: "thin", color: { rgb: "000000" } },
              right: { style: "thin", color: { rgb: "000000" } }
            }
          };
        } else if (colIndex === 1 && (index === 2 || index === 3)) { // Revenue and count cells
          worksheet[cellAddress].s = {
            font: { bold: true },
            fill: { fgColor: { rgb: "E2EFDA" } },
            alignment: { horizontal: "right" },
            numFmt: index === 2 ? "#,##0" : "0",
            border: {
              top: { style: "thin", color: { rgb: "CCCCCC" } },
              bottom: { style: "thin", color: { rgb: "CCCCCC" } },
              left: { style: "thin", color: { rgb: "CCCCCC" } },
              right: { style: "thin", color: { rgb: "CCCCCC" } }
            }
          };
        } else {
          worksheet[cellAddress].s = {
            fill: { fgColor: { rgb: "E2EFDA" } },
            border: {
              top: { style: "thin", color: { rgb: "CCCCCC" } },
              bottom: { style: "thin", color: { rgb: "CCCCCC" } },
              left: { style: "thin", color: { rgb: "CCCCCC" } },
              right: { style: "thin", color: { rgb: "CCCCCC" } }
            }
          };
        }
      }
    });
  });
  
  // Update the worksheet range to include summary
  const newRange = XLSX.utils.decode_range(worksheet['!ref']);
  newRange.e.r = summaryRow + summaryData.length - 1;
  worksheet['!ref'] = XLSX.utils.encode_range(newRange);
  
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Orders');
  
  const filename = `orders_${new Date().toISOString().split('T')[0]}.xlsx`;
  const filepath = path.join(__dirname, filename);
  
  // Use dynamic import for xlsx-style
  const XLSXStyle = await import('xlsx-style');
  XLSXStyle.default.writeFile(workbook, filepath);
  
  return { filename, filepath };
}

function parseOrderInput(input) {
  // Parse input in format: nama|harga|detail|pekerjaan|deadline
  // or multi-line format
  const lines = input.split('\n').map(line => line.trim()).filter(line => line);
  
  if (lines.length === 1) {
    // Single line format with | separator
    const parts = lines[0].split('|').map(part => part.trim());
    if (parts.length >= 4) {
      return {
        ordererName: parts[0],
        price: parseInt(parts[1]),
        details: parts[2],
        work: parts[3],
        deadline: parts[4] ? new Date(parts[4]).getTime() : null
      };
    }
  } else if (lines.length >= 4) {
    // Multi-line format
    return {
      ordererName: lines[0],
      price: parseInt(lines[1]),
      details: lines[2],
      work: lines[3],
      deadline: lines[4] ? new Date(lines[4]).getTime() : null
    };
  }
  
  return null;
}

function parseDateInput(dateStr) {
  if (!dateStr) return null;
  
  // Try different date formats
  const formats = [
    /^\d{4}-\d{2}-\d{2}$/, // YYYY-MM-DD
    /^\d{2}\/\d{2}\/\d{4}$/, // DD/MM/YYYY
    /^\d{2}-\d{2}-\d{4}$/, // DD-MM-YYYY
  ];
  
  for (const format of formats) {
    if (format.test(dateStr)) {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date.getTime();
      }
    }
  }
  
  return null;
}

// =========================
//  ⚙️ Allow Mode (Config via .env)
// =========================
// .env:
// ALLOW_MODE=all | allowlist
// ALLOW_LIST=628xxxx,628yyyy@c.us  (pisahkan dengan koma)
const envAllowMode = (process.env.ALLOW_MODE || 'all').toLowerCase();
const ALLOW_MODE = envAllowMode === 'allowlist' ? 'allowlist' : 'all';

function normalizeJid(input) {
  const id = String(input).trim();
  if (!id) return null;
  return id.includes('@c.us') ? id : `${id}@c.us`;
}

const envAllowListRaw = process.env.ALLOW_LIST || '';
const ALLOW_LIST = envAllowListRaw
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(normalizeJid)
  .filter(Boolean);

function saveSessions() {
  fs.writeFileSync("sessions.json", JSON.stringify(sessions, null, 2));
  logger.info("Sessions disimpan", { count: Object.keys(sessions).length });
}

function findContext(question) {
  const lower = question.toLowerCase();
  return knowledge.find(k => lower.includes(k.keyword))?.info || null;
}

function findFaqAnswer(question) {
  const text = (question || "").toLowerCase();
  // Exact or contains match against known FAQ questions
  const byExact = faq.find(item => item?.question && text === item.question.toLowerCase());
  if (byExact?.answer) return byExact.answer;
  const byContains = faq.find(item => item?.question && text.includes(item.question.toLowerCase()));
  if (byContains?.answer) return byContains.answer;
  return null;
}

// =========================
//  🧠 Per-user Memory
// =========================
const MEMORY_MAX_MESSAGES = 10; // total messages kept per user (user+bot)

function ensureSession(from) {
  if (!sessions[from]) sessions[from] = { mode: "ai", greeted: false, memory: [] };
  if (!Array.isArray(sessions[from].memory)) sessions[from].memory = [];
}

function appendMemory(from, role, text) {
  ensureSession(from);
  const trimmed = (text || "").toString().slice(0, 400);
  sessions[from].memory.push({ role, text: trimmed, at: Date.now() });
  while (sessions[from].memory.length > MEMORY_MAX_MESSAGES) sessions[from].memory.shift();
  saveSessions();
}

function buildMemoryBlock(from) {
  const mem = sessions[from]?.memory;
  if (!Array.isArray(mem) || mem.length === 0) return "";
  const lines = mem.map(m => `${m.role === "user" ? "User" : "Bot"}: ${m.text}`);
  return `\n\nKonteks singkat percakapan sebelumnya (terbaru di bawah):\n${lines.join("\n")}\n`;
}

// =========================
//  🔐 QR Login
// =========================
client.on("qr", qr => {
  logger.info("QR diterima, scan untuk login:");
  qrcode.generate(qr, { small: true });
});

// =========================
//  ✅ Bot Siap
// =========================
client.on("ready", () => {
  logger.info("✅ WhatsApp Bot siap digunakan!");
});

// =========================
//  💬 Event Pesan
// =========================
client.on("message", async msg => {
  const from = msg.from;
  const body = msg.body?.trim() || "";
  const isSelf = msg.fromMe;
  const chat = await msg.getChat();

  // 🔒 Abaikan status/grup
  if (msg.isStatus || msg.from === "status@broadcast" || chat.isGroup) {
    return;
  }

  logger.info("📩 Pesan diterima", { from, body });

  // 🎯 Allow mode enforcement (skip non-allowed users)
  if (ALLOW_MODE === "allowlist" && from !== ADMIN_ID) {
    const allowed = ALLOW_LIST.includes(from);
    if (!allowed) {
      logger.info("🚫 Pesan diabaikan (allowlist)", { from });
      return;
    }
  }

  // 🔔 Rate limiting (skip admin/self)
  if (from !== ADMIN_ID && !isSelf) {
    if (isRateLimited(from)) {
      logger.warn("⏳ Rate limited", { from });
      await msg.reply("⏳ Terlalu banyak pesan. Coba lagi beberapa detik lagi, ya.");
      return;
    }
  }

  // === Greeting pertama kali ===
  if (!sessions[from]?.greeted) {
    // Initialize session if missing
    ensureSession(from);
    sessions[from].mode = sessions[from].mode || "ai";
    sessions[from].greeted = true;
    saveSessions();

    let welcome =
      "🎬 *Selamat datang di Layanan Editing Video Profesional!*\n\n" +
      "Saya asisten virtual yang siap bantu kebutuhan editing video kamu. Pilih pertanyaan umum di bawah atau ketik pertanyaanmu langsung 👇\n\n";

    if (Array.isArray(faq) && faq.length > 0) {
      faq.forEach((item, i) => {
        if (item?.question) welcome += `${i + 1}. ${item.question}\n`;
      });
    } else {
      welcome += "_(Belum ada daftar pertanyaan umum)_";
    }

    await msg.reply(welcome);
    return;
  }

  // === Mode ADMIN ===
  if ((from === ADMIN_ID && body.startsWith("!")) || (isSelf && body.startsWith("!"))) {
    const [cmd, target] = body.split(" ");
    if (cmd === "!ambil" && target) {
      const targetId = target.includes("@c.us") ? target : `${target}@c.us`;
      ensureSession(targetId);
      sessions[targetId].mode = "human";
      saveSessions();
      await msg.reply(`✅ Kamu sekarang meng-handle chat dari ${targetId}`);
      await client.sendMessage(targetId, "🔔 Admin sudah bergabung dalam percakapan ini.");
    } else if (cmd === "!selesai" && target) {
      const targetId = target.includes("@c.us") ? target : `${target}@c.us`;
      ensureSession(targetId);
      sessions[targetId].mode = "ai";
      saveSessions();
      await msg.reply(`✅ Chat ${targetId} dikembalikan ke mode AI.`);
      await client.sendMessage(targetId, "🤖 Chat kembali ke mode otomatis (AI).");
    } else if (cmd === "!list") {
      const humanSessions = Object.entries(sessions)
        .filter(([_, s]) => s.mode === "human")
        .map(([id]) => `• ${id}`)
        .join("\n") || "Tidak ada user di mode human.";
      await msg.reply(`📋 Daftar user di mode human:\n${humanSessions}`);
    } else if (cmd === "!help") {
      await msg.reply(
        `🛠️ *Perintah Admin:*\n\n` +
          `*Chat Management:*\n` +
          `• !ambil <nomor> — Ambil alih chat user\n` +
          `• !selesai <nomor> — Kembalikan ke mode AI\n` +
          `• !list — Lihat daftar user dalam mode human\n\n` +
          `*Order Management:*\n` +
          `• !order add — Tambah order baru (lihat format)\n` +
          `• !order view [id] — Lihat order (semua atau spesifik)\n` +
          `• !order edit <id> <field> <value> — Edit order\n` +
          `• !order delete <id> — Hapus order\n` +
          `• !order export — Export ke Excel\n\n` +
          `• !help — Tampilkan bantuan`
      );
    } else if (cmd === "!order") {
      const [, subCmd, ...args] = body.split(" ");
      
      if (subCmd === "add") {
        // Get the full input after "!order add"
        const input = body.substring("!order add".length).trim();
        
        if (!input) {
          await msg.reply(
            `📋 *Format Tambah Order:*\n\n` +
            `*Format 1 (Single Line dengan |):*\n` +
            `!order add nama|harga|detail|pekerjaan|deadline\n\n` +
            `*Format 2 (Multi-line):*\n` +
            `!order add\n` +
            `nama pelanggan\n` +
            `harga\n` +
            `detail lengkap dengan spasi\n` +
            `jenis pekerjaan\n` +
            `deadline (opsional)\n\n` +
            `*Contoh Format 1:*\n` +
            `!order add "John Doe"|500000|"Video editing untuk pernikahan dengan efek khusus"|"Video Editing"|2024-12-31\n\n` +
            `*Contoh Format 2:*\n` +
            `!order add\n` +
            `John Doe\n` +
            `500000\n` +
            `Video editing untuk pernikahan dengan efek khusus dan transisi yang smooth\n` +
            `Video Editing\n` +
            `2024-12-31`
          );
          return;
        }
        
        const parsed = parseOrderInput(input);
        
        if (!parsed) {
          await msg.reply("❌ Format input tidak valid. Gunakan format yang benar.");
          return;
        }
        
        if (isNaN(parsed.price) || parsed.price <= 0) {
          await msg.reply("❌ Harga harus berupa angka positif.");
          return;
        }
        
        const orderId = generateOrderId();
        const order = {
          id: orderId,
          ordererName: parsed.ordererName,
          price: parsed.price,
          details: parsed.details,
          work: parsed.work,
          status: "todo",
          time: Date.now(),
          deadline: parsed.deadline
        };
        
        orders[orderId] = order;
        saveOrders();
        
        await msg.reply(`✅ Order berhasil ditambahkan!\n\n${formatOrder(order)}`);
        
      } else if (subCmd === "view") {
        if (args.length === 0) {
          // View all orders
          const orderList = Object.values(orders);
          if (orderList.length === 0) {
            await msg.reply("📋 Belum ada order.");
            return;
          }
          
          let response = `📋 *Daftar Semua Order (${orderList.length}):*\n\n`;
          orderList.forEach(order => {
            response += `${formatOrder(order)}\n\n`;
          });
          
          if (response.length > 4000) {
            // Split long messages
            const chunks = response.match(/.{1,4000}/g) || [];
            for (const chunk of chunks) {
              await msg.reply(chunk);
            }
          } else {
            await msg.reply(response);
          }
          
        } else {
          // View specific order
          const orderId = args[0];
          const order = orders[orderId];
          
          if (!order) {
            await msg.reply(`❌ Order dengan ID ${orderId} tidak ditemukan.`);
            return;
          }
          
          await msg.reply(formatOrder(order));
        }
        
      } else if (subCmd === "edit" && args.length >= 3) {
        const [orderId, field, ...valueParts] = args;
        const value = valueParts.join(" ");
        
        const order = orders[orderId];
        if (!order) {
          await msg.reply(`❌ Order dengan ID ${orderId} tidak ditemukan.`);
          return;
        }
        
        const validFields = ['ordererName', 'price', 'details', 'work', 'status', 'deadline'];
        if (!validFields.includes(field)) {
          await msg.reply(`❌ Field yang valid: ${validFields.join(', ')}`);
          return;
        }
        
        if (field === 'price') {
          const price = parseInt(value);
          if (isNaN(price) || price <= 0) {
            await msg.reply("❌ Harga harus berupa angka positif.");
            return;
          }
          order[field] = price;
        } else if (field === 'status') {
          const validStatuses = ['todo', 'on progress', 'done', 'canceled'];
          if (!validStatuses.includes(value.toLowerCase())) {
            await msg.reply(`❌ Status yang valid: ${validStatuses.join(', ')}`);
            return;
          }
          order[field] = value.toLowerCase();
        } else if (field === 'deadline') {
          const deadline = parseDateInput(value);
          if (value && !deadline) {
            await msg.reply("❌ Format deadline tidak valid. Gunakan format: YYYY-MM-DD, DD/MM/YYYY, atau DD-MM-YYYY");
            return;
          }
          order[field] = deadline;
        } else {
          order[field] = value;
        }
        
        saveOrders();
        await msg.reply(`✅ Order ${orderId} berhasil diupdate!\n\n${formatOrder(order)}`);
        
      } else if (subCmd === "delete" && args.length === 1) {
        const orderId = args[0];
        
        if (!orders[orderId]) {
          await msg.reply(`❌ Order dengan ID ${orderId} tidak ditemukan.`);
          return;
        }
        
        delete orders[orderId];
        saveOrders();
        await msg.reply(`✅ Order ${orderId} berhasil dihapus.`);
        
      } else if (subCmd === "export") {
        try {
          const { filename, filepath } = await exportOrdersToExcel();
          logger.info("Excel file generated", { filename, filepath });
          
          // Check if file exists
          if (!fs.existsSync(filepath)) {
            throw new Error("Excel file tidak ditemukan setelah dibuat");
          }
          
          // Get file stats
          const stats = fs.statSync(filepath);
          logger.info("Excel file stats", { size: stats.size, filename });
          
          // Read the Excel file as buffer
          const fileBuffer = fs.readFileSync(filepath);
          
          // Create media object with MS Excel MIME type
          const media = new MessageMedia(
            'application/vnd.ms-excel',
            fileBuffer.toString('base64'),
            filename
          );
          
          logger.info("Sending Excel file with MS Excel MIME type...");
          
          try {
            // Send the Excel file using client.sendMessage directly
            await client.sendMessage(msg.from, media, { caption: `📊 Export Order - ${filename}` });
            logger.info("Excel file sent successfully");
          } catch (sendError) {
            logger.error("Failed to send Excel file", { error: sendError.message });
            // Fallback: Send file information
            await msg.reply(
              `📊 *Excel Export Berhasil!*\n\n` +
              `✅ File Excel telah dibuat dengan styling profesional\n` +
              `📋 File: *${filename}*\n` +
              `📁 Lokasi: \`${filepath}\`\n` +
              `📏 Ukuran: ${(stats.size / 1024).toFixed(2)} KB\n\n` +
              `File dapat diakses langsung dari server.`
            );
          }
          
          // Clean up the file after 30 seconds
          setTimeout(() => {
            try {
              fs.unlinkSync(filepath);
              logger.info("Excel file cleaned up", { filename });
            } catch (e) {
              logger.warn("Gagal menghapus file export", { error: e.message });
            }
          }, 30000);
          
        } catch (error) {
          logger.error("Error export Excel", { error: error.message, stack: error.stack });
          await msg.reply(`❌ Gagal export ke Excel: ${error.message}`);
        }
        
      } else {
        await msg.reply(
          `📋 *Perintah Order:*\n\n` +
          `• !order add — Tambah order baru\n` +
          `• !order view [id] — Lihat order\n` +
          `• !order edit <id> <field> <value> — Edit order\n` +
          `• !order delete <id> — Hapus order\n` +
          `• !order export — Export ke Excel\n\n` +
          `*Field yang bisa diedit:* ordererName, price, details, work, status, deadline\n` +
          `*Status yang valid:* todo, on progress, done, canceled\n` +
          `*Format deadline:* YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY\n\n` +
          `Ketik *!order add* untuk melihat format input yang lengkap.`
        );
      }
    } else {
      await msg.reply("❓ Perintah tidak dikenal. Ketik *!help* untuk melihat daftar perintah.");
    }
    return;
  }

  // === User baru ===
  if (!sessions[from]) {
    ensureSession(from);
    sessions[from].mode = "ai";
    saveSessions();

    let welcome =
      "🎬 *Selamat datang di Layanan Editing Video Profesional!*\n\n" +
      "Saya adalah asisten virtual yang siap membantu kamu. Pilih salah satu pertanyaan umum di bawah ini atau ketik pertanyaan kamu langsung 👇\n\n";

    if (faq.length > 0) {
      faq.forEach((item, i) => {
        welcome += `${i + 1}. ${item.question}\n`;
      });
    } else {
      welcome += "_(Belum ada daftar pertanyaan umum)_";
    }

    await msg.reply(welcome);
    return;
  }

  const mode = sessions[from]?.mode || "ai";

  // === Minta admin ===
  if (/admin|cs|manusia/i.test(body)) {
    ensureSession(from);
    sessions[from].mode = "human";
    saveSessions();
    await msg.reply("🧑‍💼 Baik! Saya hubungkan kamu dengan admin kami...");
    await client.sendMessage(ADMIN_ID, `📩 *Customer ${from} ingin bicara dengan admin.*`);
    return;
  }

  // === Mode HUMAN ===
  if (mode === "human") {
    await client.sendMessage(ADMIN_ID, `📩 Dari ${from}: ${msg.body}`);
    return;
  }

  // === Mode AI ===
  const context = findContext(body);
  const faqAnswer = findFaqAnswer(body);
  const memoryBlock = buildMemoryBlock(from);

  try {
    let responseText = "";

    // 1️⃣ Jawaban dari FAQ langsung
    if (faqAnswer) {
      logger.info("📚 FAQ terjawab", { from });
      responseText = faqAnswer;

    // 2️⃣ Jawaban dari knowledge base (context ditemukan)
    } else if (context) {
      logger.info("📘 Knowledge match", { from });
      const prompt = `
Kamu adalah asisten layanan editing video profesional yang ramah dan efisien.
Gunakan informasi berikut untuk menjawab pertanyaan user.

📘 Informasi relevan:
${context}

💬 Pertanyaan user:
"${body}"

${memoryBlock}

Berikan jawaban singkat, jelas, dan sopan. Bila pertanyaannya tidak relevan dengan topik ini, tanggapi secara netral tanpa mengarang.
`;
      const result = await model.generateContent(prompt);
      responseText = result.response.text();

    // 3️⃣ Tidak ada data — AI tetap jawab sopan & arahkan ke admin
    } else {
      logger.info("💭 Tidak ada data yang cocok, batasi jawaban AI", { from });
      const prompt = `
Kamu adalah asisten layanan editing video profesional yang sopan dan ramah.
User bertanya: "${body}"

Kamu tidak punya data spesifik tentang hal ini.
Jawab secara singkat dan tetap relevan, jangan membuat asumsi atau informasi palsu.
Jika pertanyaan memerlukan jawaban pasti, sarankan dengan sopan untuk menghubungi admin.

Contoh gaya jawaban:
• "Hmm, sepertinya saya belum punya info pastinya. Biar lebih akurat, bisa langsung tanya admin ya 😊"
• "Untuk memastikan, sebaiknya kamu tanyakan ke admin kami agar dapat penjelasan lengkap."
• "Saya bantu sebisanya, tapi kalau butuh detail lebih, admin kami siap bantu!"

Gunakan gaya natural dan profesional. Jangan berulang kali menyarankan admin.
`;
      const result = await model.generateContent(prompt);
      responseText = result.response.text();
    }

    // simpan memory & balas user
    appendMemory(from, "user", body);
    appendMemory(from, "bot", responseText);
    await msg.reply(responseText);

  } catch (err) {
    logger.error("❌ Error AI", { error: err.message });
    await msg.reply("⚠️ Maaf, terjadi kesalahan saat memproses permintaanmu.");
  }
});

logger.info("🚀 Inisialisasi WhatsApp client...");
client.initialize();

log("info", "Logger startup test", { path: LOG_FILE, exists: fs.existsSync(LOG_FILE) });

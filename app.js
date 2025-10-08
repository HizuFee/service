import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import chalk from "chalk";
import { GoogleGenerativeAI } from "@google/generative-ai";

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
      sessions[targetId] = { mode: "human" };
      saveSessions();
      await msg.reply(`✅ Kamu sekarang meng-handle chat dari ${targetId}`);
      await client.sendMessage(targetId, "🔔 Admin sudah bergabung dalam percakapan ini.");
    } else if (cmd === "!selesai" && target) {
      const targetId = target.includes("@c.us") ? target : `${target}@c.us`;
      sessions[targetId] = { mode: "ai" };
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
          `• !ambil <nomor> — Ambil alih chat user\n` +
          `• !selesai <nomor> — Kembalikan ke mode AI\n` +
          `• !list — Lihat daftar user dalam mode human\n` +
          `• !help — Tampilkan bantuan`
      );
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
    sessions[from] = { mode: "human" };
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

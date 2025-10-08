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

// Safe serializer for meta/records (handles Error, BigInt, circular)
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

  // Console (colored, human-friendly)
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

  // File (structured JSONL, clean)
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
//  📚 Knowledge Base
// =========================
let knowledge = [];
try {
  if (fs.existsSync("./data/knowledge.json")) {
    const data = fs.readFileSync("./data/knowledge.json", "utf8");
    knowledge = data.trim() ? JSON.parse(data) : [];
  } else logger.warn("File knowledge.json tidak ditemukan.");
} catch (err) {
  logger.error("Gagal memuat knowledge.json", { err });
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

function saveSessions() {
  fs.writeFileSync("sessions.json", JSON.stringify(sessions, null, 2));
  logger.info("Sessions disimpan", { count: Object.keys(sessions).length });
}

function findContext(question) {
  const lower = question.toLowerCase();
  return knowledge.find(k => lower.includes(k.keyword))?.info || null;
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

  logger.info("📩 Pesan diterima", { from, body: body.slice(0, 80) + (body.length > 80 ? "..." : "") });

  // === Mode ADMIN / SELF ===
  if ((from === ADMIN_ID && body.startsWith("!")) || (isSelf && body.startsWith("!"))) {
    const [cmd, target] = body.split(" ");
    logger.info("🧩 Perintah admin", { cmd, target });

    if (cmd === "!ambil" && target) {
      const targetId = target.includes("@c.us") ? target : `${target}@c.us`;
      sessions[targetId] = { mode: "human" };
      saveSessions();
      await msg.reply(`✅ Kamu sekarang meng-handle chat dari ${targetId}`);
      await client.sendMessage(targetId, "🔔 Admin sudah bergabung dalam percakapan ini.");
    }

    else if (cmd === "!selesai" && target) {
      const targetId = target.includes("@c.us") ? target : `${target}@c.us`;
      sessions[targetId] = { mode: "ai" };
      saveSessions();
      await msg.reply(`✅ Chat ${targetId} dikembalikan ke mode AI.`);
      await client.sendMessage(targetId, "🤖 Chat kembali ke mode otomatis (AI).");
    }

    else if (cmd === "!list") {
      const humanSessions = Object.entries(sessions)
        .filter(([_, s]) => s.mode === "human")
        .map(([id]) => `• ${id}`)
        .join("\n") || "Tidak ada user di mode human.";
      await msg.reply(`📋 Daftar user di mode human:\n${humanSessions}`);
    }

    else if (cmd === "!help") {
      await msg.reply(
        `🛠️ *Perintah Admin:*\n\n` +
        `• !ambil <nomor> — Ambil alih chat user\n` +
        `• !selesai <nomor> — Kembalikan ke mode AI\n` +
        `• !list — Lihat daftar user dalam mode human\n` +
        `• !help — Tampilkan bantuan`
      );
    }

    else {
      await msg.reply("❓ Perintah tidak dikenal. Ketik *!help* untuk melihat daftar perintah.");
    }

    return;
  }

  // === Mode default: AI ===
  const mode = sessions[from]?.mode || "ai";

  // === User minta bicara dengan admin ===
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
  const prompt = context
    ? `Kamu adalah asisten customer service. Jawab berdasarkan informasi berikut: ${context}. Pertanyaan: ${body}`
    : `Kamu adalah asisten customer service. Jawab singkat, sopan, dan ramah: ${body}`;

  try {
    logger.info("🧠 Generate AI", { from, hasContext: Boolean(context), prompt: body.slice(0, 160) + (body.length > 160 ? "..." : "") });
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    logger.info("🤖 AI Answer", { to: from, answer: response.slice(0, 200) + (response.length > 200 ? "..." : "") });
    await msg.reply(response);
  } catch (err) {
    logger.error("❌ Error AI", { error: err.message });
    await msg.reply("⚠️ Maaf, terjadi kesalahan saat memproses permintaanmu.");
  }
});

logger.info("🚀 Inisialisasi WhatsApp client...");
client.initialize();

// One-time startup test write to validate file logging
log("info", "Logger startup test", { path: LOG_FILE, exists: fs.existsSync(LOG_FILE) });

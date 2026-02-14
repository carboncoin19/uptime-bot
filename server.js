import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";
import fs from "fs";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const DB_FILE = "/data/uptime.db";
const TZ_OFFSET_MS = 3600000; // Nigeria +1

const DAY_MS = 86400000;
const TG_POLL_MS = 4000;
const MIDNIGHT_CHECK_MS = 15000;
const DEVICE_STALE_MS = 2 * 60 * 1000;
/* ========================================= */

/* -------- MULTI BOT CONFIG -------- */
const BOTS = [];
for (let i = 1; i <= 10; i++) {
  const token = process.env[`TG_BOT_TOKEN_${i}`];
  const device = process.env[`TG_BOT_DEVICE_${i}`];
  if (token && device) {
    BOTS.push({
      token,
      device: device.trim(),
      deviceNorm: device.trim().toUpperCase(),
      lastId: 0,
    });
  }
}
console.log("🤖 Bots loaded:", BOTS.map(b => b.device));

/* ---------- ENSURE /data ---------- */
if (!fs.existsSync("/data")) fs.mkdirSync("/data", { recursive: true });

/* ---------- APP ---------- */
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("OK"));

/* ---------- SQLITE ---------- */
const db = new sqlite3.Database(DB_FILE, err => {
  if (err) console.log("❌ DB error:", err.message);
  else console.log("✅ SQLite ready:", DB_FILE);
});
db.get("PRAGMA journal_mode=WAL;");

/* ---------- DB INIT ---------- */
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chats(
    chat_id INTEGER,
    bot_token TEXT,
    PRIMARY KEY(chat_id, bot_token)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS devices(
    device TEXT PRIMARY KEY,
    last_seen INTEGER,
    status TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS daily_uptime(
    device TEXT,
    day INTEGER,
    uptime_ms INTEGER,
    PRIMARY KEY(device,day)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS monthly_uptime(
    device TEXT,
    month INTEGER,
    uptime_ms INTEGER,
    PRIMARY KEY(device,month)
  )`);
});

/* ---------- DB HELPERS ---------- */
const dbRun = (s, p = []) => new Promise(r => db.run(s, p, () => r(true)));
const dbGet = (s, p = []) => new Promise(r => db.get(s, p, (_, row) => r(row || null)));
const dbAll = (s, p = []) => new Promise(r => db.all(s, p, (_, rows) => r(rows || [])));

/* ---------- TIME HELPERS ---------- */
function todayEpochSec() {
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function monthStartEpochSec() {
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function epochSecToLabel(s) {
  return new Date(s * 1000 + TZ_OFFSET_MS)
    .toLocaleDateString("en-US", { month: "short", day: "2-digit" });
}

function formatTime(ms) {
  return new Date(ms + TZ_OFFSET_MS).toLocaleString();
}

const slaPercent = up => Math.min(100, (up / DAY_MS) * 100);
const bar = p =>
  "█".repeat(Math.round((p / 100) * 10)) +
  "░".repeat(10 - Math.round((p / 100) * 10));

function computeLiveStatus(d) {
  if (!d?.last_seen) return "UNKNOWN";
  if (Date.now() - d.last_seen > DEVICE_STALE_MS) return "UNKNOWN";
  return d.status || "UNKNOWN";
}

/* ---------- TELEGRAM ---------- */
async function tg(token, chat, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
  } catch {}
}

async function broadcast(token, text) {
  const chats = await dbAll(
    `SELECT chat_id FROM chats WHERE bot_token=?`,
    [token]
  );
  for (const c of chats) tg(token, c.chat_id, text);
}

/* ---------- EVENT API ---------- */
app.post("/api/event", async (req, res) => {
  const { device, event, uptime_ms, day, month, time, version } = req.body;
  const now = Date.now();
  const dev = String(device || "").trim();
  const devNorm = dev.toUpperCase();

  if (!event) return res.json({ ok: true });

  /* ===== DEVICE TRACKING ===== */
  if (dev) {
    const status =
      event === "ONLINE" || event === "OFFLINE" ? event : null;

    await dbRun(
      `INSERT INTO devices(device,last_seen,status)
       VALUES(?,?,?)
       ON CONFLICT(device)
       DO UPDATE SET last_seen=excluded.last_seen`,
      [dev, now, status]
    );

    if (status)
      await dbRun(
        `UPDATE devices SET status=? WHERE device=?`,
        [status, dev]
      );
  }

  /* ===== UPTIME STORAGE ===== */
  if (event === "DAILY_SYNC")
    await dbRun(
      `INSERT OR REPLACE INTO daily_uptime VALUES(?,?,?)`,
      [dev, day, uptime_ms || 0]
    );

  if (event === "MONTHLY_SYNC")
    await dbRun(
      `INSERT OR REPLACE INTO monthly_uptime VALUES(?,?,?)`,
      [dev, month, uptime_ms || 0]
    );

  /* ===== ONLINE/OFFLINE ALERT ===== */
  if (event === "ONLINE" || event === "OFFLINE") {
    const msg =
      `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n` +
      `${dev}\n🕒 ${time || formatTime(now)}`;

    for (const bot of BOTS)
      if (bot.deviceNorm === devNorm)
        broadcast(bot.token, msg);
  }

  /* ================= OTA PATCH ================= */

  if (event === "OTA_SUCCESS") {
    const msg =
      `🚀 OTA UPDATE SUCCESS\n\n` +
      `📟 ${dev}\n` +
      `🆕 Version: ${version || "unknown"}\n` +
      `🕒 ${time || formatTime(now)}`;

    for (const bot of BOTS)
      if (bot.deviceNorm === devNorm)
        broadcast(bot.token, msg);
  }

  if (event === "OTA_FAILED") {
    const msg =
      `❌ OTA UPDATE FAILED\n\n` +
      `📟 ${dev}\n` +
      `🆕 Version: ${version || "unknown"}\n` +
      `🕒 ${time || formatTime(now)}`;

    for (const bot of BOTS)
      if (bot.deviceNorm === devNorm)
        broadcast(bot.token, msg);
  }

  /* ================================================= */

  res.json({ ok: true });
});

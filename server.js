// ======================================================
// NDONI UPTIME SERVER (Railway)
// CLEAN, SYNTAX-SAFE FINAL VERSION
// ALL FEATURES PRESERVED
// ======================================================

/* ===================== IMPORTS ===================== */
import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

/* ===================== CONFIG ===================== */
const PORT = process.env.PORT || 8080;
const DB_FILE = "/data/uptime.db";
const TZ_OFFSET_MS = 3600000; // Nigeria +1

const DAY_MS = 86400000;
const MIDNIGHT_CHECK_MS = 15000;
const DEVICE_STALE_MS = 2 * 60 * 1000;

/* ===================== MULTI BOT CONFIG ===================== */
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

/* ===================== FILESYSTEM ===================== */
if (!fs.existsSync("/data")) fs.mkdirSync("/data", { recursive: true });

/* ===================== APP INIT ===================== */
const app = express();
const __dirname = new URL(".", import.meta.url).pathname;

app.use("/firmware", express.static(path.join(__dirname, "firmware")));
app.use(express.json());
app.get("/", (_, res) => res.status(200).send("OK"));

/* ===================== DATABASE ===================== */
const db = new sqlite3.Database(DB_FILE, err => {
  if (err) console.log("❌ DB error:", err.message);
  else console.log("✅ SQLite ready:", DB_FILE);
});

db.get("PRAGMA journal_mode=WAL;");

/* ===================== DB INIT ===================== */
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

  db.run(`CREATE TABLE IF NOT EXISTS firmware_control(
    device TEXT PRIMARY KEY,
    latest_version TEXT,
    firmware_url TEXT,
    update_requested INTEGER DEFAULT 0,
    force_update INTEGER DEFAULT 0,
    current_version TEXT
  )`);
});

/* ===================== DB HELPERS ===================== */
const dbRun = (s, p = []) => new Promise(r => db.run(s, p, () => r(true)));
const dbGet = (s, p = []) => new Promise(r => db.get(s, p, (_, row) => r(row || null)));
const dbAll = (s, p = []) => new Promise(r => db.all(s, p, (_, rows) => r(rows || [])));

/* ===================== TIME HELPERS ===================== */
function todayEpochSec() {
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function epochSecToLabel(s) {
  return new Date(s * 1000 + TZ_OFFSET_MS)
    .toLocaleDateString("en-US", { month: "short", day: "2-digit" });
}

const slaPercent = up => Math.min(100, (up / DAY_MS) * 100);
const bar = p => "█".repeat(Math.round((p / 100) * 10)) + "░".repeat(10 - Math.round((p / 100) * 10));

function computeLiveStatus(d) {
  if (!d?.last_seen) return "UNKNOWN";
  if (Date.now() - d.last_seen > DEVICE_STALE_MS) return "UNKNOWN";
  return d.status || "UNKNOWN";
}

function buildSlaMessage({ title, device, status, label, uptimeMs }) {
  const p = slaPercent(uptimeMs);
  return (
    "📊 " + title + "\\n" +
    "📟 " + device + "\\n" +
    "📡 Status: " + status + "\\n" +
    "📅 " + label + "\\n\\n" +
    "SLA: " + p.toFixed(2) + "%\\n" +
    "Uptime: " + (uptimeMs / 3600000).toFixed(2) + "h\\n" +
    bar(p)
  );
}

/* ===================== TELEGRAM HELPERS ===================== */
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
  const chats = await dbAll(`SELECT chat_id FROM chats WHERE bot_token=?`, [token]);
  for (const c of chats) tg(token, c.chat_id, text);
}

/* ===================== EVENT API ===================== */
app.post("/api/event", async (req, res) => {
  const { device, event, uptime_ms, day, month, time, version } = req.body;
  const now = Date.now();
  const dev = String(device || "").trim().toUpperCase();

  if (!event) return res.json({ ok: true });

  if (dev) {
    const status = event === "ONLINE" || event === "OFFLINE" ? event : null;

    await dbRun(
      `INSERT INTO devices(device,last_seen,status)
       VALUES(?,?,?)
       ON CONFLICT(device)
       DO UPDATE SET last_seen=excluded.last_seen`,
      [dev, now, status]
    );

    await dbRun(`INSERT INTO firmware_control(device) VALUES(?) ON CONFLICT(device) DO NOTHING`, [dev]);

    if (status)
      await dbRun(`UPDATE devices SET status=? WHERE device=?`, [status, dev]);
  }

  if (event === "DAILY_SYNC")
    await dbRun(`INSERT OR REPLACE INTO daily_uptime VALUES(?,?,?)`, [dev, day, uptime_ms || 0]);

  if (event === "MONTHLY_SYNC")
    await dbRun(`INSERT OR REPLACE INTO monthly_uptime VALUES(?,?,?)`, [dev, month, uptime_ms || 0]);

  if (event === "FW_REPORT")
    await dbRun(
      `INSERT INTO firmware_control(device,current_version)
       VALUES(?,?)
       ON CONFLICT(device)
       DO UPDATE SET current_version=excluded.current_version`,
      [dev, version || "unknown"]
    );

  if (event === "ONLINE" || event === "OFFLINE") {
    const msg = (event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE") + "
" + dev;
    for (const bot of BOTS) if (bot.deviceNorm === dev) broadcast(bot.token, msg);
  }

  res.json({ ok: true });
});

/* ===================== OTA CHECK API ===================== */
app.get("/api/fw/:device", async (req, res) => {
  const dev = req.params.device.trim().toUpperCase();
  const row = await dbGet(`SELECT * FROM firmware_control WHERE device=?`, [dev]);
  if (!row || row.update_requested !== 1) return res.json({ update: false });

  res.json({
    update: true,
    version: row.latest_version,
    url: row.firmware_url,
    force: row.force_update === 1,
    trigger: true
  });
});

/* ===================== TELEGRAM LONG POLLING ===================== */
function startLongPolling(bot) {
  async function poll() {
    try {
      const r = await fetch(`https://api.telegram.org/bot${bot.token}/getUpdates?offset=${bot.lastId + 1}&timeout=30`);
      const d = await r.json();
      if (!d.ok) return setTimeout(poll, 1000);

      for (const u of d.result) {
        bot.lastId = u.update_id;
        const chat = u.message?.chat?.id;
        const cmd = u.message?.text;
        if (!chat || !cmd) continue;

        await dbRun(`INSERT OR IGNORE INTO chats VALUES(?,?)`, [chat, bot.token]);

        if (cmd === "/start") tg(bot.token, chat, "📡 " + bot.device + " uptime monitor active.");

        if (cmd === "/fw") {
          const row = await dbGet(`SELECT current_version,latest_version FROM firmware_control WHERE device=?`, [bot.deviceNorm]);
          tg(bot.token, chat,
            "📟 " + bot.device + "
" +
            "Current Device Version: " + (row?.current_version || "Unknown") + "
" +
            "Latest Server Version: " + (row?.latest_version || "Not set")
          );
        }

        if (cmd === "/status") {
          const rows = await dbAll(`SELECT day,uptime_ms FROM daily_uptime WHERE device=? ORDER BY day DESC LIMIT 7`, [bot.deviceNorm]);
          const devRow = await dbGet(`SELECT * FROM devices WHERE device=?`, [bot.deviceNorm]);
          const y = epochSecToLabel(todayEpochSec() - 86400);
          const m = rows.find(r => epochSecToLabel(r.day) === y);
          if (!m) tg(bot.token, chat, "⚠️ No DAILY_SYNC for yesterday
📟 " + bot.device);
          else tg(bot.token, chat, buildSlaMessage({ title: "Yesterday SLA (24h)", device: bot.device, status: computeLiveStatus(devRow), label: y, uptimeMs: m.uptime_ms }));
        }

        if (cmd === "/statusweek") {
          const rows = await dbAll(`SELECT day,uptime_ms FROM daily_uptime WHERE device=? ORDER BY day DESC LIMIT 7`, [bot.deviceNorm]);
          if (!rows.length) tg(bot.token, chat, "⚠️ No uptime data yet.");
          else {
            let total = rows.reduce((s, r) => s + (r.uptime_ms || 0), 0);
            let txt = "📈 Weekly SLA Summary
📟 " + bot.device + "

";
            txt += "Overall SLA: " + slaPercent(total / rows.length).toFixed(2) + "%

";
            for (const r of rows.reverse()) txt += epochSecToLabel(r.day) + " " + bar(slaPercent(r.uptime_ms || 0)) + "
";
            tg(bot.token, chat, txt);
          }
        }
      }
      setTimeout(poll, 300);
    } catch {
      setTimeout(poll, 2000);
    }
  }
  poll();
}

for (const bot of BOTS) startLongPolling(bot);

/* ===================== START SERVER ===================== */
app.listen(PORT, "0.0.0.0", () => console.log("🚀 Server running on port", PORT));

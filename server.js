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

/* -------- MULTI BOT CONFIG -------- */
const BOTS = [];
for (let i = 1; i <= 10; i++) {
  const token = process.env[`TG_BOT_TOKEN_${i}`];
  const device = process.env[`TG_BOT_DEVICE_${i}`];
  if (token && device) {
    BOTS.push({
      token,
      device,
      deviceNorm: device.trim().toUpperCase(),
      lastId: 0,
    });
  }
}
/* ================================= */

/* ---------- ENSURE /data EXISTS ---------- */
if (!fs.existsSync("/data")) {
  fs.mkdirSync("/data", { recursive: true });
}

/* ---------- APP ---------- */
const app = express();
app.use(express.json());

/* ---------- SQLITE ---------- */
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.log("❌ DB error:", err.message);
  else console.log("✅ SQLite ready:", DB_FILE);
});
db.get("PRAGMA journal_mode=WAL;", () => {});

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
const dbGet = (s, p = []) =>
  new Promise((r) => db.get(s, p, (_, row) => r(row || null)));
const dbAll = (s, p = []) =>
  new Promise((r) => db.all(s, p, (_, rows) => r(rows || [])));
const dbRun = (s, p = []) =>
  new Promise((r) => db.run(s, p, () => r(true)));

/* ---------- TIME HELPERS ---------- */
const todayEpochSec = () => {
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};

const epochSecToLabel = (s) =>
  new Date(s * 1000 + TZ_OFFSET_MS).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
  });

const slaPercent = (up) => Math.min(100, (up / DAY_MS) * 100);
const bar = (p) =>
  "█".repeat(Math.round((p / 100) * 10)) +
  "░".repeat(10 - Math.round((p / 100) * 10));

/* ---------- LIVE STATUS ---------- */
function computeLiveStatus(d) {
  if (!d?.last_seen) return "UNKNOWN";
  if (Date.now() - d.last_seen > DEVICE_STALE_MS) return "UNKNOWN";
  return d.status || "UNKNOWN";
}

/* ---------- TELEGRAM ---------- */
async function tg(token, chat, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  }).catch(() => {});
}

async function broadcast(token, text) {
  const chats = await dbAll(
    `SELECT chat_id FROM chats WHERE bot_token=?`,
    [token]
  );

  // 🔥 FIX: warn if no subscribers
  if (!chats.length) {
    console.log("⚠️ No subscribers for bot:", token.slice(0, 10));
    return;
  }

  for (const c of chats) tg(token, c.chat_id, text);
}

/* ---------- EVENT API ---------- */
app.post("/api/event", async (req, res) => {
  const { device, event, uptime_ms, day, month, time } = req.body;
  const now = Date.now();
  const devNorm = String(device || "").trim().toUpperCase();

  if (device) {
    const status = event === "ONLINE" || event === "OFFLINE" ? event : null;
    await dbRun(
      `INSERT INTO devices(device,last_seen,status)
       VALUES(?,?,?)
       ON CONFLICT(device)
       DO UPDATE SET last_seen=excluded.last_seen`,
      [device, now, status]
    );
  }

  if (event === "DAILY_SYNC")
    await dbRun(`INSERT OR REPLACE INTO daily_uptime VALUES(?,?,?)`, [
      device,
      day,
      uptime_ms || 0,
    ]);

  if (event === "MONTHLY_SYNC")
    await dbRun(`INSERT OR REPLACE INTO monthly_uptime VALUES(?,?,?)`, [
      device,
      month,
      uptime_ms || 0,
    ]);

  /* 🔔 LIVE ONLINE / OFFLINE ALERT */
  if (event === "ONLINE" || event === "OFFLINE") {
    for (const bot of BOTS) {
      if (
        devNorm === bot.deviceNorm ||
        devNorm.includes(bot.deviceNorm) ||
        bot.deviceNorm.includes(devNorm)
      ) {
        broadcast(
          bot.token,
          `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n${device}\n🕒 ${
            time || new Date(now).toLocaleString()
          }`
        );
      }
    }
  }

  res.json({ ok: true });
});

/* ---------- TELEGRAM POLLING ---------- */
for (const bot of BOTS) {
  setInterval(async () => {
    const r = await fetch(
      `https://api.telegram.org/bot${bot.token}/getUpdates?offset=${
        bot.lastId + 1
      }`
    )
      .then((x) => x.json())
      .catch(() => null);

    if (!r?.ok) return;

    for (const u of r.result) {
      bot.lastId = u.update_id;
      const chat = u.message?.chat?.id;
      const cmd = u.message?.text;
      if (!chat || !cmd) continue;

      // 🔥 FIX: AUTO-SUBSCRIBE CHAT
      await dbRun(
        `INSERT OR IGNORE INTO chats(chat_id,bot_token) VALUES(?,?)`,
        [chat, bot.token]
      );

      if (cmd === "/start") {
        tg(
          bot.token,
          chat,
          `📡 ${bot.device} uptime monitor active.\nYou will now receive live alerts.`
        );
      }

      if (cmd === "/status") {
        const today = todayEpochSec();
        const yLabel = epochSecToLabel(today - 86400);

        const rows = await dbAll(
          `SELECT day,uptime_ms FROM daily_uptime
           WHERE device=? ORDER BY day DESC LIMIT 7`,
          [bot.device]
        );

        const dev = await dbGet(
          `SELECT last_seen,status FROM devices WHERE device=?`,
          [bot.device]
        );
        const live = computeLiveStatus(dev);

        const match = rows.find(
          (r) => epochSecToLabel(r.day) === yLabel
        );

        if (!match) {
          tg(
            bot.token,
            chat,
            `⚠️ No DAILY_SYNC for yesterday\n📟 ${bot.device}\n📡 Status: ${live}`
          );
          continue;
        }

        const up = match.uptime_ms || 0;
        const p = slaPercent(up);

        tg(
          bot.token,
          chat,
          `📊 Yesterday SLA (24h)\n📟 ${bot.device}\n📡 Status: ${live}\n📅 ${epochSecToLabel(
            match.day
          )}\n\nSLA: ${p.toFixed(2)}%\nUptime: ${(up / 3600000).toFixed(
            2
          )}h\n${bar(p)}`
        );
      }
    }
  }, TG_POLL_MS);
}

/* ---------- START ---------- */
app.listen(PORT, () => console.log("🚀 Server running on", PORT));

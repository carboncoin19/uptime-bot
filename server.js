import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";

const POLL_INTERVAL = 5000;
const DEVICE_TIMEOUT_MS = 2 * 60 * 1000;
const TZ_OFFSET_MS = 3600000;

const ADMIN_CHAT_IDS = [1621660251];
/* ========================================= */

let lastUpdateId = 0;
let lastSummaryDate = null;

/* ---------- APP ---------- */
const app = express();
app.use(express.json());

/* ---------- DATABASE ---------- */
const db = new sqlite3.Database(DB_FILE, () =>
  console.log("✅ SQLite ready:", DB_FILE)
);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT,
      event TEXT,
      time TEXT,
      day_pct REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id INTEGER PRIMARY KEY
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      device TEXT PRIMARY KEY,
      last_seen INTEGER,
      status TEXT
    )`);
});

/* ---------- TELEGRAM ---------- */
async function sendTelegram(chatId, text, menu = false) {
  if (!TG_BOT_TOKEN) return;

  const payload = {
    chat_id: chatId,
    text
  };

  if (menu) {
    payload.reply_markup = {
      keyboard: [
        [{ text: "📊 Status (24h)" }, { text: "📈 Status (7 days)" }],
        [{ text: "📉 Status (30 days)" }],
        [{ text: "♻️ Reset (Admin)" }]
      ],
      resize_keyboard: true
    };
  }

  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

function broadcast(text) {
  db.all(`SELECT chat_id FROM chats`, (_, rows) =>
    rows?.forEach(r => sendTelegram(r.chat_id, text))
  );
}

/* ---------- RESET ---------- */
async function resetUptimeData(chatId) {
  db.run(`DELETE FROM events`);
  await sendTelegram(chatId, "♻️ RESET COMPLETE\nWaiting for device sync…");
}

/* ---------- SUMMARY HELPERS ---------- */
function calculateDowntime(days) {
  return new Promise(resolve => {
    db.all(
      `SELECT event, created_at FROM events
       WHERE created_at >= datetime('now', ?)
       ORDER BY created_at ASC`,
      [`-${days} days`],
      (_, rows) => {
        let downMs = 0, count = 0, lastOffline = null;

        for (const r of rows) {
          const t = new Date(r.created_at).getTime();
          if (r.event === "OFFLINE") {
            count++; lastOffline = t;
          }
          if (r.event === "ONLINE" && lastOffline) {
            downMs += t - lastOffline;
            lastOffline = null;
          }
        }

        resolve({
          offlineCount: count,
          hours: Math.floor(downMs / 3600000),
          minutes: Math.floor((downMs % 3600000) / 60000)
        });
      }
    );
  });
}

function querySummary(days) {
  return new Promise(resolve => {
    db.get(
      `SELECT AVG(day_pct) AS avg_pct FROM events
       WHERE created_at >= datetime('now', ?)`,
      [`-${days} days`],
      (_, row) => resolve(row || {})
    );
  });
}

async function sendStatus(chatId, days, title) {
  const s = await querySummary(days);
  const d = await calculateDowntime(days);

  await sendTelegram(
    chatId,
    `📊 ${title}\n\n` +
    `Avg uptime: ${s.avg_pct?.toFixed(2) || 0}%\n` +
    `Offline count: ${d.offlineCount}\n` +
    `Downtime: ${d.hours}h ${d.minutes}m`
  );
}

/* ---------- TELEGRAM POLLING ---------- */
setInterval(async () => {
  const res = await fetch(
    `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`
  ).then(r => r.json()).catch(() => null);

  if (!res?.ok) return;

  for (const u of res.result) {
    lastUpdateId = u.update_id;
    if (!u.message?.text) continue;

    const chatId = u.message.chat.id;
    const text = u.message.text.toLowerCase();

    db.run(`INSERT OR IGNORE INTO chats VALUES (?)`, [chatId]);

    if (text === "/start" || text === "menu")
      await sendTelegram(chatId, "📡 ESP32 Uptime Monitor", true);
    else if (text.includes("24")) sendStatus(chatId, 1, "24 HOUR STATUS");
    else if (text.includes("7")) sendStatus(chatId, 7, "7 DAY STATUS");
    else if (text.includes("30")) sendStatus(chatId, 30, "30 DAY STATUS");
    else if (text.includes("reset")) {
      if (!ADMIN_CHAT_IDS.includes(chatId))
        sendTelegram(chatId, "⛔ Admin only");
      else resetUptimeData(chatId);
    }
  }
}, POLL_INTERVAL);

/* ---------- AUTO SUMMARY @ 7AM ---------- */
setInterval(() => {
  const now = new Date(Date.now() + TZ_OFFSET_MS);
  const today = now.toISOString().slice(0, 10);

  if (now.getHours() !== 7 || lastSummaryDate === today) return;
  lastSummaryDate = today;

  db.all(`SELECT chat_id FROM chats`, (_, rows) => {
    rows?.forEach(r => {
      sendStatus(r.chat_id, 1, "📊 DAILY SUMMARY");
      sendStatus(r.chat_id, 7, "📈 WEEKLY SUMMARY");
      sendStatus(r.chat_id, 30, "📉 MONTHLY SUMMARY");
    });
  });
}, 60000);

/* ---------- EVENT API ---------- */
app.post("/api/event", (req, res) => {
  const { device, event, time, day_pct, state } = req.body;
  if (!device || !event || !time)
    return res.status(400).json({ error: "Bad payload" });

  const now = Date.now();

  db.run(`
    INSERT INTO devices (device, last_seen, status)
    VALUES (?, ?, ?)
    ON CONFLICT(device)
    DO UPDATE SET last_seen=?, status=?
  `, [device, now, state || event, now, state || event]);

  if (event === "HEARTBEAT") return res.json({ ok: true });

  if (event === "STATE_SYNC") {
    db.run(
      `INSERT INTO events (device, event, time, day_pct)
       VALUES (?, ?, ?, ?)`,
      [device, state, time, day_pct || 0]
    );
    broadcast(`🔄 STATE SYNC\n${device} → ${state}`);
    return res.json({ ok: true });
  }

  db.run(
    `INSERT INTO events (device, event, time, day_pct)
     VALUES (?, ?, ?, ?)`,
    [device, event, time, day_pct]
  );

  broadcast(`${event === "ONLINE" ? "🟢" : "🔴"} ${device} ${event}`);
  res.json({ ok: true });
});

/* ---------- START ---------- */
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on ${PORT}`)
);

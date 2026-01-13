import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";
const POLL_INTERVAL = 5000;
const DEVICE_TIMEOUT_MS = 2 * 60 * 1000;

const ADMIN_CHAT_IDS = [1621660251];
/* ========================================= */

let lastUpdateId = 0;
let currentDeviceStatus = "UNKNOWN";
let offlineSince = null;

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
async function sendTelegram(chatId, text) {
  if (!TG_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
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
  db.run(`DELETE FROM devices`);
  currentDeviceStatus = "UNKNOWN";
  offlineSince = null;
  await sendTelegram(chatId, "♻️ RESET COMPLETE\nWaiting for device sync…");
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
    db.run(`INSERT OR IGNORE INTO chats VALUES (?)`, [chatId]);

    const cmd = u.message.text.replace("/", "").toLowerCase();
    if (cmd === "reset" && ADMIN_CHAT_IDS.includes(chatId)) {
      resetUptimeData(chatId);
    }
  }
}, POLL_INTERVAL);

/* ---------- DEVICE TIMEOUT ---------- */
setInterval(() => {
  const now = Date.now();
  db.all(`SELECT * FROM devices`, (_, rows) => {
    rows?.forEach(d => {
      if (now - d.last_seen > DEVICE_TIMEOUT_MS && d.status !== "OFFLINE") {
        db.run(`UPDATE devices SET status='OFFLINE' WHERE device=?`, [d.device]);
        currentDeviceStatus = "OFFLINE";
        offlineSince = now;
        broadcast(`🚨 ${d.device} unreachable`);
      }
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
    VALUES (?, ?, 'ONLINE')
    ON CONFLICT(device)
    DO UPDATE SET last_seen=?, status='ONLINE'
  `, [device, now, now]);

  if (event === "HEARTBEAT") return res.json({ ok: true });

  if (event === "STATE_SYNC") {
    currentDeviceStatus = state;
    offlineSince = state === "OFFLINE" ? now : null;
    db.run(
      `INSERT INTO events (device, event, time, day_pct)
       VALUES (?, ?, ?, ?)`,
      [device, state, time, day_pct || 0]
    );
    broadcast(`🔄 STATE SYNC\n${device} → ${state}`);
    return res.json({ ok: true });
  }

  if (event === "ONLINE" || event === "OFFLINE") {
    currentDeviceStatus = event;
    offlineSince = event === "OFFLINE" ? now : null;
  }

  db.run(
    `INSERT INTO events (device, event, time, day_pct)
     VALUES (?, ?, ?, ?)`,
    [device, event, time, day_pct]
  );

  broadcast(`${event === "ONLINE" ? "🟢" : "🔴"} ${device} ${event}`);
  res.json({ ok: true });
});

/* ---------- HEALTH ---------- */
app.get("/", (_, res) => res.send("ESP32 uptime server running"));

/* ---------- START ---------- */
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on ${PORT}`)
);

import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";
const POLL_INTERVAL = 5000;
const DEVICE_TIMEOUT_MS = 2 * 60 * 1000;
const TZ_OFFSET_MS = 3600000; // WAT
const ADMIN_CHAT_IDS = [1621660251];
/* ========================================= */

let lastUpdateId = 0;
let currentDeviceStatus = "UNKNOWN";

/* ---------- APP ---------- */
const app = express();
app.use(express.json());

/* ---------- DATABASE ---------- */
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device TEXT, event TEXT, time TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    device TEXT PRIMARY KEY, last_seen INTEGER, status TEXT
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

/* ---------- STATUS ---------- */
async function sendStatus(chatId) {
  sendTelegram(chatId, `📊 STATUS\nDevice is: ${currentDeviceStatus}`);
}

/* ---------- TELEGRAM POLLING ---------- */
setInterval(async () => {
  const r = await fetch(
    `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`
  ).then(r => r.json()).catch(() => null);

  if (!r?.ok) return;

  for (const u of r.result) {
    lastUpdateId = u.update_id;
    if (!u.message?.text) continue;

    const chatId = u.message.chat.id;
    const txt = u.message.text.toLowerCase();

    db.run(`INSERT OR IGNORE INTO chats VALUES (?)`, [chatId]);

    if (txt === "/status") sendStatus(chatId);
    if (txt === "/reset" && ADMIN_CHAT_IDS.includes(chatId)) {
      db.run(`DELETE FROM events`);
      db.run(`DELETE FROM devices`);
      currentDeviceStatus = "UNKNOWN";
      sendTelegram(chatId, "♻️ RESET DONE\nWaiting for device sync…");
    }
  }
}, POLL_INTERVAL);

/* ---------- EVENT API ---------- */
app.post("/api/event", (req, res) => {
  const { device, event, time, state } = req.body;
  if (!device || !event || !time) return res.status(400).end();

  const now = Date.now();

  if (event === "STATE_SYNC") {
    currentDeviceStatus = state;
    db.run(`INSERT OR REPLACE INTO devices VALUES (?,?,?)`,
      [device, now, state]);
    return res.json({ ok: true });
  }

  if (event === "ONLINE" || event === "OFFLINE") {
    currentDeviceStatus = event;
    broadcast(`${event === "ONLINE" ? "🟢" : "🔴"} ${device} ${event}`);
  }

  db.run(`INSERT INTO events (device,event,time) VALUES (?,?,?)`,
    [device, event, time]);

  res.json({ ok: true });
});

/* ---------- START ---------- */
app.listen(PORT, () =>
  console.log("🚀 Server running on", PORT)
);

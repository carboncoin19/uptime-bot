import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";
const POLL_INTERVAL = 5000;
const TZ_OFFSET_MS = 3600000;
const ADMIN_CHAT_IDS = [1621660251];
/* ========================================= */

let lastUpdateId = 0;
let lastSummaryDate = null;

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device TEXT, event TEXT, time TEXT, day_pct REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    device TEXT PRIMARY KEY, last_seen INTEGER, status TEXT
  )`);
});

/* ---------- TELEGRAM ---------- */
async function sendTelegram(chatId, text, menu=false) {
  const payload = { chat_id: chatId, text };
  if (menu) {
    payload.reply_markup = {
      keyboard: [
        ["📊 Status (24h)", "📈 Status (7 days)"],
        ["📉 Status (30 days)"],
        ["♻️ Reset (Admin)"]
      ],
      resize_keyboard: true
    };
  }

  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(()=>{});
}

function broadcast(text) {
  db.all(`SELECT chat_id FROM chats`, (_, rows) =>
    rows?.forEach(r => sendTelegram(r.chat_id, text))
  );
}

/* ---------- STATUS ---------- */
function getCurrentStatus(cb) {
  db.get(
    `SELECT status FROM devices ORDER BY last_seen DESC LIMIT 1`,
    (_, row) => cb(row?.status || "UNKNOWN")
  );
}

/* ---------- TELEGRAM POLLING ---------- */
setInterval(async () => {
  const r = await fetch(
    `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}`
  ).then(r=>r.json()).catch(()=>null);

  if (!r?.ok) return;

  for (const u of r.result) {
    lastUpdateId = u.update_id;
    if (!u.message?.text) continue;

    const chatId = u.message.chat.id;
    const txt = u.message.text.toLowerCase().replace("/", "");

    db.run(`INSERT OR IGNORE INTO chats VALUES (?)`, [chatId]);

    if (txt === "start" || txt === "menu") {
      sendTelegram(chatId, "📡 ESP32 Uptime Monitor", true);
    }
    else if (txt.includes("reset")) {
      if (!ADMIN_CHAT_IDS.includes(chatId))
        sendTelegram(chatId,"⛔ Admin only");
      else {
        db.run(`DELETE FROM events`);
        db.run(`DELETE FROM devices`);
        sendTelegram(chatId,"♻️ RESET DONE\nWaiting for device sync…");
      }
    }
    else {
      getCurrentStatus(status => {
        sendTelegram(chatId, `📊 STATUS\n\nDevice: ${status}`);
      });
    }
  }
}, POLL_INTERVAL);

/* ---------- EVENT API ---------- */
app.post("/api/event",(req,res)=>{
  const { device, event, time, state } = req.body;
  if(!device||!event||!time) return res.status(400).end();

  const now = Date.now();

  db.run(
    `INSERT INTO devices VALUES (?,?,?)
     ON CONFLICT(device) DO UPDATE SET last_seen=?,status=?`,
    [device, now, state || "ONLINE", now, state || "ONLINE"]
  );

  if (event === "STATE_SYNC") return res.json({ok:true});
  if (event === "HEARTBEAT") return res.json({ok:true});

  db.run(
    `INSERT INTO events (device,event,time,day_pct)
     VALUES (?,?,?,0)`,
    [device,event,time]
  );

  broadcast(`${event==="ONLINE"?"🟢":"🔴"} ${device} ${event}`);
  res.json({ok:true});
});

/* ---------- AUTO SUMMARY 7AM ---------- */
setInterval(() => {
  const t = new Date(Date.now() + TZ_OFFSET_MS);
  const today = t.toDateString();
  if (t.getHours() !== 7 || lastSummaryDate === today) return;
  lastSummaryDate = today;

  broadcast("📊 DAILY UPTIME SUMMARY READY");
}, 60000);

app.listen(PORT,()=>console.log("🚀 Server running",PORT));

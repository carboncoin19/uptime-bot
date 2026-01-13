import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";
const POLL_INTERVAL = 5000;
const TZ_OFFSET_MS = 3600000;
const ADMIN_CHAT_IDS = [1621660251];

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
    device TEXT PRIMARY KEY,
    last_seen INTEGER,
    status TEXT
  )`);
});

/* ---------- TELEGRAM ---------- */
async function sendTelegram(chatId, text, menu=false) {
  if (!TG_BOT_TOKEN) return;
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
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  }).catch(()=>{});
}

/* ---------- STATUS ---------- */
function getStatus() {
  return new Promise(res=>{
    db.get(`SELECT status FROM devices LIMIT 1`,(_,r)=>{
      res(r?.status || "UNKNOWN");
    });
  });
}

async function sendStatus(chatId, days, title) {
  const status = await getStatus();
  await sendTelegram(chatId,
    `📊 ${title}\n\nStatus: ${status}`
  );
}

/* ---------- TELEGRAM POLLING ---------- */
let lastUpdateId = 0;
setInterval(async ()=>{
  const r = await fetch(
    `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}`
  ).then(r=>r.json()).catch(()=>null);
  if (!r?.ok) return;

  for (const u of r.result) {
    lastUpdateId = u.update_id;
    const chatId = u.message?.chat.id;
    const txt = u.message?.text?.toLowerCase() || "";
    if (!chatId) continue;

    db.run(`INSERT OR IGNORE INTO chats VALUES (?)`,[chatId]);

    if (txt==="/start"||txt==="menu")
      sendTelegram(chatId,"📡 ESP32 Uptime Monitor",true);
    else if (txt.includes("24"))
      sendStatus(chatId,1,"24 HOUR STATUS");
    else if (txt.includes("7"))
      sendStatus(chatId,7,"7 DAY STATUS");
    else if (txt.includes("30"))
      sendStatus(chatId,30,"30 DAY STATUS");
    else if (txt.includes("reset") && ADMIN_CHAT_IDS.includes(chatId)){
      db.run(`DELETE FROM events`);
      db.run(`DELETE FROM devices`);
      sendTelegram(chatId,"♻️ RESET DONE\nWaiting for device sync…");
    }
  }
}, POLL_INTERVAL);

/* ---------- EVENT API ---------- */
app.post("/api/event",(req,res)=>{
  const {device,event,time,state} = req.body;
  if (!device||!event||!time) return res.status(400).end();

  const now = Date.now();

  db.run(
    `INSERT INTO devices (device,last_seen,status)
     VALUES (?,?,?)
     ON CONFLICT(device)
     DO UPDATE SET last_seen=?`,
    [device,now,"UNKNOWN",now]
  );

  if (event==="STATE_SYNC") {
    db.run(
      `UPDATE devices SET status=?, last_seen=? WHERE device=?`,
      [state,now,device]
    );
  }

  if (event!=="HEARTBEAT") {
    db.run(
      `INSERT INTO events (device,event,time,day_pct)
       VALUES (?,?,?,0)`,
      [device,event,time]
    );
  }

  res.json({ok:true});
});

app.listen(PORT,()=>console.log("🚀 Server running on",PORT));

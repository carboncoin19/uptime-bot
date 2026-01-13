import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";

const POLL_INTERVAL = 5000;
const DEVICE_TIMEOUT_MS = 2 * 60 * 1000;
const TZ_OFFSET_MS = 3600000; // WAT UTC+1

const ADMIN_CHAT_IDS = [1621660251];
/* ========================================= */

let lastUpdateId = 0;
let currentDeviceStatus = "UNKNOWN";
let offlineSince = null;

/* ---------- APP ---------- */
const app = express();
app.use(express.json());

/* ---------- DATABASE ---------- */
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device TEXT,
    event TEXT,
    time TEXT,
    day_pct REAL,
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
async function sendTelegram(chatId, text, menu = false) {
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
  }).catch(() => {});
}

function broadcast(text) {
  db.all(`SELECT chat_id FROM chats`, (_, rows) =>
    rows?.forEach(r => sendTelegram(r.chat_id, text))
  );
}

/* ---------- STATUS HELPERS ---------- */
function calcDowntime(days) {
  return new Promise(res => {
    db.all(
      `SELECT event, created_at FROM events
       WHERE created_at >= datetime('now', ?)
       ORDER BY created_at`,
      [`-${days} days`],
      (_, rows) => {
        let down = 0, cnt = 0, last = null;

        rows.forEach(r => {
          const t = new Date(r.created_at).getTime();
          if (r.event === "OFFLINE") { cnt++; last = t; }
          if (r.event === "ONLINE" && last) {
            down += t - last;
            last = null;
          }
        });

        if (last && currentDeviceStatus === "OFFLINE") {
          down += Date.now() - last;
        }

        res({
          cnt,
          h: Math.floor(down / 3600000),
          m: Math.floor((down % 3600000) / 60000)
        });
      }
    );
  });
}

function avgUptime(days) {
  return new Promise(res => {
    db.get(
      `SELECT AVG(day_pct) AS p FROM events
       WHERE created_at >= datetime('now', ?)`,
      [`-${days} days`],
      (_, r) => res(r?.p || 0)
    );
  });
}

async function sendStatus(chatId, days, title) {
  const d = await calcDowntime(days);
  const p = await avgUptime(days);

  await sendTelegram(
    chatId,
    `📊 ${title}\n\n` +
    `Status: ${currentDeviceStatus}\n` +
    `Avg uptime: ${p.toFixed(2)}%\n` +
    `Offline count: ${d.cnt}\n` +
    `Downtime: ${d.h}h ${d.m}m`
  );
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
    const txt = u.message.text.toLowerCase().replace("/", "");

    db.run(`INSERT OR IGNORE INTO chats VALUES (?)`, [chatId]);

    if (txt === "start" || txt === "menu") {
      sendTelegram(chatId, "📡 ESP32 Uptime Monitor", true);
    }
    else if (txt === "status" || txt.includes("24"))
      sendStatus(chatId, 1, "24 HOUR STATUS");
    else if (txt === "statusweek" || txt.includes("7"))
      sendStatus(chatId, 7, "7 DAY STATUS");
    else if (txt === "statusmonth" || txt.includes("30"))
      sendStatus(chatId, 30, "30 DAY STATUS");
    else if (txt.includes("reset")) {
      if (!ADMIN_CHAT_IDS.includes(chatId)) {
        sendTelegram(chatId, "⛔ Admin only");
      } else {
        db.run(`DELETE FROM events`);
        db.run(`DELETE FROM devices`);
        currentDeviceStatus = "UNKNOWN";
        offlineSince = null;
        sendTelegram(chatId, "♻️ RESET DONE\nWaiting for device sync…");
      }
    }
  }
}, POLL_INTERVAL);

/* ---------- EVENT API ---------- */
app.post("/api/event", (req, res) => {
  const { device, event, time, day_pct, uptime_ms, state } = req.body;
  if (!device || !event || !time) return res.status(400).end();

  const now = Date.now();

  // default keep-alive
  db.run(
    `INSERT INTO devices (device,last_seen,status)
     VALUES (?,?,?)
     ON CONFLICT(device) DO UPDATE SET last_seen=?,status='ONLINE'`,
    [device, now, "ONLINE", now]
  );

  if (event === "HEARTBEAT") return res.json({ ok: true });

  if (event === "SYNC" && uptime_ms) {
    db.run(
      `INSERT INTO events (device,event,time,day_pct)
       VALUES (?, 'ONLINE', ?, ?)`,
      [device, new Date().toISOString(), 100]
    );
    return res.json({ ok: true });
  }

  /* ✅ FIXED STATE_SYNC */
  if (event === "STATE_SYNC") {
    currentDeviceStatus = state;
    offlineSince = state === "OFFLINE" ? now : null;

    db.run(
      `
      INSERT INTO devices (device, last_seen, status)
      VALUES (?, ?, ?)
      ON CONFLICT(device)
      DO UPDATE SET last_seen=?, status=?
      `,
      [device, now, state, now, state]
    );

    db.run(
      `INSERT INTO events (device,event,time,day_pct)
       VALUES (?,?,?,?)`,
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
    `INSERT INTO events (device,event,time,day_pct)
     VALUES (?,?,?,?)`,
    [device, event, time, day_pct]
  );

  broadcast(`${event === "ONLINE" ? "🟢" : "🔴"} ${device} ${event}`);
  res.json({ ok: true });
});

/* ---------- AUTO SUMMARY 7AM ---------- */
setInterval(() => {
  const t = new Date(Date.now() + TZ_OFFSET_MS);
  if (t.getHours() !== 7 || t.getMinutes() !== 0) return;

  db.all(`SELECT chat_id FROM chats`, (_, rows) => {
    rows?.forEach(r => {
      sendStatus(r.chat_id, 1, "DAILY SUMMARY");
      sendStatus(r.chat_id, 7, "WEEKLY SUMMARY");
      sendStatus(r.chat_id, 30, "MONTHLY SUMMARY");
    });
  });
}, 60000);

app.listen(PORT, () =>
  console.log("🚀 Server running on", PORT)
);

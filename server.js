import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";
import fs from "fs";
import FormData from "form-data";

// ================= CONFIG =================
const PORT = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";
const POLL_INTERVAL = 5000;

// ---- ADMIN ACCESS ----
const ADMIN_CHAT_IDS = [1621660251];

// ---- OFFLINE ESCALATION (REAL OFFLINE ONLY) ----
const OFFLINE_ALERT_MIN_1 = 1;
const OFFLINE_ALERT_MIN_2 = 2;

let lastUpdateId = 0;
// =========================================


// ---------- DEVICE STATE ----------
let currentDeviceStatus = "UNKNOWN"; // ONLINE | OFFLINE | UNKNOWN
let offlineSince = null;
let textAlertSent = false;
let voiceAlertSent = false;


// ---------- AUTO SUMMARY STATE ----------
let lastDailySent = null;
let lastWeeklySent = null;
let lastMonthlySent = null;


// ---------- APP ----------
const app = express();
app.use(express.json());


// ---------- DATABASE ----------
const db = new sqlite3.Database(DB_FILE, () => {
  console.log("✅ SQLite database ready at", DB_FILE);
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT,
      event TEXT,
      time TEXT,
      day_pct REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id INTEGER PRIMARY KEY
    )
  `);
});


// ---------- TELEGRAM ----------
async function sendTelegram(chatId, text) {
  if (!TG_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  }).catch(() => {});
}

async function sendVoice(chatId) {
  if (!fs.existsSync("./offline_warning.ogg")) return;

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("voice", fs.createReadStream("./offline_warning.ogg"));

  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendVoice`, {
    method: "POST",
    body: form
  }).catch(() => {});
}


// ---------- BROADCAST ----------
function broadcastText(text) {
  db.all(`SELECT chat_id FROM chats`, (_, rows) => {
    rows?.forEach(r => sendTelegram(r.chat_id, text));
  });
}

function broadcastVoice() {
  db.all(`SELECT chat_id FROM chats`, (_, rows) => {
    rows?.forEach(r => sendVoice(r.chat_id));
  });
}


// ---------- COMMAND NORMALIZER ----------
const normalizeCommand = t => t.trim().toLowerCase().replace(/^\/+/, "");


// ---------- RESET ----------
async function resetUptimeData(chatId) {
  db.run(`DELETE FROM events`);
  currentDeviceStatus = "UNKNOWN";
  offlineSince = null;
  textAlertSent = false;
  voiceAlertSent = false;

  await sendTelegram(chatId, "♻️ ADMIN RESET\nAll uptime data erased.");
}


// ---------- DOWNTIME (CORRECT) ----------
function calculateDowntime(days) {
  return new Promise(resolve => {
    db.all(
      `
      SELECT event, created_at
      FROM events
      WHERE created_at >= datetime('now', ?)
      ORDER BY created_at ASC
      `,
      [`-${days} days`],
      (_, rows) => {
        let downMs = 0;
        let count = 0;
        let lastOffline = null;

        for (const r of rows) {
          const t = new Date(r.created_at).getTime();
          if (r.event === "OFFLINE") {
            count++;
            lastOffline = t;
          }
          if (r.event === "ONLINE" && lastOffline) {
            downMs += t - lastOffline;
            lastOffline = null;
          }
        }

        // include ongoing offline
        if (lastOffline && currentDeviceStatus === "OFFLINE") {
          downMs += Date.now() - lastOffline;
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


// ---------- SUMMARY ----------
function querySummary(days) {
  return new Promise(resolve => {
    db.get(
      `
      SELECT AVG(day_pct) AS avg_pct
      FROM events
      WHERE created_at >= datetime('now', ?)
      `,
      [`-${days} days`],
      (_, row) => resolve(row || {})
    );
  });
}

async function sendStatus(chatId, days, title) {
  const s = await querySummary(days);
  const d = await calculateDowntime(days);

  const statusEmoji =
    currentDeviceStatus === "ONLINE" ? "🟢 ONLINE" :
    currentDeviceStatus === "OFFLINE" ? "🔴 OFFLINE" :
    "⚪ UNKNOWN";

  await sendTelegram(
    chatId,
    `📊 ${title}\n\n` +
    `Status: ${statusEmoji}\n` +
    `Avg uptime: ${s.avg_pct?.toFixed(2) || 0}%\n` +
    `Offline count: ${d.offlineCount}\n` +
    `Downtime: ${d.hours}h ${d.minutes}m`
  );
}


// ---------- TELEGRAM POLLING ----------
async function pollTelegram() {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`;
  const res = await fetch(url).then(r => r.json()).catch(() => null);
  if (!res?.ok) return;

  for (const u of res.result) {
    lastUpdateId = u.update_id;
    const msg = u.message;
    if (!msg?.text) continue;

    const chatId = msg.chat.id;
    db.run(`INSERT OR IGNORE INTO chats VALUES (?)`, [chatId]);

    const cmd = normalizeCommand(msg.text);

    if (cmd === "status") await sendStatus(chatId, 1, "24 HOUR STATUS");
    else if (cmd === "statusweek") await sendStatus(chatId, 7, "7 DAY STATUS");
    else if (cmd === "statusmonth") await sendStatus(chatId, 30, "30 DAY STATUS");
    else if (cmd === "reset" && ADMIN_CHAT_IDS.includes(chatId))
      await resetUptimeData(chatId);
  }
}
setInterval(pollTelegram, POLL_INTERVAL);


// ---------- OFFLINE ESCALATION ----------
setInterval(() => {
  if (currentDeviceStatus !== "OFFLINE" || !offlineSince) return;

  const mins = (Date.now() - offlineSince) / 60000;

  if (mins >= OFFLINE_ALERT_MIN_1 && !textAlertSent) {
    broadcastText(`🚨 CRITICAL\n🔴 Device OFFLINE ${Math.floor(mins)} min`);
    textAlertSent = true;
  }

  if (mins >= OFFLINE_ALERT_MIN_2 && !voiceAlertSent) {
    broadcastVoice();
    voiceAlertSent = true;
  }
}, 30000);


// ---------- ESP32 EVENT API ----------
app.post("/api/event", (req, res) => {
  const { device, event, time, day_pct, uptime_ms } = req.body;
  if (!device || !event || !time) return res.status(400).json({ error: "Invalid payload" });

  // HEARTBEAT: acknowledge only
  if (event === "HEARTBEAT") return res.json({ ok: true });

  // SYNC: store delayed uptime
  if (event === "SYNC") {
    db.run(
      `INSERT INTO events (device, event, time, day_pct)
       VALUES (?, 'ONLINE', ?, ?)`,
      [device, time, day_pct]
    );
    return res.json({ ok: true });
  }

  // ONLINE / OFFLINE
  db.run(
    `INSERT INTO events (device, event, time, day_pct)
     VALUES (?, ?, ?, ?)`,
    [device, event, time, day_pct]
  );

  if (event === "OFFLINE") {
    currentDeviceStatus = "OFFLINE";
    offlineSince = Date.now();
    textAlertSent = false;
    voiceAlertSent = false;
  }

  if (event === "ONLINE") {
    currentDeviceStatus = "ONLINE";
    offlineSince = null;
  }

  broadcastText(
    `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\nDevice: ${device}\nTime: ${time}`
  );

  res.json({ ok: true });
});


// ---------- HEALTH ----------
app.get("/", (_, res) => res.send("ESP32 uptime server running"));


// ---------- START ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";
import fs from "fs";
import FormData from "form-data";

// ================= CONFIG =================
const PORT = process.env.PORT || 3000;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN; // SET IN RAILWAY
const DB_FILE = "/data/uptime.db";
const POLL_INTERVAL = 5000;

// ---- ADMIN ACCESS ----
const ADMIN_CHAT_IDS = [
  1621660251 // 👈 YOUR TELEGRAM CHAT ID
];

// ---- OFFLINE ESCALATION ----
const OFFLINE_ALERT_MIN_1 = 1; // text alert
const OFFLINE_ALERT_MIN_2 = 2; // voice alert

let lastUpdateId = 0;
// =========================================


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


// ---------- TELEGRAM SEND ----------
async function sendTelegram(chatId, text) {
  if (!TG_BOT_TOKEN) return;
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (err) {
    console.error("Telegram send error:", err.message);
  }
}


// ---------- TELEGRAM VOICE ----------
async function sendVoice(chatId) {
  if (!fs.existsSync("./offline_warning.ogg")) {
    console.warn("⚠️ offline_warning.ogg not found");
    return;
  }

  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendVoice`;
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("voice", fs.createReadStream("./offline_warning.ogg"));

  try {
    await fetch(url, { method: "POST", body: form });
  } catch (err) {
    console.error("Telegram voice error:", err.message);
  }
}


// ---------- BROADCAST ----------
function broadcastText(text) {
  db.all(`SELECT chat_id FROM chats`, async (_, rows) => {
    for (const r of rows) {
      await sendTelegram(r.chat_id, text);
    }
  });
}

function broadcastVoice() {
  db.all(`SELECT chat_id FROM chats`, async (_, rows) => {
    for (const r of rows) {
      await sendVoice(r.chat_id);
    }
  });
}


// ---------- COMMAND NORMALIZER ----------
function normalizeCommand(text) {
  return text.trim().toLowerCase().replace(/^\/+/, "");
}


// ---------- RESET (ADMIN ONLY) ----------
async function resetUptimeData(chatId) {
  db.run(`DELETE FROM events`);

  offlineSince = null;
  textAlertSent = false;
  voiceAlertSent = false;

  await sendTelegram(
    chatId,
    "♻️ ADMIN RESET SUCCESSFUL\n\nAll uptime and event data has been erased."
  );
}


// ---------- DOWNTIME CALC ----------
function calculateDowntime(days) {
  return new Promise((resolve) => {
    db.all(
      `
      SELECT event, created_at
      FROM events
      WHERE created_at >= datetime('now', ?)
      ORDER BY created_at ASC
      `,
      [`-${days} days`],
      (_, rows) => {
        let offlineCount = 0;
        let totalDownMs = 0;
        let lastOffline = null;

        for (const r of rows) {
          const t = new Date(r.created_at).getTime();
          if (r.event === "OFFLINE") {
            offlineCount++;
            lastOffline = t;
          }
          if (r.event === "ONLINE" && lastOffline) {
            totalDownMs += t - lastOffline;
            lastOffline = null;
          }
        }

        resolve({
          offlineCount,
          hours: Math.floor(totalDownMs / 3600000),
          minutes: Math.floor((totalDownMs % 3600000) / 60000)
        });
      }
    );
  });
}


// ---------- STATUS ----------
function querySummary(days) {
  return new Promise((resolve) => {
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

  await sendTelegram(
    chatId,
    `📊 ${title}\n\n` +
    `Avg uptime: ${s.avg_pct?.toFixed(2) || 0}%\n` +
    `Offline count: ${d.offlineCount}\n` +
    `Total downtime: ${d.hours}h ${d.minutes}m`
  );
}


// ---------- TELEGRAM POLLING ----------
async function pollTelegram() {
  const url =
    `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`;

  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) return;

    for (const u of data.result) {
      lastUpdateId = u.update_id;
      const msg = u.message;
      if (!msg?.text) continue;

      const chatId = msg.chat.id;
      db.run(`INSERT OR IGNORE INTO chats (chat_id) VALUES (?)`, [chatId]);

      const cmd = normalizeCommand(msg.text);

      if (cmd === "status") await sendStatus(chatId, 1, "24 HOUR STATUS");
      else if (cmd === "statusweek") await sendStatus(chatId, 7, "7 DAY STATUS");
      else if (cmd === "statusmonth") await sendStatus(chatId, 30, "30 DAY STATUS");
      else if (cmd === "reset") {
        if (!ADMIN_CHAT_IDS.includes(chatId)) {
          await sendTelegram(chatId, "⛔ Unauthorized");
          return;
        }
        await resetUptimeData(chatId);
      }
    }
  } catch (e) {
    console.error("Telegram poll error:", e.message);
  }
}

setInterval(pollTelegram, POLL_INTERVAL);


// ---------- OFFLINE ESCALATION ----------
let offlineSince = null;
let textAlertSent = false;
let voiceAlertSent = false;

setInterval(() => {
  if (!offlineSince) return;

  const mins = (Date.now() - offlineSince) / 60000;

  if (mins >= OFFLINE_ALERT_MIN_1 && !textAlertSent) {
    broadcastText(`🚨 CRITICAL ALERT\n🔴 Device OFFLINE for ${Math.floor(mins)} min`);
    textAlertSent = true;
  }

  if (mins >= OFFLINE_ALERT_MIN_2 && !voiceAlertSent) {
    broadcastVoice();
    voiceAlertSent = true;
  }
}, 30000);


// ---------- AUTO SUMMARY (7AM WAT) ----------
async function autoSummaries() {
  const now = new Date(Date.now() + 3600000); // UTC+1
  const h = now.getHours();
  const m = now.getMinutes();
  const day = now.getDay();
  const date = now.getDate();
  const today = now.toISOString().split("T")[0];

  if (h !== 7 || m > 1) return;

  if (lastDailySent !== today) {
    const s = await querySummary(1);
    broadcastText(`📊 DAILY SUMMARY\nAvg uptime: ${s.avg_pct?.toFixed(2) || 0}%`);
    lastDailySent = today;
  }

  if (day === 1 && lastWeeklySent !== today) {
    const s = await querySummary(7);
    broadcastText(`📊 WEEKLY SUMMARY\nAvg uptime: ${s.avg_pct?.toFixed(2) || 0}%`);
    lastWeeklySent = today;
  }

  if (date === 1 && lastMonthlySent !== today) {
    const s = await querySummary(30);
    broadcastText(`📊 MONTHLY SUMMARY\nAvg uptime: ${s.avg_pct?.toFixed(2) || 0}%`);
    lastMonthlySent = today;
  }
}

setInterval(autoSummaries, 60000);


// ---------- ESP32 EVENT API ----------
app.post("/api/event", (req, res) => {
  const { device, event, time, day_pct } = req.body;
  if (!device || !event || !time)
    return res.status(400).json({ error: "Invalid payload" });

  db.run(
    `INSERT INTO events (device, event, time, day_pct) VALUES (?, ?, ?, ?)`,
    [device, event, time, day_pct]
  );

  if (event === "OFFLINE") {
    offlineSince = Date.now();
    textAlertSent = false;
    voiceAlertSent = false;
  } else {
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

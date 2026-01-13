import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";

const POLL_INTERVAL = 5000;
const DEVICE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const TZ_OFFSET_MS = 3600000; // Nigeria WAT UTC+1

const ADMIN_CHAT_IDS = [1621660251];
/* ========================================= */

let lastUpdateId = 0;

/* ---------- APP ---------- */
const app = express();
app.use(express.json());

/* ---------- DATABASE ---------- */
const db = new sqlite3.Database(DB_FILE);
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
    CREATE TABLE IF NOT EXISTS devices (
      device TEXT PRIMARY KEY,
      last_seen INTEGER,
      status TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      chat_id INTEGER PRIMARY KEY
    )
  `);
});

/* ---------- TIME FORMAT (12H AM/PM) ---------- */
function formatTimeWAT(ms) {
  return new Date(ms + TZ_OFFSET_MS).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  });
}

/* ---------- TELEGRAM ---------- */
async function sendTelegram(chatId, text, menu = false) {
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

function broadcast(text) {
  db.all(`SELECT chat_id FROM chats`, (_, rows) => {
    rows?.forEach(r => sendTelegram(r.chat_id, text));
  });
}

/* ---------- STATUS HELPERS ---------- */
function calcDowntime(days) {
  return new Promise(resolve => {
    db.all(
      `
      SELECT event, created_at
      FROM events
      WHERE created_at >= datetime('now', ?)
      ORDER BY created_at
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

        if (lastOffline) {
          downMs += Date.now() - lastOffline;
        }

        resolve({
          count,
          h: Math.floor(downMs / 3600000),
          m: Math.floor((downMs % 3600000) / 60000)
        });
      }
    );
  });
}

function avgUptime(days) {
  return new Promise(resolve => {
    db.get(
      `
      SELECT AVG(day_pct) AS pct
      FROM events
      WHERE created_at >= datetime('now', ?)
      `,
      [`-${days} days`],
      (_, row) => resolve(row?.pct || 0)
    );
  });
}

async function sendStatus(chatId, days, title) {
  const d = await calcDowntime(days);
  const p = await avgUptime(days);

  db.get(
    `SELECT status FROM devices ORDER BY last_seen DESC LIMIT 1`,
    (_, row) => {
      const status = row?.status || "UNKNOWN";

      sendTelegram(
        chatId,
        `📊 ${title}\n\n` +
        `Status: ${status}\n` +
        `Avg uptime: ${p.toFixed(2)}%\n` +
        `Offline count: ${d.count}\n` +
        `Downtime: ${d.h}h ${d.m}m`
      );
    }
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
    const txt = u.message.text.toLowerCase();

    db.run(`INSERT OR IGNORE INTO chats VALUES (?)`, [chatId]);

    if (txt === "/start" || txt === "menu") {
      sendTelegram(chatId, "📡 ESP32 Uptime Monitor", true);
    }
    else if (txt.includes("24")) sendStatus(chatId, 1, "24 HOUR STATUS");
    else if (txt.includes("7")) sendStatus(chatId, 7, "7 DAY STATUS");
    else if (txt.includes("30")) sendStatus(chatId, 30, "30 DAY STATUS");
    else if (txt.includes("reset")) {
      if (!ADMIN_CHAT_IDS.includes(chatId)) {
        sendTelegram(chatId, "⛔ Admin only");
      } else {
        db.run(`DELETE FROM events`);
        db.run(`DELETE FROM devices`);
        sendTelegram(chatId, "♻️ RESET DONE\nWaiting for device sync…");
      }
    }
  }
}, POLL_INTERVAL);

/* ---------- DEVICE TIMEOUT ---------- */
setInterval(() => {
  const now = Date.now();

  db.all(`SELECT * FROM devices`, (_, rows) => {
    rows?.forEach(d => {
      if (now - d.last_seen > DEVICE_TIMEOUT_MS && d.status !== "OFFLINE") {
        db.run(
          `UPDATE devices SET status='OFFLINE' WHERE device=?`,
          [d.device]
        );

        broadcast(
          `🔴 ${d.device} OFFLINE\n🕒 ${formatTimeWAT(now)}`
        );
      }
    });
  });
}, 60000);

/* ---------- AUTO SUMMARY @ 7:00 AM ---------- */
let lastSummaryDay = null;

setInterval(() => {
  const now = Date.now();
  const t = new Date(now + TZ_OFFSET_MS);

  if (t.getHours() !== 7) return;

  const today = t.toDateString();
  if (today === lastSummaryDay) return;

  lastSummaryDay = today;

  db.all(`SELECT chat_id FROM chats`, (_, rows) => {
    rows?.forEach(r => {
      sendStatus(r.chat_id, 1, "DAILY SUMMARY");
      sendStatus(r.chat_id, 7, "WEEKLY SUMMARY");
      sendStatus(r.chat_id, 30, "MONTHLY SUMMARY");
    });
  });
}, 60000);

/* ---------- EVENT API ---------- */
app.post("/api/event", (req, res) => {
  const { device, event, time, day_pct, state } = req.body;
  if (!device || !event || !time) return res.status(400).end();

  const now = Date.now();

  db.run(
    `
    INSERT INTO devices (device,last_seen,status)
    VALUES (?,?,?)
    ON CONFLICT(device)
    DO UPDATE SET last_seen=?, status=status
    `,
    [device, now, "ONLINE", now]
  );

  if (event === "HEARTBEAT" || event === "SYNC") {
    return res.json({ ok: true });
  }

  if (event === "STATE_SYNC") {
    db.run(
      `
      INSERT INTO devices (device,last_seen,status)
      VALUES (?,?,?)
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

    return res.json({ ok: true });
  }

  if (event === "ONLINE" || event === "OFFLINE") {
    db.run(
      `UPDATE devices SET status=?, last_seen=? WHERE device=?`,
      [event, now, device]
    );

    broadcast(
      `${event === "ONLINE" ? "🟢" : "🔴"} ${device} ${event}\n🕒 ${formatTimeWAT(now)}`
    );
  }

  db.run(
    `INSERT INTO events (device,event,time,day_pct)
     VALUES (?,?,?,?)`,
    [device, event, time, day_pct]
  );

  res.json({ ok: true });
});

/* ---------- START ---------- */
app.listen(PORT, () =>
  console.log("🚀 Server running on", PORT)
);

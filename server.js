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

  db.run(`
    CREATE TABLE IF NOT EXISTS outages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT,
      start_time INTEGER,
      end_time INTEGER,
      duration_ms INTEGER
    )
  `);
});

/* ---------- TIME (12H AM/PM) ---------- */
function formatTime(ms) {
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

/* ---------- OUTAGE HELPERS ---------- */
function openOutage(device, now) {
  db.get(
    `SELECT id FROM outages WHERE device=? AND end_time IS NULL`,
    [device],
    (_, row) => {
      if (!row) {
        db.run(
          `INSERT INTO outages (device,start_time) VALUES (?,?)`,
          [device, now]
        );
      }
    }
  );
}

function closeOutage(device, now) {
  db.get(
    `
    SELECT id,start_time FROM outages
    WHERE device=? AND end_time IS NULL
    ORDER BY start_time DESC LIMIT 1
    `,
    [device],
    (_, o) => {
      if (o) {
        const duration = now - o.start_time;
        db.run(
          `UPDATE outages SET end_time=?, duration_ms=? WHERE id=?`,
          [now, duration, o.id]
        );
      }
    }
  );
}

/* ---------- UPTIME CALCULATION ---------- */
function getDowntime(days) {
  return new Promise(resolve => {
    db.get(
      `
      SELECT COUNT(*) AS count,
             SUM(duration_ms) AS total
      FROM outages
      WHERE start_time >= ?
      `,
      [Date.now() - days * 86400000],
      (_, row) => {
        const ms = row?.total || 0;
        resolve({
          count: row?.count || 0,
          h: Math.floor(ms / 3600000),
          m: Math.floor((ms % 3600000) / 60000),
          ms
        });
      }
    );
  });
}

async function getUptimePct(days) {
  const periodMs = days * 86400000;
  const d = await getDowntime(days);
  return Math.max(0, ((periodMs - d.ms) / periodMs) * 100);
}

/* ---------- STATUS SUMMARY ---------- */
async function sendStatus(chatId, days, title) {
  const d = await getDowntime(days);
  const uptime = await getUptimePct(days);

  db.get(
    `SELECT status FROM devices ORDER BY last_seen DESC LIMIT 1`,
    (_, row) => {
      const status = row?.status || "UNKNOWN";

      sendTelegram(
        chatId,
        `📊 ${title}\n\n` +
        `Status: ${status}\n` +
        `Uptime: ${uptime.toFixed(2)}%\n` +
        `Outages: ${d.count}\n` +
        `Downtime: ${d.h}h ${d.m}m`
      );
    }
  );
}

/* ---------- TELEGRAM COMMANDS ---------- */
setInterval(async () => {
  const r = await fetch(
    `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`
  ).then(r => r.json()).catch(() => null);

  if (!r?.ok) return;

  for (const u of r.result) {
    lastUpdateId = u.update_id;
    if (!u.message?.text) continue;

    const chatId = u.message.chat.id;
    const cmd = u.message.text.trim().toLowerCase();

    db.run(`INSERT OR IGNORE INTO chats VALUES (?)`, [chatId]);

    if (cmd === "/start") {
      sendTelegram(
        chatId,
        "📡 ESP32 Uptime Monitor\n\n" +
        "/status – 24h\n" +
        "/statusweek – 7 days\n" +
        "/statusmonth – 30 days"
      );
    } else if (cmd === "/status") sendStatus(chatId, 1, "24 HOUR STATUS");
    else if (cmd === "/statusweek") sendStatus(chatId, 7, "7 DAY STATUS");
    else if (cmd === "/statusmonth") sendStatus(chatId, 30, "30 DAY STATUS");
    else if (cmd === "/reset") {
      if (!ADMIN_CHAT_IDS.includes(chatId)) {
        sendTelegram(chatId, "⛔ Admin only");
      } else {
        db.run(`DELETE FROM events`);
        db.run(`DELETE FROM devices`);
        db.run(`DELETE FROM outages`);
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
        db.run(`UPDATE devices SET status='OFFLINE' WHERE device=?`, [d.device]);
        openOutage(d.device, now);
        broadcast(`🔴 ${d.device} OFFLINE\n🕒 ${formatTime(now)}`);
      }
    });
  });
}, 60000);

/* ---------- EVENT API ---------- */
app.post("/api/event", (req, res) => {
  const { device, event, time, state } = req.body;
  if (!device || !event || !time) return res.status(400).end();

  const now = Date.now();

  db.run(
    `
    INSERT INTO devices (device,last_seen,status)
    VALUES (?,?,?)
    ON CONFLICT(device)
    DO UPDATE SET last_seen=?, status=excluded.status
    `,
    [device, now, "ONLINE", now]
  );

  if (event === "HEARTBEAT" || event === "SYNC") {
    return res.json({ ok: true });
  }

  if (event === "STATE_SYNC") {
    db.run(
      `UPDATE devices SET status=?, last_seen=? WHERE device=?`,
      [state, now, device]
    );

    if (state === "OFFLINE") openOutage(device, now);
    if (state === "ONLINE") closeOutage(device, now);

    db.run(
      `INSERT INTO events (device,event,time) VALUES (?,?,?)`,
      [device, state, time]
    );

    return res.json({ ok: true });
  }

  if (event === "OFFLINE") openOutage(device, now);
  if (event === "ONLINE") closeOutage(device, now);

  broadcast(`${event === "ONLINE" ? "🟢" : "🔴"} ${device} ${event}\n🕒 ${formatTime(now)}`);
  res.json({ ok: true });
});

/* ---------- AUTO SUMMARY @ 7AM ---------- */
let lastSummaryDay = null;
setInterval(() => {
  const t = new Date(Date.now() + TZ_OFFSET_MS);
  if (t.getHours() !== 7) return;

  const today = t.toDateString();
  if (today === lastSummaryDay) return;
  lastSummaryDay = today;

  db.all(`SELECT chat_id FROM chats`, (_, rows) =>
    rows?.forEach(r => {
      sendStatus(r.chat_id, 1, "DAILY SUMMARY");
      sendStatus(r.chat_id, 7, "WEEKLY SUMMARY");
      sendStatus(r.chat_id, 30, "MONTHLY SUMMARY");
    })
  );
}, 60000);

/* ---------- START ---------- */
app.listen(PORT, () =>
  console.log("🚀 Server running on", PORT)
);

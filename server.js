import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";
const TZ_OFFSET_MS = 3600000; // WAT
/* ========================================= */

let lastUpdateId = 0;

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_FILE);

/* ---------- DB ---------- */
db.serialize(() => {
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
    CREATE TABLE IF NOT EXISTS daily_uptime (
      device TEXT,
      day TEXT,
      uptime_ms INTEGER,
      PRIMARY KEY (device, day)
    )
  `);
});

/* ---------- TIME ---------- */
function formatTime(ms) {
  return new Date(ms + TZ_OFFSET_MS).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
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
  db.all(`SELECT chat_id FROM chats`, (_, rows) => {
    rows?.forEach(r => sendTelegram(r.chat_id, text));
  });
}

/* ---------- SLA HELPERS ---------- */
function slaPct(ms) {
  return Math.min(100, (ms / 86400000) * 100);
}

function avgSla(device, days) {
  return new Promise(resolve => {
    db.all(
      `
      SELECT uptime_ms FROM daily_uptime
      WHERE device=?
      ORDER BY day DESC
      LIMIT ?
    `,
      [device, days],
      (_, rows) => {
        if (!rows || rows.length === 0) return resolve(0);
        const avg =
          rows.reduce((sum, r) => sum + slaPct(r.uptime_ms), 0) /
          rows.length;
        resolve(avg);
      }
    );
  });
}

/* ---------- EVENT API ---------- */
app.post("/api/event", (req, res) => {
  const { device, event, time, uptime_ms } = req.body;
  if (!device || !event || !time) return res.status(400).end();

  const now = Date.now();

  db.run(
    `
    INSERT INTO devices(device,last_seen,status)
    VALUES(?,?,?)
    ON CONFLICT(device)
    DO UPDATE SET last_seen=?, status=excluded.status
  `,
    [device, now, "ONLINE", now]
  );

  if (event === "DAILY_SYNC") {
    const day = new Date(now).toISOString().slice(0, 10);
    db.run(
      `
      INSERT OR REPLACE INTO daily_uptime(device,day,uptime_ms)
      VALUES(?,?,?)
    `,
      [device, day, uptime_ms || 0]
    );
    return res.json({ ok: true });
  }

  if (event === "ONLINE" || event === "OFFLINE") {
    db.run(`UPDATE devices SET status=? WHERE device=?`, [
      event,
      device
    ]);

    broadcast(
      `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n` +
        `${device}\n` +
        `🕒 ${formatTime(now)}`
    );
  }

  res.json({ ok: true });
});

/* ---------- TELEGRAM COMMANDS ---------- */
setInterval(async () => {
  if (!TG_BOT_TOKEN) return;

  let r;
  try {
    r = await fetch(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${
        lastUpdateId + 1
      }`
    ).then(r => r.json());
  } catch {
    return;
  }

  if (!r?.ok) return;

  for (const u of r.result) {
    lastUpdateId = u.update_id;
    if (!u.message?.text) continue;

    const chatId = u.message.chat.id;
    const cmd = u.message.text.trim().toLowerCase();

    db.run(`INSERT OR IGNORE INTO chats VALUES(?)`, [chatId]);

    if (cmd === "/start") {
      sendTelegram(
        chatId,
        "📡 *ESP32 SLA Monitor*\n\n" +
          "/status – 24h SLA\n" +
          "/statusweek – 7-day SLA\n" +
          "/statusmonth – 30-day SLA"
      );
    }

    else if (cmd === "/status") {
      const sla = await avgSla("KAINJI-Uptime", 1);
      sendTelegram(chatId, `📊 *24 HOUR SLA*\n${sla.toFixed(2)}%`);
    }

    else if (cmd === "/statusweek") {
      const sla = await avgSla("KAINJI-Uptime", 7);
      sendTelegram(chatId, `📈 *7 DAY SLA*\n${sla.toFixed(2)}%`);
    }

    else if (cmd === "/statusmonth") {
      const sla = await avgSla("KAINJI-Uptime", 30);
      sendTelegram(chatId, `📉 *30 DAY SLA*\n${sla.toFixed(2)}%`);
    }
  }
}, 5000);

/* ---------- START ---------- */
app.listen(PORT, () =>
  console.log("🚀 Server running on", PORT)
);

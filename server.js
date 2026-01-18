import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";

const POLL_INTERVAL = 5000;
const DEVICE_TIMEOUT_MS = 2 * 60 * 1000;
const TZ_OFFSET_MS = 3600000;

const ADMIN_CHAT_IDS = [1621660251];
/* ========================================= */

let lastUpdateId = 0;

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT,
      event TEXT,
      time TEXT,
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

  db.run(`CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY)`);

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

/* ---------- TIME ---------- */
function formatTime(ms) {
  return new Date(ms + TZ_OFFSET_MS).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true
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
  db.get(`SELECT id FROM outages WHERE device=? AND end_time IS NULL`,
    [device], (_, r) => {
      if (!r) db.run(
        `INSERT INTO outages (device,start_time) VALUES (?,?)`,
        [device, now]
      );
    });
}

function closeOutage(device, now) {
  db.get(`
    SELECT id,start_time FROM outages
    WHERE device=? AND end_time IS NULL
    ORDER BY start_time DESC LIMIT 1`,
    [device], (_, o) => {
      if (o) {
        db.run(`
          UPDATE outages SET end_time=?, duration_ms=?
          WHERE id=?`,
          [now, now - o.start_time, o.id]
        );
      }
    });
}

/* ---------- EVENT API (PATCHED) ---------- */
app.post("/api/event", (req, res) => {
  const { device, event, time, state, uptime_ms } = req.body;
  if (!device || !event || !time) return res.status(400).end();

  const now = Date.now();

  db.run(`
    INSERT INTO devices (device,last_seen,status)
    VALUES (?,?,?)
    ON CONFLICT(device)
    DO UPDATE SET last_seen=?, status=excluded.status
  `, [device, now, "ONLINE", now]);

  /* ✅ LONG OUTAGE REPAIR */
  if (event === "SYNC" && uptime_ms) {
    db.get(`
      SELECT id,start_time FROM outages
      WHERE device=? AND end_time IS NULL
      ORDER BY start_time DESC LIMIT 1`,
      [device], (_, o) => {
        if (o) {
          const adjustedStart = Math.min(o.start_time + uptime_ms, now);
          db.run(`
            UPDATE outages SET
              start_time=?,
              duration_ms=?
            WHERE id=?`,
            [adjustedStart, now - adjustedStart, o.id]
          );
        }
      });
    return res.json({ ok: true });
  }

  if (event === "HEARTBEAT") return res.json({ ok: true });

  if (event === "STATE_SYNC") {
    db.run(`UPDATE devices SET status=?, last_seen=? WHERE device=?`,
      [state, now, device]);
    if (state === "OFFLINE") openOutage(device, now);
    if (state === "ONLINE") closeOutage(device, now);
    return res.json({ ok: true });
  }

  if (event === "OFFLINE") openOutage(device, now);
  if (event === "ONLINE") closeOutage(device, now);

  broadcast(`${event === "ONLINE" ? "🟢" : "🔴"} ${device} ${event}\n🕒 ${formatTime(now)}`);
  res.json({ ok: true });
});

/* ---------- START ---------- */
app.listen(PORT, () => console.log("🚀 Server running on", PORT));

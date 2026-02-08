import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;

const DB_FILE = "/data/uptime.db";
const TZ_OFFSET_MS = 3600000; // Nigeria +1

const DAY_MS = 86400000;

const TG_POLL_MS = 4000;
const MIDNIGHT_CHECK_MS = 15000;

const DEFAULT_DEVICE = "KAINJI-Uptime";

// device stale => UNKNOWN
const DEVICE_STALE_MS = 2 * 60 * 1000;
/* ========================================= */

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.log("❌ Failed to open DB:", err.message);
  else console.log("✅ SQLite DB opened at:", DB_FILE);
});

db.get("PRAGMA journal_mode=WAL;", () => {});

/* ---------- DB INIT ---------- */
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chats(chat_id INTEGER PRIMARY KEY)`);

  db.run(`CREATE TABLE IF NOT EXISTS devices(
    device TEXT PRIMARY KEY,
    last_seen INTEGER,
    status TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS daily_uptime(
    device TEXT,
    day INTEGER,
    uptime_ms INTEGER,
    PRIMARY KEY(device,day)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS monthly_uptime(
    device TEXT,
    month INTEGER,
    uptime_ms INTEGER,
    PRIMARY KEY(device,month)
  )`);

  console.log("✅ DB tables ensured");
});

/* ---------- DB HELPERS ---------- */
const dbGet = (sql, p = []) =>
  new Promise((r) => db.get(sql, p, (_, row) => r(row || null)));
const dbAll = (sql, p = []) =>
  new Promise((r) => db.all(sql, p, (_, rows) => r(rows || [])));
const dbRun = (sql, p = []) =>
  new Promise((r) => db.run(sql, p, () => r(true)));

/* ---------- TIME HELPERS ---------- */
function formatTime(ms) {
  return new Date(ms + TZ_OFFSET_MS).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function todayEpochSec() {
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function monthStartEpochSec() {
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function epochSecToLabel(sec) {
  return new Date(sec * 1000 + TZ_OFFSET_MS).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
  });
}

function slaPercent(up) {
  return Math.min(100, (up / DAY_MS) * 100);
}

function bar(p) {
  const b = Math.round((p / 100) * 10);
  return "█".repeat(b) + "░".repeat(10 - b);
}

/* ---------- LIVE STATUS ---------- */
function computeLiveStatus(d) {
  if (!d?.last_seen) return "UNKNOWN";
  if (Date.now() - d.last_seen > DEVICE_STALE_MS) return "UNKNOWN";
  return d.status || "UNKNOWN";
}

const getDeviceRow = (d) =>
  dbGet(`SELECT device,last_seen,status FROM devices WHERE device=?`, [d]);

/* ---------- TELEGRAM ---------- */
async function tg(chat, text) {
  if (!TG_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  }).catch(() => {});
}

async function broadcast(text) {
  const chats = await dbAll(`SELECT chat_id FROM chats`);
  for (const c of chats) tg(c.chat_id, text);
}

/* ---------- QUERIES ---------- */
const getLastNDays = (d, n) =>
  dbAll(
    `SELECT day,uptime_ms FROM daily_uptime WHERE device=? ORDER BY day DESC LIMIT ?`,
    [d, n]
  );

const getMonthlyUptime = (d, m) =>
  dbGet(`SELECT uptime_ms FROM monthly_uptime WHERE device=? AND month=?`, [
    d,
    m,
  ]);

/* ---------- EVENT API ---------- */
app.post("/api/event", async (req, res) => {
  const { device, event, uptime_ms, day, month, time } = req.body;
  const now = Date.now();

  if (device) {
    const status = event === "ONLINE" || event === "OFFLINE" ? event : null;
    await dbRun(
      `INSERT INTO devices(device,last_seen,status)
       VALUES(?,?,?)
       ON CONFLICT(device)
       DO UPDATE SET last_seen=excluded.last_seen`,
      [device, now, status]
    );
    if (status)
      await dbRun(`UPDATE devices SET status=? WHERE device=?`, [
        status,
        device,
      ]);
  }

  if (event === "DAILY_SYNC")
    await dbRun(`INSERT OR REPLACE INTO daily_uptime VALUES(?,?,?)`, [
      device,
      day,
      uptime_ms || 0,
    ]);

  if (event === "MONTHLY_SYNC")
    await dbRun(`INSERT OR REPLACE INTO monthly_uptime VALUES(?,?,?)`, [
      device,
      month,
      uptime_ms || 0,
    ]);

  if (event === "ONLINE" || event === "OFFLINE")
    broadcast(
      `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n${device}\n🕒 ${
        time || formatTime(now)
      }`
    );

  res.json({ ok: true });
});

/* ---------- TELEGRAM BOT ---------- */
let lastId = 0;

async function handleTelegramCommand(chat, cmd) {
  await dbRun(`INSERT OR IGNORE INTO chats VALUES(?)`, [chat]);

  /* ---------- FIXED /status ---------- */
  if (cmd === "/status") {
    const today = todayEpochSec();
    const yesterdayStart = today - 86400;
    const yesterdayEnd = today;

    const rows = await dbAll(
      `SELECT day,uptime_ms FROM daily_uptime
       WHERE device=? AND day>=? AND day<?
       ORDER BY day DESC LIMIT 1`,
      [DEFAULT_DEVICE, yesterdayStart, yesterdayEnd]
    );

    const dev = await getDeviceRow(DEFAULT_DEVICE);
    const live = computeLiveStatus(dev);

    if (!rows.length)
      return tg(
        chat,
        `⚠️ No DAILY_SYNC for yesterday\n📟 ${DEFAULT_DEVICE}\n📡 Status: ${live}`
      );

    const r = rows[0];
    const p = slaPercent(r.uptime_ms || 0);

    return tg(
      chat,
      `📊 Yesterday SLA (24h)\n📟 ${DEFAULT_DEVICE}\n📡 Status: ${live}\n📅 ${epochSecToLabel(
        r.day
      )}\n\nSLA: ${p.toFixed(2)}%\nUptime: ${(
        r.uptime_ms / 3600000
      ).toFixed(2)}h\n${bar(p)}`
    );
  }

  /* ---------- UNCHANGED COMMANDS ---------- */
  if (cmd === "/statusweek") {
    const rows = await getLastNDays(DEFAULT_DEVICE, 7);
    if (!rows.length) return tg(chat, "⚠️ No uptime history yet.");

    let t = `📈 Last 7 Days SLA\n📟 ${DEFAULT_DEVICE}\n\n`;
    for (const r of rows.reverse()) {
      const p = slaPercent(r.uptime_ms || 0);
      t += `${epochSecToLabel(r.day)} ${bar(p)} ${p.toFixed(1)}%\n`;
    }
    return tg(chat, t);
  }

  if (cmd === "/statusmonth") {
    const rows = await getLastNDays(DEFAULT_DEVICE, 30);
    const totalUp = rows.reduce((s, r) => s + (r.uptime_ms || 0), 0);
    return tg(
      chat,
      `📉 Past 30 Days Summary\n📟 ${DEFAULT_DEVICE}\n\nTotal Uptime: ${(
        totalUp / 3600000
      ).toFixed(2)}h`
    );
  }

  if (cmd === "/month") {
    const m = monthStartEpochSec();
    const r = await getMonthlyUptime(DEFAULT_DEVICE, m);
    if (!r) return tg(chat, "⚠️ No MONTHLY_SYNC yet.");
    return tg(
      chat,
      `🗓️ Monthly Summary\n📟 ${DEFAULT_DEVICE}\n\nUptime: ${(
        r.uptime_ms / 3600000
      ).toFixed(2)}h`
    );
  }
}

setInterval(async () => {
  if (!TG_BOT_TOKEN) return;
  const r = await fetch(
    `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastId + 1}`
  )
    .then((x) => x.json())
    .catch(() => null);

  if (!r?.ok) return;
  for (const u of r.result) {
    lastId = u.update_id;
    const chat = u.message?.chat?.id;
    const cmd = u.message?.text;
    if (chat && cmd) await handleTelegramCommand(chat, cmd);
  }
}, TG_POLL_MS);

/* ---------- START ---------- */
app.listen(PORT, () => console.log("🚀 Server running on", PORT));

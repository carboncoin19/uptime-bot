import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;

const DB_FILE = "/data/uptime.db";
const TZ_OFFSET_MS = 3600000; // Nigeria +1

const DAY_MS = 86400000;
const TG_POLL_MS = 4000;
const MIDNIGHT_CHECK_MS = 15000;

const DEVICE_STALE_MS = 2 * 60 * 1000;

/* -------- MULTI BOT CONFIG (ENV FIXED) -------- */
const BOTS = [];

for (let i = 1; i <= 10; i++) {
  const token = process.env[`TG_BOT_TOKEN_${i}`];
  const device = process.env[`TG_BOT_DEVICE_${i}`];

  if (token && device) {
    BOTS.push({
      token,
      device,
      lastId: 0,
    });
  }
}
/* ============================================= */

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.log("❌ Failed to open DB:", err.message);
  else console.log("✅ SQLite DB opened at:", DB_FILE);
});

db.get("PRAGMA journal_mode=WAL;", () => {});

/* ---------- DB INIT ---------- */
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chats(
    chat_id INTEGER,
    bot_token TEXT,
    PRIMARY KEY(chat_id, bot_token)
  )`);

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
  new Promise((r) => db.run(sql, p, (e) => r(!e)));

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

function totalSlaPercent(totalUp, totalPeriod) {
  if (!totalPeriod || totalPeriod <= 0) return 0;
  return Math.min(100, (totalUp / totalPeriod) * 100);
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

/* ---------- TELEGRAM ---------- */
async function tg(token, chat, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
  } catch {}
}

async function broadcast(token, text) {
  const chats = await dbAll(
    `SELECT chat_id FROM chats WHERE bot_token=?`,
    [token]
  );
  for (const c of chats) tg(token, c.chat_id, text);
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

/* ---------- DAILY SUMMARY ---------- */
async function buildDailySummaryText(device, day) {
  const row = await dbGet(
    `SELECT uptime_ms FROM daily_uptime WHERE device=? AND day=?`,
    [device, day]
  );

  if (!row)
    return `📊 Daily SLA Summary\n📟 ${device}\n📅 ${epochSecToLabel(
      day
    )}\n\n⚠️ No DAILY_SYNC data yet.`;

  const up = row.uptime_ms || 0;
  const p = slaPercent(up);
  const totalP = totalSlaPercent(up, DAY_MS);

  return (
    `📊 Daily SLA Summary\n` +
    `📟 ${device}\n` +
    `📅 ${epochSecToLabel(day)}\n\n` +
    `SLA: ${p.toFixed(2)}%\n` +
    `Total Uptime %: ${totalP.toFixed(2)}%\n` +
    `Uptime: ${(up / 3600000).toFixed(2)}h\n` +
    `${bar(p)}`
  );
}

/* ---------- 7AM AUTO SUMMARY ---------- */
let lastSummaryKey = {};

async function midnightSchedulerTick() {
  const yesterday = todayEpochSec() - 86400;

  const now = new Date(Date.now() + TZ_OFFSET_MS);
  const sec = now.getHours() * 3600 + now.getMinutes() * 60;
  if (sec < 25200 || sec > 25800) return;

  for (const bot of BOTS) {
    if (lastSummaryKey[bot.device] === yesterday) continue;

    const msg = await buildDailySummaryText(bot.device, yesterday);
    await broadcast(bot.token, msg);
    lastSummaryKey[bot.device] = yesterday;
  }
}

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

  if (event === "ONLINE" || event === "OFFLINE") {
    for (const bot of BOTS)
      if (bot.device === device)
        broadcast(
          bot.token,
          `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n${device}\n🕒 ${
            time || formatTime(now)
          }`
        );
  }

  res.json({ ok: true });
});

/* ---------- TELEGRAM POLLING ---------- */
for (const bot of BOTS) {
  setInterval(async () => {
    const r = await fetch(
      `https://api.telegram.org/bot${bot.token}/getUpdates?offset=${
        bot.lastId + 1
      }`
    )
      .then((x) => x.json())
      .catch(() => null);

    if (!r?.ok) return;

    for (const u of r.result) {
      bot.lastId = u.update_id;
      const chat = u.message?.chat?.id;
      const cmd = u.message?.text;
      if (!chat || !cmd) continue;

      await dbRun(
        `INSERT OR IGNORE INTO chats(chat_id,bot_token) VALUES(?,?)`,
        [chat, bot.token]
      );

      if (cmd === "/statusweek") {
        const rows = await getLastNDays(bot.device, 7);
        const totalUp = rows.reduce((s, r) => s + (r.uptime_ms || 0), 0);
        const totalP = totalSlaPercent(totalUp, rows.length * DAY_MS);

        let t =
          `📈 Last 7 Days SLA\n📟 ${bot.device}\n` +
          `Total Uptime %: ${totalP.toFixed(2)}%\n\n`;

        for (const r of rows.reverse()) {
          const p = slaPercent(r.uptime_ms || 0);
          t += `${epochSecToLabel(r.day)} ${bar(p)} ${p.toFixed(1)}%\n`;
        }
        tg(bot.token, chat, t);
      }

      if (cmd === "/statusmonth") {
        const rows = await getLastNDays(bot.device, 30);
        const totalUp = rows.reduce((s, r) => s + (r.uptime_ms || 0), 0);
        const totalP = totalSlaPercent(totalUp, rows.length * DAY_MS);

        tg(
          bot.token,
          chat,
          `📉 Past 30 Days Summary\n📟 ${bot.device}\n\n` +
            `Total Uptime %: ${totalP.toFixed(2)}%\n` +
            `Total Uptime: ${(totalUp / 3600000).toFixed(2)}h`
        );
      }

      if (cmd === "/month") {
        const m = monthStartEpochSec();
        const r = await getMonthlyUptime(bot.device, m);
        if (!r) tg(bot.token, chat, "⚠️ No MONTHLY_SYNC yet.");
        else {
          const days =
            Math.floor((Date.now() + TZ_OFFSET_MS - m * 1000) / DAY_MS) + 1;
          const totalP = totalSlaPercent(r.uptime_ms, days * DAY_MS);

          tg(
            bot.token,
            chat,
            `🗓️ Monthly Summary\n📟 ${bot.device}\n\n` +
              `Total Uptime %: ${totalP.toFixed(2)}%\n` +
              `${bar(totalP)}`
          );
        }
      }
    }
  }, TG_POLL_MS);
}

/* ---------- SCHEDULER ---------- */
setInterval(midnightSchedulerTick, MIDNIGHT_CHECK_MS);

/* ---------- START ---------- */
app.listen(PORT, () => console.log("🚀 Server running on", PORT));

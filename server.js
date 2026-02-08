import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";
import fs from "fs";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const DB_FILE = "/data/uptime.db";
const TZ_OFFSET_MS = 3600000; // Nigeria +1
const DAY_MS = 86400000;
const TG_POLL_MS = 4000;
const MIDNIGHT_CHECK_MS = 15000;
const DEVICE_STALE_MS = 2 * 60 * 1000;

/* -------- MULTI BOT CONFIG -------- */
const BOTS = [];
for (let i = 1; i <= 10; i++) {
  const token = process.env[`TG_BOT_TOKEN_${i}`];
  const device = process.env[`TG_BOT_DEVICE_${i}`];
  if (token && device) {
    BOTS.push({
      token,
      device: device.trim(),
      deviceNorm: device.trim().toUpperCase(),
      lastId: 0,
      lastSummaryKey: null,
    });
  }
}
/* ================================= */

if (!fs.existsSync("/data")) fs.mkdirSync("/data", { recursive: true });

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_FILE);
db.get("PRAGMA journal_mode=WAL;", () => {});

/* ---------- DB INIT ---------- */
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chats(
    chat_id INTEGER,
    bot_token TEXT,
    PRIMARY KEY(chat_id,bot_token)
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
});

/* ---------- DB HELPERS ---------- */
const dbGet = (s, p = []) =>
  new Promise((r) => db.get(s, p, (_, row) => r(row || null)));
const dbAll = (s, p = []) =>
  new Promise((r) => db.all(s, p, (_, rows) => r(rows || [])));
const dbRun = (s, p = []) =>
  new Promise((r) => db.run(s, p, () => r(true)));

/* ---------- TIME HELPERS ---------- */
const todayEpochSec = () => {
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};
const monthStartEpochSec = () => {
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};
const epochSecToLabel = (s) =>
  new Date(s * 1000 + TZ_OFFSET_MS).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
  });
const slaPercent = (up) => Math.min(100, (up / DAY_MS) * 100);
const bar = (p) =>
  "█".repeat(Math.round((p / 100) * 10)) +
  "░".repeat(10 - Math.round((p / 100) * 10));

/* ---------- LIVE STATUS ---------- */
function computeLiveStatus(d) {
  if (!d?.last_seen) return "UNKNOWN";
  if (Date.now() - d.last_seen > DEVICE_STALE_MS) return "UNKNOWN";
  return d.status || "UNKNOWN";
}

/* ---------- TELEGRAM ---------- */
async function tg(token, chat, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  }).catch(() => {});
}

async function broadcast(token, text) {
  const chats = await dbAll(
    `SELECT chat_id FROM chats WHERE bot_token=?`,
    [token]
  );
  for (const c of chats) tg(token, c.chat_id, text);
}

/* ---------- EVENT API ---------- */
app.post("/api/event", async (req, res) => {
  const { device, event, uptime_ms, day, month, time } = req.body;
  const now = Date.now();
  const devNorm = String(device || "").toUpperCase();

  if (device) {
    const status = event === "ONLINE" || event === "OFFLINE" ? event : null;
    await dbRun(
      `INSERT INTO devices(device,last_seen,status)
       VALUES(?,?,?)
       ON CONFLICT(device)
       DO UPDATE SET last_seen=excluded.last_seen,
                     status=COALESCE(excluded.status,status)`,
      [device, now, status]
    );
  }

  if (event === "HEARTBEAT") return res.json({ ok: true });

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
    for (const bot of BOTS) {
      if (devNorm === bot.deviceNorm) {
        broadcast(
          bot.token,
          `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n${device}\n🕒 ${
            time || new Date(now).toLocaleString()
          }`
        );
      }
    }
  }

  res.json({ ok: true });
});

/* ---------- TELEGRAM COMMANDS ---------- */
async function handleCommand(bot, chat, cmd) {
  await dbRun(
    `INSERT OR IGNORE INTO chats(chat_id,bot_token) VALUES(?,?)`,
    [chat, bot.token]
  );

  if (cmd === "/start")
    return tg(
      bot.token,
      chat,
      `📡 ${bot.device} SLA Monitor\n/status /statusweek /statusmonth /month /devices /ping`
    );

  if (cmd === "/ping") return tg(bot.token, chat, "✅ Bot alive");

  if (cmd === "/devices") {
    const d = await dbAll(`SELECT * FROM devices`);
    return tg(
      bot.token,
      chat,
      d
        .map(
          (x) =>
            `${x.device}\nStatus: ${computeLiveStatus(x)}\nLast: ${new Date(
              x.last_seen
            ).toLocaleString()}`
        )
        .join("\n\n")
    );
  }

  if (cmd === "/status") {
    const y = todayEpochSec() - 86400;
    const rows = await dbAll(
      `SELECT day,uptime_ms FROM daily_uptime WHERE device=? ORDER BY day DESC LIMIT 7`,
      [bot.device]
    );
    const dev = await dbGet(`SELECT * FROM devices WHERE device=?`, [
      bot.device,
    ]);
    const match = rows.find((r) => epochSecToLabel(r.day) === epochSecToLabel(y));
    if (!match)
      return tg(bot.token, chat, "⚠️ No DAILY_SYNC for yesterday");

    const p = slaPercent(match.uptime_ms);
    return tg(
      bot.token,
      chat,
      `📊 Yesterday SLA\n📟 ${bot.device}\n📡 ${computeLiveStatus(dev)}\n${bar(
        p
      )} ${p.toFixed(2)}%`
    );
  }
}

/* ---------- POLLING ---------- */
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
      if (chat && cmd) handleCommand(bot, chat, cmd);
    }
  }, TG_POLL_MS);
}

/* ---------- START ---------- */
app.listen(PORT, () => console.log("🚀 Multi-Bot SLA Server running"));

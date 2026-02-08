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
    });
  }
}
console.log("🤖 Bots loaded:", BOTS.map(b => b.device));
/* ================================= */

/* ---------- ENSURE /data ---------- */
if (!fs.existsSync("/data")) fs.mkdirSync("/data", { recursive: true });

/* ---------- APP ---------- */
const app = express();
app.use(express.json());

/* ---------- SQLITE ---------- */
const db = new sqlite3.Database(DB_FILE, err => {
  if (err) console.log("❌ DB error:", err.message);
  else console.log("✅ SQLite ready:", DB_FILE);
});
db.get("PRAGMA journal_mode=WAL;");

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
});

/* ---------- DB HELPERS ---------- */
const dbRun = (s, p = []) =>
  new Promise(r => db.run(s, p, () => r(true)));

const dbGet = (s, p = []) =>
  new Promise(r => db.get(s, p, (_, row) => r(row || null)));

const dbAll = (s, p = []) =>
  new Promise(r => db.all(s, p, (_, rows) => r(rows || [])));

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

function epochSecToLabel(s) {
  return new Date(s * 1000 + TZ_OFFSET_MS)
    .toLocaleDateString("en-US", { month: "short", day: "2-digit" });
}

const slaPercent = up => Math.min(100, (up / DAY_MS) * 100);
const bar = p =>
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
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch {}
}

async function broadcast(token, text) {
  const chats = await dbAll(
    `SELECT chat_id FROM chats WHERE bot_token=?`,
    [token]
  );
  if (!chats.length) {
    console.log("⚠️ No subscribers for bot:", token.slice(0, 10));
    return;
  }
  for (const c of chats) tg(token, c.chat_id, text);
}

/* ---------- DEBUG ENDPOINTS ---------- */
app.get("/debug/chats", async (_, res) => {
  res.json(await dbAll(`SELECT * FROM chats`));
});

app.get("/debug/devices", async (_, res) => {
  res.json(await dbAll(`SELECT * FROM devices ORDER BY device`));
});

app.get("/debug/bots", (_, res) => {
  res.json(
    BOTS.map(b => ({
      device: b.device,
      deviceNorm: b.deviceNorm,
      tokenPrefix: b.token.slice(0, 10) + "…",
    }))
  );
});

app.post("/debug/clear-chats", async (_, res) => {
  await dbRun(`DELETE FROM chats`);
  res.json({ ok: true });
});

/* ---------- EVENT API ---------- */
app.post("/api/event", async (req, res) => {
  const { device, event, uptime_ms, day, month, time } = req.body;
  const now = Date.now();
  const dev = String(device || "").trim();
  const devNorm = dev.toUpperCase();

  if (dev) {
    const status =
      event === "ONLINE" || event === "OFFLINE" ? event : null;

    await dbRun(
      `INSERT INTO devices(device,last_seen,status)
       VALUES(?,?,?)
       ON CONFLICT(device)
       DO UPDATE SET last_seen=excluded.last_seen`,
      [dev, now, status]
    );

    if (status) {
      await dbRun(`UPDATE devices SET status=? WHERE device=?`, [
        status,
        dev,
      ]);
    }
  }

  if (event === "DAILY_SYNC") {
    await dbRun(
      `INSERT OR REPLACE INTO daily_uptime VALUES(?,?,?)`,
      [dev, day, uptime_ms || 0]
    );
  }

  if (event === "MONTHLY_SYNC") {
    await dbRun(
      `INSERT OR REPLACE INTO monthly_uptime VALUES(?,?,?)`,
      [dev, month, uptime_ms || 0]
    );
  }

  if (event === "ONLINE" || event === "OFFLINE") {
    const msg =
      `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n` +
      `${dev}\n🕒 ${time || formatTime(now)}`;

    for (const bot of BOTS) {
      if (bot.deviceNorm === devNorm) {
        broadcast(bot.token, msg);
      }
    }
  }

  res.json({ ok: true });
});

/* ---------- TELEGRAM POLLING ---------- */
for (const bot of BOTS) {
  setInterval(async () => {
    const r = await fetch(
      `https://api.telegram.org/bot${bot.token}/getUpdates?offset=${bot.lastId + 1}`
    ).then(x => x.json()).catch(() => null);

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

      if (cmd === "/start") {
        tg(
          bot.token,
          chat,
          `📡 ${bot.device} uptime monitor active.\nYou will now receive live alerts.`
        );
      }

      if (cmd === "/ping") {
        tg(bot.token, chat, "✅ Bot is alive.");
      }

      if (cmd === "/devices") {
        const rows = await dbAll(`SELECT * FROM devices ORDER BY device`);
        let text = "📟 Devices\n\n";
        for (const d of rows) {
          text += `• ${d.device}\n  Status: ${computeLiveStatus(d)}\n  Last seen: ${formatTime(d.last_seen)}\n\n`;
        }
        tg(bot.token, chat, text);
      }

      if (cmd === "/status") {
        const today = todayEpochSec();
        const yesterday = today - 86400;

        const rows = await dbAll(
          `SELECT day,uptime_ms FROM daily_uptime
           WHERE device=? ORDER BY day DESC LIMIT 7`,
          [bot.device]
        );

        const devRow = await dbGet(
          `SELECT last_seen,status FROM devices WHERE device=?`,
          [bot.device]
        );
        const live = computeLiveStatus(devRow);
        const label = epochSecToLabel(yesterday);
        const match = rows.find(r => epochSecToLabel(r.day) === label);

        if (!match) {
          tg(
            bot.token,
            chat,
            `⚠️ No DAILY_SYNC for yesterday\n📟 ${bot.device}\n📡 Status: ${live}`
          );
          continue;
        }

        const p = slaPercent(match.uptime_ms);
        tg(
          bot.token,
          chat,
          `📊 Yesterday SLA (24h)\n📟 ${bot.device}\n📡 Status: ${live}\n📅 ${label}\n\n` +
          `SLA: ${p.toFixed(2)}%\nUptime: ${(match.uptime_ms / 3600000).toFixed(2)}h\n${bar(p)}`
        );
      }
    }
  }, TG_POLL_MS);
}

/* ---------- 7AM AUTO SUMMARY ---------- */
let lastSummary = {};
setInterval(async () => {
  const today = todayEpochSec();
  const yesterday = today - 86400;
  const now = new Date(Date.now() + TZ_OFFSET_MS);
  const sec = now.getHours() * 3600 + now.getMinutes() * 60;

  if (sec < 25200 || sec > 25800) return;

  for (const bot of BOTS) {
    if (lastSummary[bot.device] === yesterday) continue;

    const rows = await dbAll(
      `SELECT day,uptime_ms FROM daily_uptime
       WHERE device=? ORDER BY day DESC LIMIT 7`,
      [bot.device]
    );

    const label = epochSecToLabel(yesterday);
    const match = rows.find(r => epochSecToLabel(r.day) === label);
    if (!match) continue;

    const p = slaPercent(match.uptime_ms);
    broadcast(
      bot.token,
      `📊 Daily Summary\n📟 ${bot.device}\n📅 ${label}\n` +
      `Uptime: ${(match.uptime_ms / 3600000).toFixed(2)}h\nSLA: ${p.toFixed(2)}%`
    );

    lastSummary[bot.device] = yesterday;
  }
}, MIDNIGHT_CHECK_MS);

/* ---------- START ---------- */
app.listen(PORT, () => console.log("🚀 Server running on", PORT));

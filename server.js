import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";


/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;
const DB_FILE = "/data/uptime.db";
const TZ_OFFSET_MS = 3600000; // Nigeria +1

const DAY_MS = 86400000;
const MIDNIGHT_CHECK_MS = 15000;
const DEVICE_STALE_MS = 2 * 60 * 1000;
/* ========================================= */

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

/* ---------- ENSURE /data ---------- */
if (!fs.existsSync("/data")) fs.mkdirSync("/data", { recursive: true });

/* ---------- APP ---------- */
const app = express();
const __dirname = new URL(".", import.meta.url).pathname;

app.use("/firmware", express.static(path.join(__dirname, "firmware")));

app.use(express.json());

app.get("/", (req, res) => res.status(200).send("OK"));

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
   db.run(`CREATE TABLE IF NOT EXISTS firmware_control(
  device TEXT PRIMARY KEY,
  latest_version TEXT,
  firmware_url TEXT,
  update_requested INTEGER DEFAULT 0,
  force_update INTEGER DEFAULT 0,
  current_version TEXT
)`);


});

/* ---------- DB HELPERS ---------- */
const dbRun = (s, p = []) => new Promise(r => db.run(s, p, () => r(true)));
const dbGet = (s, p = []) => new Promise(r => db.get(s, p, (_, row) => r(row || null)));
const dbAll = (s, p = []) => new Promise(r => db.all(s, p, (_, rows) => r(rows || [])));

/* ---------- TIME HELPERS ---------- */
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

function epochSecToLabel(s) {
  return new Date(s * 1000 + TZ_OFFSET_MS)
    .toLocaleDateString("en-US", { month: "short", day: "2-digit" });
}

function formatTime(ms) {
  return new Date(ms + TZ_OFFSET_MS).toLocaleString();
}

const slaPercent = up => Math.min(100, (up / DAY_MS) * 100);
const bar = p =>
  "█".repeat(Math.round((p / 100) * 10)) +
  "░".repeat(10 - Math.round((p / 100) * 10));

function computeLiveStatus(d) {
  if (!d?.last_seen) return "UNKNOWN";
  if (Date.now() - d.last_seen > DEVICE_STALE_MS) return "UNKNOWN";
  return d.status || "UNKNOWN";
}

function buildSlaMessage({ title, device, status, label, uptimeMs }) {
  const p = slaPercent(uptimeMs);
  return (
    `📊 ${title}\n` +
    `📟 ${device}\n` +
    `📡 Status: ${status}\n` +
    `📅 ${label}\n\n` +
    `SLA: ${p.toFixed(2)}%\n` +
    `Uptime: ${(uptimeMs / 3600000).toFixed(2)}h\n` +
    `${bar(p)}`
  );
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

/* ---------- EVENT API ---------- */
app.post("/api/event", async (req, res) => {
  const { device, event, uptime_ms, day, month, time, version } = req.body;
  const now = Date.now();
const dev = String(device || "").trim().toUpperCase();
const devNorm = dev;


  if (!event) return res.json({ ok: true });

  /* HEARTBEAT shortcut */
  if (event === "HEARTBEAT") return res.json({ ok: true });

  /* Device tracking */
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

    if (status)
      await dbRun(
        `UPDATE devices SET status=? WHERE device=?`,
        [status, dev]
      );
  }

  /* Uptime storage */
  if (event === "DAILY_SYNC")
    await dbRun(
      `INSERT OR REPLACE INTO daily_uptime VALUES(?,?,?)`,
      [dev, day, uptime_ms || 0]
    );

  if (event === "MONTHLY_SYNC")
    await dbRun(
      `INSERT OR REPLACE INTO monthly_uptime VALUES(?,?,?)`,
      [dev, month, uptime_ms || 0]
    );

  /* Online / Offline alert */
  if (event === "ONLINE" || event === "OFFLINE") {
    const msg =
      `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n` +
      `${dev}\n🕒 ${time || formatTime(now)}`;

    for (const bot of BOTS)
      if (bot.deviceNorm === devNorm)
        broadcast(bot.token, msg);
  }
if (event === "FW_REPORT") {
  await dbRun(
    `INSERT INTO firmware_control(device, current_version)
     VALUES(?,?)
     ON CONFLICT(device)
     DO UPDATE SET current_version=?`,
    [dev, version || "unknown", version || "unknown"]
  );
}

  /* OTA SUCCESS */
if (event === "OTA_SUCCESS") {

  await dbRun(
    `UPDATE firmware_control
     SET update_requested=0,
         force_update=0,
         current_version=?
     WHERE device=?`,
    [version || "unknown", dev]
  );

  const msg =
    `🚀 OTA UPDATE SUCCESS\n\n` +
    `📟 ${dev}\n` +
    `🆕 Version: ${version || "unknown"}\n` +
    `🕒 ${time || formatTime(now)}`;

  for (const bot of BOTS)
    if (bot.deviceNorm === devNorm)
      broadcast(bot.token, msg);
}



  /* OTA FAILED */
  if (event === "OTA_FAILED") {
    const msg =
      `❌ OTA UPDATE FAILED\n\n` +
      `📟 ${dev}\n` +
      `🆕 Version: ${version || "unknown"}\n` +
      `🕒 ${time || formatTime(now)}`;

    for (const bot of BOTS)
      if (bot.deviceNorm === devNorm)
        broadcast(bot.token, msg);
  }

  res.json({ ok: true });
});

app.get("/api/fw/:device", async (req, res) => {

  const dev = req.params.device.trim().toUpperCase();

  const row = await dbGet(
    `SELECT latest_version, firmware_url,
            update_requested, force_update
     FROM firmware_control
     WHERE device=?`,
    [dev]
  );

  if (!row || row.update_requested !== 1) {
    return res.json({ update: false });
  }

  // Reset update flag immediately


  res.json({
  update: true,
  version: row.latest_version,
  url: row.firmware_url,
  force: row.force_update === 1,
  trigger: true
});

});


/* ---------- TELEGRAM LONG POLLING ---------- */

function startLongPolling(bot) {
  async function poll() {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${bot.token}/getUpdates?offset=${bot.lastId + 1}&timeout=30`
      );
      const data = await response.json();

      if (!data.ok) {
        scheduleNext(1000);
        return;
      }

      for (const update of data.result) {
        bot.lastId = update.update_id;

        const chat = update.message?.chat?.id;
        const cmd = update.message?.text;

        if (!chat || !cmd) continue;

        await dbRun(
          `INSERT OR IGNORE INTO chats(chat_id,bot_token) VALUES(?,?)`,
          [chat, bot.token]
        );

        /* ===== COMMAND HANDLERS ===== */
        if (cmd.startsWith("/update")) {
          const parts = cmd.split(" ");
          if (parts.length < 2) {
            tg(bot.token, chat, "Usage: /update 1.0.4");
            continue;
          }

          const newVersion = parts[1];
          const fwUrl =   "http://uptime-bot-production-9a37.up.railway.app/firmware/NDONI-UPTIME.bin";

          await dbRun(
            `INSERT INTO firmware_control
             (device, latest_version, firmware_url, update_requested, force_update)
             VALUES(?,?,?,?,0)
             ON CONFLICT(device)
             DO UPDATE SET
               latest_version=?,
               update_requested=1,
               force_update=0`,
            [bot.device.toUpperCase(), newVersion, fwUrl, 1, newVersion]
          );

          tg(bot.token, chat, `🚀 Update requested\n📟 ${bot.device}\n🆕 ${newVersion}`);
        }

        if (cmd.startsWith("/forceupdate")) {
          const parts = cmd.split(" ");
          if (parts.length < 2) {
            tg(bot.token, chat, "Usage: /forceupdate 1.0.4");
            continue;
          }

          const newVersion = parts[1];
          const fwUrl =   "http://uptime-bot-production-9a37.up.railway.app/firmware/NDONI-UPTIME.bin";

          await dbRun(
            `INSERT INTO firmware_control
             (device, latest_version, firmware_url, update_requested, force_update)
             VALUES(?,?,?,?,1)
             ON CONFLICT(device)
             DO UPDATE SET
               latest_version=?,
               update_requested=1,
               force_update=1`,
            [bot.device.toUpperCase(), newVersion, fwUrl, 1, newVersion]
          );

          tg(bot.token, chat, `🔥 FORCE UPDATE requested\n📟 ${bot.device}\n🆕 ${newVersion}`);
        }

        if (cmd === "/start") {
          tg(bot.token, chat, `📡 ${bot.device} uptime monitor active.`);
        }

        if (cmd === "/status") {
          const today = todayEpochSec();
          const yLabel = epochSecToLabel(today - 86400);

          const rows = await dbAll(
            `SELECT day,uptime_ms FROM daily_uptime WHERE device=? ORDER BY day DESC LIMIT 7`,
            [bot.device.toUpperCase()]
          );

          const devRow = await dbGet(
            `SELECT last_seen,status FROM devices WHERE device=?`,
            [bot.device.toUpperCase()]
          );

          const match = rows.find(r => epochSecToLabel(r.day) === yLabel);

          if (!match) {
            tg(bot.token, chat, `⚠️ No DAILY_SYNC for yesterday\n📟 ${bot.device}\n📡 Status: ${computeLiveStatus(devRow)}`);
          } else {
            tg(bot.token, chat, buildSlaMessage({
              title: "Yesterday SLA (24h)",
              device: bot.device,
              status: computeLiveStatus(devRow),
              label: yLabel,
              uptimeMs: match.uptime_ms,
            }));
          }
        }

        if (cmd === "/fw") {
          const row = await dbGet(
            `SELECT current_version, latest_version FROM firmware_control WHERE device=?`,
            [bot.device.toUpperCase()]
          );

          tg(bot.token, chat,
            `📟 ${bot.device}\n` +
            `Current Device Version: ${row?.current_version || "Unknown"}\n` +
            `Latest Server Version: ${row?.latest_version || "Not set"}`
          );
        }

        if (cmd === "/statusweek") {
          const rows = await dbAll(
            `SELECT day,uptime_ms FROM daily_uptime WHERE device=? ORDER BY day DESC LIMIT 7`,
            [bot.device.toUpperCase()]
          );

          if (!rows.length) {
            tg(bot.token, chat, "⚠️ No uptime data yet.");
            continue;
          }

          const ordered = rows.reverse();
          const totalUp = ordered.reduce((s, r) => s + (r.uptime_ms || 0), 0);
          const expected = ordered.length * DAY_MS;
          const overall = Math.min(100, (totalUp / expected) * 100);

          let text = `📈 Weekly SLA Summary\n📟 ${bot.device}\n\nOverall SLA: ${overall.toFixed(2)}%\nTotal Uptime: ${(totalUp / 3600000).toFixed(2)}h\n\n`;
          for (const r of ordered) {
            const p = slaPercent(r.uptime_ms || 0);
            text += `${epochSecToLabel(r.day)} ${bar(p)} ${p.toFixed(1)}%\n`;
          }
          tg(bot.token, chat, text);
        }

        if (cmd === "/statusmonth") {
          const rows = await dbAll(
            `SELECT day,uptime_ms FROM daily_uptime WHERE device=? ORDER BY day DESC LIMIT 30`,
            [bot.device.toUpperCase()]
          );

          if (!rows.length) {
            tg(bot.token, chat, "⚠️ No uptime data yet.");
            continue;
          }

          const totalUp = rows.reduce((s, r) => s + (r.uptime_ms || 0), 0);
          const expected = rows.length * DAY_MS;
          const sla = Math.min(100, (totalUp / expected) * 100);

          tg(bot.token, chat,
            `📉 Monthly SLA Summary\n📟 ${bot.device}\n\nOverall SLA: ${sla.toFixed(2)}%\nTotal Uptime: ${(totalUp / 3600000).toFixed(2)}h\nDays counted: ${rows.length}`
          );
        }

        if (cmd === "/month") {
          const m = monthStartEpochSec();
          const r = await dbGet(
            `SELECT uptime_ms FROM monthly_uptime WHERE device=? AND month=?`,
            [bot.device.toUpperCase(), m]
          );

          if (!r) {
            tg(bot.token, chat, "⚠️ No MONTHLY_SYNC yet.");
          } else {
            tg(bot.token, chat, `🗓️ Monthly Summary\n📟 ${bot.device}\nUptime: ${(r.uptime_ms / 3600000).toFixed(2)}h`);
          }
        }
      }
      scheduleNext(300); // Trigger next poll after processing updates
    } catch (err) {
      console.error("❌ Polling error:", err);
      scheduleNext(2000);
    }
  }

  function scheduleNext(ms) {
    setTimeout(poll, ms);
  }

  poll();
}
  


for (const bot of BOTS) {
  startLongPolling(bot);
}

/* ---------- AUTO DAILY SLA BROADCAST ---------- */
let sent = {};

setInterval(async () => {
  const now = new Date(Date.now() + TZ_OFFSET_MS);
  const secondsToday =
    now.getHours() * 3600 + now.getMinutes() * 60;

  /* Send between 7:00AM–7:10AM Nigeria time */
  if (secondsToday < 25200 || secondsToday > 25800) return;

  for (const bot of BOTS) {
    const yLabel = epochSecToLabel(todayEpochSec() - 86400);

    if (sent[bot.device] === yLabel) continue;

    const rows = await dbAll(
      `SELECT day,uptime_ms FROM daily_uptime
       WHERE device=? ORDER BY day DESC LIMIT 7`,
      [bot.device]
    );

    const match = rows.find(
      r => epochSecToLabel(r.day) === yLabel
    );

    if (!match) continue;

    const devRow = await dbGet(
      `SELECT last_seen,status FROM devices WHERE device=?`,
      [bot.device]
    );

    broadcast(
      bot.token,
      buildSlaMessage({
        title: "Yesterday SLA (24h)",
        device: bot.device,
        status: computeLiveStatus(devRow),
        label: yLabel,
        uptimeMs: match.uptime_ms,
      })
    );

    sent[bot.device] = yLabel;
  }
}, MIDNIGHT_CHECK_MS);

/* ---------- START SERVER ---------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port", PORT);
});






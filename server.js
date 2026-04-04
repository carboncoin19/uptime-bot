// ======================================================
// NDONI UPTIME SERVER (Railway)
// REARRANGED FOR AUTO-EDITING — ALL FEATURES PRESERVED
// ======================================================

/* ===================== IMPORTS ===================== */
import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";

/* ===================== CONFIG ===================== */
const PORT = process.env.PORT || 8080;
const DB_FILE = "/data/uptime.db";
const TZ_OFFSET_MS = 3600000; // Nigeria +1

const DAY_MS = 86400000;
const MIDNIGHT_CHECK_MS = 15000;
const DEVICE_STALE_MS = 2 * 60 * 1000;

/* ===================== MULTI BOT CONFIG ===================== */
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

/* ===================== FILESYSTEM ===================== */
if (!fs.existsSync("/data")) fs.mkdirSync("/data", { recursive: true });

/* ===================== APP INIT ===================== */
const app = express();
const __dirname = new URL(".", import.meta.url).pathname;

app.use("/firmware", express.static(path.join(__dirname, "firmware")));
app.use(express.json());
app.get("/", (req, res) => res.status(200).send("OK"));

/* ===================== DATABASE ===================== */
const db = new sqlite3.Database(DB_FILE, err => {
  if (err) console.log("❌ DB error:", err.message);
  else console.log("✅ SQLite ready:", DB_FILE);
});

db.get("PRAGMA journal_mode=WAL;");
let firmwareSchemaReady = false;


/* ===================== DB INIT ===================== */
db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS firmware_control (
      device TEXT PRIMARY KEY,
      update_requested INTEGER DEFAULT 0
    )
  `);

  db.all(`PRAGMA table_info(firmware_control)`, (err, cols) => {
    if (err) return;
    console.log(
  "✅ firmware_control columns:",
  cols.map(c => c.name)
);
const has = name => cols.some(c => c.name === name);

let pending = 0;

if (!has("latest_version")) {
  pending++;
  db.run(
    `ALTER TABLE firmware_control ADD COLUMN latest_version TEXT`,
    () => { if (--pending === 0) firmwareSchemaReady = true; }
  );
}

if (!has("firmware_url")) {
  pending++;
  db.run(
    `ALTER TABLE firmware_control ADD COLUMN firmware_url TEXT`,
    () => { if (--pending === 0) firmwareSchemaReady = true; }
  );
}

if (!has("current_version")) {
  pending++;
  db.run(
    `ALTER TABLE firmware_control ADD COLUMN current_version TEXT`,
    () => { if (--pending === 0) firmwareSchemaReady = true; }
  );
}

if (!has("force_update")) {
  pending++;
  db.run(
    `ALTER TABLE firmware_control ADD COLUMN force_update INTEGER DEFAULT 0`,
    () => { if (--pending === 0) firmwareSchemaReady = true; }
  );
}

// If nothing to migrate, mark ready immediately
if (pending === 0) {
  firmwareSchemaReady = true;
}



  });


  // 3️⃣ Other tables AFTER
     db.run(`
  CREATE TABLE IF NOT EXISTS chats (
    chat_id TEXT,
    bot_token TEXT,
    PRIMARY KEY (chat_id, bot_token)
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
  CREATE TABLE IF NOT EXISTS daily_uptime (
    device TEXT,
    day INTEGER,
    uptime_ms INTEGER,
    PRIMARY KEY (device, day)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS monthly_uptime (
    device TEXT,
    month INTEGER,
    uptime_ms INTEGER,
    PRIMARY KEY (device, month)
  )
`);

});


/* ===================== DB HELPERS ===================== */
const dbRun = (s, p = []) =>
  new Promise((resolve, reject) =>
    db.run(s, p, function (err) {
      if (err) {
        console.error("❌ SQL ERROR:", err.message, s);
        reject(err);
      } else {
        resolve(true);
      }
    })
  );

const dbGet = (s, p = []) => new Promise(r => db.get(s, p, (_, row) => r(row || null)));
const dbAll = (s, p = []) => new Promise(r => db.all(s, p, (_, rows) => r(rows || [])));

/* ===================== TIME HELPERS ===================== */
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

/* ===================== TELEGRAM HELPERS ===================== */
async function tg(token, chat, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    const data = await r.json();
    if (!data.ok) console.error(`❌ TG send failed chat=${chat}:`, data.description);
  } catch (e) {
    console.error(`❌ TG fetch error chat=${chat}:`, e.message);
  }
}

async function broadcast(token, text) {
  const chats = await dbAll(
    `SELECT chat_id FROM chats WHERE bot_token=?`,
    [token]
  );
  for (const c of chats) tg(token, c.chat_id, text);
}

/* ===================== EVENT API ===================== */


// ===================== TEMP DEBUG: LIST ALL DEVICES =====================
// REMOVE AFTER VERIFICATION
app.get("/__debug/devices", async (req, res) => {
  try {
    const devices = await dbAll(
      `SELECT DISTINCT device FROM devices ORDER BY device`
    );

    const daily = await dbAll(
      `SELECT DISTINCT device FROM daily_uptime ORDER BY device`
    );

    const monthly = await dbAll(
      `SELECT DISTINCT device FROM monthly_uptime ORDER BY device`
    );

    res.json({
      devices_table: devices.map(d => d.device),
      daily_uptime_table: daily.map(d => d.device),
      monthly_uptime_table: monthly.map(d => d.device),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===================== CHATS DEBUG =====================
app.get("/__debug/chats", async (req, res) => {
  try {
    const chats = await dbAll("SELECT * FROM chats");
    res.json({ count: chats.length, chats });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===================== TEMP DB DEBUG (REMOVE AFTER USE) =====================
app.get("/__debug/db", async (req, res) => {
  try {
    const devices = await dbAll("SELECT * FROM devices");
    const firmware = await dbAll("SELECT * FROM firmware_control");
    res.json({ devices, firmware });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// ===================== FIRMWARE ROW DIAG =====================
app.get("/__debug/firmware-raw", async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT
         device,
         length(device) AS len,
         hex(device) AS hex,
         latest_version,
         firmware_url
       FROM firmware_control`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// ===================== TEMP OTA FIX (REMOVE AFTER USE) =====================
app.get("/__debug/fix-ota", async (req, res) => {
  if (!firmwareSchemaReady)
    return res.status(503).json({ error: "Firmware schema not ready" });
  console.log("🔥🔥🔥 FIX OTA ENDPOINT HIT 🔥🔥🔥");
  try {
    await dbRun(
      `INSERT INTO firmware_control
       (device, latest_version, firmware_url, update_requested, force_update)
       VALUES (?, ?, ?, 1, 0)
       ON CONFLICT(device)
       DO UPDATE SET
         latest_version = excluded.latest_version,
         firmware_url = excluded.firmware_url,
         update_requested = 1`,
      [
        "NDONI-UPTIME",
        "1.0.5",
        "https://github.com/carboncoin19/esp32-uptime-ota/releases/latest/download/firmware.bin"
      ]
    );

    res.json({ ok: true, message: "OTA fields fixed (UPSERT)" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


/* ===================== EVENT API ===================== */
app.post("/api/event", async (req, res) => {
  console.log("EVENT:", req.body);

  const { device, event, uptime_ms, day, month, time, version } = req.body;
  const now = Date.now();
  const dev = String(device || "").trim().toUpperCase();

  if (!event) return res.json({ ok: true });

  // HEARTBEAT: still update last_seen so /status works
  if (event === "HEARTBEAT") {
    if (dev) {
      
    await dbRun(
  `INSERT INTO devices(device,last_seen)
   VALUES(?,?)
   ON CONFLICT(device)
   DO UPDATE SET last_seen=excluded.last_seen`,
  [dev, now]
);

    // heartbeat only updates last_seen

    // 🔧 ENSURE firmware_control row exists for this device
    await dbRun(
      `INSERT INTO firmware_control(device)
       VALUES(?)
       ON CONFLICT(device) DO NOTHING`,
      [dev]
    );
  }
    return res.json({ ok: true });
  
  }
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

  if (event === "ONLINE" || event === "OFFLINE") {
    const msg =
      `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n` +
      `${dev}\n🕒 ${time || formatTime(now)}`;

    for (const bot of BOTS)
      if (bot.deviceNorm === dev)
        broadcast(bot.token, msg);
  }

  if (event === "FW_REPORT") {
    // Persist firmware version (handle old DB schemas safely)
    await dbRun(
      `INSERT INTO firmware_control(device, current_version)
       VALUES(?,?)
       ON CONFLICT(device)
       DO UPDATE SET current_version=excluded.current_version`,
      [dev, version || "unknown"]
    );
  }

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
      if (bot.deviceNorm === dev)
        broadcast(bot.token, msg);
  }

  if (event === "OTA_FAILED") {
    const msg =
      `❌ OTA UPDATE FAILED\n\n` +
      `📟 ${dev}\n` +
      `🆕 Version: ${version || "unknown"}\n` +
      `🕒 ${time || formatTime(now)}`;

    for (const bot of BOTS)
      if (bot.deviceNorm === dev)
        broadcast(bot.token, msg);
  }

  res.json({ ok: true });
});

/* ===================== OTA CHECK API ===================== */
app.get("/api/fw/:device", async (req, res) => {
  if (!firmwareSchemaReady)
    return res.json({ update: false });
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

  res.json({
    update: true,
    version: row.latest_version,
    url: row.firmware_url,
    force: row.force_update === 1,
    trigger: true
  });
});

/* ===================== TELEGRAM UPDATE HANDLER ===================== */
async function handleUpdate(bot, update) {
  const chat = update.message?.chat?.id;
  const cmd = update.message?.text;

  if (!chat || !cmd) return;

  await dbRun(
    `INSERT OR IGNORE INTO chats(chat_id,bot_token) VALUES(?,?)`,
    [chat, bot.token]
  );

  if (cmd === "/start")
    tg(bot.token, chat, `📡 ${bot.device} uptime monitor active.`);

  if (cmd.startsWith("/update")) {
    console.log("TG /update received:", bot.deviceNorm, cmd);

    const parts = cmd.split(" ");
    const newVersion = parts.slice(1).join(" ").trim();

    if (!newVersion) {
      await tg(bot.token, chat, "❌ Invalid version.\nUsage: /update 1.0.5");
      return;
    }

    const fwUrl =
      "https://github.com/carboncoin19/esp32-uptime-ota/releases/latest/download/firmware.bin";

    await dbRun(
      `INSERT INTO firmware_control
       (device, latest_version, firmware_url, update_requested, force_update)
       VALUES(?,?,?,?,?)
       ON CONFLICT(device)
       DO UPDATE SET
         latest_version=excluded.latest_version,
         firmware_url=excluded.firmware_url,
         update_requested=1,
         force_update=0`,
      [bot.deviceNorm, newVersion, fwUrl, 1, 0]
    );

    await tg(
      bot.token,
      chat,
      "🚀 Update requested\n" +
      "📟 " + bot.device + "\n" +
      "🆕 " + newVersion
    );
    return;
  }

  if (cmd === "/fw") {
    const row = await dbGet(
      `SELECT current_version, latest_version FROM firmware_control WHERE device=?`,
      [bot.device.toUpperCase()]
    );

    tg(
      bot.token,
      chat,
      "📟 " + bot.device + "\n" +
      "Current Device Version: " + (row?.current_version || "Unknown") + "\n" +
      "Latest Server Version: " + (row?.latest_version || "Not set")
    );
  }

  if (cmd === "/status") {
    try {
      const today = todayEpochSec();
      const yLabel = epochSecToLabel(today - 86400);

      const rows = await dbAll(
        `SELECT day,uptime_ms FROM daily_uptime WHERE device=? ORDER BY day DESC LIMIT 7`,
        [bot.deviceNorm]
      );

      const match = rows.find(r => epochSecToLabel(r.day) === yLabel);

      const devRow = await dbGet(
        `SELECT last_seen,status FROM devices WHERE device=?`,
        [bot.deviceNorm]
      );

      if (!match) {
        await tg(
          bot.token,
          chat,
          "⚠️ No DAILY_SYNC for yesterday\n" +
          "📟 " + bot.device + "\n" +
          "📡 Status: " + computeLiveStatus(devRow)
        );
      } else {
        await tg(
          bot.token,
          chat,
          buildSlaMessage({
            title: "Yesterday SLA (24h)",
            device: bot.device,
            status: computeLiveStatus(devRow),
            label: yLabel,
            uptimeMs: match.uptime_ms,
          })
        );
      }
    } catch (e) {
      console.error("/status error:", e);
      await tg(bot.token, chat, "⚠️ Status temporarily unavailable");
    }
  }

  if (cmd === "/statusweek") {
    try {
      const rows = await dbAll(
        `SELECT day, uptime_ms
         FROM daily_uptime
         WHERE device=?
         ORDER BY day DESC
         LIMIT 7`,
        [bot.deviceNorm]
      );

      if (!rows.length) {
        await tg(bot.token, chat, "⚠️ No uptime data for this week.");
        return;
      }

      const ordered = rows.reverse();

      let totalUp = 0;
      for (const r of ordered) totalUp += (r.uptime_ms || 0);

      const expected = ordered.length * DAY_MS;
      const overall = Math.min(100, (totalUp / expected) * 100);

      let text =
        "📈 Weekly SLA Summary\n" +
        "📟 " + bot.device + "\n\n" +
        "Overall SLA: " + overall.toFixed(2) + "%\n" +
        "Total Uptime: " + (totalUp / 3600000).toFixed(2) + "h\n\n";

      for (const r of ordered) {
        const p = slaPercent(r.uptime_ms || 0);
        text +=
          epochSecToLabel(r.day) + " " +
          bar(p) + " " +
          p.toFixed(1) + "%\n";
      }

      await tg(bot.token, chat, text);
    } catch (e) {
      console.error("/statusweek error:", e);
      await tg(bot.token, chat, "⚠️ Weekly status temporarily unavailable");
    }
  }

  if (cmd === "/statusmonth") {
    try {
      const rows = await dbAll(
        `SELECT day, uptime_ms
         FROM daily_uptime
         WHERE device=?
         ORDER BY day DESC
         LIMIT 30`,
        [bot.deviceNorm]
      );

      if (!rows.length) {
        await tg(bot.token, chat, "⚠️ No uptime data for this month.");
        return;
      }

      let totalUp = 0;
      for (const r of rows) totalUp += (r.uptime_ms || 0);

      const expected = rows.length * DAY_MS;
      const sla = Math.min(100, (totalUp / expected) * 100);

      await tg(
        bot.token,
        chat,
        "📉 Monthly SLA Summary\n" +
        "📟 " + bot.device + "\n\n" +
        "Overall SLA: " + sla.toFixed(2) + "%\n" +
        "Total Uptime: " + (totalUp / 3600000).toFixed(2) + "h\n" +
        "Days counted: " + rows.length
      );
    } catch (e) {
      console.error("/statusmonth error:", e);
      await tg(bot.token, chat, "⚠️ Monthly status temporarily unavailable");
    }
  }
}

/* ===================== TELEGRAM WEBHOOK ENDPOINT ===================== */
app.post("/webhook/:token", async (req, res) => {
  res.sendStatus(200);
  const bot = BOTS.find(b => b.token === req.params.token);
  if (!bot) return;
  await handleUpdate(bot, req.body);
});

/* ===================== TELEGRAM WEBHOOK REGISTRATION ===================== */
async function registerWebhook(bot) {
  const baseUrl = process.env.SERVER_BASE_URL || "https://uptime-bot-production-9a37.up.railway.app";
  const webhookUrl = `${baseUrl}/webhook/${bot.token}`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await res.json();
    console.log(`🔗 Webhook for ${bot.device}:`, data.ok ? "✅ OK" : `❌ ${data.description}`);
  } catch (e) {
    console.error(`❌ Webhook registration failed for ${bot.device}:`, e.message);
  }
}

/* ===================== DAILY SLA BROADCAST ===================== */
let sent = {};

setInterval(async () => {
  const now = new Date(Date.now() + TZ_OFFSET_MS);
  const secondsToday = now.getHours() * 3600 + now.getMinutes() * 60;

  if (secondsToday < 25200 || secondsToday > 25800) return;

  for (const bot of BOTS) {
    const yLabel = epochSecToLabel(todayEpochSec() - 86400);
    if (sent[bot.device] === yLabel) continue;

    const rows = await dbAll(
      `SELECT day,uptime_ms FROM daily_uptime
       WHERE device=? ORDER BY day DESC LIMIT 7`,
      [bot.device]
    );

    const match = rows.find(r => epochSecToLabel(r.day) === yLabel);
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

/* ===================== START SERVER ===================== */
app.listen(PORT, "0.0.0.0", () => {
  console.log("🚀 Server running on port", PORT);
  for (const bot of BOTS) registerWebhook(bot);
});




















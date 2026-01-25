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

// NEW: if device hasn't been seen recently => UNKNOWN
const DEVICE_STALE_MS = 2 * 60 * 1000; // 2 minutes
/* ========================================= */

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.log("❌ Failed to open DB:", err.message);
  } else {
    console.log("✅ SQLite DB opened at:", DB_FILE);
  }
});

// stability + concurrency
db.get("PRAGMA journal_mode=WAL;", () => {});

/* ---------- DB INIT ---------- */
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chats(
    chat_id INTEGER PRIMARY KEY
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

/* ---------- DB PROMISE HELPERS ---------- */
function dbGet(sql, params = []) {
  return new Promise((resolve) => {
    db.get(sql, params, (err, row) => {
      if (err) return resolve(null);
      resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve) => {
    db.all(sql, params, (err, rows) => {
      if (err) return resolve([]);
      resolve(rows || []);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve) => {
    db.run(sql, params, function (err) {
      if (err) return resolve(false);
      resolve(true);
    });
  });
}

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
  const now = Date.now() + TZ_OFFSET_MS;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function monthStartEpochSec() {
  const now = Date.now() + TZ_OFFSET_MS;
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function epochSecToLabel(dayEpochSec) {
  const ms = dayEpochSec * 1000;
  return new Date(ms + TZ_OFFSET_MS).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
  });
}

function slaPercent(uptimeMs) {
  return Math.min(100, (uptimeMs / DAY_MS) * 100);
}

function bar(p) {
  const blocks = Math.round((p / 100) * 10);
  return "█".repeat(blocks) + "░".repeat(10 - blocks);
}

/* ---------- LIVE STATUS HELPERS ---------- */
function computeLiveStatus(deviceRow) {
  if (!deviceRow?.last_seen) return "UNKNOWN";

  const age = Date.now() - deviceRow.last_seen;

  // If ESP not seen recently => unreachable
  if (age > DEVICE_STALE_MS) return "UNKNOWN";

  // ESP reachable => show last pin state
  if (deviceRow.status === "ONLINE") return "ONLINE";
  if (deviceRow.status === "OFFLINE") return "OFFLINE";

  return "UNKNOWN";
}

async function getDeviceRow(device) {
  return await dbGet(
    `SELECT device,last_seen,status FROM devices WHERE device=?`,
    [device]
  );
}

/* ---------- TELEGRAM ---------- */
async function tg(chat_id, text) {
  if (!TG_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {}
}

async function broadcast(text) {
  const chats = await dbAll(`SELECT chat_id FROM chats`);
  for (const c of chats) tg(c.chat_id, text);
}

/* ---------- QUERIES ---------- */
async function getDailyUptime(device, dayEpochSec) {
  const row = await dbGet(
    `SELECT uptime_ms FROM daily_uptime WHERE device=? AND day=?`,
    [device, dayEpochSec]
  );
  return row?.uptime_ms ?? null;
}

// ✅ Range-safe lookup (fixes epoch mismatch)
// ✅ Picks the BEST record in the day range (highest uptime_ms)
// This prevents selecting a 0h row when a valid 24h row exists.
async function getDailyUptimeByRange(device, startEpochSec, endEpochSec) {
  return await dbGet(
    `SELECT day, uptime_ms FROM daily_uptime
     WHERE device=? AND day BETWEEN ? AND ?
     ORDER BY uptime_ms DESC, day DESC
     LIMIT 1`,
    [device, startEpochSec, endEpochSec]
  );
}

async function getLastNDays(device, n) {
  return await dbAll(
    `SELECT day, uptime_ms FROM daily_uptime
     WHERE device=?
     ORDER BY day DESC
     LIMIT ?`,
    [device, n]
  );
}

async function getMonthlyUptime(device, monthEpochSec) {
  const row = await dbGet(
    `SELECT uptime_ms FROM monthly_uptime WHERE device=? AND month=?`,
    [device, monthEpochSec]
  );
  return row?.uptime_ms ?? null;
}

async function getDevices() {
  return await dbAll(
    `SELECT device,last_seen,status FROM devices ORDER BY device ASC`
  );
}

/* ---------- DAILY SUMMARY ---------- */
async function buildDailySummaryText(device, dayEpochSec) {
  const up = await getDailyUptime(device, dayEpochSec);

  if (up === null) {
    return (
      `📊 Daily SLA Summary\n` +
      `📟 ${device}\n` +
      `📅 ${epochSecToLabel(dayEpochSec)}\n\n` +
      `⚠️ No DAILY_SYNC data for this day yet.`
    );
  }

  const p = slaPercent(up);
  const hours = up / 3600000;

  return (
    `📊 Daily SLA Summary\n` +
    `📟 ${device}\n` +
    `📅 ${epochSecToLabel(dayEpochSec)}\n\n` +
    `SLA: ${p.toFixed(2)}%\n` +
    `Uptime: ${hours.toFixed(2)}h\n` +
    `${bar(p)}`
  );
}

/* ---------- 7AM SUMMARY SCHEDULER (YESTERDAY ONLY, RANGE SAFE) ---------- */
let lastSummaryKey = null;

async function midnightSchedulerTick() {
  const today = todayEpochSec();
  const yesterday = today - 86400;

  const nowLocal = new Date(Date.now() + TZ_OFFSET_MS);
  const seconds =
    nowLocal.getHours() * 3600 +
    nowLocal.getMinutes() * 60 +
    nowLocal.getSeconds();

  // Send summary only between 07:00:00 and 07:10:00
  if (seconds < 25200 || seconds > 25800) return;

  // Prevent duplicates
  if (lastSummaryKey === yesterday) return;

  // STRICT yesterday only, but tolerate epoch mismatch by using a range search
  const start = yesterday;
  const end = yesterday + 86399;

  const row = await getDailyUptimeByRange(DEFAULT_DEVICE, start, end);
  if (!row) return;

  const msg = await buildDailySummaryText(DEFAULT_DEVICE, row.day);
  await broadcast(msg);

  lastSummaryKey = yesterday;
}

/* ---------- EVENT API ---------- */
app.post("/api/event", async (req, res) => {
  const { device, event, uptime_ms, day, month, time } = req.body;
  const now = Date.now();

  // Update devices table
  if (device) {
    const status = event === "ONLINE" || event === "OFFLINE" ? event : null;

    await dbRun(
      `
      INSERT INTO devices(device,last_seen,status)
      VALUES(?,?,?)
      ON CONFLICT(device)
      DO UPDATE SET last_seen=excluded.last_seen
      `,
      [device, now, status]
    );

    if (status) {
      await dbRun(`UPDATE devices SET status=? WHERE device=?`, [
        status,
        device,
      ]);
    }
  }

  if (event === "HEARTBEAT") {
    return res.json({ ok: true });
  }

  if (event === "DAILY_SYNC") {
    if (device && typeof day === "number") {
      await dbRun(
        `INSERT OR REPLACE INTO daily_uptime(device,day,uptime_ms)
         VALUES(?,?,?)`,
        [device, day, uptime_ms || 0]
      );
    }
  }

  if (event === "MONTHLY_SYNC") {
    if (device && typeof month === "number") {
      await dbRun(
        `INSERT OR REPLACE INTO monthly_uptime(device,month,uptime_ms)
         VALUES(?,?,?)`,
        [device, month, uptime_ms || 0]
      );
    }
  }

  if (event === "ONLINE" || event === "OFFLINE") {
    const msg =
      `${event === "ONLINE" ? "🟢 ONLINE" : "🔴 OFFLINE"}\n` +
      `${device}\n` +
      `🕒 ${time || formatTime(now)}`;

    broadcast(msg);
  }

  res.json({ ok: true });
});

/* ---------- TELEGRAM BOT POLLING ---------- */
let lastId = 0;

async function handleTelegramCommand(chat, cmd) {
  await dbRun(`INSERT OR IGNORE INTO chats(chat_id) VALUES(?)`, [chat]);

  if (cmd === "/start") {
    return tg(
      chat,
      "📡 ESP32 SLA Monitor\n\n" +
        "/status – Yesterday (24h) SLA\n" +
        "/statusweek – Last 7 days chart\n" +
        "/statusmonth – Past 30 days summary\n" +
        "/month – Current month uptime (MONTHLY_SYNC)\n" +
        "/devices – Show devices\n" +
        "/ping – Bot test"
    );
  }

  if (cmd === "/ping") return tg(chat, "✅ Bot is alive.");

  if (cmd === "/devices") {
    const devices = await getDevices();
    if (!devices.length) return tg(chat, "No devices yet.");

    const text =
      "📟 Devices\n\n" +
      devices
        .map((d) => {
          const seen = d.last_seen ? formatTime(d.last_seen) : "never";
          const live = computeLiveStatus(d);
          return `• ${d.device}\n  Status: ${live}\n  Last seen: ${seen}\n`;
        })
        .join("\n");

    return tg(chat, text);
  }

  // ✅ /status = STRICT yesterday only (RANGE SAFE + BEST UPTIME PICK)
  if (cmd === "/status") {
    const today = todayEpochSec();
    const yesterday = today - 86400;

    const start = yesterday;
    const end = yesterday + 86399;

    const row = await getDailyUptimeByRange(DEFAULT_DEVICE, start, end);

    const dev = await getDeviceRow(DEFAULT_DEVICE);
    const liveStatus = computeLiveStatus(dev);

    if (!row) {
      return tg(
        chat,
        `⚠️ No DAILY_SYNC for yesterday yet.\n` +
          `📅 Expected day: ${epochSecToLabel(yesterday)}\n` +
          `📡 Device status: ${liveStatus}\n\n` +
          `This means ESP32 has not uploaded yesterday summary yet.\n` +
          `Try again later or check /statusweek.`
      );
    }

    const up = row.uptime_ms ?? 0;
    const p = slaPercent(up);
    const hours = up / 3600000;

    return tg(
      chat,
      `📊 Yesterday SLA (24h)\n` +
        `📟 ${DEFAULT_DEVICE}\n` +
        `📡 Status: ${liveStatus}\n` +
        `📅 ${epochSecToLabel(yesterday)}\n\n` +
        `SLA: ${p.toFixed(2)}%\n` +
        `Uptime: ${hours.toFixed(2)}h\n` +
        `${bar(p)}`
    );
  }

  // 7 DAYS CHART
  if (cmd === "/statusweek") {
    const rows = await getLastNDays(DEFAULT_DEVICE, 7);
    if (!rows.length) return tg(chat, "⚠️ No uptime history yet.");

    const ordered = [...rows].reverse();
    let text = `📈 Last 7 Days SLA\n📟 ${DEFAULT_DEVICE}\n\n`;

    for (const r of ordered) {
      const p = slaPercent(r.uptime_ms || 0);
      const h = (r.uptime_ms || 0) / 3600000;
      text += `${epochSecToLabel(r.day)}  ${bar(p)}  ${p.toFixed(1)}%  (${h.toFixed(1)}h)\n`;
    }
    return tg(chat, text);
  }

  // PAST 30 DAYS SUMMARY
  if (cmd === "/statusmonth") {
    const rows = await getLastNDays(DEFAULT_DEVICE, 30);
    if (!rows.length) return tg(chat, "⚠️ No uptime history yet.");

    const avgSla =
      rows.reduce((s, r) => s + slaPercent(r.uptime_ms || 0), 0) / rows.length;

    const totalHours =
      rows.reduce((s, r) => s + (r.uptime_ms || 0), 0) / 3600000;

    const mini = [...rows].slice(0, 10).reverse();

    let text =
      `📉 Past 30 Days Summary\n` +
      `📟 ${DEFAULT_DEVICE}\n\n` +
      `Average SLA: ${avgSla.toFixed(2)}%\n` +
      `Total Uptime (30 days): ${totalHours.toFixed(2)}h\n` +
      `Days counted: ${rows.length}\n\n` +
      `📊 Last 10 days:\n`;

    for (const r of mini) {
      const p = slaPercent(r.uptime_ms || 0);
      text += `${epochSecToLabel(r.day)} ${bar(p)} ${p.toFixed(1)}%\n`;
    }

    return tg(chat, text);
  }

  // MONTHLY_SYNC SUMMARY
  if (cmd === "/month") {
    const m = monthStartEpochSec();
    const up = await getMonthlyUptime(DEFAULT_DEVICE, m);

    if (up === null) {
      return tg(
        chat,
        "⚠️ No MONTHLY_SYNC data yet.\nIt will appear after ESP32 sends MONTHLY_SYNC."
      );
    }

    const hours = up / 3600000;
    const daysSoFar = Math.max(
      1,
      Math.floor((Date.now() + TZ_OFFSET_MS - m * 1000) / DAY_MS)
    );
    const expected = daysSoFar * DAY_MS;
    const sla = Math.min(100, (up / expected) * 100);

    return tg(
      chat,
      `🗓️ Monthly Uptime (MONTHLY_SYNC)\n` +
        `📟 ${DEFAULT_DEVICE}\n\n` +
        `Month start epoch: ${m}\n` +
        `Uptime: ${hours.toFixed(2)}h\n` +
        `SLA so far: ${sla.toFixed(2)}%`
    );
  }

  if (cmd.startsWith("/")) return tg(chat, "Unknown command. Type /start");
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

    if (!chat || !cmd) continue;
    await handleTelegramCommand(chat, cmd);
  }
}, TG_POLL_MS);

/* ---------- 7AM SUMMARY LOOP ---------- */
setInterval(() => {
  midnightSchedulerTick().catch(() => {});
}, MIDNIGHT_CHECK_MS);

/* ---------- START SERVER ---------- */
app.listen(PORT, () => console.log("🚀 Server running on", PORT));

import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";

const DEVICE_TIMEOUT_MS = 2 * 60 * 1000;
const TZ_OFFSET_MS = 3600000;

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      device TEXT PRIMARY KEY,
      last_seen INTEGER,
      status TEXT
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

/* ---------- HELPERS ---------- */
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

/* ---------- EVENT API ---------- */
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

  // 🔥 APPLY BUFFERED UPTIME
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

  if (event === "OFFLINE") openOutage(device, now);
  if (event === "ONLINE") closeOutage(device, now);

  res.json({ ok: true });
});

app.listen(PORT, () =>
  console.log("🚀 Server running on", PORT)
);

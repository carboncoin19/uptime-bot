import express from "express";
import sqlite3 from "sqlite3";

const app = express();
app.use(express.json());

const db = new sqlite3.Database("/data/uptime.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS daily_uptime (
      device TEXT,
      date TEXT,
      uptime_ms INTEGER
    )
  `);
});

/* ---------- EVENT API ---------- */
app.post("/api/event", (req, res) => {
  const { device, event, time, uptime_ms } = req.body;
  if (!device || !event) return res.status(400).end();

  const today = new Date().toISOString().slice(0, 10);

  if (event === "DAILY_SYNC" && uptime_ms !== undefined) {
    db.run(`
      INSERT INTO daily_uptime (device,date,uptime_ms)
      VALUES (?,?,?)
    `, [device, today, uptime_ms]);

    return res.json({ ok: true });
  }

  return res.json({ ok: true });
});

/* ---------- START ---------- */
app.listen(8080, () => console.log("🚀 Server running"));

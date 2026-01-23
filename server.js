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
/* ========================================= */

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_FILE);

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
});

/* ---------- DB PROMISE HELPERS ---------- */
function dbGet(sql, params = []) {
  return new Promise((resolve) => {
    db.get(sql, params, (_, row) => resolve(row));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve) => {
    db.all(sql, params, (_, rows) => resolve(rows || []));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve) => {
    db.run(sql, params, () => resolve(true));
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
  const c

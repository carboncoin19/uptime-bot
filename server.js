import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 8080;

const DB_FILE = "/data/uptime.db";
const TZ_OFFSET_MS = 3600000;

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
    BOTS.push({ token, device, lastId: 0 });
  }
}
/* ================================= */

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_FILE);
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
});

/* ---------- DB HELPERS ---------- */
const dbGet = (q, p=[]) => new Promise(r => db.get(q,p,(_,row)=>r(row||null)));
const dbAll = (q, p=[]) => new Promise(r => db.all(q,p,(_,rows)=>r(rows||[])));
const dbRun = (q, p=[]) => new Promise(r => db.run(q,p,e=>r(!e)));

/* ---------- TIME ---------- */
const todayEpochSec = () => {
  const d = new Date(Date.now()+TZ_OFFSET_MS);
  d.setHours(0,0,0,0);
  return Math.floor(d.getTime()/1000);
};

const monthStartEpochSec = () => {
  const d = new Date(Date.now()+TZ_OFFSET_MS);
  d.setDate(1); d.setHours(0,0,0,0);
  return Math.floor(d.getTime()/1000);
};

const epochSecToLabel = s =>
  new Date(s*1000+TZ_OFFSET_MS).toLocaleDateString("en-US",{month:"short",day:"2-digit"});

const slaPercent = up => Math.min(100, (up/DAY_MS)*100);
const totalSlaPercent = (u,p)=>p?Math.min(100,(u/p)*100):0;
const bar = p => "█".repeat(Math.round(p/10))+"░".repeat(10-Math.round(p/10));

/* ---------- LIVE STATUS ---------- */
const computeLiveStatus = d => {
  if (!d?.last_seen) return "UNKNOWN";
  if (Date.now()-d.last_seen>DEVICE_STALE_MS) return "UNKNOWN";
  return d.status||"UNKNOWN";
};

/* ---------- TELEGRAM ---------- */
const tg = (token, chat, text) =>
  fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ chat_id:chat, text })
  }).catch(()=>{});

const broadcast = async (token, text) => {
  const chats = await dbAll(`SELECT chat_id FROM chats WHERE bot_token=?`,[token]);
  chats.forEach(c => tg(token,c.chat_id,text));
};

/* ---------- EVENT API ---------- */
app.post("/api/event", async (req,res)=>{
  const { device,event,uptime_ms,day,month,time } = req.body;
  const now = Date.now();

  if(device){
    const status = event==="ONLINE"||event==="OFFLINE"?event:null;
    await dbRun(`
      INSERT INTO devices(device,last_seen,status)
      VALUES(?,?,?)
      ON CONFLICT(device)
      DO UPDATE SET last_seen=excluded.last_seen
    `,[device,now,status]);
    if(status) await dbRun(`UPDATE devices SET status=? WHERE device=?`,[status,device]);
  }

  if(event==="DAILY_SYNC")
    await dbRun(`INSERT OR REPLACE INTO daily_uptime VALUES(?,?,?)`,
      [device,day,uptime_ms||0]);

  if(event==="MONTHLY_SYNC")
    await dbRun(`INSERT OR REPLACE INTO monthly_uptime VALUES(?,?,?)`,
      [device,month,uptime_ms||0]);

  if(event==="ONLINE"||event==="OFFLINE"){
    for(const b of BOTS)
      if(b.device===device)
        broadcast(b.token,
          `${event==="ONLINE"?"🟢 ONLINE":"🔴 OFFLINE"}\n${device}\n🕒 ${time||new Date(now).toLocaleString()}`);
  }

  res.json({ok:true});
});

/* ---------- TELEGRAM POLLING ---------- */
for(const bot of BOTS){
  setInterval(async ()=>{
    const r = await fetch(
      `https://api.telegram.org/bot${bot.token}/getUpdates?offset=${bot.lastId+1}`
    ).then(r=>r.json()).catch(()=>null);
    if(!r?.ok) return;

    for(const u of r.result){
      bot.lastId = u.update_id;
      const chat = u.message?.chat?.id;
      const cmd  = u.message?.text;
      if(!chat||!cmd) continue;

      await dbRun(`INSERT OR IGNORE INTO chats VALUES(?,?)`,[chat,bot.token]);

      /* ---------- ORIGINAL COMMANDS ---------- */

      if(cmd==="/start")
        tg(bot.token,chat,
          `📡 Uptime Monitor\n\n/status\n/statusweek\n/statusmonth\n/month`);

      if(cmd==="/status"){
        const y = todayEpochSec()-86400;
        const r = await dbGet(`SELECT uptime_ms FROM daily_uptime WHERE device=? AND day=?`,
          [bot.device,y]);
        if(!r) return tg(bot.token,chat,"⚠️ No DAILY_SYNC yet.");
        const p = slaPercent(r.uptime_ms||0);
        tg(bot.token,chat,
          `📊 Yesterday SLA\n📟 ${bot.device}\n📅 ${epochSecToLabel(y)}\n\nSLA: ${p.toFixed(2)}%\n${bar(p)}`);
      }

      if(cmd==="/statusweek"){
        const rows = await dbAll(`SELECT * FROM daily_uptime WHERE device=? ORDER BY day DESC LIMIT 7`,
          [bot.device]);
        let t=`📈 Last 7 Days SLA\n📟 ${bot.device}\n\n`;
        rows.reverse().forEach(r=>{
          const p=slaPercent(r.uptime_ms||0);
          t+=`${epochSecToLabel(r.day)} ${bar(p)} ${p.toFixed(1)}%\n`;
        });
        tg(bot.token,chat,t);
      }

      if(cmd==="/statusmonth"){
        const rows = await dbAll(`SELECT * FROM daily_uptime WHERE device=? ORDER BY day DESC LIMIT 30`,
          [bot.device]);
        const totalUp = rows.reduce((s,r)=>s+(r.uptime_ms||0),0);
        tg(bot.token,chat,
          `📉 Past 30 Days\n📟 ${bot.device}\nTotal Uptime %: ${totalSlaPercent(totalUp,rows.length*DAY_MS).toFixed(2)}%`);
      }

      if(cmd==="/month"){
        const m = monthStartEpochSec();
        const r = await dbGet(`SELECT uptime_ms FROM monthly_uptime WHERE device=? AND month=?`,
          [bot.device,m]);
        if(!r) return tg(bot.token,chat,"⚠️ No MONTHLY_SYNC yet.");
        tg(bot.token,chat,
          `🗓️ Monthly Summary\n📟 ${bot.device}\nUptime: ${(r.uptime_ms/3600000).toFixed(2)}h`);
      }
    }
  }, TG_POLL_MS);
}

/* ---------- SCHEDULER ---------- */
setInterval(async ()=>{
  const y = todayEpochSec()-86400;
  for(const b of BOTS){
    const msg = await dbGet(`SELECT uptime_ms FROM daily_uptime WHERE device=? AND day=?`,
      [b.device,y]);
    if(msg) broadcast(b.token,
      `📊 Daily Summary\n📟 ${b.device}\nSLA: ${slaPercent(msg.uptime_ms).toFixed(2)}%`);
  }
}, MIDNIGHT_CHECK_MS);

/* ---------- START ---------- */
app.listen(PORT, ()=>console.log("🚀 Server running on",PORT));

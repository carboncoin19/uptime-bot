import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

const PORT = process.env.PORT || 8080;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const DB_FILE = "/data/uptime.db";

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB_FILE);

/* ---------- DB ---------- */
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    device TEXT PRIMARY KEY,
    last_seen INTEGER,
    status TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chats (
    chat_id INTEGER PRIMARY KEY
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS daily_uptime (
    device TEXT,
    day TEXT,
    uptime_ms INTEGER,
    PRIMARY KEY (device, day)
  )`);
});

/* ---------- TIME ---------- */
function formatTime(ms) {
  return new Date(ms + 3600000).toLocaleString("en-US", {
    month:"short", day:"2-digit", year:"numeric",
    hour:"numeric", minute:"2-digit", second:"2-digit",
    hour12:true
  });
}

/* ---------- TELEGRAM ---------- */
async function sendTelegram(chatId, text) {
  if (!TG_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ chat_id:chatId, text })
  }).catch(()=>{});
}

function broadcast(text) {
  db.all(`SELECT chat_id FROM chats`, (_, rows) =>
    rows?.forEach(r => sendTelegram(r.chat_id, text))
  );
}

/* ---------- SLA ---------- */
function slaPct(ms){ return Math.min(100,(ms/86400000)*100); }

function avgSla(device, days){
  return new Promise(resolve=>{
    db.all(`
      SELECT uptime_ms FROM daily_uptime
      WHERE device=?
      ORDER BY day DESC LIMIT ?
    `,[device,days],(_,rows)=>{
      if(!rows.length) return resolve(0);
      resolve(rows.reduce((s,r)=>s+slaPct(r.uptime_ms),0)/rows.length);
    });
  });
}

/* ---------- EVENT API ---------- */
app.post("/api/event",(req,res)=>{
  const { device,event,time,uptime_ms } = req.body;
  if(!device||!event||!time) return res.status(400).end();

  const now=Date.now();

  db.run(`
    INSERT INTO devices(device,last_seen,status)
    VALUES(?,?,?)
    ON CONFLICT(device)
    DO UPDATE SET last_seen=?,status=excluded.status
  `,[device,now,"ONLINE",now]);

  if(event==="DAILY_SYNC"){
    const day=new Date(now).toISOString().slice(0,10);
    db.run(`
      INSERT OR REPLACE INTO daily_uptime(device,day,uptime_ms)
      VALUES(?,?,?)
    `,[device,day,uptime_ms||0]);
    return res.json({ok:true});
  }

  if(event==="ONLINE"||event==="OFFLINE"){
    db.run(`UPDATE devices SET status=? WHERE device=?`,
      [event,device]);
    broadcast(`${event==="ONLINE"?"🟢 ONLINE":"🔴 OFFLINE"}\n${device}\n🕒 ${formatTime(now)}`);
  }

  res.json({ok:true});
});

/* ---------- TELEGRAM COMMANDS ---------- */
let lastUpdateId=0;
setInterval(async()=>{
  const r=await fetch(
    `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}`
  ).then(r=>r.json()).catch(()=>null);
  if(!r?.ok) return;

  for(const u of r.result){
    lastUpdateId=u.update_id;
    if(!u.message?.text) continue;
    const chatId=u.message.chat.id;
    const cmd=u.message.text.toLowerCase();
    db.run(`INSERT OR IGNORE INTO chats VALUES(?)`,[chatId]);

    if(cmd==="/status")
      sendTelegram(chatId,`📊 24H SLA\n${(await avgSla("KAINJI-Uptime",1)).toFixed(2)}%`);
    else if(cmd==="/statusweek")
      sendTelegram(chatId,`📈 WEEK SLA\n${(await avgSla("KAINJI-Uptime",7)).toFixed(2)}%`);
    else if(cmd==="/statusmonth")
      sendTelegram(chatId,`📉 MONTH SLA\n${(await avgSla("KAINJI-Uptime",30)).toFixed(2)}%`);
  }
},5000);

/* ---------- START ---------- */
app.listen(PORT,()=>console.log("🚀 Server running on",PORT));

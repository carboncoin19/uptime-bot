import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

const PORT=process.env.PORT||8080;
const TG_BOT_TOKEN=process.env.TG_BOT_TOKEN;
const DB_FILE="/data/uptime.db";
const TZ_OFFSET_MS=3600000;

const app=express();
app.use(express.json());
const db=new sqlite3.Database(DB_FILE);

/* ---------- DB ---------- */
db.serialize(()=>{
  db.run(`CREATE TABLE IF NOT EXISTS chats(chat_id INTEGER PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS daily_uptime(
    device TEXT, day INTEGER, uptime_ms INTEGER,
    PRIMARY KEY(device,day)
  )`);
});

/* ---------- TIME ---------- */
function formatTime(ms){
  return new Date(ms+TZ_OFFSET_MS).toLocaleString("en-US",{
    month:"short",day:"2-digit",year:"numeric",
    hour:"numeric",minute:"2-digit",second:"2-digit",hour12:true
  });
}

/* ---------- TELEGRAM ---------- */
async function tg(chat,text){
  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:chat,text})
  }).catch(()=>{});
}

function broadcast(text){
  db.all(`SELECT chat_id FROM chats`,(_,r)=>r?.forEach(x=>tg(x.chat_id,text)));
}

/* ---------- SLA ---------- */
const DAY_MS=86400000;
const sla=ms=>Math.min(100,(ms/DAY_MS)*100);

function avg(device,days){
  return new Promise(res=>{
    db.all(`
      SELECT uptime_ms FROM daily_uptime
      WHERE device=? ORDER BY day DESC LIMIT ?
    `,[device,days],(_,r)=>{
      if(!r?.length) return res(0);
      res(r.reduce((s,x)=>s+sla(x.uptime_ms),0)/r.length);
    });
  });
}

/* ---------- EVENT API ---------- */
app.post("/api/event",(req,res)=>{
  const {device,event,uptime_ms,day,time}=req.body;

  if(event==="DAILY_SYNC"){
    db.run(`
      INSERT OR REPLACE INTO daily_uptime(device,day,uptime_ms)
      VALUES(?,?,?)
    `,[device,day,uptime_ms||0]);
  }

  if(event==="ONLINE"||event==="OFFLINE"){
    broadcast(
      `${event==="ONLINE"?"🟢 ONLINE":"🔴 OFFLINE"}\n`+
      `${device}\n🕒 ${time||formatTime(Date.now())}`
    );
  }

  res.json({ok:true});
});

/* ---------- TELEGRAM COMMANDS ---------- */
let lastId=0;
setInterval(async()=>{
  const r=await fetch(
    `https://api.telegram.org/bot${TG_BOT_TOKEN}/getUpdates?offset=${lastId+1}`
  ).then(r=>r.json()).catch(()=>null);
  if(!r?.ok) return;

  for(const u of r.result){
    lastId=u.update_id;
    const chat=u.message?.chat.id;
    const cmd=u.message?.text;
    if(!chat||!cmd) continue;

    db.run(`INSERT OR IGNORE INTO chats VALUES(?)`,[chat]);

    if(cmd==="/start"){
      tg(chat,
        "📡 ESP32 SLA Monitor\n\n"+
        "/status – 24h SLA\n"+
        "/statusweek – 7 day SLA\n"+
        "/statusmonth – 30 day SLA"
      );
    }
    if(cmd==="/status") tg(chat,`📊 24H SLA\n${(await avg("KAINJI-Uptime",1)).toFixed(2)}%`);
    if(cmd==="/statusweek") tg(chat,`📈 7 DAY SLA\n${(await avg("KAINJI-Uptime",7)).toFixed(2)}%`);
    if(cmd==="/statusmonth") tg(chat,`📉 30 DAY SLA\n${(await avg("KAINJI-Uptime",30)).toFixed(2)}%`);
  }
},5000);

/* ---------- START ---------- */
app.listen(PORT,()=>console.log("🚀 Server running",PORT));

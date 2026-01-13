import express from "express";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

const PORT = process.env.PORT || 8080;
const TG = process.env.TG_BOT_TOKEN;
const DB = "/data/uptime.db";
const ADMIN = [1621660251];

let lastUpdateId = 0;
let currentStatus = "UNKNOWN";

const app = express();
app.use(express.json());

const db = new sqlite3.Database(DB);
db.serialize(()=>{
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    device TEXT, event TEXT, time TEXT, day_pct REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY)`);
});

async function tg(chat,text){
  await fetch(`https://api.telegram.org/bot${TG}/sendMessage`,{
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({chat_id:chat,text})
  }).catch(()=>{});
}

function broadcast(msg){
  db.all(`SELECT chat_id FROM chats`,(_,r)=>r.forEach(c=>tg(c.chat_id,msg)));
}

function summary(days){
  return new Promise(res=>{
    db.all(`
      SELECT event, created_at FROM events
      WHERE created_at >= datetime('now','-${days} days')
    `,(_,rows)=>{
      let d=0,c=0,l=null;
      rows.forEach(r=>{
        const t=new Date(r.created_at).getTime();
        if(r.event==="OFFLINE"){c++;l=t;}
        if(r.event==="ONLINE"&&l){d+=t-l;l=null;}
      });
      res({c,h:Math.floor(d/3600000),m:Math.floor(d%3600000/60000)});
    });
  });
}

function uptime(days){
  return new Promise(res=>{
    db.get(`
      SELECT AVG(day_pct)p FROM events
      WHERE created_at >= datetime('now','-${days} days')
    `,(_,r)=>res(r?.p||0));
  });
}

app.post("/api/event",(req,res)=>{
  const {device,event,time,day_pct,state}=req.body;
  if(!device||!event||!time)return res.sendStatus(400);

  if(event==="STATE_SYNC"){
    // DO NOT override real state
    return res.json({ok:true});
  }

  db.run(`INSERT INTO events(device,event,time,day_pct)
          VALUES(?,?,?,?)`,
          [device,event,time,day_pct||0]);

  if(event==="ONLINE"||event==="OFFLINE"){
    currentStatus=event;
    broadcast(`${event==="ONLINE"?"🟢":"🔴"} ${device} ${event}\n🕒 ${time}`);
  }

  res.json({ok:true});
});

setInterval(async()=>{
  const r=await fetch(`https://api.telegram.org/bot${TG}/getUpdates?offset=${lastUpdateId+1}`)
    .then(r=>r.json()).catch(()=>null);
  if(!r?.ok)return;

  for(const u of r.result){
    lastUpdateId=u.update_id;
    if(!u.message?.text)continue;
    const chat=u.message.chat.id;
    const t=u.message.text.toLowerCase();
    db.run(`INSERT OR IGNORE INTO chats VALUES (?)`,[chat]);

    if(t.includes("status")){
      const d=await summary(1), w=await summary(7), m=await summary(30);
      const p1=await uptime(1), p7=await uptime(7), p30=await uptime(30);
      tg(chat,
`📊 STATUS SUMMARY

Current: ${currentStatus}

Daily: ${p1.toFixed(2)}% | Offline ${d.c} (${d.h}h ${d.m}m)
Weekly: ${p7.toFixed(2)}% | Offline ${w.c}
Monthly: ${p30.toFixed(2)}% | Offline ${m.c}`);
    }

    if(t.includes("reset") && ADMIN.includes(chat)){
      db.run(`DELETE FROM events`);
      currentStatus="UNKNOWN";
      tg(chat,"♻️ RESET DONE\nWaiting for device sync…");
    }
  }
},5000);

app.listen(PORT,()=>console.log("🚀 Server running",PORT));

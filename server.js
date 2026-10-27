
const express=require("express");
const http=require("http");
const WebSocket=require("ws");
const crypto=require("crypto");

const app=express();
const server=http.createServer(app);
const wss=new WebSocket.Server({server});
const PORT=process.env.PORT||3000;

app.use(express.static("public"));
app.get("/health",(_,res)=>res.json({ok:true,game:"AI WORLD 3D"}));

const players=new Map();
const sockets=new Map();
const builds=new Map();

const BUILD_TYPES=["block","wall","tree","lamp","bench","house"];

const npcs=[
 {id:"npc-1",name:"Мира",x:240,y:180,color:"#f0a85a",hp:100,tx:240,ty:180,grabbedBy:null},
 {id:"npc-2",name:"Роб",x:430,y:350,color:"#a78bfa",hp:100,tx:430,ty:350,grabbedBy:null},
 {id:"npc-3",name:"Кекс",x:760,y:220,color:"#5eead4",hp:100,tx:760,ty:220,grabbedBy:null},
 {id:"npc-4",name:"Луна",x:930,y:460,color:"#fb7185",hp:100,tx:930,ty:460,grabbedBy:null}
];

const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const clean=(s,max=180)=>String(s??"").replace(/[<>]/g,"").trim().slice(0,max);

function send(ws,data){
 if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data));
}

function broadcast(data){
 const raw=JSON.stringify(data);
 for(const ws of sockets.values()){
  if(ws.readyState===WebSocket.OPEN)ws.send(raw);
 }
}

function publicPlayer(p){
 return {
  id:p.id,
  name:p.name,
  x:p.x,
  y:p.y,
  color:p.color,
  hp:p.hp,
  grabbedBy:p.grabbedBy
 };
}

function snapshot(){
 return {
  type:"snapshot",
  players:[...players.values()].map(publicPlayer),
  npcs,
  builds:[...builds.values()]
 };
}

wss.on("connection",ws=>{
 const id=crypto.randomUUID();
 const colors=["#7dd3fc","#f9a8d4","#86efac","#fde68a","#c4b5fd"];

 const p={
  id,
  name:"Игрок-"+id.slice(0,4),
  x:550+Math.random()*100,
  y:300+Math.random()*100,
  color:colors[Math.floor(Math.random()*colors.length)],
  hp:100,
  grabbedBy:null,
  grabTarget:null,
  lastMove:0
 };

 players.set(id,p);
 sockets.set(id,ws);

 send(ws,{
  type:"welcome",
  id,
  self:publicPlayer(p),
  players:[...players.values()].map(publicPlayer),
  npcs,
  builds:[...builds.values()]
 });

 broadcast({type:"player-joined",player:publicPlayer(p)});

 ws.on("message",buffer=>{
  let m;

  try{
   m=JSON.parse(buffer.toString());
  }catch{
   return;
  }

  const me=players.get(id);
  if(!me||!m||typeof m.type!=="string")return;

  if(m.type==="move"){
   if(Date.now()-me.lastMove<25||me.grabbedBy)return;

   me.lastMove=Date.now();
   me.x=clamp(Number(m.x)||me.x,28,1172);
   me.y=clamp(Number(m.y)||me.y,28,672);

   broadcast({
    type:"player-moved",
    id,
    x:me.x,
    y:me.y
   });
  }

  if(m.type==="rename"){
   const name=clean(m.name,18);
   if(!name)return;

   me.name=name;

   broadcast({
    type:"player-updated",
    player:publicPlayer(me)
   });
  }

  if(m.type==="build"){
   if(builds.size>=300){
    send(ws,{
     type:"notice",
     text:"Достигнут лимит построек."
    });
    return;
   }

   const buildType=String(m.buildType||"");
   const x=Number(m.x);
   const y=Number(m.y);
   const z=Number(m.z);

   if(!BUILD_TYPES.includes(buildType))return;

   if(
    !Number.isFinite(x)||
    !Number.isFinite(y)||
    !Number.isFinite(z)
   )return;

   if(Math.abs(x)>70||Math.abs(z)>70||y<0||y>30)return;

   const build={
    id:crypto.randomUUID(),
    ownerId:id,
    ownerName:me.name,
    buildType,
    x,
    y,
    z
   };

   builds.set(build.id,build);

   broadcast({
    type:"build-added",
    build
   });
  }

  if(m.type==="remove-build"){
   const build=builds.get(String(m.buildId||""));
   if(!build)return;

   if(build.ownerId!==id&&build.ownerName!==me.name){
    send(ws,{
     type:"notice",
     text:"Можно удалять только свои постройки."
    });
    return;
   }

   builds.delete(build.id);

   broadcast({
    type:"build-removed",
    buildId:build.id
   });
  }

  if(m.type==="clear-my-builds"){
   const removed=[];

   for(const [buildId,build] of builds){
    if(build.ownerId===id||build.ownerName===me.name){
     builds.delete(buildId);
     removed.push(buildId);
    }
   }

   broadcast({
    type:"builds-removed",
    buildIds:removed
   });

   send(ws,{
    type:"notice",
    text:"Твои постройки удалены: "+removed.length
   });
  }

  if(m.type==="chat"){
   const text=clean(m.text);

   if(text){
    broadcast({
     type:"chat",
     from:me.name,
     fromId:id,
     text
    });
   }
  }

  if(m.type==="action"){
   const target=players.get(m.targetId)||
    npcs.find(n=>n.id===m.targetId);

   if(!target||target.id===id)return;

   if(Math.hypot(target.x-me.x,target.y-me.y)>150){
    send(ws,{
     type:"notice",
     text:"Подойди поближе к персонажу."
    });
    return;
   }

   if(m.action==="heal"){
    target.hp=clamp((target.hp??100)+25,0,100);
   }else if(m.action==="hit"){
    target.hp=clamp((target.hp??100)-10,0,100);
   }else if(m.action==="grab"){
    if(target.grabbedBy)return;

    target.grabbedBy=id;
    me.grabTarget=target.id;
   }else if(m.action==="release"){
    const held=players.get(me.grabTarget)||
     npcs.find(n=>n.id===me.grabTarget);

    if(!held){
     send(ws,{
      type:"notice",
      text:"Ты никого не удерживаешь."
     });
     return;
    }

    held.grabbedBy=null;
    me.grabTarget=null;

    broadcast({
     type:"grab-state",
     targetId:held.id,
     grabbedBy:null
    });

    return;
   }

   broadcast({
    type:"grab-state",
    targetId:target.id,
    grabbedBy:target.grabbedBy||null
   });

   if(players.has(target.id)){
    broadcast({
     type:"player-updated",
     player:publicPlayer(target)
    });
   }else{
    broadcast({
     type:"npc-update",
     npcs
    });
   }
  }
 });

 ws.on("close",()=>{
  if(me.grabTarget){
   const held=players.get(me.grabTarget)||
    npcs.find(n=>n.id===me.grabTarget);

   if(held)held.grabbedBy=null;
  }

  for(const other of players.values()){
   if(other.grabTarget===id)other.grabTarget=null;
  }

  players.delete(id);
  sockets.delete(id);

  broadcast({
   type:"player-left",
   id,
   name:p.name
  });
 });
});

setInterval(()=>{
 for(const npc of npcs){
  if(npc.grabbedBy){
   const holder=players.get(npc.grabbedBy);

   if(holder){
    npc.x=holder.x+20;
    npc.y=holder.y+20;
   }

   continue;
  }

  if(
   Math.random()<.025||
   Math.hypot(npc.tx-npc.x,npc.ty-npc.y)<8
  ){
   npc.tx=60+Math.random()*1080;
   npc.ty=60+Math.random()*580;
  }

  const dx=npc.tx-npc.x;
  const dy=npc.ty-npc.y;
  const d=Math.hypot(dx,dy)||1;

  npc.x=clamp(npc.x+dx/d*1.2,28,1172);
  npc.y=clamp(npc.y+dy/d*1.2,28,672);
 }

 broadcast({
  type:"npc-update",
  npcs
 });
},80);

server.listen(PORT,"0.0.0.0",()=>{
 console.log("AI WORLD 3D запущен на порту "+PORT);
});

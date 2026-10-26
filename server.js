
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_, res) => res.json({ ok: true, game: "AI WORLD" }));

const players = new Map();
const sockets = new Map();

const npcs = [
  { id: "npc-1", name: "Мира", x: 240, y: 180, color: "#f0a85a", tx: 240, ty: 180 },
  { id: "npc-2", name: "Роб", x: 430, y: 350, color: "#a78bfa", tx: 430, ty: 350 },
  { id: "npc-3", name: "Кекс", x: 760, y: 220, color: "#5eead4", tx: 760, ty: 220 },
  { id: "npc-4", name: "Луна", x: 930, y: 460, color: "#fb7185", tx: 930, ty: 460 }
];

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data) {
  const raw = JSON.stringify(data);
  for (const ws of sockets.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
}

function clean(value, max = 180) {
  return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, max);
}

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, x: p.x, y: p.y,
    color: p.color, hp: p.hp, grabbedBy: p.grabbedBy
  };
}

function snapshot() {
  return {
    type: "snapshot",
    players: [...players.values()].map(publicPlayer),
    npcs
  };
}

wss.on("connection", ws => {
  const id = crypto.randomUUID();
  const colors = ["#7dd3fc", "#f9a8d4", "#86efac", "#fde68a", "#c4b5fd"];

  const p = {
    id,
    name: "Игрок-" + id.slice(0, 4),
    x: 550 + Math.random() * 100,
    y: 300 + Math.random() * 100,
    color: colors[Math.floor(Math.random() * colors.length)],
    hp: 100,
    grabbedBy: null,
    grabTarget: null,
    lastMove: 0
  };

  players.set(id, p);
  sockets.set(id, ws);

  send(ws, { type: "welcome", id, self: publicPlayer(p), ...snapshot() });
  broadcast({ type: "player-joined", player: publicPlayer(p) });

  ws.on("message", buffer => {
    let m;
    try {
      m = JSON.parse(buffer.toString());
    } catch {
      return;
    }

    const me = players.get(id);
    if (!me || !m || typeof m.type !== "string") return;

    if (m.type === "move") {
      if (Date.now() - me.lastMove < 25 || me.grabbedBy) return;
      me.lastMove = Date.now();
      me.x = clamp(Number(m.x) || me.x, 28, 1172);
      me.y = clamp(Number(m.y) || me.y, 28, 672);
      broadcast({ type: "player-moved", id, x: me.x, y: me.y });
    }

    if (m.type === "rename") {
      const name = clean(m.name, 18);
      if (!name) return;
      me.name = name;
      broadcast({ type: "player-updated", player: publicPlayer(me) });
    }

    if (m.type === "chat") {
      const text = clean(m.text);
      if (text) broadcast({
        type: "chat", from: me.name, fromId: id, text
      });
    }

    if (m.type === "npc-chat") {
      const npc = npcs.find(n => n.id === m.npcId);
      const text = clean(m.text);
      if (!npc || !text) return;

      broadcast({
        type: "chat", from: me.name,
        text: "→ " + npc.name + ": " + text
      });

      const lower = text.toLowerCase();
      let reply;

      if (/привет|здравств|хай|hello|hi\b/.test(lower)) {
        reply = `Привет, ${me.name}! Рад тебя видеть!`;
      } else if (/как дела|как ты/.test(lower)) {
        reply = "У меня всё хорошо! Гуляю по этому миру.";
      } else if (/помощ|что делать|куда идти/.test(lower)) {
        reply = "Исследуй карту, общайся с игроками и открывай новые места!";
      } else if (/имя|зовут/.test(lower)) {
        reply = `Меня зовут ${npc.name}. А как зовут тебя?`;
      } else {
        const replies = [
          "Интересно! Расскажи ещё.",
          "Я пока гуляю по миру. Пойдём исследовать?",
          "Может, скоро здесь появятся новые места!",
          "Хорошая мысль. Я об этом подумаю."
        ];
        reply = replies[Math.floor(Math.random() * replies.length)];
      }

      setTimeout(() => broadcast({
        type: "chat", from: npc.name,
        fromId: npc.id, text: reply, npc: true
      }), 500);
    }

    if (m.type === "action") {
      const target = players.get(m.targetId);
      if (!target || target.id === id) return;

      if (Math.hypot(target.x - me.x, target.y - me.y) > 115) {
        send(ws, { type: "notice", text: "Подойди поближе к игроку." });
        return;
      }

      if (m.action === "heal") {
        target.hp = clamp(target.hp + 25, 0, 100);
      } else if (m.action === "hit") {
        target.hp = clamp(target.hp - 10, 0, 100);
      } else if (m.action === "grab") {
        if (target.grabbedBy) return;
        target.grabbedBy = id;
        me.grabTarget = target.id;
        broadcast({ type: "grab-state", targetId: target.id, grabbedBy: id });
      } else if (m.action === "release") {
        const held = players.get(me.grabTarget);
        if (!held) {
          send(ws, { type: "notice", text: "Ты никого не удерживаешь." });
          return;
        }
        held.grabbedBy = null;
        me.grabTarget = null;
        broadcast({ type: "grab-state", targetId: held.id, grabbedBy: null });
      }

      broadcast({ type: "player-updated", player: publicPlayer(target) });
    }
  });

  ws.on("close", () => {
    const old = players.get(id);
    if (old?.grabTarget) {
      const held = players.get(old.grabTarget);
      if (held) held.grabbedBy = null;
    }

    for (const other of players.values()) {
      if (other.grabTarget === id) other.grabTarget = null;
    }

    players.delete(id);
    sockets.delete(id);
    broadcast({ type: "player-left", id, name: old?.name || "Игрок" });
  });
});

setInterval(() => {
  for (const npc of npcs) {
    if (Math.random() < 0.025 ||
        Math.hypot(npc.tx - npc.x, npc.ty - npc.y) < 8) {
      npc.tx = 60 + Math.random() * 1080;
      npc.ty = 60 + Math.random() * 580;
    }

    const dx = npc.tx - npc.x;
    const dy = npc.ty - npc.y;
    const distance = Math.hypot(dx, dy) || 1;

    npc.x = clamp(npc.x + dx / distance * 1.2, 28, 1172);
    npc.y = clamp(npc.y + dy / distance * 1.2, 28, 672);
  }

  broadcast({ type: "npc-update", npcs });
}, 80);

server.listen(PORT, "0.0.0.0", () => {
  console.log("AI WORLD запущен на порту " + PORT);
});

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const META_FILE = path.join(DATA_DIR, "meta.json");
const AUTH_VERSION = 2;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error("Failed to read", file, e.message);
  }
  return fallback;
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// One-time refresh: old name-only accounts are cleared so every username can be registered with a password.
function refreshTakenUsernames() {
  const meta = readJson(META_FILE, {});
  if (meta.authVersion === AUTH_VERSION) return false;
  writeJson(USERS_FILE, {});
  writeJson(META_FILE, { authVersion: AUTH_VERSION, refreshedAt: Date.now() });
  console.log("Refreshed taken usernames for the login system.");
  return true;
}
refreshTakenUsernames();

function loadUsers() {
  const raw = readJson(USERS_FILE, {});
  const clean = {};
  for (const [name, u] of Object.entries(raw || {})) {
    if (!u || !u.passwordHash) continue;
    clean[name] = u;
  }
  return clean;
}

let users = loadUsers();
const sessions = new Map(); // token -> username

function reloadUsersFromDisk() {
  const fresh = loadUsers();
  for (const [name, u] of Object.entries(fresh)) {
    const live = users[name];
    users[name] = {
      ...u,
      socketId: live?.socketId || null,
      roomId: live?.roomId || null,
    };
  }
  for (const name of Object.keys(users)) {
    if (!fresh[name]) {
      if (!users[name].socketId) delete users[name];
    }
  }
  return users;
}

function takenUsernames() {
  reloadUsersFromDisk();
  return Object.keys(users)
    .filter((n) => users[n] && users[n].passwordHash)
    .sort((a, b) => a.localeCompare(b));
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/usernames", (_req, res) => {
  const names = takenUsernames();
  res.json({ ok: true, refreshedAt: Date.now(), count: names.length, usernames: names });
});

app.post("/api/usernames/refresh", (_req, res) => {
  const names = takenUsernames();
  res.json({ ok: true, refreshedAt: Date.now(), count: names.length, usernames: names });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function saveUsers() {
  try {
    const dump = {};
    for (const [name, u] of Object.entries(users)) {
      if (!u.passwordHash) continue;
      dump[name] = {
        username: u.username,
        passwordHash: u.passwordHash,
        friends: u.friends || [],
        incoming: u.incoming || [],
        outgoing: u.outgoing || [],
        color: u.color,
        createdAt: u.createdAt,
        gamesPlayed: u.gamesPlayed || 0,
        wins: u.wins || 0,
        highScore: u.highScore || 0,
        rank: u.rank || "none",
      };
    }
    writeJson(USERS_FILE, dump);
  } catch (e) {
    console.error("Failed to save users:", e.message);
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 32).toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
  } catch {
    return false;
  }
}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function normalizeName(raw) {
  return String(raw || "").trim().replace(/\s+/g, " ").slice(0, 16);
}

function nameTaken(username) {
  const key = username.toLowerCase();
  return Object.keys(users).some((n) => n.toLowerCase() === key);
}

function findUser(username) {
  const key = username.toLowerCase();
  const exact = Object.keys(users).find((n) => n.toLowerCase() === key);
  return exact ? users[exact] : null;
}

const sockets = new Map(); // socketId -> username
const rooms = new Map(); // roomId -> room

const COLORS = [
  "#38bdf8", "#a78bfa", "#f472b6", "#34d399",
  "#fbbf24", "#fb7185", "#22d3ee", "#c084fc",
  "#4ade80", "#60a5fa",
];

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function makeCode(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

const RANKS = {
  owner: { title: "Owner", badge: "👑" },
  admin: { title: "Admin", badge: "⚡" },
  captain: { title: "Captain", badge: "🌟" },
  guardian: { title: "Guardian", badge: "🛡️" },
  comet: { title: "Comet", badge: "☄️" },
  spark: { title: "Spark", badge: "✨" },
  navigator: { title: "Navigator", badge: "🧭" },
  none: { title: "Player", badge: "" },
};
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "AuraNandu_67_";
const adminTokens = new Map();

function rankInfo(rank) {
  return RANKS[rank] || RANKS.none;
}

function withRank(obj, username) {
  const info = rankInfo(users[username]?.rank);
  return { ...obj, rank: users[username]?.rank || "none", badge: info.badge, rankTitle: info.title };
}

function publicUser(name) {
  const u = users[name];
  if (!u) return null;
  const info = rankInfo(u.rank);
  return {
    username: name,
    color: u.color,
    online: !!u.socketId,
    friends: u.friends || [],
    incoming: u.incoming || [],
    outgoing: u.outgoing || [],
    gamesPlayed: u.gamesPlayed || 0,
    wins: u.wins || 0,
    highScore: u.highScore || 0,
    rank: u.rank || "none",
    badge: info.badge,
    rankTitle: info.title,
  };
}

function onlineList() {
  return Object.keys(users)
    .filter((n) => users[n].socketId)
    .map((n) => ({
      username: n,
      color: users[n].color,
      badge: rankInfo(users[n].rank).badge,
      roomId: users[n].roomId || null,
    }));
}

function roomPublic(room) {
  return {
    id: room.id,
    host: room.host,
    players: room.players.map((p) => ({
      username: p.username,
      color: p.color,
      badge: rankInfo(users[p.username]?.rank).badge,
      ready: p.ready,
      score: p.score,
    })),
    state: room.state,
    maxPlayers: room.maxPlayers,
    timeLeft: room.timeLeft,
  };
}

function emitFriendsUpdate(name) {
  const u = users[name];
  if (!u || !u.socketId) return;
  const friendProfiles = (u.friends || []).map((f) => ({
    username: f,
    color: users[f]?.color || "#888",
    badge: rankInfo(users[f]?.rank).badge,
    online: !!(users[f] && users[f].socketId),
    roomId: users[f]?.roomId || null,
  }));
  io.to(u.socketId).emit("friends:update", {
    friends: friendProfiles,
    incoming: u.incoming || [],
    outgoing: u.outgoing || [],
  });
}

function leaveRoom(socket, username) {
  const u = users[username];
  if (!u || !u.roomId) return;
  const room = rooms.get(u.roomId);
  u.roomId = null;
  if (!room) return;
  socket.leave(room.id);
  room.players = room.players.filter((p) => p.username !== username);
  if (room.players.length === 0) {
    if (room.loop) clearInterval(room.loop);
    rooms.delete(room.id);
  } else {
    if (room.host === username) room.host = room.players[0].username;
    if (room.state === "playing" && room.players.length < 1) {
      endMatch(room);
    }
    io.to(room.id).emit("room:update", roomPublic(room));
    io.to(room.id).emit("chat:message", {
      system: true,
      text: `${username} left the room`,
      time: Date.now(),
    });
  }
}

function spawnStar(room) {
  const rare = Math.random() < 0.12;
  return {
    id: makeCode(8),
    x: 40 + Math.random() * (room.width - 80),
    y: 40 + Math.random() * (room.height - 80),
    r: rare ? 16 : 9,
    value: rare ? 30 : 10,
    hue: rare ? 45 : 200 + Math.random() * 80,
    rare,
  };
}

function startMatch(room) {
  room.state = "playing";
  room.timeLeft = 60;
  room.stars = Array.from({ length: 18 }, () => spawnStar(room));
  room.players.forEach((p) => {
    p.x = 80 + Math.random() * (room.width - 160);
    p.y = 80 + Math.random() * (room.height - 160);
    p.vx = 0;
    p.vy = 0;
    p.score = 0;
    p.ready = false;
  });
  io.to(room.id).emit("game:start", {
    room: roomPublic(room),
    stars: room.stars,
    players: room.players.map((p) => ({
      username: p.username,
      color: p.color,
      badge: rankInfo(users[p.username]?.rank).badge,
      x: p.x,
      y: p.y,
      score: 0,
    })),
    timeLeft: room.timeLeft,
    width: room.width,
    height: room.height,
  });

  if (room.loop) clearInterval(room.loop);
  room.tick = 0;
  room.loop = setInterval(() => tickRoom(room), 50);
}

function tickRoom(room) {
  if (room.state !== "playing") return;
  room.tick += 1;
  if (room.tick % 20 === 0) {
    room.timeLeft -= 1;
    if (room.timeLeft <= 0) {
      endMatch(room);
      return;
    }
  }
  if (room.stars.length < 16 && Math.random() < 0.35) {
    room.stars.push(spawnStar(room));
  }

  const SPEED = 0.55;
  const FRICTION = 0.86;
  const MAX = 7.2;

  for (const p of room.players) {
    const input = p.input || { up: false, down: false, left: false, right: false };
    if (input.up) p.vy -= SPEED;
    if (input.down) p.vy += SPEED;
    if (input.left) p.vx -= SPEED;
    if (input.right) p.vx += SPEED;
    p.vx *= FRICTION;
    p.vy *= FRICTION;
    const mag = Math.hypot(p.vx, p.vy);
    if (mag > MAX) {
      p.vx = (p.vx / mag) * MAX;
      p.vy = (p.vy / mag) * MAX;
    }
    p.x += p.vx;
    p.y += p.vy;
    const pr = 18;
    if (p.x < pr) { p.x = pr; p.vx *= -0.4; }
    if (p.x > room.width - pr) { p.x = room.width - pr; p.vx *= -0.4; }
    if (p.y < pr) { p.y = pr; p.vy *= -0.4; }
    if (p.y > room.height - pr) { p.y = room.height - pr; p.vy *= -0.4; }
  }

  // soft player bounce
  for (let i = 0; i < room.players.length; i++) {
    for (let j = i + 1; j < room.players.length; j++) {
      const a = room.players[i];
      const b = room.players[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const min = 36;
      if (dist < min) {
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = min - dist;
        a.x -= nx * overlap * 0.5;
        a.y -= ny * overlap * 0.5;
        b.x += nx * overlap * 0.5;
        b.y += ny * overlap * 0.5;
        const dvx = b.vx - a.vx;
        const dvy = b.vy - a.vy;
        const impact = dvx * nx + dvy * ny;
        if (impact < 0) {
          a.vx += nx * impact;
          a.vy += ny * impact;
          b.vx -= nx * impact;
          b.vy -= ny * impact;
        }
      }
    }
  }

  const collected = [];
  room.stars = room.stars.filter((star) => {
    for (const p of room.players) {
      const d = Math.hypot(p.x - star.x, p.y - star.y);
      if (d < 18 + star.r) {
        p.score += star.value;
        collected.push({
          starId: star.id,
          by: p.username,
          value: star.value,
          x: star.x,
          y: star.y,
          rare: star.rare,
        });
        return false;
      }
    }
    return true;
  });

  io.to(room.id).emit("game:state", {
    timeLeft: room.timeLeft,
    players: room.players.map((p) => ({
      username: p.username,
      color: p.color,
      badge: rankInfo(users[p.username]?.rank).badge,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      score: p.score,
    })),
    stars: room.stars,
    collected,
  });
}

function endMatch(room) {
  room.state = "results";
  if (room.loop) {
    clearInterval(room.loop);
    room.loop = null;
  }
  const board = [...room.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      rank: i + 1,
      username: p.username,
      color: p.color,
      badge: rankInfo(users[p.username]?.rank).badge,
      score: p.score,
    }));
  if (board[0]) {
    const winner = users[board[0].username];
    if (winner) winner.wins = (winner.wins || 0) + 1;
  }
  for (const p of room.players) {
    const u = users[p.username];
    if (!u) continue;
    u.gamesPlayed = (u.gamesPlayed || 0) + 1;
    u.highScore = Math.max(u.highScore || 0, p.score);
  }
  saveUsers();
  io.to(room.id).emit("game:over", { leaderboard: board });
  io.to(room.id).emit("room:update", roomPublic(room));
}

io.on("connection", (socket) => {
  function attach(username) {
    const existing = users[username];
    if (existing && existing.socketId && existing.socketId !== socket.id) {
      const old = io.sockets.sockets.get(existing.socketId);
      if (old) {
        old.emit("auth:kicked", "Signed in from another tab.");
        old.disconnect(true);
      }
    }
    users[username].socketId = socket.id;
    sockets.set(socket.id, username);
    socket.emit("auth:ok", publicUser(username));
    io.emit("lobby:online", onlineList());
    emitFriendsUpdate(username);
  }

  socket.on("auth:taken", (_payload, cb) => {
    const names = takenUsernames();
    cb?.({ ok: true, count: names.length, usernames: names, refreshedAt: Date.now() });
  });

  socket.on("auth:check", (rawName, cb) => {
    reloadUsersFromDisk();
    const username = normalizeName(rawName);
    if (!username || username.length < 2 || !/^[A-Za-z0-9_ ]+$/.test(username)) {
      return cb?.({ ok: true, valid: false, taken: false });
    }
    cb?.({ ok: true, valid: true, taken: nameTaken(username), username });
  });

  socket.on("auth:register", ({ username: rawName, password } = {}, cb) => {
    reloadUsersFromDisk();
    const username = normalizeName(rawName);
    const pass = String(password || "");
    if (!username || username.length < 2) {
      return cb?.({ ok: false, error: "Username must be 2–16 characters." });
    }
    if (!/^[A-Za-z0-9_ ]+$/.test(username)) {
      return cb?.({ ok: false, error: "Use letters, numbers, spaces or _ only." });
    }
    if (pass.length < 4 || pass.length > 64) {
      return cb?.({ ok: false, error: "Password must be 4–64 characters." });
    }
    if (nameTaken(username)) {
      return cb?.({ ok: false, error: "That username is already taken." });
    }
    users[username] = {
      username,
      passwordHash: hashPassword(pass),
      color: randomColor(),
      friends: [],
      incoming: [],
      outgoing: [],
      gamesPlayed: 0,
      wins: 0,
      highScore: 0,
      createdAt: Date.now(),
    };
    saveUsers();
    const token = makeToken();
    sessions.set(token, username);
    attach(username);
    cb?.({ ok: true, token, user: publicUser(username) });
  });

  socket.on("auth:login", (payload, cb) => {
    reloadUsersFromDisk();
    const body = payload && typeof payload === "object" ? payload : { username: payload };
    const { password, token } = body;
    if (token && sessions.has(token)) {
      const username = sessions.get(token);
      if (users[username]) {
        attach(username);
        return cb?.({ ok: true, token, user: publicUser(username) });
      }
      sessions.delete(token);
    }
    const username = normalizeName(body.username);
    const pass = String(password || "");
    const user = findUser(username);
    if (!user || !verifyPassword(pass, user.passwordHash)) {
      return cb?.({ ok: false, error: "Wrong username or password." });
    }
    const nextToken = makeToken();
    sessions.set(nextToken, user.username);
    attach(user.username);
    cb?.({ ok: true, token: nextToken, user: publicUser(user.username) });
  });

  socket.on("auth:logout", () => {
    const username = sockets.get(socket.id);
    if (!username) return;
    for (const [token, name] of sessions) {
      if (name === username) sessions.delete(token);
    }
    socket.emit("auth:loggedout");
  });

  function adminOk(token) {
    return token && adminTokens.get(token) === socket.id;
  }

  socket.on("admin:open", ({ password } = {}, cb) => {
    if (password !== ADMIN_PASSWORD) return cb?.({ ok: false, error: "Wrong admin password." });
    const token = makeToken();
    adminTokens.set(token, socket.id);
    const players = Object.keys(users).map((n) => publicUser(n));
    cb?.({
      ok: true,
      token,
      ranks: Object.entries(RANKS).map(([id, info]) => ({ id, title: info.title, badge: info.badge })),
      players,
    });
  });

  socket.on("admin:set", ({ token, username, rank } = {}, cb) => {
    if (!adminOk(token)) return cb?.({ ok: false, error: "Open the admin panel again." });
    const user = findUser(username);
    if (!user) return cb?.({ ok: false, error: "Player not found." });
    if (!RANKS[rank]) return cb?.({ ok: false, error: "Unknown rank." });
    user.rank = rank;
    saveUsers();
    const info = rankInfo(rank);
    if (user.socketId) io.to(user.socketId).emit("rank:you", publicUser(user.username));
    io.emit("rank:changed", { username: user.username, badge: info.badge, rankTitle: info.title, rank });
    cb?.({ ok: true, user: publicUser(user.username), players: Object.keys(users).map((n) => publicUser(n)) });
  });

  socket.on("chat:lobby", (text) => {
    const username = sockets.get(socket.id);
    if (!username) return;
    const clean = String(text || "").trim().slice(0, 160);
    if (!clean) return;
    io.emit("chat:lobby", {
      username,
      color: users[username].color,
      badge: rankInfo(users[username].rank).badge,
      text: clean,
      time: Date.now(),
    });
  });

  socket.on("chat:room", (text) => {
    const username = sockets.get(socket.id);
    if (!username) return;
    const u = users[username];
    if (!u?.roomId) return;
    const clean = String(text || "").trim().slice(0, 160);
    if (!clean) return;
    io.to(u.roomId).emit("chat:message", {
      username,
      color: u.color,
      text: clean,
      time: Date.now(),
    });
  });

  socket.on("room:create", (cb) => {
    const username = sockets.get(socket.id);
    if (!username) return cb?.({ ok: false, error: "Login first." });
    leaveRoom(socket, username);
    let id = makeCode();
    while (rooms.has(id)) id = makeCode();
    const room = {
      id,
      host: username,
      maxPlayers: 8,
      state: "lobby",
      timeLeft: 60,
      width: 1100,
      height: 700,
      stars: [],
      players: [
        {
          username,
          color: users[username].color,
          ready: false,
          score: 0,
          x: 200,
          y: 200,
          vx: 0,
          vy: 0,
          input: {},
        },
      ],
    };
    rooms.set(id, room);
    users[username].roomId = id;
    socket.join(id);
    cb?.({ ok: true, room: roomPublic(room) });
    io.to(id).emit("room:update", roomPublic(room));
    io.emit("lobby:online", onlineList());
  });

  socket.on("room:join", (code, cb) => {
    const username = sockets.get(socket.id);
    if (!username) return cb?.({ ok: false, error: "Login first." });
    const id = String(code || "").trim().toUpperCase();
    const room = rooms.get(id);
    if (!room) return cb?.({ ok: false, error: "Room not found." });
    if (room.state === "playing") return cb?.({ ok: false, error: "Match already in progress." });
    if (room.players.length >= room.maxPlayers) return cb?.({ ok: false, error: "Room is full." });
    if (room.players.some((p) => p.username === username)) {
      users[username].roomId = id;
      socket.join(id);
      return cb?.({ ok: true, room: roomPublic(room) });
    }
    leaveRoom(socket, username);
    room.players.push({
      username,
      color: users[username].color,
      ready: false,
      score: 0,
      x: 200,
      y: 200,
      vx: 0,
      vy: 0,
      input: {},
    });
    users[username].roomId = id;
    socket.join(id);
    io.to(id).emit("room:update", roomPublic(room));
    io.to(id).emit("chat:message", {
      system: true,
      text: `${username} joined the room`,
      time: Date.now(),
    });
    io.emit("lobby:online", onlineList());
    cb?.({ ok: true, room: roomPublic(room) });
  });

  socket.on("room:leave", () => {
    const username = sockets.get(socket.id);
    if (!username) return;
    leaveRoom(socket, username);
    io.emit("lobby:online", onlineList());
  });

  socket.on("room:ready", (ready) => {
    const username = sockets.get(socket.id);
    if (!username) return;
    const room = rooms.get(users[username].roomId);
    if (!room || room.state === "playing") return;
    const p = room.players.find((x) => x.username === username);
    if (p) p.ready = !!ready;
    io.to(room.id).emit("room:update", roomPublic(room));
  });

  socket.on("room:start", () => {
    const username = sockets.get(socket.id);
    if (!username) return;
    const room = rooms.get(users[username].roomId);
    if (!room || room.host !== username) return;
    if (room.state === "playing") return;
    if (room.players.length < 1) return;
    startMatch(room);
  });

  socket.on("room:again", () => {
    const username = sockets.get(socket.id);
    if (!username) return;
    const room = rooms.get(users[username].roomId);
    if (!room) return;
    room.state = "lobby";
    room.players.forEach((p) => {
      p.ready = false;
      p.score = 0;
    });
    io.to(room.id).emit("room:update", roomPublic(room));
  });

  socket.on("game:input", (input) => {
    const username = sockets.get(socket.id);
    if (!username) return;
    const room = rooms.get(users[username].roomId);
    if (!room || room.state !== "playing") return;
    const p = room.players.find((x) => x.username === username);
    if (!p) return;
    p.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right,
    };
  });

  socket.on("friends:search", (q, cb) => {
    const username = sockets.get(socket.id);
    const query = String(q || "").trim().toLowerCase();
    if (!query) return cb?.([]);
    const results = Object.keys(users)
      .filter((n) => n.toLowerCase().includes(query) && n !== username)
      .slice(0, 8)
      .map((n) => ({
        username: n,
        color: users[n].color,
        online: !!users[n].socketId,
      }));
    cb?.(results);
  });

  socket.on("friends:request", (target, cb) => {
    const username = sockets.get(socket.id);
    if (!username) return cb?.({ ok: false, error: "Login first." });
    const to = String(target || "").trim();
    if (!users[to]) return cb?.({ ok: false, error: "Player not found." });
    if (to === username) return cb?.({ ok: false, error: "That's you!" });
    const me = users[username];
    const them = users[to];
    me.friends = me.friends || [];
    me.outgoing = me.outgoing || [];
    me.incoming = me.incoming || [];
    them.friends = them.friends || [];
    them.outgoing = them.outgoing || [];
    them.incoming = them.incoming || [];
    if (me.friends.includes(to)) return cb?.({ ok: false, error: "Already friends." });
    if (me.outgoing.includes(to)) return cb?.({ ok: false, error: "Request already sent." });
    // if they already requested us, auto-accept
    if (me.incoming.includes(to)) {
      me.incoming = me.incoming.filter((x) => x !== to);
      them.outgoing = them.outgoing.filter((x) => x !== username);
      if (!me.friends.includes(to)) me.friends.push(to);
      if (!them.friends.includes(username)) them.friends.push(username);
      saveUsers();
      emitFriendsUpdate(username);
      emitFriendsUpdate(to);
      if (them.socketId) {
        io.to(them.socketId).emit("friends:notify", {
          text: `${username} accepted your friend request!`,
        });
      }
      return cb?.({ ok: true, accepted: true });
    }
    me.outgoing.push(to);
    them.incoming.push(username);
    saveUsers();
    emitFriendsUpdate(username);
    emitFriendsUpdate(to);
    if (them.socketId) {
      io.to(them.socketId).emit("friends:notify", {
        text: `${username} sent you a friend request.`,
      });
    }
    cb?.({ ok: true });
  });

  socket.on("friends:respond", ({ from, accept }, cb) => {
    const username = sockets.get(socket.id);
    if (!username) return;
    const me = users[username];
    const them = users[from];
    if (!me || !them) return cb?.({ ok: false });
    me.incoming = (me.incoming || []).filter((x) => x !== from);
    them.outgoing = (them.outgoing || []).filter((x) => x !== username);
    if (accept) {
      if (!me.friends.includes(from)) me.friends.push(from);
      if (!them.friends.includes(username)) them.friends.push(username);
    }
    saveUsers();
    emitFriendsUpdate(username);
    emitFriendsUpdate(from);
    if (accept && them.socketId) {
      io.to(them.socketId).emit("friends:notify", {
        text: `${username} is now your friend!`,
      });
    }
    cb?.({ ok: true });
  });

  socket.on("friends:invite", (target) => {
    const username = sockets.get(socket.id);
    if (!username) return;
    const me = users[username];
    const them = users[target];
    if (!me?.roomId || !them) return;
    if (!(me.friends || []).includes(target)) return;
    if (!them.socketId) return;
    const room = rooms.get(me.roomId);
    if (!room) return;
    io.to(them.socketId).emit("friends:invite", {
      from: username,
      color: me.color,
      roomId: me.roomId,
    });
  });

  socket.on("disconnect", () => {
    const username = sockets.get(socket.id);
    sockets.delete(socket.id);
    if (!username || !users[username]) {
      io.emit("lobby:online", onlineList());
      return;
    }
    if (users[username].socketId === socket.id) {
      leaveRoom(socket, username);
      users[username].socketId = null;
      users[username].roomId = null;
    }
    io.emit("lobby:online", onlineList());
    // refresh friends online status for their friends
    (users[username].friends || []).forEach(emitFriendsUpdate);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Stellar Party running on port ${PORT}`);
});

const socket = io({ transports: ["websocket", "polling"] });

const views = {
  login: document.getElementById("view-login"),
  lobby: document.getElementById("view-lobby"),
  room: document.getElementById("view-room"),
  game: document.getElementById("view-game"),
  results: document.getElementById("view-results"),
};

let me = null;
let currentRoom = null;
let friendsState = { friends: [], incoming: [], outgoing: [] };
let pendingInvite = null;
let authMode = "login";
const keys = { up: false, down: false, left: false, right: false };

function show(name) {
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[name].classList.add("active");
  if (name === "game") setTimeout(() => Game.resize(), 50);
  if (name === "login") refreshTaken();
}

function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2800);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function colorDot(color) {
  return `<span class="dot" style="background:${color};color:${color}"></span>`;
}

function typingNow(e) {
  const t = e.target;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

function setAuthMode(mode) {
  authMode = mode;
  document.getElementById("tab-login").classList.toggle("active", mode === "login");
  document.getElementById("tab-register").classList.toggle("active", mode === "register");
  document.getElementById("auth-submit").textContent = mode === "login" ? "Log in" : "Create account";
  document.getElementById("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  checkName();
}

function finishLogin(res) {
  me = res.user;
  if (res.token) localStorage.setItem("stellar_token", res.token);
  localStorage.setItem("stellar_username", me.username);
  document.getElementById("me-chip").textContent = `${me.badge ? me.badge + " " : ""}${me.username}`;
  show("lobby");
}

function refreshTaken() {
  const list = document.getElementById("taken-list");
  const count = document.getElementById("taken-count");
  if (!list) return;
  list.textContent = "Refreshing…";
  socket.emit("auth:taken", {}, (res) => {
    const names = res?.usernames || [];
    count.textContent = String(names.length);
    list.innerHTML = names.length
      ? names.map((n) => `<span class="chip">${escapeHtml(n)}</span>`).join("")
      : `<span class="muted">No usernames taken yet</span>`;
    checkName();
  });
}

function checkName() {
  const status = document.getElementById("name-status");
  const name = document.getElementById("username").value.trim();
  if (!status) return;
  if (name.length < 2) {
    status.className = "name-status";
    status.textContent = "";
    return;
  }
  socket.emit("auth:check", name, (res) => {
    if (!res?.valid) {
      status.className = "name-status bad";
      status.textContent = "Use 2–16 letters, numbers, spaces or _";
      return;
    }
    if (authMode === "register") {
      status.className = res.taken ? "name-status bad" : "name-status ok";
      status.textContent = res.taken ? "Username taken" : "Username available";
    } else {
      status.className = res.taken ? "name-status ok" : "name-status";
      status.textContent = res.taken ? "Account found" : "No account with that name yet";
    }
  });
}

document.getElementById("tab-login").addEventListener("click", () => setAuthMode("login"));
document.getElementById("tab-register").addEventListener("click", () => setAuthMode("register"));
document.getElementById("btn-refresh-names").addEventListener("click", refreshTaken);
document.getElementById("username").addEventListener("input", () => {
  clearTimeout(checkName._t);
  checkName._t = setTimeout(checkName, 180);
});

document.getElementById("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  const event = authMode === "register" ? "auth:register" : "auth:login";
  socket.emit(event, { username, password }, (res) => {
    if (!res?.ok) return toast(res?.error || "Could not sign in");
    document.getElementById("password").value = "";
    finishLogin(res);
    refreshTaken();
  });
});

document.getElementById("btn-logout").addEventListener("click", () => {
  socket.emit("auth:logout");
  socket.emit("room:leave");
  localStorage.removeItem("stellar_token");
  me = null;
  currentRoom = null;
  Game.stop();
  show("login");
  toast("Logged out");
});

document.getElementById("btn-create").addEventListener("click", () => {
  socket.emit("room:create", (res) => {
    if (!res?.ok) return toast(res?.error || "Could not create room");
    enterRoom(res.room);
  });
});

document.getElementById("btn-join").addEventListener("click", joinFromInput);
document.getElementById("join-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinFromInput();
});

function joinFromInput() {
  const code = document.getElementById("join-code").value.trim();
  socket.emit("room:join", code, (res) => {
    if (!res?.ok) return toast(res?.error || "Could not join");
    enterRoom(res.room);
  });
}

function enterRoom(room) {
  currentRoom = room;
  document.getElementById("room-code").textContent = room.id;
  document.getElementById("room-chat").innerHTML = "";
  renderRoom(room);
  show("room");
}

document.getElementById("btn-leave").addEventListener("click", () => {
  socket.emit("room:leave");
  currentRoom = null;
  Game.stop();
  show("lobby");
});

document.getElementById("btn-copy").addEventListener("click", async () => {
  if (!currentRoom) return;
  try {
    await navigator.clipboard.writeText(currentRoom.id);
    toast("Room code copied!");
  } catch {
    toast("Code: " + currentRoom.id);
  }
});

document.getElementById("btn-ready").addEventListener("click", () => {
  const mePlayer = currentRoom?.players.find((p) => p.username === me.username);
  socket.emit("room:ready", !mePlayer?.ready);
});

document.getElementById("btn-start").addEventListener("click", () => {
  socket.emit("room:start");
});

document.getElementById("btn-again").addEventListener("click", () => {
  socket.emit("room:again");
  show("room");
});

document.getElementById("btn-lobby").addEventListener("click", () => {
  socket.emit("room:leave");
  currentRoom = null;
  show("lobby");
});

document.getElementById("lobby-chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("lobby-chat-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("chat:lobby", text);
  input.value = "";
});

document.getElementById("room-chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("room-chat-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("chat:room", text);
  input.value = "";
});

document.getElementById("btn-search").addEventListener("click", searchFriends);
document.getElementById("friend-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    searchFriends();
  }
});

function searchFriends() {
  const q = document.getElementById("friend-search").value;
  socket.emit("friends:search", q, (results) => {
    const box = document.getElementById("search-results");
    if (!results.length) {
      box.innerHTML = `<div class="row-item">No players found</div>`;
      return;
    }
    box.innerHTML = results
      .map(
        (r) => `
        <div class="row-item">
          <div class="who">${colorDot(r.color)} ${escapeHtml(r.username)}
            <span class="muted">${r.online ? "online" : "offline"}</span>
          </div>
          <button class="btn tiny" data-add="${escapeHtml(r.username)}">Add</button>
        </div>`
      )
      .join("");
    box.querySelectorAll("[data-add]").forEach((btn) => {
      btn.addEventListener("click", () => {
        socket.emit("friends:request", btn.dataset.add, (res) => {
          if (!res?.ok) return toast(res?.error || "Could not send request");
          toast(res.accepted ? "You are now friends!" : "Friend request sent");
        });
      });
    });
  });
}

function renderFriends() {
  const req = document.getElementById("requests-list");
  const list = document.getElementById("friends-list");
  const incoming = friendsState.incoming || [];
  if (!incoming.length) req.textContent = "No pending requests";
  else {
    req.innerHTML = incoming
      .map(
        (name) => `
        <div class="row-item">
          <div class="who">${escapeHtml(name)}</div>
          <div>
            <button class="btn tiny" data-acc="${escapeHtml(name)}">Accept</button>
            <button class="btn tiny ghost" data-dec="${escapeHtml(name)}">No</button>
          </div>
        </div>`
      )
      .join("");
    req.querySelectorAll("[data-acc]").forEach((b) =>
      b.addEventListener("click", () => socket.emit("friends:respond", { from: b.dataset.acc, accept: true }))
    );
    req.querySelectorAll("[data-dec]").forEach((b) =>
      b.addEventListener("click", () => socket.emit("friends:respond", { from: b.dataset.dec, accept: false }))
    );
  }

  const friends = friendsState.friends || [];
  if (!friends.length) list.textContent = "Add friends to invite them";
  else {
    list.innerHTML = friends
      .map(
        (f) => `
        <div class="row-item ${f.online ? "online" : "offline"}">
          <div class="who">${colorDot(f.color)} ${f.badge ? f.badge + " " : ""}${escapeHtml(f.username)}
            <span class="muted">${f.online ? (f.roomId ? "in a room" : "online") : "offline"}</span>
          </div>
        </div>`
      )
      .join("");
  }
  renderInvites();
}

function renderInvites() {
  const box = document.getElementById("invite-list");
  if (!box) return;
  const friends = (friendsState.friends || []).filter((f) => f.online);
  if (!friends.length) {
    box.textContent = "Online friends will show up here to invite.";
    return;
  }
  box.innerHTML = friends
    .map(
      (f) => `
      <div class="row-item">
        <div class="who">${colorDot(f.color)} ${f.badge ? f.badge + " " : ""}${escapeHtml(f.username)}</div>
        <button class="btn tiny" data-inv="${escapeHtml(f.username)}">Invite</button>
      </div>`
    )
    .join("");
  box.querySelectorAll("[data-inv]").forEach((b) => {
    b.addEventListener("click", () => {
      socket.emit("friends:invite", b.dataset.inv);
      toast("Invite sent to " + b.dataset.inv);
    });
  });
}

function renderRoom(room) {
  currentRoom = room;
  document.getElementById("player-count").textContent = `${room.players.length}/${room.maxPlayers}`;
  document.getElementById("room-players").innerHTML = room.players
    .map(
      (p) => `
      <div class="player-card">
        <div class="who">${colorDot(p.color)} <span class="name">${p.badge ? p.badge + " " : ""}${escapeHtml(p.username)}</span></div>
        <div>${p.username === room.host ? "Host · " : ""}${
          p.ready ? '<span class="ready-tag">READY</span>' : '<span class="wait-tag">WAITING</span>'
        }</div>
      </div>`
    )
    .join("");
  const isHost = me && room.host === me.username;
  document.getElementById("btn-start").classList.toggle("hidden", !isHost);
  document.getElementById("host-hint").textContent = isHost
    ? "You are the host. Start whenever the party is ready."
    : `${room.host} is the host.`;
  const mePlayer = room.players.find((p) => p.username === me?.username);
  document.getElementById("btn-ready").textContent = mePlayer?.ready ? "Unready" : "Ready";
}

function appendChat(el, msg) {
  const line = document.createElement("div");
  line.className = "chat-line" + (msg.system ? " system" : "");
  if (msg.system) line.textContent = msg.text;
  else {
    line.innerHTML = `<span class="name" style="color:${msg.color}">${msg.badge ? msg.badge + " " : ""}${escapeHtml(msg.username)}</span>${escapeHtml(msg.text)}`;
  }
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

socket.on("lobby:online", (list) => {
  document.getElementById("online-list").innerHTML = list
    .map((p) => `<span class="chip">${p.badge ? p.badge + " " : ""}${escapeHtml(p.username)}</span>`)
    .join("") || `<span class="muted">Just you for now</span>`;
});

socket.on("chat:lobby", (msg) => appendChat(document.getElementById("lobby-chat"), msg));
socket.on("chat:message", (msg) => appendChat(document.getElementById("room-chat"), msg));

socket.on("room:update", (room) => {
  if (!currentRoom || currentRoom.id !== room.id) currentRoom = room;
  renderRoom(room);
});

socket.on("game:start", (payload) => {
  currentRoom = payload.room;
  show("game");
  Game.start(payload, me.username);
  document.getElementById("timer").textContent = payload.timeLeft;
});

socket.on("game:state", (state) => {
  Game.applyState(state);
  document.getElementById("timer").textContent = state.timeLeft;
  document.getElementById("hud-scores").innerHTML = [...state.players]
    .sort((a, b) => b.score - a.score)
    .map(
      (p) =>
        `<div class="score-pill"><span style="color:${p.color}">●</span> ${p.badge ? p.badge + " " : ""}${escapeHtml(p.username)} · ${p.score}</div>`
    )
    .join("");
});

socket.on("game:over", ({ leaderboard }) => {
  Game.stop();
  const board = document.getElementById("leaderboard");
  const classes = ["gold", "silver", "bronze"];
  board.innerHTML = leaderboard
    .map(
      (row, i) =>
        `<li class="${classes[i] || ""}"><span>#${row.rank} ${row.badge ? row.badge + " " : ""}${escapeHtml(row.username)}</span><span>${row.score}</span></li>`
    )
    .join("");
  const winner = leaderboard[0];
  document.getElementById("winner-line").textContent = winner
    ? `${winner.username} shines brightest with ${winner.score} points!`
    : "Nice run!";
  show("results");
});

socket.on("friends:update", (state) => {
  friendsState = state;
  renderFriends();
});

socket.on("friends:notify", (n) => toast(n.text));

socket.on("friends:invite", (inv) => {
  pendingInvite = inv;
  document.getElementById("invite-text").textContent = `${inv.from} invited you to room ${inv.roomId}`;
  document.getElementById("invite-modal").classList.remove("hidden");
});

document.getElementById("invite-accept").addEventListener("click", () => {
  document.getElementById("invite-modal").classList.add("hidden");
  if (!pendingInvite) return;
  socket.emit("room:join", pendingInvite.roomId, (res) => {
    if (!res?.ok) return toast(res?.error || "Could not join");
    enterRoom(res.room);
  });
  pendingInvite = null;
});
document.getElementById("invite-decline").addEventListener("click", () => {
  document.getElementById("invite-modal").classList.add("hidden");
  pendingInvite = null;
});

socket.on("auth:kicked", (msg) => {
  toast(msg);
  me = null;
  show("login");
});

function sendInput() {
  socket.emit("game:input", keys);
}

const moveMap = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  KeyW: "up",
  KeyS: "down",
  KeyA: "left",
  KeyD: "right",
};
window.addEventListener("keydown", (e) => {
  if (typingNow(e) || !moveMap[e.code]) return;
  keys[moveMap[e.code]] = true;
  sendInput();
  e.preventDefault();
});
window.addEventListener("keyup", (e) => {
  if (!moveMap[e.code]) return;
  keys[moveMap[e.code]] = false;
  if (!typingNow(e)) sendInput();
});

const pad = document.getElementById("touch-pad");
pad.querySelectorAll("button").forEach((btn) => {
  const dir = btn.dataset.dir;
  const on = (ev) => {
    ev.preventDefault();
    keys[dir] = true;
    sendInput();
  };
  const off = (ev) => {
    ev.preventDefault();
    keys[dir] = false;
    sendInput();
  };
  btn.addEventListener("pointerdown", on);
  btn.addEventListener("pointerup", off);
  btn.addEventListener("pointerleave", off);
  btn.addEventListener("pointercancel", off);
  btn.addEventListener("contextmenu", (ev) => ev.preventDefault());
});

const savedName = localStorage.getItem("stellar_username");
if (savedName) document.getElementById("username").value = savedName;
const savedToken = localStorage.getItem("stellar_token");
if (savedToken) {
  socket.emit("auth:login", { token: savedToken }, (res) => {
    if (res?.ok) finishLogin(res);
    else {
      localStorage.removeItem("stellar_token");
      show("login");
    }
  });
} else {
  show("login");
}

let adminToken = "";
document.getElementById("btn-admin").addEventListener("click", () => {
  document.getElementById("admin-modal").classList.remove("hidden");
});
document.getElementById("admin-close").addEventListener("click", () => {
  document.getElementById("admin-modal").classList.add("hidden");
});
document.getElementById("admin-lock").addEventListener("submit", (e) => {
  e.preventDefault();
  socket.emit("admin:open", { password: document.getElementById("admin-password").value }, (res) => {
    if (!res?.ok) return toast(res?.error || "Could not open ranks");
    adminToken = res.token;
    const select = document.getElementById("admin-rank");
    select.innerHTML = res.ranks.map((r) => `<option value="${r.id}">${r.badge} ${r.title}</option>`).join("");
    document.getElementById("admin-panel").classList.remove("hidden");
    document.getElementById("admin-lock").classList.add("hidden");
    drawAdmin(res.players);
    if (me) document.getElementById("admin-user").value = me.username;
  });
});
function drawAdmin(players) {
  document.getElementById("admin-list").innerHTML = players
    .map((p) => `<div class="row-item"><div class="who">${p.badge || ""} ${escapeHtml(p.username)}</div><span class="muted">${escapeHtml(p.rankTitle || "Player")}</span></div>`)
    .join("");
}
document.getElementById("admin-give").addEventListener("click", () => {
  socket.emit("admin:set", {
    token: adminToken,
    username: document.getElementById("admin-user").value.trim(),
    rank: document.getElementById("admin-rank").value,
  }, (res) => {
    if (!res?.ok) return toast(res?.error || "Could not save rank");
    drawAdmin(res.players);
    toast("Rank saved");
    if (me && res.user.username === me.username) {
      me = res.user;
      document.getElementById("me-chip").textContent = `${me.badge ? me.badge + " " : ""}${me.username}`;
    }
  });
});
socket.on("rank:you", (user) => {
  me = user;
  document.getElementById("me-chip").textContent = `${me.badge ? me.badge + " " : ""}${me.username}`;
});

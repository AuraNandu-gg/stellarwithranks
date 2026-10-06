const Game = (() => {
  const canvas = () => document.getElementById("game");
  let ctx = null;
  let W = 1100;
  let H = 700;
  let players = [];
  let stars = [];
  let particles = [];
  let sparks = [];
  let me = "";
  let running = false;
  let raf = 0;
  let t = 0;

  function resize() {
    const c = canvas();
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.max(1, Math.floor(rect.width * dpr));
    c.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    c._cssW = rect.width;
    c._cssH = rect.height;
  }

  function worldToScreen(x, y) {
    const c = canvas();
    const sx = (c._cssW || 1) / W;
    const sy = (c._cssH || 1) / H;
    return { x: x * sx, y: y * sy, s: Math.min(sx, sy) };
  }

  function burst(x, y, color, n = 16, rare = false) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1.2 + Math.random() * 3.2;
      particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 1,
        color,
        r: rare ? 3.2 : 2.1,
      });
    }
  }

  function start(payload, username) {
    W = payload.width || 1100;
    H = payload.height || 700;
    players = payload.players || [];
    stars = payload.stars || [];
    particles = [];
    sparks = [];
    me = username;
    running = true;
    resize();
    cancelAnimationFrame(raf);
    loop();
  }

  function applyState(state) {
    players = state.players || players;
    stars = state.stars || stars;
    if (state.collected) {
      for (const c of state.collected) {
        burst(c.x, c.y, c.rare ? "#fbbf24" : "#67e8f9", c.rare ? 28 : 14, c.rare);
      }
    }
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  function drawStar(x, y, r, hue, rare, pulse) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * (rare ? 0.04 : 0.02));
    ctx.shadowBlur = rare ? 24 : 14;
    ctx.shadowColor = `hsl(${hue}, 90%, 65%)`;
    ctx.fillStyle = rare ? "#fde68a" : `hsl(${hue}, 90%, 70%)`;
    ctx.beginPath();
    const spikes = 5;
    const outer = r * (1 + pulse * 0.08);
    const inner = outer * 0.45;
    for (let i = 0; i < spikes * 2; i++) {
      const ang = (i * Math.PI) / spikes - Math.PI / 2;
      const rad = i % 2 === 0 ? outer : inner;
      const px = Math.cos(ang) * rad;
      const py = Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function loop() {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    t += 1;
    const c = canvas();
    if (!ctx || !c) return;
    const cw = c._cssW || 1;
    const ch = c._cssH || 1;
    const sx = cw / W;
    const sy = ch / H;

    ctx.clearRect(0, 0, cw, ch);

    const g = ctx.createRadialGradient(cw * 0.5, ch * 0.5, 20, cw * 0.5, ch * 0.5, Math.max(cw, ch) * 0.7);
    g.addColorStop(0, "#15143a");
    g.addColorStop(1, "#05041a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);

    ctx.save();
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < 40; i++) {
      const px = ((i * 97 + t * 0.15) % W) * sx;
      const py = ((i * 53 + t * 0.08) % H) * sy;
      ctx.fillStyle = i % 3 === 0 ? "#a78bfa" : "#fff";
      ctx.beginPath();
      ctx.arc(px, py, i % 5 === 0 ? 1.6 : 1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(124,92,255,0.18)";
    ctx.lineWidth = 2;
    ctx.strokeRect(6, 6, cw - 12, ch - 12);
    ctx.restore();

    for (const star of stars) {
      drawStar(star.x * sx, star.y * sy, star.r * Math.min(sx, sy) * 1.15, star.hue, star.rare, Math.sin(t / 10 + star.x));
    }

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.04;
      p.life -= 0.025;
    }
    particles = particles.filter((p) => p.life > 0);
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x * sx, p.y * sy, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const p of players) {
      const x = p.x * sx;
      const y = p.y * sy;
      const r = 16 * Math.min(sx, sy);

      ctx.save();
      ctx.strokeStyle = `${p.color}55`;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - (p.vx || 0) * 6 * sx, y - (p.vy || 0) * 6 * sy);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.shadowBlur = 22;
      ctx.shadowColor = p.color;
      const glow = ctx.createRadialGradient(x - 4, y - 4, 2, x, y, r + 4);
      glow.addColorStop(0, "#ffffff");
      glow.addColorStop(0.28, p.color);
      glow.addColorStop(1, `${p.color}00`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r + 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.arc(x - r * 0.28, y - r * 0.28, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = "#fff";
      ctx.font = `800 ${Math.max(11, 13 * Math.min(sx, sy))}px Nunito, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText((p.badge ? p.badge + " " : "") + p.username + (p.username === me ? "  (you)" : ""), x, y - r - 8);
      ctx.fillStyle = "#fde68a";
      ctx.fillText(String(p.score || 0), x, y + r + 16);
    }
  }

  window.addEventListener("resize", resize);

  return { start, applyState, stop, resize };
})();

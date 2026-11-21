// Shared drawing helpers (player page + host page).
(function (global) {
  'use strict';

  // Inspector (ghost) colours. Yellow is reserved for dodgers and coins, white for
  // frightened inspectors, so neither appears here.
  const LOOK_COLORS = [
    '#ff4d4d', '#ff9a1f', '#ff5ec8', '#1fc6c6', '#2fd18b', '#a8e64a',
    '#5cc8ff', '#a66bff', '#ff8a7a', '#c08850', '#e040fb', '#3d7cff',
  ];
  const PAC_COLOR = '#ffd300';
  const ACCESSORIES = ['none', 'glasses', 'shades', 'bowtie', 'scarf', 'mustache', 'headphones', 'monocle', 'umbrella', 'flower'];
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];

  function lookOf(i) {
    return { color: LOOK_COLORS[i % LOOK_COLORS.length], acc: ACCESSORIES[Math.floor(i / LOOK_COLORS.length) % ACCESSORIES.length] };
  }

  // Fare dodger: plain yellow chomper; the accessory + name tell players apart.
  function drawPac(ctx, x, y, r, look, dir, mouth) {
    const m = Math.max(0.02, mouth) * 0.28 * Math.PI;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((dir || 0) * Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r, m, Math.PI * 2 - m);
    ctx.closePath();
    ctx.fillStyle = PAC_COLOR;
    ctx.fill();
    ctx.restore();
    drawAccessory(ctx, x, y, r, look.acc, -0.42);
  }

  // Ticket inspector: ghost silhouette with a peaked inspector's cap.
  // mode: 'normal' | 'fright' | 'flash' | 'dead'
  function drawGhost(ctx, x, y, r, look, dir, mode, t) {
    const dead = mode === 'dead';
    const fright = mode === 'fright' || mode === 'flash';
    if (!dead) {
      ctx.beginPath();
      ctx.arc(x, y - r * 0.1, r * 0.9, Math.PI, 0);
      ctx.lineTo(x + r * 0.9, y + r * 0.85);
      const off = Math.floor(t * 8) % 2;
      for (let k = 1; k <= 6; k++) {
        const px = x + r * 0.9 - k * (1.8 * r / 6);
        const py = y + r * 0.85 - ((k + off) % 2 ? r * 0.2 : 0);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = mode === 'flash' ? '#777' : fright ? '#f2f2f2' : look.color;
      ctx.fill();
    }

    if (fright) {
      ctx.fillStyle = '#000';
      ctx.fillRect(x - r * 0.38, y - r * 0.3, r * 0.18, r * 0.18);
      ctx.fillRect(x + r * 0.2, y - r * 0.3, r * 0.18, r * 0.18);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = r * 0.08;
      ctx.beginPath();
      for (let k = 0; k <= 6; k++) {
        const px = x - r * 0.5 + k * r / 6;
        const py = y + r * 0.25 + (k % 2 ? -r * 0.1 : 0);
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    } else {
      const ox = DX[dir || 0] * r * 0.1, oy = DY[dir || 0] * r * 0.1;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(x + s * r * 0.32, y - r * 0.15, r * 0.2, r * 0.25, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + s * r * 0.32 + ox, y - r * 0.15 + oy, r * 0.11, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();
      }
    }

    // Inspector cap: simple black cap with a white peak line.
    ctx.save();
    if (dead) ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, r * 0.07);
    roundRect(ctx, x - r * 0.62, y - r * 1.25, r * 1.24, r * 0.36, r * 0.12);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - r * 0.8, y - r * 0.88);
    ctx.lineTo(x + r * 0.8, y - r * 0.88);
    ctx.stroke();
    ctx.restore();

    if (!dead && !fright) drawAccessory(ctx, x, y, r, look.acc, -0.15);
  }

  // faceY: relative y (in r units) of the eye line.
  function drawAccessory(ctx, x, y, r, acc, faceY) {
    const fy = y + faceY * r;
    ctx.save();
    switch (acc) {
      case 'glasses':
        ctx.strokeStyle = '#111';
        ctx.lineWidth = Math.max(1, r * 0.08);
        for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(x + s * r * 0.32, fy, r * 0.2, 0, Math.PI * 2); ctx.stroke(); }
        ctx.beginPath(); ctx.moveTo(x - r * 0.12, fy); ctx.lineTo(x + r * 0.12, fy); ctx.stroke();
        break;
      case 'shades':
        ctx.fillStyle = '#111';
        for (const s of [-1, 1]) { roundRect(ctx, x + s * r * 0.32 - r * 0.22, fy - r * 0.13, r * 0.44, r * 0.26, r * 0.08); ctx.fill(); }
        ctx.fillRect(x - r * 0.12, fy - r * 0.04, r * 0.24, r * 0.07);
        break;
      case 'bowtie':
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.moveTo(x, y + r * 0.62); ctx.lineTo(x - r * 0.3, y + r * 0.45); ctx.lineTo(x - r * 0.3, y + r * 0.8); ctx.closePath();
        ctx.moveTo(x, y + r * 0.62); ctx.lineTo(x + r * 0.3, y + r * 0.45); ctx.lineTo(x + r * 0.3, y + r * 0.8); ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(x, y + r * 0.62, r * 0.08, 0, Math.PI * 2); ctx.fill();
        break;
      case 'scarf':
        ctx.fillStyle = '#000';
        ctx.fillRect(x - r * 0.78, y + r * 0.32, r * 1.56, r * 0.22);
        ctx.fillRect(x + r * 0.25, y + r * 0.4, r * 0.22, r * 0.55);
        ctx.fillStyle = '#fff';
        for (let k = -2; k <= 2; k++) ctx.fillRect(x + k * r * 0.3, y + r * 0.32, r * 0.07, r * 0.22);
        break;
      case 'mustache':
        ctx.fillStyle = '#000';
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.ellipse(x + s * r * 0.17, fy + r * 0.38, r * 0.2, r * 0.08, s * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      case 'headphones':
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(1.5, r * 0.13);
        ctx.beginPath(); ctx.arc(x, y - r * 0.05, r * 0.98, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
        ctx.fillStyle = '#fff';
        for (const s of [-1, 1]) { roundRect(ctx, x + s * r * 0.95 - r * 0.13, y - r * 0.4, r * 0.26, r * 0.5, r * 0.08); ctx.fill(); }
        break;
      case 'monocle':
        ctx.strokeStyle = '#000';
        ctx.lineWidth = Math.max(1, r * 0.08);
        ctx.beginPath(); ctx.arc(x + r * 0.32, fy, r * 0.22, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = Math.max(0.8, r * 0.04);
        ctx.beginPath(); ctx.moveTo(x + r * 0.52, fy + r * 0.08); ctx.quadraticCurveTo(x + r * 0.7, fy + r * 0.5, x + r * 0.45, fy + r * 0.8); ctx.stroke();
        break;
      case 'umbrella': {
        const ux = x + r * 1.0, uy = y - r * 0.55;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(1, r * 0.07);
        ctx.beginPath(); ctx.moveTo(ux, uy); ctx.lineTo(ux, y + r * 0.35); ctx.arc(ux - r * 0.1, y + r * 0.35, r * 0.1, 0, Math.PI); ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(ux, uy, r * 0.48, Math.PI, 0); ctx.closePath(); ctx.fill();
        break;
      }
      case 'flower': {
        const fx = x - r * 0.72, fy2 = y - r * 0.78;
        ctx.fillStyle = '#fff';
        for (let k = 0; k < 5; k++) {
          const a = k * Math.PI * 2 / 5;
          ctx.beginPath(); ctx.arc(fx + Math.cos(a) * r * 0.15, fy2 + Math.sin(a) * r * 0.15, r * 0.13, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.arc(fx, fy2, r * 0.1, 0, Math.PI * 2); ctx.fill();
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }

  // Oyster coin
  function drawCoin(ctx, x, y, s) {
    ctx.fillStyle = '#ffd300';
    ctx.beginPath(); ctx.arc(x, y, s * 0.1, 0, Math.PI * 2); ctx.fill();
  }

  // Cup of tea (power pellet)
  function drawTea(ctx, x, y, s) {
    const k = s * 0.26;
    ctx.save();
    ctx.strokeStyle = '#e8e8e8';
    ctx.lineWidth = Math.max(1, k * 0.22);
    ctx.beginPath(); ctx.arc(x + k * 0.95, y + k * 0.1, k * 0.36, -Math.PI / 2, Math.PI / 2); ctx.stroke();
    ctx.fillStyle = '#e8e8e8';
    ctx.beginPath();
    ctx.moveTo(x - k, y - k * 0.5);
    ctx.lineTo(x + k, y - k * 0.5);
    ctx.lineTo(x + k * 0.7, y + k * 0.8);
    ctx.lineTo(x - k * 0.7, y + k * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Small avatar for lobby/host. role: 'pac' | 'ghost'
  function drawAvatar(canvas, lookIndex, role) {
    const dpr = global.devicePixelRatio || 1;
    const size = canvas.clientWidth || canvas.width;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const look = lookOf(lookIndex);
    if (role === 'ghost') drawGhost(ctx, size / 2, size * 0.58, size * 0.3, look, 0, 'normal', 0);
    else drawPac(ctx, size * 0.46, size * 0.55, size * 0.3, look, 0, 0.6);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Leaderboard HTML. highlightId: entity id of the viewer (or null).
  function boardHtml(rows, role, highlightId, limit) {
    const head = role === 'pac'
      ? '<tr><th></th><th>Name</th><th>Coins</th><th>Tea</th><th>Eaten</th><th>Pts</th></tr>'
      : '<tr><th></th><th>Name</th><th>Catches</th><th>Eaten</th><th>Pts</th></tr>';
    const line = (row, i) => {
      const me = row.id !== null && row.id === highlightId ? ' class="me"' : '';
      const color = role === 'pac' ? PAC_COLOR : lookOf(row.look).color;
      const name = `<span class="dot" style="background:${color}"></span>${escapeHtml(row.name)}`;
      return role === 'pac'
        ? `<tr${me}><td>${i + 1}</td><td>${name}</td><td>${row.coins}</td><td>${row.teas}</td><td>${row.ghosts}</td><td>${row.score}</td></tr>`
        : `<tr${me}><td>${i + 1}</td><td>${name}</td><td>${row.catches}</td><td>${row.eaten}</td><td>${row.score}</td></tr>`;
    };
    let body = rows.slice(0, limit).map(line).join('');
    const myIdx = highlightId === null ? -1 : rows.findIndex((r) => r.id === highlightId);
    if (myIdx >= limit) body += `<tr class="gap"><td colspan="6">…</td></tr>` + line(rows[myIdx], myIdx);
    if (!rows.length) body = '<tr><td colspan="6">Nobody</td></tr>';
    return `<table>${head}${body}</table>`;
  }

  global.FD = { LOOK_COLORS, PAC_COLOR, ACCESSORIES, DX, DY, lookOf, drawPac, drawGhost, drawAccessory, drawCoin, drawTea, drawAvatar, roundRect, escapeHtml, boardHtml };
})(window);

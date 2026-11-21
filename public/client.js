(() => {
  'use strict';
  const { lookOf, drawPac, drawGhost, drawCoin, drawTea, drawAvatar, escapeHtml, boardHtml } = FD;
  const $ = (s) => document.querySelector(s);

  // Tile codes (must match server)
  const T = { EMPTY: 0, WALL: 1, PELLET: 2, POWER: 3, DOOR: 4, HOUSE: 5, HWALL: 6 };
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const BASE = 24;          // px per tile in the prerendered layers
  const LAG_S = 0.15;       // others are drawn ~this far behind their newest position
  const SEND_MS = 33;       // how often we report our position (~30 Hz)
  const isTouch = window.matchMedia('(pointer: coarse)').matches;

  // ------------------------------------------------------------ session
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  // Session token is per tab (survives reloads, but two tabs = two players).
  let token = null;
  try { token = sessionStorage.getItem('fd_token'); } catch { /* ignore */ }
  if (!token) {
    token = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    try { sessionStorage.setItem('fd_token', token); } catch { /* ignore */ }
  }

  const socket = io();
  const me = { joined: false, name: store.get('fd_name') || '', look: 0 };
  let round = null;
  let lastLobby = null;

  function show(id) {
    for (const s of ['join', 'lobby', 'game']) $('#' + s).classList.toggle('hidden', s !== id);
    $('#end').classList.add('hidden');
  }

  // ------------------------------------------------------------ join + lobby
  $('#name').value = me.name;
  $('#joinForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = $('#name').value.trim();
    if (!name) return;
    $('#joinError').textContent = '';
    $('#name').blur();
    socket.emit('join', { name, token }, onJoined);
  });

  function onJoined(res) {
    if (!res || !res.ok) {
      me.joined = false;
      round = null;
      show('join');
      $('#joinError').textContent = (res && res.error) || 'Could not join.';
      return;
    }
    me.joined = true;
    me.name = res.name;
    me.look = res.look;
    store.set('fd_name', me.name);
    // A roundStart / roundEnd (if any) arrives right after this and takes over the screen.
    if (!round && $('#end').classList.contains('hidden')) renderLobby();
  }

  socket.on('connect', () => {
    if (me.joined) socket.emit('join', { name: me.name, token }, onJoined);
  });
  socket.on('disconnect', (reason) => {
    if (reason !== 'io server disconnect') return; // normal drops auto-reconnect
    me.joined = false;
    round = null;
    show('join');
    $('#joinError').textContent = 'You joined from another tab. Reload to play here.';
  });

  socket.on('lobby', (data) => {
    lastLobby = data;
    updateLobbyText();
  });

  function renderLobby() {
    show('lobby');
    $('#lobbyName').textContent = me.name;
    requestAnimationFrame(() => drawAvatar($('#lobbyAvatar'), me.look, 'pac'));
    updateLobbyText();
  }

  function updateLobbyText() {
    if (!lastLobby) return;
    $('#lobbyCount').textContent = `${lastLobby.count} player${lastLobby.count === 1 ? '' : 's'}`;
  }

  // ------------------------------------------------------------ round lifecycle
  socket.on('roundStart', (d) => {
    const tiles = new Uint8Array(d.tiles.length);
    const powers = [];
    for (let i = 0; i < d.tiles.length; i++) {
      tiles[i] = d.tiles.charCodeAt(i) - 48;
      if (tiles[i] === T.POWER) powers.push(i);
    }
    const ents = [];
    for (const e of d.ents) ents[e.id] = { ...e, lookObj: lookOf(e.look) };
    const mine = d.you !== null ? ents[d.you] : null;
    round = {
      W: d.W, H: d.H, bx: d.bx, by: d.by, tiles, powers, houses: d.houses, ents,
      you: d.you, role: mine ? mine.role : null, speeds: d.speeds,
      total: d.total, left: d.left, pacsAlive: ents.filter((e) => e && e.role === 'pac').length,
      remotes: new Map(), tickNo: 0, fr: 0, sd: false, state: 'countdown',
      countdownEnd: performance.now() + d.startIn,
      watch: null, mini: { mt: null, mp: null, mg: null }, miniAt: 0,
      // Our own character, simulated locally for instant response.
      me: d.pos ? { x: d.pos[0], y: d.pos[1], dir: d.pos[2], tp: d.pos[3], next: null, moving: false,
        st: 0, f: 0, score: 0, resp: 0, corr: 0, sentAt: 0, sentX: NaN, sentY: NaN } : null,
      hud: {},
    };
    round.mazeImg = prerenderMaze(round);
    round.coinImg = prerenderCoins(round);
    round.miniImg = prerenderMini(round);
    $('#feed').innerHTML = '';
    show('game');
    resize();
    updateHud();
  });

  socket.on('roundAbort', () => {
    round = null;
    if (me.joined) renderLobby();
  });

  socket.on('tick', (d) => {
    const r = round;
    if (!r || r.state === 'ended') return;
    const now = performance.now();

    // Other characters: add each new position to that character's path; the render loop
    // glides along the path at a steady speed (see moveRemotes), so uneven network
    // timing never shows up as jitter.
    r.tickNo++;
    const u16 = new Uint16Array(d.b);
    for (let i = 0; i + 3 < u16.length; i += 4) {
      const id = u16[i], x = u16[i + 1] / 100, y = u16[i + 2] / 100, f = u16[i + 3];
      let rem = r.remotes.get(id);
      if (!rem) {
        rem = { x, y, path: [], f, seen: r.tickNo };
        r.remotes.set(id, rem);
        continue;
      }
      rem.f = f;
      rem.seen = r.tickNo;
      const last = rem.path.length ? rem.path[rem.path.length - 1] : [rem.x, rem.y];
      if (last[0] === x && last[1] === y) continue;
      if (Math.abs(last[0] - x) + Math.abs(last[1] - y) > 3) { // teleport / long gap: jump
        rem.x = x; rem.y = y; rem.path = [];
        continue;
      }
      // Characters only turn on tile centres, so add the corner instead of cutting it.
      const onRow = (v) => Math.abs(v - Math.round(v)) < 0.01;
      if (last[0] !== x && last[1] !== y) {
        if (onRow(last[1]) && onRow(x)) rem.path.push([Math.round(x), Math.round(last[1])]);
        else if (onRow(last[0]) && onRow(y)) rem.path.push([Math.round(last[0]), Math.round(y)]);
      }
      rem.path.push([x, y]);
      if (rem.path.length > 12) { const p = rem.path[rem.path.length - 1]; rem.x = p[0]; rem.y = p[1]; rem.path = []; }
    }
    for (const [id, rem] of r.remotes) if (r.tickNo - rem.seen > 2) r.remotes.delete(id); // left view / caught

    for (const i of d.p) {
      if (r.tiles[i] === T.PELLET) clearCoin(r, i);
      r.tiles[i] = T.EMPTY;
    }
    if (d.p.length) r.powers = r.powers.filter((i) => r.tiles[i] === T.POWER);
    r.left = d.l;
    r.pacsAlive = d.pa;
    r.fr = d.fr;
    r.sd = !!d.sd;
    r.state = d.s;
    if (d.s === 'countdown') r.countdownEnd = now + d.c;
    if (d.w !== undefined) r.watch = d.w;
    if (d.mt) r.mini.mt = new Uint8Array(d.mt);
    if (d.mp) r.mini.mp = new Uint8Array(d.mp);
    if (d.mg) r.mini.mg = new Uint8Array(d.mg);

    if (d.me && r.me) {
      const p = r.me;
      const [sx, sy, f, score, resp, tp] = d.me;
      p.f = f;
      p.st = (f >> 4) & 3;
      p.score = score;
      p.resp = resp;
      // Teleported (eaten → station) or not moving under our control: follow the server.
      if (tp !== p.tp || p.st !== 0) {
        p.x = sx / 100; p.y = sy / 100; p.tp = tp; p.moving = false; p.next = null; p.started = false;
      }
    }
    for (const ev of d.ev) pushFeed(ev);
    updateHud();
  });

  // Server rejected a move (e.g. desync): snap back.
  socket.on('correct', (c) => {
    if (!round || !round.me) return;
    Object.assign(round.me, { x: c.x, y: c.y, dir: c.d, tp: c.tp, corr: c.c, sentX: NaN, sentY: NaN });
  });

  socket.on('roundEnd', (res) => {
    const myId = round ? round.you : null;
    if (round) round.state = 'ended';
    $('#endTitle').textContent = res.winner === 'pac' ? 'Fare dodgers win' : 'Inspectors win';
    $('#endSub').textContent = res.winner === 'pac'
      ? 'Every coin collected.'
      : `Every dodger caught. ${res.left} coin${res.left === 1 ? '' : 's'} left.`;
    $('#pacBoard').innerHTML = boardHtml(res.pacBoard, 'pac', myId, 10);
    $('#ghostBoard').innerHTML = boardHtml(res.ghostBoard, 'ghost', myId, 10);
    if (!round) show('lobby'); // joined while results were showing
    $('#end').classList.remove('hidden');
  });

  // ------------------------------------------------------------ HUD
  function nameOf(id) {
    const e = round && round.ents[id];
    return e ? escapeHtml(e.name) : '?';
  }

  function pushFeed(ev) {
    let html;
    if (ev.t === 'catch') html = `<b>${nameOf(ev.g)}</b> caught <b>${nameOf(ev.p)}</b>`;
    else if (ev.t === 'eat') html = `<b>${nameOf(ev.p)}</b> sent <b>${nameOf(ev.g)}</b> back`;
    else if (ev.t === 'tea') html = `<b>${nameOf(ev.p)}</b> had tea`;
    if (!html) return;
    const feed = $('#feed');
    const li = document.createElement('li');
    li.innerHTML = html;
    feed.prepend(li);
    while (feed.children.length > 3) feed.lastChild.remove();
    setTimeout(() => li.remove(), 4000);
  }

  // Only touch the DOM when something actually changed.
  function setHud(key, el, prop, value) {
    if (round.hud[key] === value) return;
    round.hud[key] = value;
    el[prop] = value;
  }

  function updateHud() {
    const r = round;
    if (!r) return;
    const mine = r.you !== null ? r.ents[r.you] : null;
    const roleHtml = mine
      ? `<b>${mine.role === 'pac' ? 'Dodger' : 'Inspector'}</b> &nbsp;${r.me ? r.me.score : 0}`
      : 'Spectating';
    setHud('role', $('#role'), 'innerHTML', roleHtml);
    setHud('roleClass', $('#role'), 'className', mine ? mine.role : '');
    const pacs = r.ents.reduce((n, e) => n + (e && e.role === 'pac' ? 1 : 0), 0);
    setHud('info', $('#info'), 'textContent', `${r.pacsAlive}/${pacs} dodgers · ${r.left} coins`);
    setHud('bar', $('#progressFill').style, 'width', `${(100 * (r.total - r.left) / Math.max(1, r.total)).toFixed(1)}%`);

    let msg = '';
    if (r.fr > 0) msg = (mine && mine.role === 'ghost' ? 'Run! ' : 'Inspectors frightened ') + Math.ceil(r.fr / 1000) + 's';
    else if (r.sd) msg = 'Sudden death: last coins shown on map';
    setHud('notice', $('#notice'), 'textContent', msg);
    const spectating = !r.me || r.me.st === 1;
    $('#notice').classList.toggle('hidden', !msg || spectating);
    $('#notice').classList.toggle('warn', !r.fr && r.sd);
  }

  // ------------------------------------------------------------ prerendered layers
  function prerenderMaze(r) {
    const c = document.createElement('canvas');
    c.width = r.W * BASE;
    c.height = r.H * BASE;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    const at = (x, y) => (x < 0 || y < 0 || x >= r.W || y >= r.H ? -1 : r.tiles[y * r.W + x]);
    const isWall = (x, y) => at(x, y) === T.WALL;
    const isH = (x, y) => at(x, y) === T.HWALL;
    const cx = (x) => x * BASE + BASE / 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Walls: thin white lines (a line-map look), drawn as one path.
    ctx.strokeStyle = '#e6e6e6';
    ctx.lineWidth = BASE * 0.14;
    ctx.beginPath();
    for (let y = 0; y < r.H; y++) {
      for (let x = 0; x < r.W; x++) {
        if (!isWall(x, y)) continue;
        ctx.moveTo(cx(x), cx(y));
        ctx.lineTo(cx(x), cx(y));
        if (isWall(x + 1, y)) { ctx.moveTo(cx(x), cx(y)); ctx.lineTo(cx(x + 1), cx(y)); }
        if (isWall(x, y + 1)) { ctx.moveTo(cx(x), cx(y)); ctx.lineTo(cx(x), cx(y + 1)); }
      }
    }
    ctx.stroke();

    // Stations (ghost houses): double outline + name.
    ctx.strokeStyle = '#e6e6e6';
    ctx.lineWidth = BASE * 0.14;
    ctx.beginPath();
    for (let y = 0; y < r.H; y++) {
      for (let x = 0; x < r.W; x++) {
        if (!isH(x, y)) continue;
        if (isH(x + 1, y)) { ctx.moveTo(cx(x), cx(y)); ctx.lineTo(cx(x + 1), cx(y)); }
        if (isH(x, y + 1)) { ctx.moveTo(cx(x), cx(y)); ctx.lineTo(cx(x), cx(y + 1)); }
      }
    }
    ctx.stroke();
    for (const h of r.houses) {
      const [dx, dy] = h.door;
      ctx.strokeStyle = 'rgba(232,232,232,0.35)';
      ctx.setLineDash([BASE * 0.15, BASE * 0.15]);
      ctx.beginPath();
      ctx.moveTo(cx(dx - 1), cx(dy));
      ctx.lineTo(cx(dx + 1), cx(dy));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(232,232,232,0.28)';
      ctx.font = `${BASE * 0.42}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(h.name.toUpperCase(), (h.x + h.w / 2) * BASE, (h.y + h.h / 2) * BASE);
    }
    return c;
  }

  // Coins live on their own transparent layer; eaten ones are erased, so a frame
  // costs one drawImage instead of hundreds of circles.
  function prerenderCoins(r) {
    const c = document.createElement('canvas');
    c.width = r.W * BASE;
    c.height = r.H * BASE;
    const ctx = c.getContext('2d');
    for (let i = 0; i < r.tiles.length; i++) {
      if (r.tiles[i] !== T.PELLET) continue;
      const x = i % r.W, y = (i / r.W) | 0;
      drawCoin(ctx, (x + 0.5) * BASE, (y + 0.5) * BASE, BASE);
    }
    return c;
  }

  function clearCoin(r, i) {
    const x = i % r.W, y = (i / r.W) | 0;
    r.coinImg.getContext('2d').clearRect(x * BASE, y * BASE, BASE, BASE);
  }

  function prerenderMini(r) {
    const c = document.createElement('canvas');
    c.width = r.W;
    c.height = r.H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect(0, 0, r.W, r.H);
    for (let y = 0; y < r.H; y++) {
      for (let x = 0; x < r.W; x++) {
        const v = r.tiles[y * r.W + x];
        if (v === T.WALL) { ctx.fillStyle = '#333'; ctx.fillRect(x, y, 1, 1); }
        else if (v === T.HWALL || v === T.DOOR) { ctx.fillStyle = '#888'; ctx.fillRect(x, y, 1, 1); }
      }
    }
    return c;
  }

  // ------------------------------------------------------------ local movement (prediction)
  function canEnter(r, x, y) {
    if (x < 0 || y < 0 || x >= r.W || y >= r.H) return false;
    const v = r.tiles[y * r.W + x];
    if (v === T.WALL || v === T.HWALL) return false;
    if (v === T.DOOR || v === T.HOUSE) return r.role === 'ghost';
    return true;
  }

  // Same rules as the server: keep moving; a chosen turn is buffered until it's possible.
  function stepMe(r, dt) {
    const p = r.me;
    const fright = !!(p.f & 8);
    const speed = r.role === 'pac' ? r.speeds.pac : fright ? r.speeds.fright : r.speeds.ghost;
    let d = speed * dt;
    for (let guard = 0; d > 1e-9 && guard < 10; guard++) {
      const cx = Math.round(p.x), cy = Math.round(p.y);
      if (Math.abs(p.x - cx) < 1e-6 && Math.abs(p.y - cy) < 1e-6) {
        p.x = cx; p.y = cy;
        if (p.next !== null && canEnter(r, cx + DX[p.next], cy + DY[p.next])) { p.dir = p.next; p.next = null; p.started = true; }
        // Stand still until the first valid direction, and stop at walls.
        if (!p.started || !canEnter(r, cx + DX[p.dir], cy + DY[p.dir])) { p.moving = false; break; }
        p.moving = true;
      } else if (p.next !== null && p.next === (p.dir + 2) % 4) {
        p.dir = p.next;
        p.next = null;
      }
      const horiz = p.dir % 2 === 0;
      const sgn = p.dir === 0 || p.dir === 1 ? 1 : -1;
      const v = horiz ? p.x : p.y;
      const target = sgn > 0 ? Math.floor(v + 1e-6) + 1 : Math.ceil(v - 1e-6) - 1;
      const dist = Math.abs(target - v);
      let nv;
      if (d >= dist) { nv = target; d -= dist; } else { nv = v + sgn * d; d = 0; }
      if (horiz) p.x = nv; else p.y = nv;
    }
  }

  function sendPos(r, now) {
    const p = r.me;
    const tileChanged = Math.round(p.x) !== Math.round(p.sentX) || Math.round(p.y) !== Math.round(p.sentY);
    const moved = p.x !== p.sentX || p.y !== p.sentY;
    if (!moved || (!tileChanged && now - p.sentAt < SEND_MS)) return;
    p.sentAt = now;
    p.sentX = p.x;
    p.sentY = p.y;
    socket.emit('pos', { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000, d: p.dir, m: p.moving ? 1 : 0, tp: p.tp, c: p.corr });
  }

  function setDir(d) {
    const r = round;
    if (!r || !r.me) return;
    r.me.next = d;
  }

  // ------------------------------------------------------------ canvas + camera
  const view = $('#view');
  const ctx = view.getContext('2d', { alpha: false });
  const mini = $('#minimap');
  const mctx = mini.getContext('2d');
  let vw = 0, vh = 0, dpr = 1, tilePx = 28;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    vw = window.innerWidth;
    vh = window.innerHeight;
    view.width = Math.round(vw * dpr);
    view.height = Math.round(vh * dpr);
    view.style.width = vw + 'px';
    view.style.height = vh + 'px';
    tilePx = Math.max(18, Math.min(32, Math.min(vw, vh) / 14));
    if (round) {
      const maxW = Math.min(170, vw * 0.36), maxH = Math.min(130, vh * 0.22);
      const s = Math.min(maxW / round.W, maxH / round.H);
      mini.width = Math.round(round.W * s * dpr);
      mini.height = Math.round(round.H * s * dpr);
      mini.style.width = Math.round(round.W * s) + 'px';
      mini.style.height = Math.round(round.H * s) + 'px';
      round.miniAt = 0;
      socket.emit('view', { hw: vw / 2 / tilePx, hh: vh / 2 / tilePx });
    }
  }
  window.addEventListener('resize', resize);
  resize();

  // Glide every other character along its received path at its real speed, nudged
  // slightly faster/slower to keep about LAG_S seconds behind the newest position.
  function moveRemotes(r, dt) {
    for (const [id, rem] of r.remotes) {
      if (!rem.path.length) continue;
      const e = r.ents[id];
      const base = e && e.role === 'pac' ? r.speeds.pac : (rem.f & 8) ? r.speeds.fright : r.speeds.ghost;
      let backlog = 0, px = rem.x, py = rem.y;
      for (const [x, y] of rem.path) { backlog += Math.abs(x - px) + Math.abs(y - py); px = x; py = y; }
      // Smooth the backlog so each new packet doesn't cause a speed bump, then
      // gently speed up / slow down to hold a steady buffer.
      const err = backlog - base * LAG_S;
      rem.err = rem.err === undefined ? err : rem.err + (err - rem.err) * Math.min(1, dt * 2);
      let speed = base * (1 + Math.max(-0.15, Math.min(0.3, rem.err / base)));
      if (backlog > base * 0.6) speed = base * 1.8; // far behind (e.g. after a hiccup): catch up quickly
      let d = speed * dt;
      while (d > 0 && rem.path.length) {
        const [tx, ty] = rem.path[0];
        const dist = Math.abs(tx - rem.x) + Math.abs(ty - rem.y);
        if (dist <= d) { rem.x = tx; rem.y = ty; d -= dist; rem.path.shift(); }
        else { rem.x += Math.sign(tx - rem.x) * Math.min(d, Math.abs(tx - rem.x)); rem.y += Math.sign(ty - rem.y) * Math.min(d, Math.abs(ty - rem.y)); d = 0; }
      }
    }
  }

  $('#specPrev').addEventListener('click', () => socket.emit('watch', -1));
  $('#specNext').addEventListener('click', () => socket.emit('watch', 1));

  // ------------------------------------------------------------ render loop
  let lastFrame = performance.now();
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!round || $('#game').classList.contains('hidden')) return;
    const r = round;
    const t = now / 1000;

    // Move our own character immediately (no waiting for the server).
    const meAlive = r.me && r.me.st === 0;
    if (meAlive && r.state === 'playing') {
      stepMe(r, dt);
      sendPos(r, now);
    }

    moveRemotes(r, dt);
    const others = r.remotes;
    const spectating = !r.me || r.me.st === 1;
    toggle($('#dpad'), 'hidden', !(isTouch && !spectating && r.state !== 'ended'));
    toggle($('#spectate'), 'hidden', !spectating || r.state === 'ended' || r.watch === null);
    if (spectating && r.watch !== null && r.ents[r.watch]) setHud('spec', $('#specName'), 'textContent', r.ents[r.watch].name);

    // camera
    let camX = r.W / 2, camY = r.H / 2;
    if (!spectating) { camX = r.me.x + 0.5; camY = r.me.y + 0.5; }
    else if (r.watch !== null && others.has(r.watch)) { const w = others.get(r.watch); camX = w.x + 0.5; camY = w.y + 0.5; }
    const pad = 2;
    const halfW = vw / 2 / tilePx, halfH = vh / 2 / tilePx;
    camX = r.W + pad * 2 <= halfW * 2 ? r.W / 2 : Math.max(halfW - pad, Math.min(r.W + pad - halfW, camX));
    camY = r.H + pad * 2 <= halfH * 2 ? r.H / 2 : Math.max(halfH - pad, Math.min(r.H + pad - halfH, camY));
    // Snap the camera to whole device pixels to avoid shimmering.
    const ox = Math.round((vw / 2 - camX * tilePx) * dpr) / dpr;
    const oy = Math.round((vh / 2 - camY * tilePx) * dpr) / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, vw, vh);

    // maze + coins: visible part of two prerendered layers
    const scale = tilePx / BASE;
    const sx = Math.max(0, -ox / scale), sy = Math.max(0, -oy / scale);
    const sw = Math.min(r.mazeImg.width - sx, vw / scale), sh = Math.min(r.mazeImg.height - sy, vh / scale);
    if (sw > 0 && sh > 0) {
      ctx.drawImage(r.mazeImg, sx, sy, sw, sh, ox + sx * scale, oy + sy * scale, sw * scale, sh * scale);
      ctx.drawImage(r.coinImg, sx, sy, sw, sh, ox + sx * scale, oy + sy * scale, sw * scale, sh * scale);
    }
    for (const i of r.powers) {
      const x = i % r.W, y = (i / r.W) | 0;
      const px = ox + (x + 0.5) * tilePx, py = oy + (y + 0.5) * tilePx;
      if (px > -tilePx && py > -tilePx && px < vw + tilePx && py < vh + tilePx) drawTea(ctx, px, py, tilePx);
    }

    // characters: inspectors, then dodgers, then you on top
    const rad = tilePx * 0.44;
    const margin = tilePx * 2;
    const fs = Math.max(10, Math.round(tilePx * 0.38));
    ctx.font = `${fs}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const drawOne = (e, x, y, f, mine) => {
      const px = ox + (x + 0.5) * tilePx, py = oy + (y + 0.5) * tilePx;
      if (px < -margin || py < -margin || px > vw + margin || py > vh + margin) return;
      const dir = f & 3, moving = !!(f & 4), fright = !!(f & 8), st = (f >> 4) & 3;
      if (st === 1) return;
      if (mine) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, rad * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (e.role === 'pac') {
        drawPac(ctx, px, py, rad, e.lookObj, dir, moving ? Math.abs(Math.sin(t * 14 + e.id)) : 0.35);
      } else {
        let mode = 'normal';
        if (st === 2) mode = 'dead';
        else if (fright) mode = r.fr < 2000 && Math.floor(t * 6) % 2 ? 'flash' : 'fright';
        drawGhost(ctx, px, py, rad, e.lookObj, dir, mode, t + e.id);
      }
      const ty = py - rad * (e.role === 'ghost' ? 1.45 : 1.2);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(e.name, px + 1, ty + 1);
      ctx.fillStyle = mine ? '#fff' : 'rgba(255,255,255,0.6)';
      ctx.fillText(e.name, px, ty);
    };
    for (const pass of ['ghost', 'pac']) {
      for (const [id, s] of others) {
        const e = r.ents[id];
        if (e && e.role === pass && id !== r.you) drawOne(e, s.x, s.y, s.f, false);
      }
    }
    if (r.me && !spectating) {
      const p = r.me;
      const f = (p.dir & 3) | (p.moving ? 4 : 0) | (p.f & 8) | (p.st << 4);
      drawOne(r.ents[r.you], p.x, p.y, f, true);
    }

    if (now - r.miniAt > 150) { r.miniAt = now; drawMinimap(t); }
    drawCenter(now);
  }

  function toggle(el, cls, on) {
    if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
  }

  function drawMinimap(t) {
    const r = round;
    const w = mini.width, h = mini.height;
    const s = w / r.W;
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.imageSmoothingEnabled = false;
    mctx.clearRect(0, 0, w, h);
    mctx.drawImage(r.miniImg, 0, 0, w, h);
    const sq = (x, y, d, color) => { mctx.fillStyle = color; mctx.fillRect((x + 0.5) * s - d / 2, (y + 0.5) * s - d / 2, d, d); };
    for (const i of r.powers) sq(i % r.W, (i / r.W) | 0, Math.max(2, s * 1.5), '#bbb');
    if (r.sd && Math.floor(t * 3) % 2 === 0) {
      for (let i = 0; i < r.tiles.length; i++) if (r.tiles[i] === T.PELLET) sq(i % r.W, (i / r.W) | 0, Math.max(3, s * 2.2), '#ffd300');
    }
    const dot = Math.max(2, s * 1.2);
    const plot = (arr, color) => { if (arr) for (let i = 0; i + 1 < arr.length; i += 2) sq(arr[i], arr[i + 1], dot, color); };
    const playing = r.me && r.me.st !== 1;
    if (playing) plot(r.mini.mt, r.role === 'pac' ? '#ffd300' : '#fff'); // teammates only
    else { plot(r.mini.mg, '#fff'); plot(r.mini.mp, '#ffd300'); }
    if (playing) {
      mctx.fillStyle = '#fff';
      mctx.beginPath();
      mctx.arc((r.me.x + 0.5) * s, (r.me.y + 0.5) * s, Math.max(3, s * 1.4), 0, Math.PI * 2);
      mctx.fill();
    }
  }

  function drawCenter(now) {
    const r = round;
    const el = $('#center');
    let html = '';
    const mine = r.you !== null ? r.ents[r.you] : null;
    if (r.state === 'countdown') {
      const n = Math.max(1, Math.ceil((r.countdownEnd - now) / 1000));
      const line = !mine ? 'Round in progress. You join the next one.'
        : mine.role === 'pac' ? 'You are a <b>fare dodger</b>. Collect every coin.'
          : 'You are an <b class="ghost">inspector</b>. Catch every dodger.';
      html = `<div class="big">${n}</div><div>${line}</div>`;
    } else if (r.state === 'playing' && r.me) {
      if (r.me.st === 1) html = '<div>Caught. You\'re spectating.</div>';
      else if (r.me.st === 2) html = `<div>Back on duty in ${Math.ceil(r.me.resp / 1000)}</div>`;
    }
    if (el.dataset.html !== html) {
      el.dataset.html = html;
      el.innerHTML = html;
      el.classList.toggle('hidden', !html);
    }
  }

  requestAnimationFrame(frame);

  // Debug hook for measuring smoothness: open the page with ?debug
  if (location.search.includes('debug')) window.__fd = { get round() { return round; } };

  // ------------------------------------------------------------ input
  // Press a direction once: you keep moving that way. Pressing early queues the turn
  // for the next junction (like the arcade game).
  const KEYS = { ArrowRight: 0, KeyD: 0, ArrowDown: 1, KeyS: 1, ArrowLeft: 2, KeyA: 2, ArrowUp: 3, KeyW: 3 };
  window.addEventListener('keydown', (ev) => {
    if (!round || document.activeElement === $('#name')) return;
    const d = KEYS[ev.code];
    if (d === undefined) return;
    ev.preventDefault();
    setDir(d);
  });

  let touchStart = null;
  const gameEl = $('#game');
  gameEl.addEventListener('touchstart', (ev) => {
    if (ev.target.closest('button')) return;
    const t0 = ev.touches[0];
    touchStart = { x: t0.clientX, y: t0.clientY };
  }, { passive: true });
  gameEl.addEventListener('touchmove', (ev) => {
    if (!touchStart) return;
    ev.preventDefault();
    const t0 = ev.touches[0];
    const dx = t0.clientX - touchStart.x, dy = t0.clientY - touchStart.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
    setDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3));
    touchStart = { x: t0.clientX, y: t0.clientY };
  }, { passive: false });
  gameEl.addEventListener('touchend', () => { touchStart = null; });

  for (const b of document.querySelectorAll('#dpad button')) {
    b.addEventListener('pointerdown', (ev) => { ev.preventDefault(); setDir(Number(b.dataset.dir)); });
  }
})();

'use strict';
const { T, generate, shuffle } = require('./maze');

// Directions: 0 right, 1 down, 2 left, 3 up
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

const CFG = {
  tickMs: 50,         // 20 Hz simulation + network updates
  pacSpeed: 8,        // tiles / second
  ghostSpeed: 7.2,    // 0.9x
  frightSpeed: 4,     // 0.5x
  frightMs: 6000,
  respawnMs: 5000,
  countdownMs: 3000,
  pacRatio: 0.4,
  suddenDeath: 0.05,
  catchDist: 0.65,
  maxLooks: 120,      // 12 colours x 10 accessories
  nameMax: 16,
  pruneAfterMs: 120000,
  viewPad: 3,         // extra tiles sent around each player's screen
  maxView: 40,
  miniEvery: 4,       // minimap positions every N ticks (5 Hz)
  speedSlack: 1.6,    // tolerance when validating client-reported movement (network bursts)
  budgetCap: 4,       // max tiles a client can "bank" for bursty networks
};

const POINTS = { coin: 10, tea: 50, ghost: 200, catch: 300, eaten: -50 };
const ST = { alive: 0, out: 1, dead: 2 };

class Game {
  constructor(io, hostKey) {
    this.io = io;
    this.hostKey = hostKey;
    this.players = new Map(); // token -> player
    this.state = 'lobby';     // lobby | countdown | playing | ended
    this.round = null;
    this.lastResult = null;
    this.lastTick = Date.now();
    this.tickNo = 0;
    this.lobbyDirty = true;

    io.on('connection', (s) => this.onConnection(s));
    setInterval(() => this.tick(), CFG.tickMs);
    setInterval(() => this.flushLobby(), 300);
    setInterval(() => this.sendHostStatus(), 1000);
    setInterval(() => this.prune(), 30000);
  }

  // ---------------------------------------------------------------- sockets
  onConnection(socket) {
    socket.on('join', (data, ack) => this.onJoin(socket, data, typeof ack === 'function' ? ack : () => {}));

    const entFor = () => {
      const r = this.round;
      const e = r && r.byToken.get(socket.data.token);
      return e && e.player.socket === socket ? e : null;
    };
    const playerFor = () => {
      const p = this.players.get(socket.data.token);
      return p && p.socket === socket ? p : null;
    };

    // Players move on their own device and report positions; the server validates.
    socket.on('pos', (m) => this.onPos(socket, entFor(), m));
    // Server-simulated movement (used by bots): set a direction, keep moving.
    socket.on('dir', (d) => {
      const e = entFor();
      if (e && !e.clientAuth && Number.isInteger(d) && d >= 0 && d <= 3) e.next = d;
    });
    socket.on('view', (v) => {
      const p = playerFor();
      if (!p || !v) return;
      const hw = Number(v.hw), hh = Number(v.hh);
      if (!Number.isFinite(hw) || !Number.isFinite(hh)) return;
      p.view = { hw: Math.max(4, Math.min(CFG.maxView, hw)), hh: Math.max(4, Math.min(CFG.maxView, hh)) };
    });
    socket.on('watch', (step) => {
      const p = playerFor();
      if (p && this.round) this.cycleWatch(p, step === -1 ? -1 : 1);
    });

    socket.on('host:auth', (key, ack) => {
      const ok = key === this.hostKey;
      if (ok) {
        socket.data.host = true;
        socket.join('host');
        socket.emit('lobby', this.lobbyPayload());
        this.sendHostStatus();
        if (this.state === 'ended' && this.lastResult) socket.emit('roundEnd', this.lastResult);
      }
      if (typeof ack === 'function') ack({ ok });
    });
    socket.on('host:start', () => { if (socket.data.host) this.startRound(); });
    socket.on('host:stop', () => { if (socket.data.host) this.abortRound(); });

    socket.on('disconnect', () => {
      const p = this.players.get(socket.data.token);
      if (p && p.socket === socket) {
        p.socket = null;
        p.connected = false;
        p.leftAt = Date.now();
        this.lobbyDirty = true;
      }
    });
  }

  onJoin(socket, data, ack) {
    const name = String((data && data.name) || '').replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, CFG.nameMax);
    const token = String((data && data.token) || '').slice(0, 64);
    if (!name) return ack({ ok: false, error: 'Please enter a username.' });
    if (token.length < 8) return ack({ ok: false, error: 'Bad session, please reload.' });

    const lower = name.toLowerCase();
    let takeover = null;
    for (const p of this.players.values()) {
      if (p.token !== token && p.name.toLowerCase() === lower) {
        // A disconnected player's name can be reclaimed (e.g. the phone dropped the tab).
        if (p.connected || this.players.has(token)) return ack({ ok: false, error: 'That username is taken.' });
        takeover = p;
      }
    }
    if (takeover) {
      const oldToken = takeover.token;
      this.players.delete(oldToken);
      takeover.token = token;
      this.players.set(token, takeover);
      const r = this.round;
      if (r && r.byToken.has(oldToken)) {
        r.byToken.set(token, r.byToken.get(oldToken));
        r.byToken.delete(oldToken);
      }
    }

    let p = this.players.get(token);
    const old = p && p.socket;
    if (p) {
      p.name = name;
    } else {
      p = { token, name, look: this.allocLook(), socket: null, connected: false, leftAt: 0, view: null, watch: null };
      this.players.set(token, p);
    }
    p.socket = socket;
    p.connected = true;
    p.leftAt = 0;
    socket.data.token = token;
    socket.join('players');
    if (old && old !== socket) old.disconnect(true);

    ack({ ok: true, name: p.name, look: p.look, state: this.state });

    if (this.round && (this.state === 'countdown' || this.state === 'playing')) {
      socket.emit('roundStart', this.roundPayload(p));
    } else if (this.state === 'ended' && this.lastResult) {
      socket.emit('roundEnd', this.lastResult);
    }
    this.lobbyDirty = true;
  }

  allocLook() {
    const used = new Set([...this.players.values()].map((p) => p.look));
    for (let i = 0; i < CFG.maxLooks; i++) if (!used.has(i)) return i;
    return Math.floor(Math.random() * CFG.maxLooks);
  }

  // ---------------------------------------------------------------- lobby
  lobbyPayload() {
    const players = [...this.players.values()].filter((p) => p.connected).map((p) => ({ name: p.name, look: p.look }));
    return { state: this.state, count: players.length, players };
  }

  flushLobby() {
    if (!this.lobbyDirty) return;
    this.lobbyDirty = false;
    const payload = this.lobbyPayload();
    this.io.to('players').emit('lobby', payload);
    this.io.to('host').emit('lobby', payload);
  }

  sendHostStatus() {
    const r = this.round;
    // Nobody from this round is still connected: don't leave an orphan round running.
    if (r && !r.ents.some((e) => e.player.connected)) { this.abortRound(); return; }
    const status = { state: this.state, players: this.lobbyPayload().count };
    if (r) {
      status.total = r.total;
      status.left = r.left;
      status.pacs = r.ents.filter((e) => e.role === 'pac').length;
      status.ghosts = r.ents.length - status.pacs;
      status.pacsAlive = r.ents.filter((e) => e.role === 'pac' && e.st === 'alive').length;
      status.map = `${r.maze.W}x${r.maze.H}`;
      status.suddenDeath = r.suddenDeath;
    }
    this.io.to('host').emit('hostStatus', status);
  }

  prune() {
    const now = Date.now();
    for (const [token, p] of this.players) {
      const inRound = this.round && this.round.byToken.has(token);
      if (!p.connected && !inRound && now - p.leftAt > CFG.pruneAfterMs) this.players.delete(token);
    }
    this.lobbyDirty = true;
  }

  // ---------------------------------------------------------------- rounds
  startRound() {
    if (this.state === 'countdown' || this.state === 'playing') return;
    const ps = shuffle([...this.players.values()].filter((p) => p.connected));
    if (ps.length < 2) {
      this.io.to('host').emit('hostError', 'Need at least 2 players to start.');
      return;
    }

    const nPac = Math.min(ps.length - 1, Math.max(1, Math.round(ps.length * CFG.pacRatio)));
    const maze = generate(ps.length);
    const ents = [];
    const byToken = new Map();
    const houseFill = maze.houses.map(() => 0);

    ps.forEach((p, i) => {
      const role = i < nPac ? 'pac' : 'ghost';
      let x, y, house = null;
      if (role === 'pac') {
        [x, y] = maze.pacSpawns[Math.floor(i * maze.pacSpawns.length / nPac)];
      } else {
        const g = i - nPac;
        const hi = g % maze.houses.length;
        house = maze.houses[hi];
        [x, y] = house.spawns[houseFill[hi]++ % house.spawns.length];
      }
      const e = {
        id: i, player: p, role, x, y,
        dir: role === 'pac' ? 0 : 3, moving: false, next: null,
        clientAuth: false, budget: CFG.budgetCap, lastPosAt: 0, tp: 0, corr: 0,
        st: 'alive', frightened: false, respawnAt: 0, house,
        score: 0, coins: 0, teas: 0, ghosts: 0, catches: 0, eaten: 0,
      };
      ents.push(e);
      byToken.set(p.token, e);
    });
    for (const p of this.players.values()) p.watch = null;

    let total = 0;
    for (const v of maze.tiles) if (v === T.PELLET || v === T.POWER) total++;

    this.round = {
      maze, ents, byToken, total, left: total,
      frightUntil: 0, startAt: Date.now() + CFG.countdownMs,
      eaten: [], events: [], suddenDeath: false,
    };
    this.state = 'countdown';
    this.lastResult = null;
    this.lastTick = Date.now();

    const tilesStr = Array.from(maze.tiles).join('');
    for (const p of this.players.values()) if (p.socket) p.socket.emit('roundStart', this.roundPayload(p, tilesStr));
    this.lobbyDirty = true;
    this.sendHostStatus();
  }

  roundPayload(p, tilesStr) {
    const r = this.round;
    const m = r.maze;
    const e = r.byToken.get(p.token);
    return {
      W: m.W, H: m.H, bx: m.bx, by: m.by,
      tiles: tilesStr || Array.from(m.tiles).join(''),
      houses: m.houses.map((h) => ({ x: h.x, y: h.y, w: h.w, h: h.h, door: h.door, name: h.name })),
      ents: r.ents.map((x) => ({ id: x.id, name: x.player.name, look: x.player.look, role: x.role })),
      you: e ? e.id : null,
      pos: e ? [e.x, e.y, e.dir, e.tp] : null,
      speeds: { pac: CFG.pacSpeed, ghost: CFG.ghostSpeed, fright: CFG.frightSpeed },
      startIn: Math.max(0, r.startAt - Date.now()),
      total: r.total,
      left: r.left,
    };
  }

  abortRound() {
    if (!this.round && this.state !== 'ended') return;
    this.round = null;
    this.lastResult = null;
    this.state = 'lobby';
    this.io.to('players').emit('roundAbort');
    this.lobbyDirty = true;
    this.sendHostStatus();
  }

  endRound(winner) {
    const r = this.round;
    const board = (role) => r.ents.filter((e) => e.role === role).sort((a, b) => b.score - a.score).map((e) => ({
      id: e.id, name: e.player.name, look: e.player.look, score: e.score,
      coins: e.coins, teas: e.teas, ghosts: e.ghosts, catches: e.catches, eaten: e.eaten,
      survived: e.st === 'alive',
    }));
    this.lastResult = { winner, pacBoard: board('pac'), ghostBoard: board('ghost'), total: r.total, left: r.left };
    this.state = 'ended';
    this.round = null;
    this.io.to('players').emit('roundEnd', this.lastResult);
    this.io.to('host').emit('roundEnd', this.lastResult);
    this.lobbyDirty = true;
    this.sendHostStatus();
  }

  // ---------------------------------------------------------------- spectating
  watchTarget(p) {
    const r = this.round;
    const cur = p.watch !== null ? r.ents[p.watch] : null;
    if (cur && cur.st !== 'out') return cur;
    const next = r.ents.find((e) => e.role === 'pac' && e.st !== 'out') || r.ents.find((e) => e.st !== 'out') || null;
    p.watch = next ? next.id : null;
    return next;
  }

  cycleWatch(p, step) {
    const live = this.round.ents.filter((e) => e.st !== 'out');
    if (!live.length) return;
    const i = live.findIndex((e) => e.id === p.watch);
    p.watch = live[(i + step + live.length) % live.length].id;
  }

  // ---------------------------------------------------------------- movement
  speedOf(e) {
    return e.role === 'pac' ? CFG.pacSpeed : e.frightened ? CFG.frightSpeed : CFG.ghostSpeed;
  }

  canEnter(e, x, y) {
    const m = this.round.maze;
    if (x < 0 || y < 0 || x >= m.W || y >= m.H) return false;
    const v = m.tiles[y * m.W + x];
    if (v === T.WALL || v === T.HWALL) return false;
    if (v === T.DOOR || v === T.HOUSE) return e.role === 'ghost';
    return true;
  }

  // Validate a client-reported position: on the grid, through open tiles, within speed.
  onPos(socket, e, m) {
    const r = this.round;
    if (!e || !r || this.state !== 'playing' || e.st !== 'alive' || !m) return;
    const x = Number(m.x), y = Number(m.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    e.clientAuth = true;
    if (m.tp !== e.tp) return; // client hasn't caught up with a teleport yet
    if (m.c !== e.corr) return; // sent before our last correction reached the client: stale

    const now = Date.now();
    const reject = (why) => {
      if (process.env.DEBUG_POS) console.log(`reject ${e.player.name}: ${why}`, { from: [e.x, e.y], to: [x, y], budget: +e.budget.toFixed(2) });
      e.corr++;
      socket.emit('correct', { x: e.x, y: e.y, d: e.dir, tp: e.tp, c: e.corr });
    };

    const rx = Math.round(x), ry = Math.round(y);
    const offX = Math.abs(x - rx) > 0.001, offY = Math.abs(y - ry) > 0.001;
    if (offX && offY) return reject('off-grid');
    if (!this.canEnter(e, rx, ry)) return reject('wall');
    if (offX && !(this.canEnter(e, Math.floor(x), ry) && this.canEnter(e, Math.ceil(x), ry))) return reject('wall-x');
    if (offY && !(this.canEnter(e, rx, Math.floor(y)) && this.canEnter(e, rx, Math.ceil(y)))) return reject('wall-y');

    const elapsed = e.lastPosAt ? Math.min(1, (now - e.lastPosAt) / 1000) : 1;
    e.lastPosAt = now;
    e.budget = Math.min(CFG.budgetCap, e.budget + this.speedOf(e) * CFG.speedSlack * elapsed);
    const dist = Math.abs(x - e.x) + Math.abs(y - e.y);
    if (dist > e.budget + 0.05) return reject('too fast');

    // Tiles passed through since the last report (at most 2; the maze has no 2x2 open areas,
    // so a diagonal hop has exactly one open corner).
    const ox = Math.round(e.x), oy = Math.round(e.y);
    const md = Math.abs(rx - ox) + Math.abs(ry - oy);
    const path = [];
    if (md === 2) {
      let mid;
      if (rx === ox || ry === oy) mid = [(ox + rx) / 2, (oy + ry) / 2];
      else if (this.canEnter(e, rx, oy)) mid = [rx, oy];
      else if (this.canEnter(e, ox, ry)) mid = [ox, ry];
      if (!mid || !this.canEnter(e, mid[0], mid[1])) return reject('bad path');
      path.push(mid);
    } else if (md > 2) {
      return reject('too far');
    }
    path.push([rx, ry]);

    e.budget -= dist;
    e.x = x;
    e.y = y;
    e.dir = (Number(m.d) | 0) & 3;
    e.moving = !!m.m;
    for (const [px, py] of path) this.arrive(e, px, py, now);
  }

  // Server-side movement for entities without a client simulating them (bots).
  step(e, dt, now) {
    let d = this.speedOf(e) * dt;
    for (let guard = 0; d > 1e-9 && guard < 10; guard++) {
      const cx = Math.round(e.x), cy = Math.round(e.y);
      if (Math.abs(e.x - cx) < 1e-6 && Math.abs(e.y - cy) < 1e-6) {
        e.x = cx; e.y = cy;
        this.arrive(e, cx, cy, now);
        if (e.next !== null && this.canEnter(e, cx + DX[e.next], cy + DY[e.next])) { e.dir = e.next; e.next = null; }
        if (!this.canEnter(e, cx + DX[e.dir], cy + DY[e.dir])) { e.moving = false; break; }
        e.moving = true;
      } else if (e.next !== null && e.next === (e.dir + 2) % 4) {
        e.dir = e.next;
        e.next = null;
      }
      const horiz = e.dir % 2 === 0;
      const sgn = e.dir === 0 || e.dir === 1 ? 1 : -1;
      const v = horiz ? e.x : e.y;
      const target = sgn > 0 ? Math.floor(v + 1e-6) + 1 : Math.ceil(v - 1e-6) - 1;
      const dist = Math.abs(target - v);
      let nv;
      if (d >= dist) { nv = target; d -= dist; } else { nv = v + sgn * d; d = 0; }
      if (horiz) e.x = nv; else e.y = nv;
    }
  }

  arrive(e, x, y, now) {
    if (e.role !== 'pac') return;
    const r = this.round;
    const i = y * r.maze.W + x;
    const v = r.maze.tiles[i];
    if (v === T.PELLET) {
      r.maze.tiles[i] = T.EMPTY;
      r.left--;
      e.coins++;
      e.score += POINTS.coin;
      r.eaten.push(i);
    } else if (v === T.POWER) {
      r.maze.tiles[i] = T.EMPTY;
      r.left--;
      e.teas++;
      e.score += POINTS.tea;
      r.eaten.push(i);
      r.frightUntil = now + CFG.frightMs;
      for (const g of r.ents) if (g.role === 'ghost' && g.st === 'alive') g.frightened = true;
      r.events.push({ t: 'tea', p: e.id });
    }
  }

  // ---------------------------------------------------------------- simulation
  tick() {
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    this.tickNo++;
    const r = this.round;
    if (!r) return;

    if (this.state === 'countdown') {
      if (now < r.startAt) { this.broadcast(now); return; }
      this.state = 'playing';
      for (const e of r.ents) e.lastPosAt = now;
      this.sendHostStatus();
    }
    if (this.state !== 'playing') return;

    if (r.frightUntil && now >= r.frightUntil) {
      r.frightUntil = 0;
      for (const e of r.ents) e.frightened = false;
    }
    for (const e of r.ents) {
      if (e.st === 'dead' && now >= e.respawnAt) { e.st = 'alive'; e.frightened = false; }
    }
    for (const e of r.ents) if (e.st === 'alive' && !e.clientAuth) this.step(e, dt, now);
    this.collide(now);

    r.suddenDeath = r.left > 0 && r.left <= Math.ceil(r.total * CFG.suddenDeath);
    this.broadcast(now);

    if (r.left === 0) this.endRound('pac');
    else if (!r.ents.some((e) => e.role === 'pac' && e.st === 'alive')) this.endRound('ghost');
  }

  collide(now) {
    const r = this.round;
    const pacs = r.ents.filter((e) => e.role === 'pac' && e.st === 'alive');
    const ghosts = r.ents.filter((e) => e.role === 'ghost' && e.st === 'alive');
    const d2max = CFG.catchDist * CFG.catchDist;
    for (const p of pacs) {
      for (const g of ghosts) {
        if (p.st !== 'alive') break;
        if (g.st !== 'alive') continue;
        const dx = p.x - g.x, dy = p.y - g.y;
        if (dx * dx + dy * dy >= d2max) continue;
        if (g.frightened) {
          g.st = 'dead';
          g.frightened = false;
          g.respawnAt = now + CFG.respawnMs;
          const sp = g.house.spawns[Math.floor(Math.random() * g.house.spawns.length)];
          g.x = sp[0]; g.y = sp[1];
          g.moving = false; g.next = null; g.dir = 3;
          g.tp++; // tells the client to snap to the station
          g.budget = CFG.budgetCap;
          p.ghosts++; p.score += POINTS.ghost;
          g.eaten++; g.score += POINTS.eaten;
          r.events.push({ t: 'eat', p: p.id, g: g.id });
        } else {
          p.st = 'out';
          p.moving = false;
          g.catches++; g.score += POINTS.catch;
          r.events.push({ t: 'catch', p: p.id, g: g.id });
        }
      }
    }
  }

  // Each player gets only what's near their screen, packed as binary
  // (id, x*100, y*100, flags) per character = 8 bytes.
  broadcast(now) {
    const r = this.round;
    const flagsOf = (x) => x.dir | (x.moving ? 4 : 0) | (x.frightened ? 8 : 0) | (ST[x.st] << 4);

    let pacsAlive = 0;
    for (const e of r.ents) if (e.role === 'pac' && e.st === 'alive') pacsAlive++;

    const sendMini = this.tickNo % CFG.miniEvery === 0;
    let pacMini = null, ghostMini = null;
    if (sendMini) {
      const pp = [], gp = [];
      for (const e of r.ents) {
        if (e.st !== 'alive') continue;
        (e.role === 'pac' ? pp : gp).push(Math.round(e.x), Math.round(e.y));
      }
      pacMini = Buffer.from(Uint8Array.from(pp));
      ghostMini = Buffer.from(Uint8Array.from(gp));
    }

    const base = {
      T: now,
      s: this.state,
      l: r.left,
      pa: pacsAlive,
      fr: r.frightUntil ? Math.max(0, r.frightUntil - now) : 0,
      sd: r.suddenDeath ? 1 : 0,
      c: this.state === 'countdown' ? Math.max(0, r.startAt - now) : 0,
      p: r.eaten,
      ev: r.events,
    };

    for (const p of this.players.values()) {
      const sock = p.socket;
      if (!sock) continue;
      const e = r.byToken.get(p.token);
      const inPlay = e && e.st !== 'out';
      const focus = inPlay ? e : this.watchTarget(p);
      const hw = (p.view ? p.view.hw : 12) + CFG.viewPad;
      const hh = (p.view ? p.view.hh : 10) + CFG.viewPad;
      const arr = [];
      if (focus) {
        for (const x of r.ents) {
          if ((inPlay && x === e) || x.st === 'out') continue;
          if (Math.abs(x.x - focus.x) > hw || Math.abs(x.y - focus.y) > hh) continue;
          arr.push(x.id, Math.round(x.x * 100), Math.round(x.y * 100), flagsOf(x));
        }
      }
      const msg = Object.assign({}, base, { b: Buffer.from(Uint16Array.from(arr).buffer) });
      if (e) msg.me = [Math.round(e.x * 100), Math.round(e.y * 100), flagsOf(e), e.score, e.st === 'dead' ? Math.max(0, e.respawnAt - now) : 0, e.tp];
      if (!inPlay && focus) msg.w = focus.id;
      if (sendMini) {
        if (inPlay) msg.mt = e.role === 'pac' ? pacMini : ghostMini;
        else { msg.mp = pacMini; msg.mg = ghostMini; }
      }
      sock.emit('tick', msg);
    }
    r.eaten = [];
    r.events = [];
  }
}

module.exports = { Game, CFG, POINTS };

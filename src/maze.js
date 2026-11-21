'use strict';

// Tile codes (also sent to clients as a digit string).
const T = { EMPTY: 0, WALL: 1, PELLET: 2, POWER: 3, DOOR: 4, HOUSE: 5, HWALL: 6 };

const STATION_NAMES = ['Strand', 'Waterloo', 'Temple', 'Holborn', 'London Bridge', 'Embankment'];

// Map grows in classic-sized blocks (~28x31) with the player count.
function blocksFor(n) {
  if (n <= 12) return [1, 1];
  if (n <= 40) return [2, 1];
  if (n <= 80) return [2, 2];
  return [3, 2];
}

function shuffle(a, rand = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pacman-ish maze: start from an open lattice (1-wide corridors around 1x1 pillars),
// then randomly join pillars into bigger wall blocks while keeping the maze connected
// and free of dead ends. Left/right mirrored for the classic look.
function generate(playerCount, rand = Math.random) {
  const [bx, by] = blocksFor(playerCount);
  let W = 28 * bx, H = 31 * by;
  if (W % 2 === 0) W--;
  if (H % 2 === 0) H--;

  const tiles = new Uint8Array(W * H);
  const fixed = new Uint8Array(W * H);
  const at = (x, y) => y * W + x;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      tiles[at(x, y)] = border || (x % 2 === 0 && y % 2 === 0) ? T.WALL : T.EMPTY;
    }
  }

  // --- Ghost houses ("stations"), one per block, mirrored horizontally.
  const mid = (bx - 1) / 2;
  const rxs = new Array(bx);
  for (let b = 0; b < bx; b++) {
    if (b === mid) rxs[b] = (W - 1) / 2 - 4;
    else if (b < mid) {
      let rx = Math.round((b + 0.5) * W / bx) - 4;
      if (rx % 2 === 0) rx--;
      rxs[b] = rx;
    }
  }
  for (let b = 0; b < bx; b++) if (b > mid) rxs[b] = W - 1 - (rxs[bx - 1 - b] + 8);

  const houses = [];
  for (let r = 0; r < by; r++) {
    let ry = Math.round((r + 0.5) * H / by) - 3;
    if (ry % 2 === 0) ry--;
    for (let b = 0; b < bx; b++) {
      const rx = rxs[b];
      const spawns = [];
      for (let y = ry; y <= ry + 6; y++) {
        for (let x = rx; x <= rx + 8; x++) {
          const i = at(x, y);
          fixed[i] = 1;
          if (x === rx || x === rx + 8 || y === ry || y === ry + 6) tiles[i] = T.EMPTY; // ring corridor
          else if (x === rx + 1 || x === rx + 7 || y === ry + 1 || y === ry + 5) tiles[i] = T.HWALL;
          else { tiles[i] = T.HOUSE; spawns.push([x, y]); }
        }
      }
      tiles[at(rx + 4, ry + 1)] = T.DOOR;
      houses.push({
        x: rx + 2, y: ry + 2, w: 5, h: 3,
        door: [rx + 4, ry + 1],
        spawns,
        name: STATION_NAMES[houses.length % STATION_NAMES.length],
      });
    }
  }

  const passable = (v) => v === T.EMPTY || v === T.PELLET || v === T.POWER;
  let openCount = 0;
  for (let i = 0; i < tiles.length; i++) if (passable(tiles[i])) openCount++;

  const connected = () => {
    let start = -1;
    for (let i = 0; i < tiles.length; i++) if (passable(tiles[i])) { start = i; break; }
    const seen = new Uint8Array(tiles.length);
    const stack = [start];
    seen[start] = 1;
    let count = 0;
    while (stack.length) {
      const i = stack.pop();
      count++;
      const x = i % W, y = (i / W) | 0;
      const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [nx, ny] of nb) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = at(nx, ny);
        if (!seen[j] && passable(tiles[j])) { seen[j] = 1; stack.push(j); }
      }
    }
    return count === openCount;
  };

  const degree = (x, y) => {
    let d = 0;
    if (passable(tiles[at(x + 1, y)])) d++;
    if (passable(tiles[at(x - 1, y)])) d++;
    if (passable(tiles[at(x, y + 1)])) d++;
    if (passable(tiles[at(x, y - 1)])) d++;
    return d;
  };

  // Candidate passages (exactly one coordinate even), left half incl. centre column.
  const cands = [];
  const half = (W - 1) / 2;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x <= half; x++) {
      if ((x % 2 === 0) === (y % 2 === 0)) continue;
      if (fixed[at(x, y)]) continue;
      cands.push([x, y]);
    }
  }
  shuffle(cands, rand);

  for (const [x, y] of cands) {
    if (rand() > 0.6) continue;
    const mx = W - 1 - x;
    const list = mx === x ? [[x, y]] : [[x, y], [mx, y]];
    if (list.some(([px, py]) => tiles[at(px, py)] !== T.EMPTY || fixed[at(px, py)])) continue;
    for (const [px, py] of list) tiles[at(px, py)] = T.WALL;
    openCount -= list.length;

    let ok = true;
    for (const [px, py] of list) {
      for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
        if (passable(tiles[at(nx, ny)]) && degree(nx, ny) < 2) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (ok) ok = connected();
    if (!ok) {
      for (const [px, py] of list) tiles[at(px, py)] = T.EMPTY;
      openCount += list.length;
    }
  }

  // Oyster coins everywhere open.
  for (let i = 0; i < tiles.length; i++) if (tiles[i] === T.EMPTY) tiles[i] = T.PELLET;

  // Cups of tea: 4 per block near its corners.
  const nearestPellet = (tx, ty) => {
    for (let rad = 0; rad < 8; rad++) {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          const x = tx + dx, y = ty + dy;
          if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
          if (tiles[at(x, y)] === T.PELLET) return at(x, y);
        }
      }
    }
    return -1;
  };
  for (let r = 0; r < by; r++) {
    for (let b = 0; b < bx; b++) {
      const x0 = Math.floor(b * W / bx), x1 = Math.floor((b + 1) * W / bx) - 1;
      const y0 = Math.floor(r * H / by), y1 = Math.floor((r + 1) * H / by) - 1;
      for (const [tx, ty] of [[x0 + 3, y0 + 3], [x1 - 3, y0 + 3], [x0 + 3, y1 - 3], [x1 - 3, y1 - 3]]) {
        const i = nearestPellet(tx, ty);
        if (i >= 0) tiles[i] = T.POWER;
      }
    }
  }

  // Fare dodger spawns: walk the outer corridor clockwise.
  const pacSpawns = [];
  const pushIf = (x, y) => { if (passable(tiles[at(x, y)])) pacSpawns.push([x, y]); };
  for (let x = 1; x <= W - 2; x++) pushIf(x, 1);
  for (let y = 2; y <= H - 2; y++) pushIf(W - 2, y);
  for (let x = W - 3; x >= 1; x--) pushIf(x, H - 2);
  for (let y = H - 3; y >= 2; y--) pushIf(1, y);

  return { W, H, bx, by, tiles, houses, pacSpawns };
}

module.exports = { T, generate, blocksFor, shuffle };

// Pac-Man (2D canvas) played by TypeSafe Jev 1.13 via the OpenRouter Decisions API.
// Decisions are pre-fetched one junction ahead with PROJECTED ghost positions,
// so Jev sees the board as it will look when pacman arrives.
import { MAZE } from './maze.mjs';

/* ---------------- constants ---------------- */
const DIRS = { up: { dx: 0, dy: -1 }, down: { dx: 0, dy: 1 }, left: { dx: -1, dy: 0 }, right: { dx: 1, dy: 0 } };
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
const GHOST_COLORS = ['#ff2121', '#ffb8ff', '#00ffff', '#ffb852'];
const GHOST_SPEED_FACTOR = 2.0;
const FRIGHT_MS = 7000;
const DECIDE_TIMEOUT = 12000;
const WIN_R = 3;          // local map radius -> 7x7 window
const PRE_DIST = 4;       // pre-fetch junctions up to this many cells ahead
const THREAT_CELLS = 3;   // look-ahead cells for the pursuit check
const TAU = Math.PI * 2;

const H = MAZE.length, W = MAZE[0].length;

/* ---------------- parse maze ---------------- */
// NOTE: 'P' is stripped here; pacman position is tracked in `pac`, never rendered statically.
let grid = MAZE.map(r => r.split('').map(ch => (ch === 'P' ? ' ' : ch)));
const pacStart = { col: 0, row: 0 };
const ghostStarts = [];
const dotCells = [];
const pellets = [];
let totalDots = 0;
MAZE.forEach((row, r) => row.split('').forEach((ch, c) => {
  if (ch === 'P') { pacStart.col = c; pacStart.row = r; }
  if (ch === 'G') ghostStarts.push({ col: c, row: r });
  if (ch === '.') { dotCells.push({ col: c, row: r }); totalDots++; }
  if (ch === 'o') pellets.push({ col: c, row: r });
}));

function passable(c, r, ghost) {
  const ch = grid[r]?.[c];
  if (!ch || ch === '#') return false;
  return ghost ? true : ch !== 'G' && ch !== 'D';
}
function openDirs(c, r, ghost) {
  const out = [];
  for (const [n, d] of Object.entries(DIRS)) if (passable(c + d.dx, r + d.dy, ghost)) out.push(n);
  return out;
}

/* ---------------- 2D canvas ---------------- */
const wrap = document.getElementById('canvas-wrap');
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let cell = 0, offX = 0, offY = 0;
function fit() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = wrap.clientWidth, h = Math.max(1, wrap.clientHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cell = Math.floor(Math.min(w / W, h / H));
  offX = (w - cell * W) / 2;
  offY = (h - cell * H) / 2;
}
window.addEventListener('resize', fit);

/* ---------------- game state ---------------- */
let score = 0, lives = 3, level = 1, dotsLeft = totalDots;
let stepMs = 240;
let frightMs = 0, frightCombo = 0;
let freezeMs = 0, pendingReset = null;
let paused = false, gameOverFlag = false;
let ghostsFrozen = false;   // test hook: stops ghost movement
let decisionToken = 0;
let preDecision = null;     // arrived pre-fetch result, not yet applied
let preInFlight = null;     // pre-fetch request still in flight
const sessionId = 'pacman-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now();
const startTime = performance.now();

const pac = {
  col: pacStart.col, row: pacStart.row, dir: 'left',
  fx: pacStart.col, fz: pacStart.row, fromx: pacStart.col, fromz: pacStart.row,
  tx: pacStart.col, tz: pacStart.row, prog: 1, moving: false, waiting: false,
  waitStart: 0,
};

const ghosts = ghostStarts.map(s => ({
  spawn: s, col: s.col, row: s.row, dir: 'up',
  fx: s.col, fz: s.row, fromx: s.col, fromz: s.row, tx: s.col, tz: s.row,
  prog: 0, moving: false, acc: 0, fright: false, state: 'chase', hiddenUntil: 0,
}));

const stats = {
  calls: 0, forced: 0, errors: 0, overrides: 0, flees: 0, preHits: 0, inTok: 0, outTok: 0, cost: 0,
  lat: [], conf: [], danger: [], waits: [], chosen: { up: 0, down: 0, left: 0, right: 0 },
  offered: { up: 0, down: 0, left: 0, right: 0 }, probSum: { up: 0, down: 0, left: 0, right: 0 },
  log: [], last: null,
};

/* ---------------- DOM helpers ---------------- */
const $ = id => document.getElementById(id);
function pushLog(msg) {
  stats.log.unshift(`[${((performance.now() - startTime) / 1000).toFixed(1)}s] ${msg}`);
  if (stats.log.length > 10) stats.log.pop();
  const ul = $('s-log');
  if (ul) ul.innerHTML = stats.log.map(m => `<li>${m}</li>`).join('');
}
function setStatus(s, cls = '') {
  const el = $('hud-status');
  if (!el) return;
  el.textContent = s;
  el.className = cls;
}

/* ---------------- movement ---------------- */
function legalForPac() {
  const all = openDirs(pac.col, pac.row, false);
  const opts = all.filter(d => d !== OPP[pac.dir]);
  return opts.length ? opts : all;
}

function startPacMove() {
  const d = DIRS[pac.dir];
  pac.fromx = pac.fx; pac.fromz = pac.fz;
  pac.tx = pac.col + d.dx; pac.tz = pac.row + d.dy;
  pac.prog = 0; pac.moving = true;
}

function eatCell(c, r) {
  const ch = grid[r][c];
  if (ch === '.') {
    score += 10; dotsLeft--;
    grid[r][c] = ' ';
    updateHud();
  } else if (ch === 'o') {
    score += 50;
    decisionToken++;          // strategy flipped: invalidate in-flight pre-fetches
    frightMs = FRIGHT_MS; frightCombo = 0;
    grid[r][c] = ' ';
    ghosts.forEach(g => { if (g.state === 'chase') g.fright = true; });
    pushLog('power pellet! ghosts frightened');
    updateHud();
  }
  if (dotsLeft === 0) { freezeMs = 1500; pendingReset = 'level'; }
}

// Pursuit check: cells pacman will occupy in the next THREAT_CELLS steps of
// direction d, flagged when a non-frightened ghost could be there at roughly
// the same time (or sooner). Uses live ghost positions.
function threatCells(d) {
  const dd = DIRS[d];
  const gStep = stepMs * GHOST_SPEED_FACTOR;
  const threatened = [];
  let c = pac.col + dd.dx, r = pac.row + dd.dy;
  for (let i = 1; i <= THREAT_CELLS; i++) {
    if (!passable(c, r, false)) break;
    const tArr = i * stepMs;
    for (const g of ghosts) {
      if (g.state === 'eaten' || g.fright) continue;
      const tG = (Math.abs(g.col - c) + Math.abs(g.row - r)) * gStep;
      if (tG <= tArr + 150) { threatened.push({ c, r }); break; }
    }
    c += dd.dx; r += dd.dy;
  }
  return threatened;
}

function anyGhostApproaching() {
  for (const g of ghosts) {
    if (g.state === 'eaten' || g.fright) continue;
    const d = Math.abs(g.col - pac.col) + Math.abs(g.row - pac.row);
    if (d !== 2) continue;
    const dd = DIRS[g.dir];
    const nd = Math.abs(g.col + dd.dx - pac.col) + Math.abs(g.row + dd.dy - pac.row);
    if (nd < d) return true;
  }
  return false;
}

// Reflex: a non-frightened ghost is closing in while pacman waits for a
// decision. Don't wait: flee to the least-threatened legal direction now.
function fleeNow(reason) {
  decisionToken++;
  preDecision = null; preInFlight = null;
  pac.waiting = false;
  const legal = legalForPac();
  if (!legal.length) return;
  let best = null, bt = Infinity, bd = -1;
  for (const d of legal) {
    const t = threatCells(d).length;
    const dg = ghostDangerAt(pac.col + DIRS[d].dx, pac.row + DIRS[d].dy, ghosts);
    if (t < bt || (t === bt && dg > bd)) { bt = t; bd = dg; best = d; }
  }
  stats.flees++;
  pushLog(`reflex flee ${best}: ${reason}`);
  pac.dir = best;
  setStatus('moving');
  if (!paused && freezeMs <= 0 && !gameOverFlag) { startPacMove(); maybePreRequest(); }
}

function updatePac(dt) {
  if (pac.moving) {
    pac.prog += dt / stepMs;
    if (pac.prog >= 1) {
      pac.prog = 1;
      pac.col += DIRS[pac.dir].dx; pac.row += DIRS[pac.dir].dy;
      pac.fx = pac.tx; pac.fz = pac.tz;
      pac.moving = false;
      eatCell(pac.col, pac.row);
      checkPacGhostCollisions();
    } else {
      pac.fx = pac.fromx + (pac.tx - pac.fromx) * pac.prog;
      pac.fz = pac.fromz + (pac.tz - pac.fromz) * pac.prog;
      checkCrossing();
    }
  } else if (!pac.waiting) {
    const legal = legalForPac();
    if (legal.length === 1) {
      pac.dir = legal[0];
      stats.forced++;
      startPacMove();
      maybePreRequest();
    } else if (legal.length > 1) {
      if (preDecision && preDecision.col === pac.col && preDecision.row === pac.row && preDecision.dir === pac.dir) {
        const pd = preDecision;
        preDecision = null;
        pd.pre = true;
        finalizeDecision(pd);
      } else if (preInFlight && preInFlight.col === pac.col && preInFlight.row === pac.row && preInFlight.dir === pac.dir) {
        pac.waiting = true;
        pac.waitStart = performance.now();
        setStatus('Jev deciding…', 'wait');
      } else {
        if (preDecision) preDecision = null;   // stale, discard
        pac.waiting = true;
        pac.waitStart = performance.now();
        setStatus('Jev deciding…', 'wait');
        jevDecide();
      }
    }
  } else {
    // waiting: reflex flee if a non-frightened ghost closes in
    const dNear = ghostDangerAt(pac.col, pac.row, ghosts);
    if (Number.isFinite(dNear) && (dNear <= 1 || (dNear === 2 && anyGhostApproaching()))) {
      fleeNow(`ghost ${dNear} cell(s) away while waiting`);
    }
  }
}

function chasePickAt(g, legal, pc, pr) {
  if (Math.random() < 0.5) return legal[Math.floor(Math.random() * legal.length)];
  let best = [], bd = Infinity;
  for (const d of legal) {
    const dd = DIRS[d];
    const dist = Math.abs(g.col + dd.dx - pc) + Math.abs(g.row + dd.dy - pr);
    if (dist < bd) { bd = dist; best = [d]; }
    else if (dist === bd) best.push(d);
  }
  return best[Math.floor(Math.random() * best.length)];
}

function updateGhosts(dt) {
  const t = performance.now();
  const gStep = stepMs * GHOST_SPEED_FACTOR;
  for (const g of ghosts) {
    if (ghostsFrozen) continue;
    if (g.state === 'eaten') {
      if (t >= g.hiddenUntil) { g.state = 'chase'; g.fright = false; }
      continue;
    }
    g.acc += dt;
    if (!g.moving) {
      if (g.acc >= gStep) {
        g.acc -= gStep;
        const all = openDirs(g.col, g.row, true);
        const opts = all.filter(d => d !== OPP[g.dir]);
        const legal = opts.length ? opts : all;
        if (legal.length) {
          g.dir = g.fright
            ? legal[Math.floor(Math.random() * legal.length)]
            : chasePickAt(g, legal, pac.col, pac.row);
          const d = DIRS[g.dir];
          g.fromx = g.fx; g.fromz = g.fz;
          g.tx = g.col + d.dx; g.tz = g.row + d.dy;
          g.prog = 0; g.moving = true;
        }
      }
    } else {
      g.prog += dt / gStep;
      if (g.prog >= 1) {
        g.prog = 1;
        g.col += DIRS[g.dir].dx; g.row += DIRS[g.dir].dy;
        g.fx = g.tx; g.fz = g.tz;
        g.moving = false;
        checkPacGhostCollisions();
      } else {
        g.fx = g.fromx + (g.tx - g.fromx) * g.prog;
        g.fz = g.fromz + (g.tz - g.fromz) * g.prog;
      }
    }
  }
}

/* ---------------- collisions ---------------- */
// The cell pacman effectively occupies right now: mid-step he is closer to
// the target cell than to the cell he left.
function pacEffectiveCell() {
  if (pac.moving && pac.prog > 0.5) {
    return { col: pac.col + DIRS[pac.dir].dx, row: pac.row + DIRS[pac.dir].dy };
  }
  return { col: pac.col, row: pac.row };
}

function checkPacGhostCollisions() {
  if (freezeMs > 0 || gameOverFlag) return;
  const pc = pacEffectiveCell();
  for (const g of ghosts) {
    if (g.state === 'eaten') continue;
    if (g.col === pc.col && g.row === pc.row) {
      if (frightMs > 0 && g.fright) eatGhost(g);
      else { pacDies(); return; }
    }
  }
}

function checkCrossing() {
  if (!pac.moving || freezeMs > 0 || gameOverFlag) return;
  for (const g of ghosts) {
    if (g.state === 'eaten' || !g.moving) continue;
    if (g.prog < 0.3 || pac.prog < 0.3) continue;
    if (g.tx === pac.fx && g.tz === pac.fz && pac.tx === g.fx && pac.tz === g.fz) {
      if (frightMs > 0 && g.fright) eatGhost(g);
      else pacDies();
      return;
    }
  }
}

function eatGhost(g) {
  frightCombo = Math.min(frightCombo + 1, 4);
  const pts = 200 * (2 ** (frightCombo - 1));
  score += pts;
  g.state = 'eaten'; g.moving = false; g.fright = false;
  g.col = g.spawn.col; g.row = g.spawn.row;
  g.fx = g.col; g.fz = g.row;
  g.hiddenUntil = performance.now() + 1200;
  pushLog(`ate ghost +${pts}`);
  updateHud();
}

function pacDies() {
  if (gameOverFlag || freezeMs > 0) return;
  lives--;
  decisionToken++;
  preDecision = null; preInFlight = null;
  pac.waiting = false; pac.moving = false;
  updateHud();
  const dNear = ghostDangerAt(pac.col, pac.row, ghosts);
  pushLog(`death: nearest ghost ${Number.isFinite(dNear) ? dNear + ' cell(s)' : 'none (?)'}, pac was ${pac.moving ? 'moving' : 'waiting'}`);
  if (lives <= 0) { gameOver(); return; }
  freezeMs = 1400; pendingReset = 'death';
  frightMs = 0;
  ghosts.forEach(g => { g.fright = false; });
  setStatus(`hit! ${lives} ${lives === 1 ? 'life' : 'lives'} left`, 'err');
}

function gameOver() {
  gameOverFlag = true;
  paused = true;
  preDecision = null; preInFlight = null;
  $('ov-title').textContent = 'GAME OVER';
  $('ov-stats').textContent =
    `score            ${score}\n` +
    `level            ${level}\n` +
    `decisions        ${stats.calls}\n` +
    `input tokens     ${stats.inTok}\n` +
    `est. cost        $${stats.cost.toFixed(5)}`;
  $('overlay').classList.remove('hidden');
}

function resetPositions() {
  preDecision = null; preInFlight = null;
  pac.col = pacStart.col; pac.row = pacStart.row; pac.dir = 'left';
  pac.fx = pac.col; pac.fz = pac.row;
  pac.prog = 1; pac.moving = false; pac.waiting = false;
  ghosts.forEach(g => {
    g.col = g.spawn.col; g.row = g.spawn.row; g.dir = 'up';
    g.fx = g.col; g.fz = g.row;
    g.moving = false; g.prog = 0; g.acc = 0; g.fright = false;
    g.state = 'chase';
  });
}

function applyLevelReset() {
  level++;
  stepMs = Math.max(140, stepMs * 0.96);
  grid = MAZE.map(r => r.split('').map(ch => (ch === 'P' ? ' ' : ch)));
  dotsLeft = totalDots;
  frightMs = 0;
  setStatus(`level ${level}!`);
  updateHud();
}

/* ---------------- ghost projection ---------------- */
// Simulate ghosts forward for the time pacman needs to travel `pacSteps`
// cells along his current direction. Pre-fetched decisions see the board as
// it will look on arrival, not as it looks now.
function projectGhosts(pacSteps) {
  const gStep = stepMs * GHOST_SPEED_FACTOR;
  const T = pacSteps * stepMs;
  const out = ghosts.map(g => ({
    col: g.col, row: g.row, dir: g.dir, fright: g.fright, state: g.state,
    remainEaten: g.state === 'eaten' ? Math.max(0, g.hiddenUntil - performance.now()) : 0,
  }));
  let t = 0;
  while (t + gStep <= T + 1) {
    t += gStep;
    const k = Math.min(pacSteps, Math.floor((t + stepMs / 2) / stepMs));
    const pc = pac.col + DIRS[pac.dir].dx * k;
    const pr = pac.row + DIRS[pac.dir].dy * k;
    for (const g of out) {
      if (g.state === 'eaten') {
        g.remainEaten -= gStep;
        if (g.remainEaten <= 0) { g.state = 'chase'; g.fright = false; }
        continue;
      }
      if (g.fright && frightMs <= t) g.fright = false;
      const all = openDirs(g.col, g.row, true);
      const opts = all.filter(d => d !== OPP[g.dir]);
      const legal = opts.length ? opts : all;
      if (!legal.length) continue;
      const pick = g.fright
        ? legal[Math.floor(Math.random() * legal.length)]
        : chasePickAt(g, legal, pc, pr);
      g.dir = pick;
      const dd = DIRS[pick];
      g.col += dd.dx; g.row += dd.dy;
    }
  }
  return out;
}

/* ---------------- Jev context builders (parametrized by position) ---------------- */
function makeWindow(cx, cy, board, ghostList) {
  const rows = [];
  for (let r = cy - WIN_R; r <= cy + WIN_R; r++) {
    let line = '';
    for (let c = cx - WIN_R; c <= cx + WIN_R; c++) {
      if (r < 0 || r >= H || c < 0 || c >= W) { line += '#'; continue; }
      const ch = board[r][c];
      line += (ch === 'G' || ch === 'D') ? 'H' : ch;   // house cells: impassable, never "ghost"
    }
    rows.push(line);
  }
  for (const g of ghostList) {                          // real ghosts only
    if (g.state === 'eaten') continue;
    const dc = g.col - (cx - WIN_R), dr = g.row - (cy - WIN_R);
    if (dc >= 0 && dc < 2 * WIN_R + 1 && dr >= 0 && dr < 2 * WIN_R + 1) {
      const s = rows[dr];
      rows[dr] = s.slice(0, dc) + (g.fright ? 'g' : 'G') + s.slice(dc + 1);
    }
  }
  const s = rows[WIN_R];
  rows[WIN_R] = s.slice(0, WIN_R) + 'P' + s.slice(WIN_R + 1);
  return rows;
}

function makeDirInfo(d, cx, cy, board, ghostList) {
  const dd = DIRS[d];
  const danger = ghostDangerAt(cx + dd.dx, cy + dd.dy, ghostList);
  const open = (cc, rr) => {
    const ch = board[rr]?.[cc];
    return !!ch && ch !== '#' && ch !== 'G' && ch !== 'D';
  };
  let len = 0, dot = null, pellet = null, gNear = null, gFright = null, dotCount = 0;
  let c = cx + dd.dx, r = cy + dd.dy;
  while (open(c, r) && len < 8) {
    len++;
    const ch = board[r][c];
    if (ch === '.') { dotCount++; if (dot === null) dot = len; }
    if (ch === 'o' && pellet === null) pellet = len;
    for (const g of ghostList) {
      if (g.state === 'eaten' || g.col !== c || g.row !== r) continue;
      if (g.fright && gFright === null) gFright = len;
      if (!g.fright && gNear === null) gNear = len;
    }
    c += dd.dx; r += dd.dy;
  }
  while (open(c, r)) { len++; c += dd.dx; r += dd.dy; }
  return { len, dot, pellet, gNear, gFright, danger, dotCount };
}

// Nearest non-frightened ghost to a cell, manhattan distance. Infinity if none.
function ghostDangerAt(c, r, ghostList) {
  let min = Infinity;
  for (const g of ghostList) {
    if (g.state === 'eaten' || g.fright) continue;
    const d = Math.abs(g.col - c) + Math.abs(g.row - r);
    if (d < min) min = d;
  }
  return min;
}

// Greedy food value of a direction: points per cell distance to the best
// nearby edible (frightened ghost 200 > pellet 50 > dot 10). Frightened ghosts
// only count when the fright timer is long enough to reach them before it ends.
function foodUtilityAt(d, cx, cy, board, ghostList) {
  const info = makeDirInfo(d, cx, cy, board, ghostList);
  let u = 0;
  if (info.pellet !== null) u = Math.max(u, 50 / info.pellet);
  if (info.gFright !== null && frightMs > info.gFright * stepMs + 500) u = Math.max(u, 200 / info.gFright);
  if (info.dot !== null) u = Math.max(u, 10 / info.dot);
  return u;
}

function dirDesc(d, info) {
  const parts = [];
  if (info.gNear !== null) parts.push(`DANGER: ghost ${info.gNear} ahead`);
  if (info.gFright !== null) parts.push(`frightened ghost ${info.gFright} ahead (edible +200)`);
  if (info.pellet !== null) parts.push(`pellet ${info.pellet} ahead (+50, frightens all ghosts 7s)`);
  if (info.dot !== null) parts.push(`dot ${info.dot} ahead (+10)`);
  if (info.dotCount > 1) parts.push(`${info.dotCount} dots within 8 cells`);
  if (info.dot === null && info.pellet === null && info.gFright === null) parts.push('no food ahead');
  if (Number.isFinite(info.danger)) parts.push(`nearest ghost ${info.danger} from target`);
  parts.push(`corridor ${info.len}`);
  return parts.join(', ');
}

function makeGhostSummary(cx, cy, ghostList) {
  const parts = [];
  for (const g of ghostList) {
    if (g.state === 'eaten') continue;
    const dist = Math.abs(g.col - cx) + Math.abs(g.row - cy);
    const dd = DIRS[g.dir];
    const next = Math.abs(g.col + dd.dx - cx) + Math.abs(g.row + dd.dy - cy);
    const outside = Math.abs(g.col - cx) > WIN_R || Math.abs(g.row - cy) > WIN_R;
    parts.push(`(${g.col},${g.row}) d=${dist} heading ${g.dir}${next < dist ? ' (toward you)' : ''}${outside ? ' (outside map)' : ''}${g.fright ? ' frightened' : ''}`);
  }
  return parts.length ? parts.join('; ') : 'none';
}

function strategyLine(legal, cx, cy, board, fMs, ghostList) {
  if (fMs > 0) {
    return `FRIGHT ACTIVE (${(fMs / 1000).toFixed(1)}s left): chase and eat the nearest frightened ghost; do not avoid frightened ghosts, but stop chasing when time is nearly out.`;
  }
  const pelletNear = legal.some(d => { const i = makeDirInfo(d, cx, cy, board, ghostList); return i.pellet !== null && i.pellet <= 6; });
  if (pelletNear) {
    return 'A power pellet is in reach: take it if any non-frightened ghost is nearby, it frightens all ghosts for 7s.';
  }
  return 'Eat dots: prefer directions with dots; avoid empty corridors when an equally safe dotted path exists.';
}

function buildContext(cx, cy, dir, legal, board, fMs, ghostList, isPre) {
  const win = makeWindow(cx, cy, board, ghostList);
  const state = [
    `Pac-Man game. Grid: ${W} cols x ${H} rows, origin (0,0) top-left, rows go down, cols go right.`,
    `Local ${2 * WIN_R + 1}x${2 * WIN_R + 1} map centered on Pac-Man (P) at (${cx},${cy}), currently facing ${dir}:`,
    ...win,
    `Legend: # wall, . dot (10 pts), o power pellet (50 pts, frightens ghosts 7s), H ghost house (impassable), G ghost, g frightened ghost (edible, 200+ pts), P Pac-Man.`,
    `Ghosts (col,row, manhattan distance): ${makeGhostSummary(cx, cy, ghostList)}`,
    `Fright timer ${Math.round(fMs)}ms${fMs > 0 ? ' FRIGHT ACTIVE: ghosts are edible (200/400/800/1600 pts), chase them' : ''}. Score ${score}. Lives ${lives}. Dots left ${dotsLeft}.`,
    isPre ? 'Note: ghost positions above are projected to the moment you arrive at this junction.' : '',
  ].filter(Boolean).join('\n');
  const questions = {
    move: {
      type: 'choice',
      instructions: `Pac-Man (P) must move ONE cell now. Pick the best of: ${legal.join(', ')}. ` +
        'Scoring: dot +10, power pellet +50 (frightens all ghosts 7s), frightened ghost +200/400/800/1600. Non-frightened ghosts kill you. ' +
        `${strategyLine(legal, cx, cy, board, fMs, ghostList)} ` +
        'If a non-frightened ghost is within 3 cells and no pellet is in reach, pick the direction whose target cell is farthest from the nearest ghost. Never reverse.',
      criteria: Object.fromEntries(legal.map(d => [d, dirDesc(d, makeDirInfo(d, cx, cy, board, ghostList))])),
    },
    danger: {
      type: 'noul',
      instructions: 'Is any NON-frightened ghost within 4 cells (manhattan distance) of Pac-Man right now?',
      criteria: { true: 'A non-frightened ghost is 4 cells or closer', false: 'No non-frightened ghost within 4 cells' },
    },
  };
  return { state, questions };
}

/* ---------------- Jev decision pipeline ---------------- */
// ctx: { col, row, dir, legal, segmentClear, isPre, token }
async function requestDecision(ctx) {
  const token = ctx.token;
  const board = grid.map(r => r.join(''));
  for (const [c, r] of ctx.segmentClear) {
    if (board[r][c] === '.' || board[r][c] === 'o') board[r] = board[r].slice(0, c) + ' ' + board[r].slice(c + 1);
  }
  const fMs = Math.max(0, frightMs - ctx.segmentClear.length * stepMs);
  const ghostList = ctx.isPre ? projectGhosts(ctx.segmentClear.length) : ghosts;
  const { state, questions } = buildContext(ctx.col, ctx.row, ctx.dir, ctx.legal, board, fMs, ghostList, ctx.isPre);
  const t0 = performance.now();
  window.__pac.lastRequest = { state, questions };
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), DECIDE_TIMEOUT);
    const res = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, state, questions, provider: { sort: 'latency' } }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    const data = await res.json().catch(() => null);
    const lat = performance.now() - t0;
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    const ans = data.answers?.move;
    if (!ans || ans.type !== 'choice') throw new Error(`malformed answer: ${JSON.stringify(ans)}`);
    if (token !== decisionToken) { preInFlight = null; return; }
    const probs = ans.probabilities || {};
    const conf = typeof ans.confidence === 'number' ? ans.confidence : 0;
    const dAns = data.answers?.danger;
    const dangerP = dAns && dAns.type === 'noul' ? dAns.noul : null;
    const decision = { col: ctx.col, row: ctx.row, dir: ctx.dir, legal: ctx.legal, probs, conf, dangerP, lat, data };
    if (ctx.isPre) {
      preInFlight = null;
      if (pac.col === ctx.col && pac.row === ctx.row && pac.dir === ctx.dir && !pac.moving) {
        finalizeDecision(decision);   // arrived already: apply now
      } else {
        preDecision = decision;       // still traveling: park it
      }
    } else {
      finalizeDecision(decision);
    }
  } catch (err) {
    if (token !== decisionToken) return;
    preInFlight = null;
    if (ctx.isPre) {
      // If pacman is waiting on this pre-fetch, fall back to a fresh call.
      if (pac.waiting && pac.col === ctx.col && pac.row === ctx.row) { jevDecide(); }
      return;
    }
    stats.errors++;
    pushLog(`error: ${err.message}`);
    renderStats();
    pac.dir = ctx.legal[Math.floor(Math.random() * ctx.legal.length)];
    pac.waiting = false;
    setStatus('error · random fallback', 'err');
    if (!paused && freezeMs <= 0 && !gameOverFlag) startPacMove();
  }
}

async function jevDecide() {
  requestDecision({
    col: pac.col, row: pac.row, dir: pac.dir,
    legal: legalForPac(), segmentClear: [], isPre: false, token: decisionToken,
  });
}

// Fire the NEXT junction's decision while pacman still travels toward it.
function nextJunction(c, r, d) {
  const dd = DIRS[d];
  let nc = c + dd.dx, nr = r + dd.dy, dist = 0;
  while (passable(nc, nr, false)) {
    dist++;
    const opts = openDirs(nc, nr, false).filter(x => x !== OPP[d]);
    if (opts.length >= 2) return { col: nc, row: nr, dist };
    nc += dd.dx; nr += dd.dy;
  }
  return null;
}

function maybePreRequest() {
  const j = nextJunction(pac.col, pac.row, pac.dir);
  if (!j || j.dist > PRE_DIST) return;
  if (preInFlight && preInFlight.col === j.col && preInFlight.row === j.row) return;
  if (preDecision && preDecision.col === j.col && preDecision.row === j.row) return;
  const legal = openDirs(j.col, j.row, false).filter(x => x !== OPP[pac.dir]);
  if (legal.length <= 1) return;
  const segmentClear = [];
  const dd = DIRS[pac.dir];
  let c = pac.col + dd.dx, r = pac.row + dd.dy;
  for (let i = 0; i < j.dist; i++) {
    if (grid[r][c] === 'o') return;   // pellet mid-segment: strategy flips, decide fresh on arrival
    segmentClear.push([c, r]);
    c += dd.dx; r += dd.dy;
  }
  preInFlight = { col: j.col, row: j.row, dir: pac.dir, legal, token: decisionToken };
  requestDecision({ col: j.col, row: j.row, dir: pac.dir, legal, segmentClear, isPre: true, token: decisionToken });
}

// Apply a decision (fresh or pre-fetched) at pacman's current cell:
// temperature sampling + pursuit, safety and food overrides on CURRENT positions.
function finalizeDecision(decision) {
  const { col, row, dir, legal, probs, conf, dangerP, lat, data } = decision;
  if (col !== pac.col || row !== pac.row || dir !== pac.dir) return;   // stale: moved on or died
  const wait = pac.waiting ? Math.round(performance.now() - (pac.waitStart || performance.now())) : 0;
  let top = legal[0], tp = -1;
  const weights = legal.map(d => {
    const p = typeof probs[d] === 'number' ? probs[d] : 0;
    if (p > tp) { tp = p; top = d; }
    return Math.max(0, p) ** 2;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let chosen = legal[legal.length - 1];
  if (total > 0) {
    let rnd = Math.random() * total;
    for (let i = 0; i < legal.length; i++) {
      rnd -= weights[i];
      if (rnd <= 0) { chosen = legal[i]; break; }
    }
  } else {
    chosen = legal[Math.floor(Math.random() * legal.length)];
  }
  let override = null;

  // 1) Pursuit override: if a non-frightened ghost is closing on the chosen
  //    path (it can reach one of the next 3 cells at about the same time as
  //    pacman), prefer a direction with fewer threatened cells.
  const threats = {};
  for (const d of legal) threats[d] = threatCells(d).length;
  if (threats[chosen] > 0) {
    let best = chosen, bt = threats[chosen];
    for (const d of legal) if (threats[d] < bt) { bt = threats[d]; best = d; }
    if (best !== chosen) {
      override = { from: chosen, to: best, reason: `ghost closing on ${chosen} path (${threats[chosen]} threatened cell(s) vs ${bt})` };
      chosen = best;
    }
  }

  // 2) Static danger: an empty safe path always beats a chance of getting killed.
  const chosenDanger = ghostDangerAt(pac.col + DIRS[chosen].dx, pac.row + DIRS[chosen].dy, ghosts);
  if (!override && Number.isFinite(chosenDanger) && chosenDanger <= 2) {
    let safest = null, sd = -1;
    for (const d of legal) {
      const dg = ghostDangerAt(pac.col + DIRS[d].dx, pac.row + DIRS[d].dy, ghosts);
      if (dg > sd) { sd = dg; safest = d; }
    }
    if (safest && sd > chosenDanger) {
      override = { from: chosen, to: safest, reason: `ghost ${chosenDanger} from ${chosen} target vs ${sd} from ${safest}` };
      chosen = safest;
    }
  }

  // 3) Food preference: equally safe but clearly richer alternatives win.
  if (!override) {
    const cU = foodUtilityAt(chosen, pac.col, pac.row, grid, ghosts);
    let best = null, bestU = cU;
    for (const d of legal) {
      if (d === chosen) continue;
      if (threats[d] > threats[chosen]) continue;    // not less threatened
      const dg = ghostDangerAt(pac.col + DIRS[d].dx, pac.row + DIRS[d].dy, ghosts);
      if (dg < chosenDanger) continue;               // not less safe statically
      const u = foodUtilityAt(d, pac.col, pac.row, grid, ghosts);
      if (u > bestU) { bestU = u; best = d; }
    }
    if (best && bestU - cU >= 5) {
      override = { from: chosen, to: best, reason: `food value ${bestU.toFixed(0)} on ${best} vs ${cU.toFixed(0)} on ${chosen}` };
      chosen = best;
    }
  }

  recordDecision({ legal, probs, chosen, top, conf, lat, data, dangerP, override, wait, pre: !!decision.pre });
  pac.dir = chosen;
  pac.waiting = false;
  setStatus('moving');
  if (!paused && freezeMs <= 0 && !gameOverFlag) { startPacMove(); maybePreRequest(); }
}

function recordDecision({ legal, probs, chosen, top, conf, lat, data, dangerP, override, wait, pre }) {
  stats.calls++;
  stats.lat.push(lat);
  stats.conf.push(conf);
  if (dangerP !== null) stats.danger.push(dangerP);
  if (override) stats.overrides++;
  if (pre) stats.preHits++;
  stats.waits.push(wait ?? 0);
  const u = data.usage || {};
  stats.inTok += u.input_tokens || 0;
  stats.outTok += u.output_tokens || 0;
  stats.cost += u.cost || 0;
  stats.chosen[chosen]++;
  stats.last = { legal, probs, chosen, top, conf, lat, tokens: u.input_tokens || 0, dangerP, override, wait: wait ?? 0, pre: !!pre };
  for (const d of legal) {
    stats.offered[d]++;
    stats.probSum[d] += typeof probs[d] === 'number' ? probs[d] : 0;
  }
  pushLog(`decided ${chosen} (${(conf * 100).toFixed(0)}%)${pre ? ' ⚡pre' : ''}${override ? ` [override: Jev wanted ${override.from}]` : ''} · danger ${dangerP === null ? '?' : (dangerP * 100).toFixed(0) + '%'} · wait ${wait ?? 0}ms · ${Math.round(lat)}ms · ${u.input_tokens || 0}t`);
  renderStats();
}

/* ---------------- sidepane rendering ---------------- */
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function renderStats() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('s-calls', stats.calls);
  set('s-forced', stats.forced);
  set('s-lat-avg', stats.lat.length ? `${Math.round(avg(stats.lat))}ms` : '—');
  set('s-lat-last', stats.lat.length ? `${Math.round(stats.lat[stats.lat.length - 1])}ms` : '—');
  set('s-conf', stats.conf.length ? `${(avg(stats.conf) * 100).toFixed(0)}%` : '—');
  set('s-err', stats.errors);
  set('s-tok', stats.inTok);
  set('s-cost', `$${stats.cost.toFixed(5)}`);

  const latest = $('s-latest');
  if (latest && stats.last) {
    const L = stats.last;
    latest.innerHTML = L.legal.map(d => {
      const p = L.probs[d] ?? 0;
      const chosen = d === L.chosen;
      const top = d === L.top;
      return `<div class="dec-row ${chosen ? 'chosen' : ''}">
        <span class="dir">${d}</span>
        <div class="bar"><i style="width:${Math.round(p * 100)}%"></i></div>
        <span>${(p * 100).toFixed(0)}%</span>
        <span class="chosen-tag">${top ? '▲' : ''}${chosen ? '✓' : ''}</span>
      </div>`;
    }).join('') +
      `<div class="dec-meta">confidence ${(L.conf * 100).toFixed(0)}% · danger est. ${L.dangerP === null ? '—' : (L.dangerP * 100).toFixed(0) + '%'} · wait ${L.wait}ms${L.pre ? ' ⚡pre-fetched' : ''} · ${Math.round(L.lat)}ms · ${L.tokens} tokens in${L.override ? `<br>override: Jev picked ${L.override.from}, played ${L.override.to} (${L.override.reason})` : ''}${stats.overrides || stats.flees ? `<br>${stats.overrides} override${stats.overrides === 1 ? '' : 's'}, ${stats.flees} reflex flee${stats.flees === 1 ? '' : 's'} this session` : ''}${stats.preHits ? `<br>${stats.preHits} of ${stats.calls} decisions pre-fetched · avg wait ${Math.round(avg(stats.waits))}ms` : ''}</div>`;
  }

  const dist = $('s-dist');
  if (dist) {
    const total = stats.calls;
    dist.innerHTML = Object.keys(DIRS).map(d => {
      const n = stats.chosen[d];
      const pct = total ? Math.round((n / total) * 100) : 0;
      const avgP = stats.offered[d] ? (stats.probSum[d] / stats.offered[d] * 100).toFixed(0) : '—';
      return `<div class="dec-row">
        <span class="dir">${d}</span>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <span>${n} (${pct}%)</span>
      </div><div class="dec-meta" style="margin-top:0">avg prob when offered: ${avgP}%</div>`;
    }).join('');
  }

  drawSpark();
}

function drawSpark() {
  const c = $('s-spark');
  if (!c) return;
  const cx = c.getContext('2d');
  cx.clearRect(0, 0, c.width, c.height);
  const L = stats.lat.slice(-100);
  if (L.length < 2) return;
  const max = Math.max(...L, 100);
  cx.strokeStyle = '#5eead4';
  cx.lineWidth = 1.5;
  cx.beginPath();
  L.forEach((v, i) => {
    const x = 4 + (i / (L.length - 1)) * (c.width - 8);
    const y = c.height - 8 - (v / max) * (c.height - 16);
    i ? cx.lineTo(x, y) : cx.moveTo(x, y);
  });
  cx.stroke();
  cx.fillStyle = '#5eead4';
  cx.font = '10px sans-serif';
  cx.fillText(`max ${Math.round(max)}ms`, 4, 11);
}

/* ---------------- HUD ---------------- */
function updateHud() {
  $('hud-score').textContent = score;
  $('hud-level').textContent = level;
  $('hud-dots').textContent = dotsLeft;
  $('hud-lives').textContent = '●'.repeat(Math.max(0, lives));
  $('hud-fright').textContent = frightMs > 0 ? `${(frightMs / 1000).toFixed(1)}s` : '—';
}

/* ---------------- reset / controls ---------------- */
function newGame(resetStats = true) {
  score = 0; lives = 3; level = 1; dotsLeft = totalDots;
  stepMs = Number($('speed').value || 240);
  frightMs = 0; frightCombo = 0;
  freezeMs = 0; pendingReset = null;
  paused = false; gameOverFlag = false;
  decisionToken++;
  preDecision = null; preInFlight = null;
  grid = MAZE.map(r => r.split('').map(ch => (ch === 'P' ? ' ' : ch)));
  resetPositions();
  if (resetStats) {
    Object.assign(stats, {
      calls: 0, forced: 0, errors: 0, overrides: 0, flees: 0, preHits: 0, inTok: 0, outTok: 0, cost: 0,
      lat: [], conf: [], danger: [], waits: [], chosen: { up: 0, down: 0, left: 0, right: 0 },
      offered: { up: 0, down: 0, left: 0, right: 0 }, probSum: { up: 0, down: 0, left: 0, right: 0 },
      log: [], last: null,
    });
    $('s-log').innerHTML = '';
  }
  $('overlay').classList.add('hidden');
  renderStats();
  updateHud();
  setStatus('starting…');
}

$('btn-pause').addEventListener('click', () => {
  paused = !paused;
  $('btn-pause').textContent = paused ? 'Resume' : 'Pause';
  setStatus(paused ? 'paused' : 'moving');
});
$('btn-restart').addEventListener('click', () => newGame(true));
$('ov-btn').addEventListener('click', () => newGame(true));
$('speed').addEventListener('input', e => {
  stepMs = Number(e.target.value);
  $('speed-val').textContent = `${stepMs}ms`;
});

/* ---------------- health check ---------------- */
fetch('/api/health').then(r => r.json()).then(h => {
  if (h.ok && !h.keyConfigured) $('s-key-warn').classList.remove('hidden');
}).catch(() => $('s-key-warn').classList.remove('hidden'));

/* ---------------- main loop ---------------- */
// Simulation runs on a timer so the AI keeps playing even in background tabs;
// rendering runs on requestAnimationFrame (pauses when hidden).
let lastTick = performance.now();
function tick(now) {
  const dt = Math.min(100, now - lastTick);
  lastTick = now;
  if (gameOverFlag || paused) return;
  if (freezeMs > 0) {
    freezeMs -= dt;
    if (freezeMs <= 0) {
      if (pendingReset === 'level') { applyLevelReset(); resetPositions(); }
      else resetPositions();
      pendingReset = null;
    }
  } else {
    if (frightMs > 0) frightMs -= dt;
    updatePac(dt);
    updateGhosts(dt);
    if (frightMs <= 0 && ghosts.some(g => g.fright)) {
      ghosts.forEach(g => { g.fright = false; });
    }
  }
}
setInterval(() => tick(performance.now()), 40);

/* ---------------- 2D rendering ---------------- */
function draw(now) {
  const t = now / 1000;
  const w = wrap.clientWidth, h = Math.max(1, wrap.clientHeight);
  ctx.fillStyle = '#05060f';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#0a0c22';
  ctx.fillRect(offX, offY, cell * W, cell * H);

  // dots
  ctx.fillStyle = '#ffb8ae';
  for (const d of dotCells) {
    if (grid[d.row][d.col] !== '.') continue;
    ctx.beginPath();
    ctx.arc(offX + (d.col + 0.5) * cell, offY + (d.row + 0.5) * cell, Math.max(1.5, cell * 0.09), 0, TAU);
    ctx.fill();
  }

  // power pellets
  for (const p of pellets) {
    if (grid[p.row][p.col] !== 'o') continue;
    const r = Math.max(2, cell * 0.22 * (1 + 0.15 * Math.sin(t * 3 + p.col)));
    ctx.fillStyle = '#ffb8ae';
    ctx.beginPath();
    ctx.arc(offX + (p.col + 0.5) * cell, offY + (p.row + 0.5) * cell, r, 0, TAU);
    ctx.fill();
  }

  // walls
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const ch = MAZE[r][c];
    if (ch === '#') {
      ctx.fillStyle = '#2424d8';
      ctx.fillRect(offX + c * cell, offY + r * cell, cell, cell);
    } else if (ch === 'D') {
      ctx.fillStyle = '#4a4ae8';
      ctx.fillRect(offX + c * cell, offY + r * cell, cell, cell);
    }
  }

  // ghosts
  for (const g of ghosts) {
    if (g.state === 'eaten') continue;
    const x = offX + (g.fx + 0.5) * cell;
    const y = offY + (g.fz + 0.5) * cell + Math.sin(t * 5 + g.spawn.col) * cell * 0.04;
    const r = cell * 0.42;
    const color = g.fright
      ? (frightMs < 2000 && Math.floor(t * 6) % 2 === 0 ? '#f0f0ff' : '#2121de')
      : GHOST_COLORS[ghosts.indexOf(g)];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, Math.PI, TAU);            // top half
    ctx.lineTo(x + r, y + r * 0.55);
    const feet = 4;
    for (let f = 0; f <= feet; f++) {
      const fx = x + r - (2 * r * f) / feet;
      ctx.lineTo(fx, y + (f % 2 === 0 ? r * 0.05 : r * 0.55));
    }
    ctx.closePath();
    ctx.fill();
    const ang = Math.atan2(DIRS[g.dir].dy, DIRS[g.dir].dx);
    const ex = Math.cos(ang) * r * 0.3, ey = Math.sin(ang) * r * 0.3;
    const px2 = -Math.sin(ang), py2 = Math.cos(ang);
    for (const s of [-1, 1]) {
      const cx2 = x + ex + px2 * s * r * 0.4, cy2 = y - r * 0.2 + ey + py2 * s * r * 0.4;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx2, cy2, Math.max(1.5, r * 0.3), 0, TAU);
      ctx.fill();
      ctx.fillStyle = g.fright ? '#2121de' : '#1a1aff';
      ctx.beginPath();
      ctx.arc(cx2 + Math.cos(ang) * r * 0.13, cy2 + Math.sin(ang) * r * 0.13, Math.max(1, r * 0.15), 0, TAU);
      ctx.fill();
    }
  }

  // wait ring
  if (pac.waiting) {
    const x = offX + (pac.fx + 0.5) * cell, y = offY + (pac.fz + 0.5) * cell;
    ctx.strokeStyle = `rgba(255,238,51,${0.45 + 0.4 * Math.sin(t * 6)})`;
    ctx.lineWidth = Math.max(1.5, cell * 0.06);
    ctx.beginPath();
    ctx.arc(x, y, cell * 0.62, 0, TAU);
    ctx.stroke();
  }

  // pacman
  {
    const x = offX + (pac.fx + 0.5) * cell;
    const y = offY + (pac.fz + 0.5) * cell + (pac.waiting ? Math.sin(t * 7) * cell * 0.06 : 0);
    const r = cell * 0.45;
    const ang = Math.atan2(DIRS[pac.dir].dy, DIRS[pac.dir].dx);
    const mouth = 0.16 + 0.34 * (0.5 + 0.5 * Math.sin(t * 9));
    ctx.fillStyle = '#ffee33';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, r, ang + mouth, ang - mouth, true);
    ctx.closePath();
    ctx.fill();
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  draw(now);
}

fit();
updateHud();
renderStats();
setStatus('starting…');
requestAnimationFrame(frame);

// test hooks
window.__pac = {
  stats,
  get: () => ({
    score, lives, level, dotsLeft, paused, gameOverFlag,
    pac: { col: pac.col, row: pac.row, dir: pac.dir, waiting: pac.waiting },
    ghosts: ghosts.map(g => ({ col: g.col, row: g.row, state: g.state, fright: g.fright })),
    calls: stats.calls, errors: stats.errors, flees: stats.flees, last: stats.last,
    preFlight: !!preInFlight, preReady: !!preDecision,
  }),
  die: () => pacDies(),
  newGame: r => newGame(r),
  lastRequest: null,
  tp: (i, c, r, dir = null) => {
    const g = ghosts[i];
    g.col = c; g.row = r; g.fx = c; g.fz = r; g.moving = false;
    if (dir) g.dir = dir;
  },
  tpp: (c, r, dir = 'left') => {
    pac.col = c; pac.row = r; pac.fx = c; pac.fz = r;
    pac.moving = false; pac.waiting = false; pac.dir = dir;
    decisionToken++;
  },
  freezeGhosts: f => { ghostsFrozen = f; },
  setFright: ms => { frightMs = ms; ghosts.forEach(g => { if (g.state === 'chase') g.fright = true; }); },
  project: n => projectGhosts(n).map(g => ({ col: g.col, row: g.row, dir: g.dir, fright: g.fright })),
};

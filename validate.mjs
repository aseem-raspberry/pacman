// Validates the maze: shape, borders, reachability, connectivity, no 2x2 open blocks.
import { MAZE } from './public/maze.mjs';

const H = MAZE.length, W = MAZE[0].length;
const errs = [];
const key = (c, r) => `${c},${r}`;

MAZE.forEach((row, i) => {
  if (row.length !== W) errs.push(`row ${i}: width ${row.length} != ${W}: "${row}"`);
  if (/[^#.oPGD ]/.test(row)) errs.push(`row ${i}: bad chars: "${row}"`);
});
for (let c = 0; c < W; c++) {
  if (MAZE[0][c] !== '#') errs.push(`top border col ${c}`);
  if (MAZE[H - 1][c] !== '#') errs.push(`bottom border col ${c}`);
}
for (let r = 0; r < H; r++) {
  if (MAZE[r][0] !== '#') errs.push(`left border row ${r}`);
  if (MAZE[r][W - 1] !== '#') errs.push(`right border row ${r}`);
}

let P = null; const G = [], O = [], DOTS = [];
MAZE.forEach((row, r) => row.split('').forEach((ch, c) => {
  if (ch === 'P') P = { c, r };
  if (ch === 'G') G.push({ c, r });
  if (ch === 'o') O.push({ c, r });
  if (ch === '.') DOTS.push({ c, r });
}));
if (!P) errs.push('no P cell');
if (G.length !== 4) errs.push(`ghost cell count = ${G.length}, expected 4`);
if (O.length !== 4) errs.push(`pellet count = ${O.length}, expected 4`);

function bfs(start, ghost) {
  const seen = new Set([key(start.c, start.r)]);
  const visit = new Set([key(start.c, start.r)]);
  const q = [start];
  while (q.length) {
    const { c, r } = q.shift();
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr, k = key(nc, nr);
      if (seen.has(k)) continue;
      const ch = MAZE[nr]?.[nc];
      if (ch === undefined || ch === '#') continue;
      const ok = ghost ? true : ch !== 'G' && ch !== 'D';
      if (ok) { seen.add(k); visit.add(k); q.push({ c: nc, r: nr }); }
    }
  }
  return visit;
}

if (P) {
  const reach = bfs(P, false);
  DOTS.forEach(d => { if (!reach.has(key(d.c, d.r))) errs.push(`dot unreachable at (${d.c},${d.r})`); });
  O.forEach(d => { if (!reach.has(key(d.c, d.r))) errs.push(`pellet unreachable at (${d.c},${d.r})`); });
  if (G.length) {
    const gh = bfs(G[0], true);
    if (!gh.has(key(P.c, P.r))) errs.push('ghost house not connected to outside (door missing?)');
    G.forEach(g => { if (!gh.has(key(g.c, g.r))) errs.push(`ghost cell unreachable from ghost 0 at (${g.c},${g.r})`); });
  }
}

for (let r = 0; r < H - 1; r++) for (let c = 0; c < W - 1; c++) {
  const open = [[0, 0], [1, 0], [0, 1], [1, 1]].every(([dc, dr]) => {
    const ch = MAZE[r + dr][c + dc];
    return ch !== '#' && ch !== 'G' && ch !== 'D';
  });
  if (open) errs.push(`2x2 open block at (${c},${r})`);
}

console.log(`grid ${W}x${H}, dots ${DOTS.length}, pellets ${O.length}, ghosts ${G.length}, pacman at ${P ? `(${P.c},${P.r})` : '?'}`);
if (errs.length) { console.log('ERRORS:'); errs.forEach(e => console.log(' -', e)); process.exit(1); }
console.log('MAZE OK');
MAZE.forEach((row, r) => console.log(String(r).padStart(2), row));

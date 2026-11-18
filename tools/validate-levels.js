#!/usr/bin/env node
/*
 * 레벨 검증기 — 게임과 같은 물리 코드로 가능한 점프를 모두 시뮬레이션해
 * 시작점에서 별등대까지 갈 수 있는지, 각 점프가 얼마나 어려운지 확인한다.
 *
 * 점프 하나 = 출발 위치 x 방향(←↑→) x 차지 x 공중 조작(없음/←/→ 계속 누름) x 출발 시각.
 * 움직이는 발판이나 돌풍이 있는 화면(과 그 위아래 화면)에서는 출발 시각을 16프레임 간격으로 바꿔 본다.
 * 무너지는 돌 위에서는 남은 시간 안에 걷고 차지해야 하므로, 착지 위치와 남은 시간을 함께 기억한다.
 *
 *   node tools/validate-levels.js           요약 + 화면별 도달 지도
 *   node tools/validate-levels.js -q        요약만
 *   node tools/validate-levels.js --edges N 화면 N에서 출발하는 모든 이동
 *
 * 지도 기호:  ^ 도달한 발판 위   x 도달 못 한 발판 위   = 움직이는 발판 출발 위치   - 도착 위치
 * 어려움 수치: 그 이동에 성공하는 (위치·방향·차지·공중 조작) 조합 수를 출발 시각 하나당으로 환산한 값.
 */
'use strict';
const Ph = require('../src/physics.js');
const L = require('../src/levels.js');
const { TILE, ROWS, CYCLE, P, World, createPlayer, step, overlaps, groundUnder, T_ICE, T_CRUMBLE } = Ph;

const quiet = process.argv.includes('-q');
const t0 = Date.now();
const world = new World(L.SCREENS);
const COLS = Ph.COLS;

const timed = L.SCREENS.map((s) => !!((s.wind && s.gust) || (s.movers && s.movers.length)));
const nearTimed = (sc) => timed[sc] || !!timed[sc - 1] || !!timed[sc + 1];
const PHASES = [];
for (let t = 0; t < CYCLE; t += 16) PHASES.push(t);

// ── 1. 설 수 있는 위치를 발판(segment)으로 묶기 (무너지는 돌은 멀쩡한 상태 기준) ──
world.reset(0);
const segAt = new Map();
const segs = [];
const probe = createPlayer(0, 0);
for (let r = 1; r <= world.rows; r++) {
  const arr = new Int32Array(world.width).fill(-1);
  let cur = -1;
  for (let x = 0; x <= world.width - P.W; x++) {
    probe.x = x; probe.y = r * TILE - P.H;
    const g = overlaps(world, x, probe.y) ? 0 : groundUnder(world, probe);
    if (g) {
      if (cur === -1) { cur = segs.length; segs.push({ id: cur, row: r, x0: x, x1: x, ice: false, crumble: false, screen: world.screenAt(r * TILE - 8) }); }
      segs[cur].x1 = x; arr[x] = cur;
      if (g === T_ICE) segs[cur].ice = true;
      if (g === T_CRUMBLE) segs[cur].crumble = true;
    } else cur = -1;
  }
  segAt.set(r, arr);
}
function segOf(p) {
  const arr = segAt.get(Math.round((p.y + P.H) / TILE));
  if (!arr) return -1;
  for (const x of [Math.round(p.x), Math.floor(p.x), Math.ceil(p.x)]) if (x >= 0 && x < arr.length && arr[x] >= 0) return arr[x];
  return -1;
}
function crumbleGroupUnder(p) {
  const r = Math.round((p.y + P.H) / TILE);
  for (let c = Math.floor(p.x / TILE); c <= Math.floor((p.x + P.W - 1e-6) / TILE); c++) {
    const i = r * COLS + c;
    if (c >= 0 && c < COLS && world.grid[i] === T_CRUMBLE) return world.groupOf[i];
  }
  return -1;
}

// ── 2. 노드: 고정 발판 / 움직이는 발판 / 무너지는 돌(착지 위치·남은 시간) ──
const nodes = [], nodeIdx = new Map();
function nodeId(key, data) {
  if (!nodeIdx.has(key)) { nodeIdx.set(key, nodes.length); nodes.push(Object.assign({ key }, data)); }
  return nodeIdx.get(key);
}
function nodeOf(p) {
  if (!p.onGround) return -1;
  if (p.plat) return nodeId('m' + p.plat.id, { type: 'm', m: p.plat.id, screen: p.plat.screen });
  const s = segOf(p);
  if (s < 0) return -1;
  if (!segs[s].crumble) return nodeId('s' + s, { type: 's', seg: s, screen: segs[s].screen });
  const gi = crumbleGroupUnder(p);
  if (gi < 0) return nodeId('s' + s, { type: 's', seg: s, screen: segs[s].screen });
  const g = world.groups[gi];
  const left = g.state === 1 ? g.timer : P.CRUMBLE_DELAY;
  const x = Math.round(p.x / 8) * 8, lb = Math.floor(left / 10) * 10;
  return nodeId(`c${s}:${x}:${lb}`, { type: 'c', seg: s, g: gi, x, left: lb, screen: segs[s].screen });
}

// ── 3. 시뮬레이션 ──
const NONE = { jump: false, left: false, right: false };
const LEFT = { jump: false, left: true, right: false };
const RIGHT = { jump: false, left: false, right: true };
const goals = world.objects.filter((o) => o.ch === 'G');
const touchesGoal = (p) => goals.some((g) => p.x < g.x + TILE + 4 && p.x + P.W > g.x - 4 && p.y < g.y + TILE && p.y + P.H > g.y);

// 시각에 따라 결과가 달라질 수 있는 점프인지(움직이는 발판 근처를 지났거나 돌풍 속을 날았는지) 기록한다.
// 그렇지 않은 점프는 한 시각만 시뮬레이션하고 나머지 시각도 같은 결과로 친다.
const moverBoxes = world.movers.map((m) => ({
  x0: Math.min(m.x0, m.x0 + m.ax) - 6, x1: Math.max(m.x0, m.x0 + m.ax) + m.w + 6,
  y0: Math.min(m.y0, m.y0 + m.ay) - 20, y1: Math.max(m.y0, m.y0 + m.ay) + 12,
}));
let sensitive = false;
function markTime(p) {
  if (sensitive) return;
  if (p.plat) { sensitive = true; return; }
  if (!p.onGround) { const sc = L.SCREENS[world.screenAt(p.y + P.H / 2)]; if (sc.gust && sc.wind) { sensitive = true; return; } }
  for (const b of moverBoxes) if (p.x < b.x1 && p.x + P.W > b.x0 && p.y < b.y1 && p.y + P.H > b.y0) { sensitive = true; return; }
}
// 불티: 게임과 같은 판정(타일 둘레 3px)으로 시뮬레이션 중 닿은 적이 있는지 기록
const sparks = world.objects.filter((o) => o.ch === '*');
const sparkHit = new Set();
function touchSparks(p) {
  for (let i = 0; i < sparks.length; i++) {
    const o = sparks[i];
    if (p.x < o.x + TILE + 3 && p.x + P.W > o.x - 3 && p.y < o.y + TILE + 3 && p.y + P.H > o.y - 3) sparkHit.add(i);
  }
}
function tickStep(p, inp) { world.tick(p); step(p, inp, world); p.events.length = 0; markTime(p); touchSparks(p); }

function settle(p, airDir) {
  const AIR = airDir < 0 ? LEFT : airDir > 0 ? RIGHT : NONE;
  let goal = false;
  for (let f = 0; f < 3000; f++) {
    if (touchesGoal(p)) goal = true;
    if (p.onGround && p.vx === 0 && p.splat === 0) return { p, goal };
    let inp = p.onGround ? NONE : AIR;
    if (p.onGround && p.ice && p.splat === 0) inp = p.vx > 0.06 ? LEFT : p.vx < -0.06 ? RIGHT : NONE; // 얼음 위에서 제동
    tickStep(p, inp);
  }
  return null;
}

function begin(node, t, x) {
  world.reset(t);
  sensitive = node.type === 'm';
  if (node.type === 'm') {
    const m = world.movers[node.m], p = createPlayer(m.x + x, m.y - P.H);
    p.plat = m;
    return p;
  }
  const p = createPlayer(x, segs[node.seg].row * TILE - P.H);
  if (node.type === 'c') {
    const walk = Math.ceil(Math.abs(x - node.x) / P.WALK);
    if (walk >= node.left - 1) return null;
    const g = world.groups[node.g];
    g.state = 1; g.timer = node.left - walk;
  }
  return p;
}

function simJump(node, t, x, dir, k, air) {
  // 무너지는 돌: 걷고 차지하는 동안 무너지면 점프가 아니라 추락일 뿐이니 건너뛴다
  if (node.type === 'c' && Math.ceil(Math.abs(x - node.x) / P.WALK) + k >= node.left - 1) return null;
  const p = begin(node, t, x);
  if (!p) return null;
  const hold = { jump: true, left: dir < 0, right: dir > 0 };
  const release = { jump: false, left: dir < 0, right: dir > 0 };
  for (let f = 0; f < k && p.onGround; f++) tickStep(p, hold);
  if (p.onGround) tickStep(p, release);
  return settle(p, air);
}

function simWalkOff(node, dir) {
  const seg = segs[node.seg];
  const p = begin(node, 0, dir < 0 ? seg.x0 : seg.x1);
  for (let f = 0; f < 300 && p.onGround; f++) tickStep(p, dir < 0 ? LEFT : RIGHT);
  if (p.onGround) return null;
  return settle(p, 0);
}

function samples(node) {
  const isTimed = node.type === 'm' || nearTimed(node.screen);
  const phases = isTimed ? PHASES : [0];
  const kStep = isTimed ? 2 : 1, xStep = isTimed || node.type === 'c' ? 4 : 2;
  const xs = [];
  if (node.type === 'm') {
    const m = world.movers[node.m];
    for (let x = -P.W + 1; x <= m.w - 1; x += xStep) xs.push(x);
  } else {
    const seg = segs[node.seg];
    let a = seg.x0, b = seg.x1;
    if (node.type === 'c') { const reach = Math.max(0, node.left - 3) * P.WALK; a = Math.max(a, node.x - reach); b = Math.min(b, node.x + reach); }
    for (let x = a; x <= b; x += xStep) xs.push(x);
    if (xs[xs.length - 1] !== b) xs.push(b);
  }
  const ks = [];
  for (let k = 1; k <= P.CHARGE_FRAMES; k += kStep) ks.push(k);
  if (ks[ks.length - 1] !== P.CHARGE_FRAMES) ks.push(P.CHARGE_FRAMES);
  return { phases, xs, ks, weight: ((xStep / 2) * kStep) / phases.length };
}

// ── 4. BFS ──
const startObj = world.objects.find((o) => o.ch === 'P');
world.reset(0);
const startP = createPlayer(startObj.x + (TILE - P.W) / 2, startObj.y + TILE - P.H);
const startNode = nodeOf(startP);
if (startNode < 0) { console.error('시작 위치(P) 아래에 발판이 없습니다.'); process.exit(1); }

const dist = [], edgeW = new Map();
let goalVia = -1, sims = 0;
dist[startNode] = 0;
const queue = [startNode];
while (queue.length) {
  const u = queue.shift(), node = nodes[u];
  const { phases, xs, ks, weight } = samples(node);
  const take = (res, w) => {
    sims++;
    if (!res) return;
    if (res.goal && goalVia < 0) goalVia = u;
    const v = nodeOf(res.p);
    if (v < 0 || v === u) return;
    const key = u + '>' + v;
    edgeW.set(key, (edgeW.get(key) || 0) + w);
    if (dist[v] === undefined) { dist[v] = dist[u] + 1; queue.push(v); }
  };
  for (const x of xs) for (const dir of [-1, 0, 1]) for (const k of ks) for (const air of [-1, 0, 1]) {
    const first = simJump(node, phases[0], x, dir, k, air);
    if (!sensitive) { take(first, weight * phases.length); continue; }
    take(first, weight);
    for (let i = 1; i < phases.length; i++) take(simJump(node, phases[i], x, dir, k, air), weight);
  }
  if (node.type === 's') { take(simWalkOff(node, -1), 1); take(simWalkOff(node, 1), 1); }
}

const reachedSeg = new Set(), reachedMover = new Set();
nodes.forEach((n, i) => { if (dist[i] === undefined) return; if (n.type === 'm') reachedMover.add(n.m); else reachedSeg.add(n.seg); });

// 발판 위를 걷기만 해도 별등대에 닿는 경우
let goalNode = -1;
for (const g of goals) {
  const arr = segAt.get(Math.floor(g.y / TILE) + 1);
  if (!arr) continue;
  for (let x = Math.max(0, g.x - P.W - 3); x < Math.min(arr.length, g.x + TILE + 4); x++) {
    if (arr[x] >= 0 && reachedSeg.has(arr[x])) { goalNode = nodeIdx.get('s' + arr[x]); break; }
  }
}

function describe(i) {
  const n = nodes[i];
  if (n.type === 'm') { const m = world.movers[n.m]; return `화면${m.screen} 움직이는 발판${n.m}`; }
  const g = segs[n.seg], top = (world.n - 1 - g.screen) * ROWS;
  return `화면${g.screen} r${g.row - top} c${Math.floor(g.x0 / TILE)}-${Math.floor((g.x1 + P.W - 1) / TILE)}${g.ice ? ' 얼음' : ''}${n.type === 'c' ? ' 무너짐' : ''}`;
}

// ── 5. 출력 ──
if (!quiet) {
  for (let sc = world.n - 1; sc >= 0; sc--) {
    const S = L.SCREENS[sc];
    const tags = [L.ZONES[S.zone].name];
    if (S.wind) tags.push(`바람 ${S.wind > 0 ? '→' : '←'} ${Math.abs(S.wind)}${S.gust ? ' (돌풍)' : ''}`);
    console.log(`\n── 화면 ${sc} (${tags.join(', ')}) ──`);
    const rows = S.map.map((l) => l.split(''));
    const top = (world.n - 1 - sc) * ROWS;
    for (const g of segs) {
      const lr = g.row - 1 - top;
      if (lr < 0 || lr >= ROWS) continue;
      const mark = reachedSeg.has(g.id) ? '^' : 'x';
      for (let c = Math.floor(g.x0 / TILE); c <= Math.floor((g.x1 + P.W - 1) / TILE); c++) if (rows[lr][c] === '.') rows[lr][c] = mark;
    }
    for (const m of world.movers.filter((mm) => mm.screen === sc)) {
      const spec = { c: m.x0 / TILE, r: m.y0 / TILE - top, w: m.w / TILE };
      const ends = [[spec.c, spec.r, '='], [spec.c + m.ax / TILE, spec.r + m.ay / TILE, '-']];
      for (const [c0, r0, ch] of ends) for (let c = c0; c < c0 + spec.w; c++) if (rows[r0] && rows[r0][c] === '.') rows[r0][c] = ch;
    }
    rows.forEach((r, i) => console.log(String(i).padStart(2) + ' ' + r.join('')));
    for (const m of world.movers.filter((mm) => mm.screen === sc)) console.log(`   움직이는 발판${m.id}: ${reachedMover.has(m.id) ? '도달' : '✗ 도달 못 함'}`);
  }
}

const reachableSegs = segs.filter((g) => reachedSeg.has(g.id)).length;
console.log(`\n발판 ${segs.length}개 중 ${reachableSegs}개, 움직이는 발판 ${world.movers.length}개 중 ${reachedMover.size}개 도달 · 시뮬레이션 ${sims.toLocaleString()}회 · ${((Date.now() - t0) / 1000).toFixed(1)}초`);

let ok = true;
for (const o of world.objects.filter((o) => o.ch === 'S' || o.ch === 'N')) {
  const arr = segAt.get(Math.floor(o.y / TILE) + 1);
  let hit = false;
  if (arr) for (let x = Math.max(0, o.x - P.W + 1); x < o.x + TILE; x++) if (arr[x] >= 0 && reachedSeg.has(arr[x])) hit = true;
  if (!hit) { ok = false; console.log(`✗ ${o.ch === 'S' ? '기억의 돌' : '까마귀'} (화면${o.screen}, c${o.col})에 닿을 수 없음`); }
}

console.log(`불티 ${sparkHit.size} / ${sparks.length}개 모을 수 있음`);
sparks.forEach((o, i) => { if (!sparkHit.has(i)) { ok = false; console.log(`✗ 불티 (화면${o.screen}, c${o.col})에 닿을 수 없음`); } });

const ei = process.argv.indexOf('--edges');
if (ei > 0) {
  const scs = process.argv[ei + 1].split(',').map(Number);
  console.log(`\n화면 ${scs.join(', ')}에서 출발하는 이동`);
  const list = [...edgeW].map(([key, w]) => { const [a, b] = key.split('>').map(Number); return { a, b, w }; })
    .filter((e) => scs.includes(nodes[e.a].screen)).sort((x, y) => x.a - y.a || y.w - x.w);
  for (const e of list) console.log(`  ${describe(e.a).padEnd(26)} → ${describe(e.b).padEnd(26)} (${e.w.toFixed(1)})`);
}

const endNode = goalNode >= 0 ? goalNode : goalVia;
if (endNode < 0) {
  ok = false;
  let best = startNode, bestR = Infinity;
  nodes.forEach((n, i) => {
    if (dist[i] === undefined) return;
    const y = n.type === 'm' ? world.movers[n.m].y0 : segs[n.seg].row * TILE;
    if (y < bestR) { bestR = y; best = i; }
  });
  console.log(`✗ 별등대(G)에 도달할 수 없음. 가장 높이 간 곳: ${describe(best)}`);
} else {
  // 가장 쉬운 경로: 경로 중 가장 어려운 이동이 최대한 쉬운 경로 (widest path)
  const adj = new Map();
  for (const [key, w] of edgeW) {
    const [a, b] = key.split('>').map(Number);
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ b, w });
  }
  const N = nodes.length, width = new Array(N).fill(-1), hops = new Array(N).fill(Infinity), prev = new Array(N).fill(-1), done = new Uint8Array(N);
  width[startNode] = Infinity; hops[startNode] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < N; i++) if (!done[i] && width[i] >= 0 && (u < 0 || width[i] > width[u] || (width[i] === width[u] && hops[i] < hops[u]))) u = i;
    if (u < 0) break;
    done[u] = 1;
    for (const { b, w } of adj.get(u) || []) {
      const nw = Math.min(width[u], w);
      if (!done[b] && (nw > width[b] || (nw === width[b] && hops[u] + 1 < hops[b]))) { width[b] = nw; hops[b] = hops[u] + 1; prev[b] = u; }
    }
  }
  const path = [];
  for (let s = endNode; prev[s] >= 0; s = prev[s]) path.unshift({ a: prev[s], b: s });
  console.log(`✓ 별등대 도달 가능 (최소 ${dist[endNode] + (goalNode >= 0 ? 0 : 1)}번 이동)\n\n가장 쉬운 경로 — 괄호 = 성공하는 조합 수(출발 시각 하나당), 적을수록 어려움`);
  for (const e of path) {
    const w = edgeW.get(e.a + '>' + e.b) || 0;
    console.log(`  ${describe(e.a).padEnd(26)} → ${describe(e.b).padEnd(26)} (${w.toFixed(1)})${w < 15 ? '  ← 어려움' : ''}`);
  }
  console.log(`가장 어려운 이동의 조합 수: ${width[endNode].toFixed(1)}`);
}
process.exit(ok ? 0 : 1);

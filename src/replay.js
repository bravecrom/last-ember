/*
 * replay.js — 입력 기록으로 오르기를 다시 재생한다 (고스트 · 추락 다시 보기).
 * 물리가 60fps 고정 스텝의 결정론적 코드라서, 시작 상태와 프레임마다의 입력(←·→·점프 3비트)만 있으면 똑같이 재현된다.
 *
 *   Recorder  한 번의 오르기를 구간(이어하기마다 새 구간)별로 기록. encode/decode로 문자열 저장.
 *   Ghost     기록을 자기만의 World에서 한 프레임씩 재생 (최고 기록 고스트).
 *   History   최근 15초의 입력과 0.5초마다의 상태 사본. 큰 추락을 다시 보여 줄 때 쓴다.
 *   Playback  History의 한 구간을 별도 World에서 재생.
 */
(function () {
  'use strict';
  const { World, createPlayer, step } = Physics;

  const toBits = (inp) => (inp.left ? 1 : 0) | (inp.right ? 2 : 0) | (inp.jump ? 4 : 0);
  const INPUTS = [];
  for (let b = 0; b < 8; b++) INPUTS.push({ left: !!(b & 1), right: !!(b & 2), jump: !!(b & 4) });

  // ── 기록 ──
  // 구간 = { x, y, facing, runs: [[입력비트, 프레임 수], ...] } — 같은 입력이 이어지면 한 덩어리로 센다
  function Recorder(segs) { this.segs = segs || []; this.cur = null; }
  Recorder.prototype.begin = function (p) {
    this.cur = { x: p.x, y: p.y, facing: p.facing, runs: [] };
    this.segs.push(this.cur);
  };
  Recorder.prototype.push = function (bits) {
    const r = this.cur.runs, last = r[r.length - 1];
    if (last && last[0] === bits) last[1]++;
    else r.push([bits, 1]);
  };
  // 문자열: 구간은 '|'로, 구간 머리는 'x,y,facing:', 덩어리는 입력비트(0~7) + 36진수 길이를 '.'로 잇는다.
  // 좌표는 소수점을 자르지 않는다 (잘리면 재현이 어긋난다).
  function encode(segs) {
    return segs.map((s) => `${s.x},${s.y},${s.facing}:` + s.runs.map(([b, n]) => b + n.toString(36)).join('.')).join('|');
  }
  function decode(str) {
    if (!str) return [];
    return str.split('|').map((part) => {
      const [head, body] = part.split(':'), [x, y, facing] = head.split(',').map(Number);
      const runs = body ? body.split('.').map((t) => [Number(t[0]), parseInt(t.slice(1), 36)]) : [];
      return { x, y, facing, runs };
    });
  }

  // ── 고스트 ──
  function Ghost(segs, screens, dark) {
    this.segs = segs;
    this.world = new World(screens, { dark });
    this.si = -1;
    this.done = false;
    this.frame = 0;
    this.nextSeg();
  }
  Ghost.prototype.nextSeg = function () {
    for (;;) {
      this.si++;
      if (this.si >= this.segs.length) { this.done = true; return; }
      const s = this.segs[this.si];
      if (!s.runs.length) continue;
      this.world.reset(0);
      this.p = createPlayer(s.x, s.y);
      this.p.facing = s.facing;
      this.ri = 0;
      this.left = s.runs[0][1];
      return;
    }
  };
  Ghost.prototype.tick = function () {
    if (this.done) return;
    const s = this.segs[this.si];
    this.world.tick(this.p);
    step(this.p, INPUTS[s.runs[this.ri][0]], this.world);
    this.p.events.length = 0;
    this.world.events.length = 0;
    this.frame++;
    if (--this.left > 0) return;
    if (++this.ri < s.runs.length) this.left = s.runs[this.ri][1];
    else this.nextSeg();
  };

  // ── 최근 입력과 상태 사본 ──
  const HIST = 900, SNAP_EVERY = 30;
  function clonePlayer(p) { return Object.assign({}, p, { events: [], plat: p.plat ? p.plat.id : null }); }
  function History() { this.bits = new Uint8Array(HIST); this.reset(); }
  History.prototype.reset = function () { this.n = 0; this.snaps = []; };
  // 프레임을 진행하기 직전에 부른다
  History.prototype.before = function (p, world) {
    if (this.n % SNAP_EVERY) return;
    this.snaps.push({ n: this.n, p: clonePlayer(p), t: world.t, g: world.groups.map((g) => [g.state, g.timer]) });
    while (this.snaps.length && this.snaps[0].n < this.n - HIST + SNAP_EVERY) this.snaps.shift();
  };
  History.prototype.push = function (bits) { this.bits[this.n % HIST] = bits; this.n++; };
  // from 프레임부터 재생할 수 있는지 (그 앞의 사본이 남아 있는지)
  History.prototype.snapFor = function (from) {
    let best = null;
    for (const s of this.snaps) if (s.n <= from && s.n > this.n - HIST) best = s;
    return best;
  };

  function Playback(screens, dark) { this.world = new World(screens, { dark }); this.p = null; }
  Playback.prototype.start = function (hist, from, to) {
    const s = hist.snapFor(from);
    if (!s) return false;
    const w = this.world;
    w.reset(s.t);
    w.groups.forEach((g, i) => { g.state = s.g[i][0]; g.timer = s.g[i][1]; for (const c of g.cells) w.broken[c] = g.state === 2 ? 1 : 0; });
    this.p = Object.assign(createPlayer(0, 0), s.p, { events: [], plat: s.p.plat === null ? null : w.movers[s.p.plat] });
    this.hist = hist; this.f = s.n; this.end = to; this.begin = s.n;
    return true;
  };
  // 한 프레임 재생. 끝났으면 false. 이번 프레임의 사건(점프·착지)을 돌려준다.
  Playback.prototype.tick = function () {
    if (this.f >= this.end) return null;
    const p = this.p;
    p.events.length = 0;
    this.world.tick(p);
    this.world.events.length = 0;
    step(p, INPUTS[this.hist.bits[this.f % HIST]], this.world);
    this.f++;
    return p.events;
  };

  window.Replay = { toBits, Recorder, encode, decode, Ghost, History, Playback, HIST };
})();

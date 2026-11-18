/*
 * physics.js — 60fps 고정 스텝의 결정론적 플레이어 물리.
 * 게임(game.js)과 레벨 검증기(tools/validate-levels.js)가 같은 코드를 쓴다.
 *
 * 한 프레임 = world.tick(player) 다음 step(player, input, world).
 * 움직이는 발판과 돌풍은 world.t(프레임 수)로 위치·세기가 정해지므로 같은 시각이면 늘 같다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Physics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TILE = 16, COLS = 32, ROWS = 18;
  const SCREEN_W = COLS * TILE, SCREEN_H = ROWS * TILE; // 512 x 288
  const CYCLE = 240; // 움직이는 발판·돌풍의 공통 주기(프레임). 발판 주기는 이 값의 약수여야 한다.

  // 모든 속도 단위는 px/frame (60fps)
  const P = {
    W: 10, H: 14,               // 히트박스
    GRAVITY: 0.3, MAX_FALL: 9, MAX_VX: 5,
    WALK: 1.4,
    JUMP_VX: 2.6,               // 점프 수평 속도
    MIN_VY: 2.2, MAX_VY: 8.4,   // 차지량에 따라 수직 속도가 정해진다
    CHARGE_FRAMES: 35,          // 최대 차지까지 걸리는 프레임 (최대에 닿으면 자동 점프)
    AIR_ACCEL: 0.15,            // 공중에서 방향키를 누르면 이만큼씩 가속
    AIR_MAX: 2.6,               // 공중 이동 최고 속도 (점프 수평 속도와 같음)
    BOUNCE: 0.5,                // 공중에서 벽에 부딪히면 반대로 튕김
    ICE_ACCEL: 0.05, ICE_FRICTION: 0.975, ICE_LAND_KEEP: 0.85,
    SPLAT_FALL: 170,            // 이 거리(px) 이상 떨어지면 엎어진다
    SPLAT_FRAMES: 45,
    CRUMBLE_DELAY: 42,          // 무너지는 돌: 밟은 뒤 무너질 때까지
    CRUMBLE_RESPAWN: 180,       // 무너진 뒤 다시 생길 때까지
  };

  const T_AIR = 0, T_SOLID = 1, T_ICE = 2, T_CRUMBLE = 3;

  // 돌풍 세기 0~1: 한 주기(240프레임) 중 130프레임 불고 90프레임 쉰다.
  function gustFactor(t) {
    const ph = ((t % CYCLE) + CYCLE) % CYCLE;
    if (ph < 20) return ph / 20;
    if (ph < 130) return 1;
    if (ph < 150) return (150 - ph) / 20;
    return 0;
  }

  // screens: 아래(0)부터 위로. 각 screen.map은 위→아래 18줄, 줄마다 32글자.
  function World(screens) {
    this.screens = screens;
    this.n = screens.length;
    this.rows = this.n * ROWS;
    this.width = SCREEN_W;
    this.height = this.rows * TILE;
    this.grid = new Uint8Array(COLS * this.rows);
    this.broken = new Uint8Array(COLS * this.rows);
    this.groupOf = new Int32Array(COLS * this.rows).fill(-1);
    this.groups = [];
    this.objects = [];
    this.movers = [];
    this.events = [];
    for (let s = 0; s < this.n; s++) {
      const map = screens[s].map, top = (this.n - 1 - s) * ROWS;
      if (map.length !== ROWS) throw new Error(`screen ${s}: ${map.length}줄 (필요: ${ROWS})`);
      for (let r = 0; r < ROWS; r++) {
        const line = map[r];
        if (line.length !== COLS) throw new Error(`screen ${s} row ${r}: ${line.length}칸 (필요: ${COLS})`);
        const wr = top + r;
        for (let c = 0; c < COLS; c++) {
          const ch = line[c], i = wr * COLS + c;
          if (ch === '#') this.grid[i] = T_SOLID;
          else if (ch === 'I') this.grid[i] = T_ICE;
          else if (ch === 'C') {
            this.grid[i] = T_CRUMBLE;
            // 가로로 이어진 C는 한 덩어리로 함께 무너진다
            if (c > 0 && this.grid[i - 1] === T_CRUMBLE) { this.groupOf[i] = this.groupOf[i - 1]; this.groups[this.groupOf[i]].cells.push(i); }
            else { this.groupOf[i] = this.groups.length; this.groups.push({ cells: [i], state: 0, timer: 0, screen: s }); }
          } else if (ch !== '.') this.objects.push({ ch, screen: s, col: c, row: wr, x: c * TILE, y: wr * TILE });
        }
      }
      for (const m of screens[s].movers || []) {
        const period = m.period || CYCLE;
        if (CYCLE % period) throw new Error(`screen ${s}: 발판 주기 ${period}는 ${CYCLE}의 약수여야 합니다`);
        this.movers.push({
          id: this.movers.length, screen: s,
          x0: m.col * TILE, y0: (top + m.row) * TILE, w: m.w * TILE, ax: (m.dx || 0) * TILE, ay: (m.dy || 0) * TILE,
          period, phase: m.phase || 0, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0,
        });
      }
    }
    this.reset(0);
  }
  World.prototype.tile = function (c, r) {
    if (c < 0 || c >= COLS || r >= this.rows) return T_SOLID;
    if (r < 0) return T_AIR;
    const i = r * COLS + c, v = this.grid[i];
    return v === T_CRUMBLE && this.broken[i] ? T_AIR : v;
  };
  World.prototype.screenAt = function (y) {
    const s = this.n - 1 - Math.floor(y / SCREEN_H);
    return s < 0 ? 0 : s >= this.n ? this.n - 1 : s;
  };
  World.prototype.screenTop = function (s) { return (this.n - 1 - s) * SCREEN_H; };
  World.prototype.windAt = function (y) {
    const sc = this.screens[this.screenAt(y)], w = sc.wind || 0;
    return w && sc.gust ? w * gustFactor(this.t) : w;
  };
  World.prototype.moverAt = function (m, t) {
    const s = (1 - Math.cos((2 * Math.PI * (t + m.phase)) / m.period)) / 2;
    return [m.x0 + m.ax * s, m.y0 + m.ay * s];
  };
  World.prototype.setTime = function (t) {
    this.t = t;
    for (const m of this.movers) {
      const [px, py] = this.moverAt(m, t - 1), [x, y] = this.moverAt(m, t);
      m.px = px; m.py = py; m.x = x; m.y = y; m.vx = x - px; m.vy = y - py;
    }
  };
  World.prototype.reset = function (t = 0) {
    for (const g of this.groups) { g.state = 0; g.timer = 0; for (const i of g.cells) this.broken[i] = 0; }
    this.events.length = 0;
    this.setTime(t);
  };
  // 한 프레임 진행: 시계, 움직이는 발판, 무너지는 돌 (p: 다시 생기는 돌이 플레이어와 겹치지 않게 확인)
  World.prototype.tick = function (p) {
    this.setTime(this.t + 1);
    for (const g of this.groups) {
      if (g.state === 1 && --g.timer <= 0) {
        g.state = 2; g.timer = P.CRUMBLE_RESPAWN;
        for (const i of g.cells) this.broken[i] = 1;
        this.events.push({ type: 'break', g });
      } else if (g.state === 2 && --g.timer <= 0) {
        if (p && g.cells.some((i) => cellOverlaps(i, p))) g.timer = 1;
        else { g.state = 0; for (const i of g.cells) this.broken[i] = 0; this.events.push({ type: 'restore', g }); }
      }
    }
  };
  function cellOverlaps(i, p) {
    const x = (i % COLS) * TILE, y = Math.floor(i / COLS) * TILE;
    return p.x < x + TILE && p.x + P.W > x && p.y < y + TILE && p.y + P.H > y;
  }

  function createPlayer(x, y) {
    return {
      x, y, vx: 0, vy: 0, onGround: true, ice: false, plat: null,
      charge: 0, charging: false, facing: 1, splat: 0,
      apexY: y, events: [],
    };
  }

  function overlaps(w, x, y) {
    const c0 = Math.floor(x / TILE), c1 = Math.floor((x + P.W - 1e-6) / TILE);
    const r0 = Math.floor(y / TILE), r1 = Math.floor((y + P.H - 1e-6) / TILE);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (w.tile(c, r)) return true;
    return false;
  }

  // 발 밑 타일 종류 (발이 타일 경계에 정확히 놓여 있을 때만)
  function groundUnder(w, p) {
    const feet = p.y + P.H;
    const r = Math.round(feet / TILE);
    if (Math.abs(r * TILE - feet) > 0.01) return T_AIR;
    const tc = w.tile(Math.floor((p.x + P.W / 2) / TILE), r);
    if (tc) return tc;
    return w.tile(Math.floor(p.x / TILE), r) || w.tile(Math.floor((p.x + P.W - 1e-6) / TILE), r);
  }
  function supported(w, p) {
    if (p.plat) return p.x + P.W > p.plat.x && p.x < p.plat.x + p.plat.w;
    return !!groundUnder(w, p);
  }

  function moveX(w, p, dx) {
    p.x += dx;
    if (!overlaps(w, p.x, p.y)) return false;
    if (dx > 0) p.x = Math.floor((p.x + P.W) / TILE) * TILE - P.W;
    else p.x = (Math.floor(p.x / TILE) + 1) * TILE;
    return true;
  }

  function moveY(w, p, dy) {
    p.y += dy;
    if (!overlaps(w, p.x, p.y)) return false;
    if (dy > 0) p.y = Math.floor((p.y + P.H) / TILE) * TILE - P.H;
    else p.y = (Math.floor(p.y / TILE) + 1) * TILE;
    return true;
  }

  // 떨어지는 중에 발이 움직이는 발판 윗면을 지나면 그 발판 (위에서만 올라설 수 있다)
  function moverBelow(w, p, prevFeet, newFeet) {
    let best = null;
    for (const m of w.movers) {
      if (p.x + P.W <= m.x || p.x >= m.x + m.w) continue;
      if (prevFeet <= m.py + 0.5 && newFeet >= m.y && (!best || m.y < best.y)) best = m;
    }
    return best;
  }

  // 발판에 실려 함께 움직인다. 머리가 막히면 떨어지고, 발판이 바닥 아래로 내려가면 바닥에 선다.
  function carry(w, p) {
    const m = p.plat;
    if (m.vx) moveX(w, p, m.vx);
    const dy = m.y - P.H - p.y;
    if (dy && moveY(w, p, dy)) {
      if (dy > 0) p.plat = null;
      else startFall(p);
    }
  }

  function touchCrumble(w, p) {
    const r = Math.round((p.y + P.H) / TILE);
    for (let c = Math.floor(p.x / TILE); c <= Math.floor((p.x + P.W - 1e-6) / TILE); c++) {
      if (c < 0 || c >= COLS || r >= w.rows) continue;
      const i = r * COLS + c;
      if (w.grid[i] !== T_CRUMBLE || w.broken[i]) continue;
      const g = w.groups[w.groupOf[i]];
      if (g.state === 0) { g.state = 1; g.timer = P.CRUMBLE_DELAY; w.events.push({ type: 'crack', g }); }
    }
  }

  function jump(p, dir) {
    const c = Math.min(p.charge, P.CHARGE_FRAMES) / P.CHARGE_FRAMES;
    p.vy = -(P.MIN_VY + (P.MAX_VY - P.MIN_VY) * c);
    p.vx = dir * P.JUMP_VX + (p.plat ? p.plat.vx : 0); // 움직이는 발판의 속도를 이어받는다
    if (dir) p.facing = dir;
    p.onGround = false; p.plat = null; p.charging = false; p.charge = 0; p.apexY = p.y;
    p.events.push({ type: 'jump', power: c });
  }

  function startFall(p) {
    if (p.plat) p.vx += p.plat.vx;
    p.onGround = false; p.plat = null; p.charging = false; p.charge = 0; p.apexY = p.y;
  }

  function land(w, p) {
    const fall = p.y - p.apexY;
    p.vy = 0; p.onGround = true;
    p.ice = !p.plat && groundUnder(w, p) === T_ICE;
    p.vx = p.ice ? p.vx * P.ICE_LAND_KEEP : 0;
    if (fall >= P.SPLAT_FALL) { p.splat = P.SPLAT_FRAMES; p.events.push({ type: 'splat', fall }); }
    else p.events.push({ type: 'land', fall });
  }

  // input: { left, right, jump } (jump = 점프 키를 누르고 있는지)
  function step(p, input, w) {
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);

    if (p.onGround) {
      if (p.plat) carry(w, p);
      if (p.onGround && !supported(w, p)) startFall(p);
    }

    if (p.onGround) {
      const g = p.plat ? T_SOLID : groundUnder(w, p);
      p.ice = g === T_ICE;
      if (g === T_CRUMBLE) touchCrumble(w, p);
      const canAct = p.splat === 0;
      if (p.splat > 0) p.splat--;

      if (canAct && input.jump) {
        p.charging = true; p.charge++;
        if (dir) p.facing = dir;
        if (p.charge >= P.CHARGE_FRAMES) jump(p, dir);
      } else if (p.charging) {
        jump(p, dir);
      }

      if (p.onGround) {
        const walking = canAct && !p.charging && dir !== 0;
        if (walking) p.facing = dir;
        if (p.ice) {
          if (walking) p.vx += dir * P.ICE_ACCEL;
          p.vx *= P.ICE_FRICTION;
          if (Math.abs(p.vx) < 0.02) p.vx = 0;
        } else {
          p.vx = walking ? dir * P.WALK : 0;
        }
        if (p.vx) {
          if (moveX(w, p, p.vx)) p.vx = 0;
          if (!supported(w, p)) startFall(p);
        }
        return;
      }
    }

    // 공중: 방향키 쪽으로 가속(최고 AIR_MAX), 손을 떼면 속도 유지. 중력, 바람, 벽 튕김.
    p.vy = Math.min(p.vy + P.GRAVITY, P.MAX_FALL);
    if (dir && dir * p.vx < P.AIR_MAX) {
      p.vx = dir > 0 ? Math.min(P.AIR_MAX, p.vx + P.AIR_ACCEL) : Math.max(-P.AIR_MAX, p.vx - P.AIR_ACCEL);
      p.facing = dir;
    }
    const wind = w.windAt(p.y + P.H / 2);
    if (wind) p.vx = Math.max(-P.MAX_VX, Math.min(P.MAX_VX, p.vx + wind));
    if (p.vx && moveX(w, p, p.vx)) {
      if (Math.abs(p.vx) > 0.6) p.events.push({ type: 'bump' });
      p.vx = -p.vx * P.BOUNCE;
    }
    const prevFeet = p.y + P.H;
    const m = p.vy > 0 && w.movers.length ? moverBelow(w, p, prevFeet, prevFeet + p.vy) : null;
    if (m && !overlaps(w, p.x, m.y - P.H)) {
      p.y = m.y - P.H; p.plat = m;
      land(w, p);
    } else if (moveY(w, p, p.vy)) {
      if (p.vy > 0) land(w, p);
      else { p.vy = 0; p.events.push({ type: 'bump', ceiling: true }); }
    }
    if (!p.onGround && p.vy <= 0) p.apexY = p.y;
  }

  return { TILE, COLS, ROWS, SCREEN_W, SCREEN_H, CYCLE, P, T_AIR, T_SOLID, T_ICE, T_CRUMBLE, gustFactor, World, createPlayer, step, overlaps, groundUnder };
});

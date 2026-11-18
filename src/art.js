/*
 * art.js — 이미지 파일 없이 코드로 그리는 픽셀 아트.
 * 스프라이트(루미, 까마귀), 구역별 타일, 배경, 장식 오브젝트, 타이틀 장면.
 */
(function () {
  'use strict';
  const { TILE, COLS, ROWS, SCREEN_W: VW, SCREEN_H: VH, T_ICE, T_SOLID, T_CRUMBLE } = Physics;

  const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

  function hash(x, y, k) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(k | 0, 1103515245);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pixEllipse(ctx, cx, cy, rx, ry) {
    for (let dy = -ry; dy <= ry; dy++) {
      const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / (ry * ry))));
      ctx.fillRect(Math.round(cx - half), Math.round(cy + dy), half * 2, 1);
    }
  }
  function vgrad(ctx, top, bottom, h = VH) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top); g.addColorStop(1, bottom);
    ctx.fillStyle = g; ctx.fillRect(0, 0, VW, h);
  }
  function glow(ctx, x, y, r, color, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${color},${a})`); g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // ───────────────────────── 스프라이트 ─────────────────────────
  const OUTLINE = '#1a1222';
  function sprite(rows, pal, outline = OUTLINE) {
    const h = rows.length, w = rows[0].length;
    const cv = makeCanvas(w + 2, h + 2), c = cv.getContext('2d');
    const solid = (x, y) => y >= 0 && y < h && x >= 0 && x < w && rows[y][x] !== '.';
    c.fillStyle = outline;
    for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++)
      if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) c.fillRect(x + 1, y + 1, 1, 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (solid(x, y)) { c.fillStyle = pal[rows[y][x]]; c.fillRect(x + 1, y + 1, 1, 1); }
    return cv;
  }
  function mirror(cv) {
    const m = makeCanvas(cv.width, cv.height), c = m.getContext('2d');
    c.translate(cv.width, 0); c.scale(-1, 1); c.drawImage(cv, 0, 0);
    return m;
  }

  const LUMI_PAL = {
    R: '#d9483b', P: '#f27d5e', r: '#9a2f36', S: '#f7d3ad', E: '#2a1a2e', p: '#ee9585',
    W: '#f5c451', B: '#40609e', b: '#2c4174', K: '#6a4330', k: '#4a2e22', G: '#c9973a', Y: '#fff4b8',
  };
  const HEAD = [
    '.....RRRR.......',
    '....RPPRRR......',
    '...RPRRRRRR.....',
    '...RRRRSSSS.....',
    '...rRRSSSES.....',
    '...rRRSSSSp.....',
    '...rrRWWWWW.....',
  ];
  const TORSO = [
    '....rBBBBBBSG...',
    '....bBBBBBBGYG..',
    '....bBBBBBBGYG..',
    '....bbBBBBB.G...',
    '.....bBBBBB.....',
  ];
  const LEGS = {
    stand: ['.....KK..KK.....', '.....KK..KK.....'],
    strideA: ['....kk...KK.....', '...kk.....KK....'],
    strideB: ['....KK...kk.....', '...KK.....kk....'],
    pass: ['.....KKkk.......', '.....KK.kk......'],
    jump: ['.....KK..KK.....', '....KK....KK....'],
    dangle: ['.....KK..KK.....', '.....K....K.....'],
  };
  function compose({ headY, legs, tail = [] }) {
    const g = Array.from({ length: 16 }, () => '................'.split(''));
    const put = (rows, y) => rows.forEach((row, i) => {
      const yy = y + i;
      if (yy < 0 || yy > 15) return;
      for (let x = 0; x < 16; x++) if (row[x] !== '.') g[yy][x] = row[x];
    });
    put(legs, 14); put(TORSO, 9); put(HEAD, headY);
    tail.forEach(([x, y]) => { if (g[y][x] === '.') g[y][x] = 'W'; });
    return g.map((r) => r.join(''));
  }
  const LUMI_ROWS = {
    idle0: compose({ headY: 2, legs: LEGS.stand, tail: [[3, 9], [2, 10], [2, 11]] }),
    idle1: compose({ headY: 3, legs: LEGS.stand, tail: [[3, 10], [2, 11], [2, 12]] }),
    walk0: compose({ headY: 3, legs: LEGS.strideA, tail: [[3, 9], [2, 10], [1, 10]] }),
    walk1: compose({ headY: 2, legs: LEGS.pass, tail: [[3, 9], [2, 9], [1, 9]] }),
    walk2: compose({ headY: 3, legs: LEGS.strideB, tail: [[3, 9], [2, 10], [1, 10]] }),
    walk3: compose({ headY: 2, legs: LEGS.pass, tail: [[3, 9], [2, 9], [1, 9]] }),
    jump: compose({ headY: 1, legs: LEGS.jump, tail: [[3, 9], [2, 10], [2, 11], [1, 12]] }),
    fall: compose({ headY: 2, legs: LEGS.dangle, tail: [[2, 8], [1, 7], [1, 6]] }),
    crouch: [
      '................', '................', '................', '................', '................',
      '.....RRRR.......',
      '....RPPRRR......',
      '...RPRRRRRR.....',
      '...RRRRSSSS.....',
      '...rRRSSSES.....',
      '...rRRSSSSp.....',
      '..WrrRWWWWWSG...',
      '.W.bBBBBBBGYG...',
      '...bBBBBBBGYG...',
      '...bbBBBBBBG....',
      '....KKK.KKK.....',
    ],
    splat: [
      '................', '................', '................', '................', '................',
      '................', '................', '................', '................', '................',
      '................', '................', '................',
      '..RRRR..........',
      '.RPRRRWBBBBBKK..',
      '.rRRRRWbBBBBKK.G',
    ],
  };
  const lumi = {};
  for (const k in LUMI_ROWS) { const s = sprite(LUMI_ROWS[k], LUMI_PAL); lumi[k] = [s, mirror(s)]; }

  const CROW_PAL = { k: '#272338', K: '#433d61', w: '#6a6394', e: '#ffd75e', y: '#e2a03c' };
  const CROW_BASE = [
    '................', '................', '................', '................', '................',
    '.........kkk....',
    '........kkkkk...',
    '........kkekkyy.',
    '.......kkkkkk...',
    '......kkKKkkk...',
    '.....kKKwKkkk...',
    '....kKKKKkkkk...',
    '...kkKKKkkkk....',
    '..kkk..kkkk.....',
    '.......y..y.....',
    '......yy.yy.....',
  ];
  const crowRows = (patch) => CROW_BASE.map((r, i) => (patch[i] !== undefined ? patch[i] : r));
  const crow = {};
  for (const [k, rows] of Object.entries({
    idle: CROW_BASE,
    blink: crowRows({ 7: '........kkkkkyy.' }),
    caw: crowRows({ 7: '........kkekkyyy', 8: '.......kkkkkky..' }),
  })) { const s = sprite(rows, CROW_PAL, '#0e0b16'); crow[k] = [s, mirror(s)]; }

  // ───────────────────────── 구역 스타일 ─────────────────────────
  const ZS = {
    forest:   { darkRGB: '6,16,20',  lamp: '#d8f08a', lampRGB: '210,240,140', dust: ['#7a5a40', '#9a7a5a'], edge: '#26180f' },
    ramparts: { darkRGB: '16,10,28', lamp: '#ffb455', lampRGB: '255,170,80',  dust: ['#8a8ea4', '#a9adbf'], edge: '#22243a' },
    frost:    { darkRGB: '4,10,26',  lamp: '#8fe8ff', lampRGB: '120,220,255', dust: ['#dcefff', '#ffffff'], edge: '#16263c' },
    gale:     { darkRGB: '10,14,36', lamp: '#ffcf70', lampRGB: '255,200,110', dust: ['#d6c29a', '#efe3c4'], edge: '#4a3c2a' },
    summit:   { darkRGB: '4,3,18',   lamp: '#ffe9a0', lampRGB: '255,225,150', dust: ['#c9a85a', '#ffe08a'], edge: '#100d20' },
  };

  // ───────────────────────── 타일 ─────────────────────────
  function tileBase(c, zone, t, x, y, nb, h, wr) {
    if (t === T_ICE) {
      c.fillStyle = '#76c0e6'; c.fillRect(x, y, 16, 16);
      c.fillStyle = '#9fdcf8'; c.fillRect(x, y, 16, 5);
      c.fillStyle = '#5aa4d2'; c.fillRect(x, y + 11, 16, 5);
      c.fillStyle = '#d8f5ff';
      for (let k = 0; k < 2; k++) {
        const sx = (h(k + 1) * 12) | 0;
        for (let i = 0; i < 5; i++) c.fillRect(x + sx + i, y + 12 - i * 2, 1, 2);
      }
      c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(x + ((h(5) * 14) | 0), y + 6 + ((h(6) * 4) | 0), 2, 1);
      edges(c, x, y, nb, '#2f6f9e');
      return;
    }
    if (zone === 'forest') {
      c.fillStyle = '#4b3327'; c.fillRect(x, y, 16, 16);
      c.fillStyle = '#433026'; c.fillRect(x, y + 6 + ((h(1) * 5) | 0), 16, 2);
      for (let i = 0; i < 10; i++) {
        c.fillStyle = h(i + 10) < 0.5 ? '#3a281f' : '#5d4031';
        c.fillRect(x + ((h(i + 20) * 15) | 0), y + ((h(i + 30) * 15) | 0), h(i + 40) < 0.3 ? 2 : 1, 1);
      }
      if (h(2) < 0.4) {
        const px = x + 2 + ((h(3) * 10) | 0), py = y + 6 + ((h(4) * 7) | 0);
        c.fillStyle = '#6b625a'; c.fillRect(px, py, 3, 2); c.fillStyle = '#8c847a'; c.fillRect(px, py, 1, 1);
      }
    } else if (zone === 'ramparts') {
      c.fillStyle = '#5e6277'; c.fillRect(x, y, 16, 16);
      for (let course = 0; course < 2; course++) {
        const yy = y + course * 8, vx = (wr + course) % 2 ? 8 : 0;
        const parts = vx ? [[0, vx], [vx, 16]] : [[0, 16]];
        parts.forEach(([a, b], i) => {
          const s = h(200 + course * 3 + i);
          if (s < 0.35) { c.fillStyle = 'rgba(0,0,0,.14)'; c.fillRect(x + a, yy, b - a, 7); }
          else if (s > 0.75) { c.fillStyle = 'rgba(255,255,255,.07)'; c.fillRect(x + a, yy, b - a, 7); }
          c.fillStyle = '#7a7f97'; c.fillRect(x + a + 1, yy, b - a - 1, 1);
        });
        c.fillStyle = '#3a3c4f'; c.fillRect(x, yy + 7, 16, 1); c.fillRect(x + vx, yy, 1, 7);
      }
      if (h(220) < 0.18) {
        c.fillStyle = '#45485b';
        const cx = x + 3 + ((h(221) * 9) | 0);
        for (let i = 0; i < 4; i++) c.fillRect(cx + (i % 2), y + 2 + i * 2 + ((h(222) * 3) | 0), 1, 2);
      }
    } else if (zone === 'frost') {
      c.fillStyle = '#34506f'; c.fillRect(x, y, 16, 16);
      for (let i = 0; i < 6; i++) {
        c.fillStyle = '#2b4561';
        c.fillRect(x + ((h(i + 10) * 13) | 0), y + ((h(i + 20) * 13) | 0), 2 + ((h(i + 30) * 3) | 0), 2);
      }
      c.fillStyle = '#4c6f95';
      for (let i = 0; i < 5; i++) c.fillRect(x + ((h(i + 40) * 15) | 0), y + ((h(i + 50) * 15) | 0), 1, 1);
      if (h(60) < 0.3) { c.fillStyle = '#9fe6ff'; c.fillRect(x + 3 + ((h(61) * 10) | 0), y + 4 + ((h(62) * 9) | 0), 1, 1); }
    } else if (zone === 'gale') {
      c.fillStyle = '#b39b74'; c.fillRect(x, y, 16, 16);
      c.fillStyle = '#d4bf98'; c.fillRect(x, y, 16, 1); c.fillRect(x, y, 1, 16);
      c.fillStyle = '#8a7553'; c.fillRect(x, y + 15, 16, 1); c.fillRect(x + 15, y, 1, 16);
      for (let i = 0; i < 8; i++) {
        c.fillStyle = h(i + 10) < 0.5 ? '#a68d66' : '#c4ad85';
        c.fillRect(x + 1 + ((h(i + 20) * 14) | 0), y + 1 + ((h(i + 30) * 14) | 0), 1, 1);
      }
      if (h(70) < 0.25) { c.fillStyle = '#9a835e'; c.fillRect(x + 4, y + 7, 8, 1); c.fillRect(x + 4, y + 5, 1, 3); c.fillRect(x + 11, y + 7, 1, 3); }
    } else {
      c.fillStyle = '#2e2947'; c.fillRect(x, y, 16, 16);
      c.fillStyle = '#423b66'; c.fillRect(x, y, 16, 1); c.fillRect(x, y, 1, 16);
      c.fillStyle = '#1d1933'; c.fillRect(x, y + 15, 16, 1); c.fillRect(x + 15, y, 1, 16);
      if (h(80) < 0.18) {
        const sx = x + 5 + ((h(81) * 5) | 0), sy = y + 5 + ((h(82) * 5) | 0);
        c.fillStyle = '#6a5fa8'; c.fillRect(sx, sy - 1, 1, 3); c.fillRect(sx - 1, sy, 3, 1);
      }
    }
    edges(c, x, y, nb, ZS[zone].edge);
  }
  function edges(c, x, y, nb, col) {
    c.fillStyle = col;
    if (!nb.l) c.fillRect(x, y, 1, 16);
    if (!nb.r) c.fillRect(x + 15, y, 1, 16);
    if (!nb.d) c.fillRect(x, y + 15, 16, 1);
  }

  // 윗면/아랫면 장식 (타일 밖으로 튀어나오므로 두 번째 패스에서 그린다)
  function tileTrim(c, zone, t, x, y, nb, h) {
    const ice = t === T_ICE;
    if (!nb.u) {
      if (ice) {
        c.fillStyle = '#e8fbff'; c.fillRect(x, y, 16, 1);
        c.fillStyle = '#bdeeff'; c.fillRect(x, y + 1, 16, 1);
      } else if (zone === 'forest') {
        c.fillStyle = '#3e7a38'; c.fillRect(x, y, 16, 4);
        c.fillStyle = '#62a845'; c.fillRect(x, y, 16, 2);
        c.fillStyle = '#8fd060'; c.fillRect(x, y, 16, 1);
        for (let i = 0; i < 16; i++) {
          if (h(50 + i) < 0.5) { c.fillStyle = '#3e7a38'; c.fillRect(x + i, y + 4, 1, h(70 + i) < 0.3 ? 2 : 1); }
          if (h(90 + i) < 0.3) {
            const bh = 1 + ((h(110 + i) * 3) | 0);
            c.fillStyle = h(130 + i) < 0.5 ? '#62a845' : '#8fd060'; c.fillRect(x + i, y - bh, 1, bh);
          }
        }
        if (h(150) < 0.14) { c.fillStyle = h(152) < 0.5 ? '#f0d86a' : '#e88a9a'; c.fillRect(x + 3 + ((h(151) * 10) | 0), y - 2, 1, 1); }
      } else if (zone === 'ramparts') {
        c.fillStyle = '#8a8fa6'; c.fillRect(x, y, 16, 1);
        if (h(240) < 0.55) {
          const a = (h(241) * 8) | 0, w = 4 + ((h(242) * 8) | 0);
          c.fillStyle = '#4d6b45'; c.fillRect(x + a, y, Math.min(w, 16 - a), 2);
          c.fillStyle = '#6f9a5c'; c.fillRect(x + a, y, Math.min(w, 16 - a), 1);
          if (h(243) < 0.5) { c.fillStyle = '#4d6b45'; c.fillRect(x + a + 1, y + 2, 1, 2); }
        }
      } else if (zone === 'frost') {
        for (let i = 0; i < 16; i++) {
          const sh = 2 + (h(300 + i) < 0.35 ? 1 : 0);
          c.fillStyle = '#a8c4e4'; c.fillRect(x + i, y + sh, 1, 1);
          c.fillStyle = '#e6f2ff'; c.fillRect(x + i, y - (h(320 + i) < 0.15 ? 1 : 0), 1, sh + (h(320 + i) < 0.15 ? 1 : 0));
        }
        if (h(340) < 0.4) { c.fillStyle = '#ffffff'; c.fillRect(x + ((h(341) * 15) | 0), y, 1, 1); }
      } else if (zone === 'gale') {
        c.fillStyle = '#eadcb9'; c.fillRect(x, y, 16, 1);
        if (h(360) < 0.3) { c.fillStyle = '#8a7553'; c.fillRect(x + ((h(361) * 13) | 0), y, 2, 1); }
      } else {
        c.fillStyle = '#c99a3c'; c.fillRect(x, y, 16, 2);
        c.fillStyle = '#ffd877'; c.fillRect(x, y, 16, 1);
        c.fillStyle = '#8a6524'; c.fillRect(x, y + 2, 16, 1);
      }
    }
    if (!nb.d) {
      if (ice || zone === 'frost') {
        for (let i = 1; i < 15; i++) {
          if (h(400 + i) > (ice ? 0.3 : 0.18)) continue;
          const len = 2 + ((h(420 + i) * 5) | 0);
          for (let j = 0; j < len; j++) {
            c.fillStyle = j === 0 ? '#e8fbff' : '#a6dcf5';
            c.fillRect(x + i, y + 16 + j, j < len / 2 ? 2 : 1, 1);
          }
          i += 2;
        }
      } else if (zone === 'forest') {
        for (let i = 1; i < 15; i++) {
          if (h(440 + i) > 0.12) continue;
          const len = 2 + ((h(460 + i) * 5) | 0);
          c.fillStyle = '#3a281f'; c.fillRect(x + i, y + 16, 1, len);
          if (len > 3) c.fillRect(x + i + 1, y + 16 + len - 1, 1, 1);
        }
        if (h(480) < 0.2) {
          const vx = x + 2 + ((h(481) * 12) | 0), len = 5 + ((h(482) * 10) | 0);
          for (let j = 0; j < len; j++) { c.fillStyle = j % 3 === 2 ? '#4f8a3c' : '#2f5a2c'; c.fillRect(vx + (j % 3 === 2 ? 1 : 0), y + 16 + j, 1, 1); }
        }
      } else if (zone === 'ramparts' && h(500) < 0.15) {
        c.fillStyle = '#4d6b45'; c.fillRect(x + 4 + ((h(501) * 8) | 0), y + 16, 1, 2 + ((h(502) * 3) | 0));
      }
    }
  }

  function renderTiles(world, s) {
    const zone = world.screens[s].zone;
    const cv = makeCanvas(VW, VH), c = cv.getContext('2d');
    const top = (world.n - 1 - s) * ROWS;
    const pass = (fn) => {
      for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) {
        const wr = top + r, t = world.tile(col, wr);
        if (!t || t === T_CRUMBLE) continue; // 무너지는 돌은 매 프레임 따로 그린다
        const nb = { u: !!world.tile(col, wr - 1), d: !!world.tile(col, wr + 1), l: !!world.tile(col - 1, wr), r: !!world.tile(col + 1, wr) };
        fn(c, zone, t, col * TILE, r * TILE, nb, (k) => hash(col, wr, k), wr);
      }
    };
    pass(tileBase);
    pass(tileTrim);
    return cv;
  }

  // ───────────────────────── 배경 ─────────────────────────
  function bgForest(c, s, R) {
    vgrad(c, '#0d1f2c', '#17343b');
    for (let i = 0; i < 26; i++) { c.fillStyle = 'rgba(30,70,64,.35)'; pixEllipse(c, R() * VW, R() * VH, 20 + R() * 40, 8 + R() * 16); }
    for (let i = 0; i < 8; i++) {
      const x = (R() * VW) | 0, w = (14 + R() * 22) | 0;
      c.fillStyle = '#132c31'; c.fillRect(x, 0, w, VH);
      c.fillStyle = '#18363b'; c.fillRect(x + 2, 0, 2, VH);
      c.fillStyle = '#0f2428'; for (let y = (R() * 20) | 0; y < VH; y += 14 + ((R() * 20) | 0)) c.fillRect(x + 4 + ((R() * (w - 8)) | 0), y, 1, 4);
    }
    for (let i = 0; i < 18; i++) { c.fillStyle = '#10272a'; pixEllipse(c, R() * VW, R() * VH, 16 + R() * 30, 6 + R() * 12); }
    for (let i = 0; i < 3; i++) {
      const x = (R() * VW) | 0, w = (10 + R() * 10) | 0;
      c.fillStyle = '#0b1c20'; c.fillRect(x, 0, w, VH);
      for (let b = 0; b < 3; b++) {
        const by = (R() * VH) | 0, dir = R() < 0.5 ? -1 : 1;
        for (let j = 0; j < 24; j++) c.fillRect(x + (dir > 0 ? w + j : -j), by - (j >> 2), 2, 2);
      }
    }
    for (let i = 0; i < 9; i++) {
      const x = (R() * VW) | 0, len = (40 + R() * 140) | 0;
      for (let j = 0; j < len; j++) {
        c.fillStyle = '#1d4637'; c.fillRect(x + ((Math.sin(j * 0.08 + i) * 1.5) | 0), j, 1, 1);
        if (j % 7 === 3) { c.fillStyle = '#285c45'; c.fillRect(x + 1 + ((Math.sin(j * 0.08 + i) * 1.5) | 0), j, 2, 1); }
      }
    }
    if (s === 2) { glow(c, 420, 40, 90, '220,235,200', 0.18); c.fillStyle = '#e8eed6'; pixEllipse(c, 420, 40, 14, 14); c.fillStyle = '#cfd8bb'; c.fillRect(414, 36, 3, 2); c.fillRect(424, 44, 2, 2); }
    if (s === 0) { const g = c.createLinearGradient(0, 200, 0, VH); g.addColorStop(0, 'rgba(140,190,180,0)'); g.addColorStop(1, 'rgba(140,190,180,.16)'); c.fillStyle = g; c.fillRect(0, 200, VW, 88); }
  }
  function bgRamparts(c, s, R) {
    vgrad(c, '#1b1735', '#3c2a4c');
    c.fillStyle = '#d8cfe8'; for (let i = 0; i < 40; i++) c.fillRect((R() * VW) | 0, (R() * VH * 0.7) | 0, 1, 1);
    if (s === 4) {
      glow(c, 380, 80, 120, '255,230,200', 0.16);
      c.fillStyle = '#efe4c8'; pixEllipse(c, 380, 80, 30, 30);
      c.fillStyle = '#ddd0b0'; pixEllipse(c, 370, 72, 6, 5); pixEllipse(c, 392, 92, 4, 4); pixEllipse(c, 386, 66, 3, 3);
    }
    for (let i = 0; i < 6; i++) { c.fillStyle = 'rgba(90,70,120,.35)'; pixEllipse(c, R() * VW, R() * VH, 40 + R() * 50, 4 + R() * 6); }
    for (let i = 0; i < 6; i++) {
      const x = (R() * VW) | 0, w = (26 + R() * 44) | 0, y = (R() * VH * 0.8) | 0;
      c.fillStyle = '#2a2442'; c.fillRect(x, y, w, VH - y);
      for (let cx = x; cx < x + w; cx += 8) c.fillRect(cx, y - 5, 5, 5);
      for (let k = 0; k < 4; k++) {
        const wx = x + 4 + ((R() * (w - 8)) | 0), wy = y + 10 + ((R() * (VH - y - 20)) | 0);
        c.fillStyle = R() < 0.3 ? '#d99a4e' : '#1b1730'; c.fillRect(wx, wy, 2, 4);
      }
    }
    for (let i = 0; i < 3; i++) {
      const x = (R() * VW) | 0, w = (40 + R() * 30) | 0, y = (VH * 0.3 + R() * VH * 0.6) | 0;
      c.fillStyle = '#211c35'; c.fillRect(x, y, w, VH - y);
      for (let cx = x; cx < x + w; cx += 10) c.fillRect(cx, y - 6, 6, 6);
    }
  }
  function bgFrost(c, s, R) {
    vgrad(c, '#0a1527', '#13294a');
    for (let i = 0; i < 30; i++) { c.fillStyle = 'rgba(8,18,34,.6)'; pixEllipse(c, R() * VW, R() * VH, 10 + R() * 40, 8 + R() * 30); }
    for (let i = 0; i < 6; i++) { c.fillStyle = '#0b1a30'; pixEllipse(c, R() < 0.5 ? 20 : VW - 20, R() * VH, 40 + R() * 40, 30 + R() * 40); }
    for (let i = 0; i < 7; i++) {
      const cx = 40 + R() * (VW - 80), cy = 20 + R() * (VH - 40), purple = R() < 0.35;
      glow(c, cx, cy, 40, purple ? '160,120,255' : '90,210,255', 0.16);
      const n = 3 + ((R() * 3) | 0);
      for (let k = 0; k < n; k++) {
        const len = 8 + R() * 14, ang = -Math.PI / 2 + (R() - 0.5) * 1.6, w = 2 + R() * 2;
        for (let j = 0; j < len; j++) {
          const px = cx + Math.cos(ang) * j, py = cy + Math.sin(ang) * j, ww = Math.max(1, w * (1 - j / len) + 0.5);
          c.fillStyle = j > len - 3 ? '#e8fbff' : purple ? '#8f7ff0' : '#5fc8ec';
          c.fillRect(px | 0, py | 0, ww | 0, 1);
        }
      }
    }
    for (let i = 0; i < 16; i++) {
      const x = (R() * VW) | 0, len = (6 + R() * 18) | 0, w = (3 + R() * 5) | 0;
      c.fillStyle = '#0c1c33';
      for (let j = 0; j < len; j++) c.fillRect(x + ((j / len) * w * 0.5) | 0, j, Math.max(1, w - ((j / len) * w) | 0), 1);
    }
  }
  function bgGale(c, s, R) {
    vgrad(c, '#1a2950', '#46659b');
    c.fillStyle = '#dfe8ff'; for (let i = 0; i < 30; i++) c.fillRect((R() * VW) | 0, (R() * VH * 0.45) | 0, 1, 1);
    for (let i = 0; i < 9; i++) {
      const y = R() * VH, x = R() * VW;
      c.fillStyle = 'rgba(120,150,205,.22)'; pixEllipse(c, x, y, 50 + R() * 70, 6 + R() * 8);
      c.fillStyle = 'rgba(170,190,230,.16)'; pixEllipse(c, x + 10, y - 3, 30 + R() * 40, 4 + R() * 4);
    }
    for (let i = 0; i < 4; i++) {
      const x = (R() * VW) | 0, w = (6 + R() * 6) | 0, y = (R() * VH * 0.6) | 0;
      c.fillStyle = '#263764'; c.fillRect(x, y, w, VH - y);
      for (let j = 0; j < 10; j++) c.fillRect(x + (j >> 1), y - j, Math.max(1, w - j), 1);
      c.fillStyle = '#c75a4a'; c.fillRect(x + w, y + 6, 6, 3);
    }
    if (s === 8) {
      c.fillStyle = '#2a3b66';
      let px = 0;
      while (px < VW) {
        const w = 60 + R() * 80, hgt = 40 + R() * 60;
        for (let j = 0; j < w; j++) { const hh = hgt * (1 - Math.abs(j - w / 2) / (w / 2)); c.fillRect((px + j) | 0, (VH - hh) | 0, 1, hh | 0); }
        c.fillStyle = '#c9d6ee';
        for (let j = w * 0.4; j < w * 0.6; j++) { const hh = hgt * (1 - Math.abs(j - w / 2) / (w / 2)); c.fillRect((px + j) | 0, (VH - hh) | 0, 1, 3); }
        c.fillStyle = '#2a3b66';
        px += w * 0.7;
      }
    }
  }
  function bgSummit(c, s, R) {
    vgrad(c, '#04031a', '#1a1545');
    for (let x = 0; x < VW; x++) {
      const y = 70 + Math.sin(x * 0.018) * 22 + Math.sin(x * 0.051 + 1) * 9;
      const a = 0.08 + 0.07 * Math.sin(x * 0.03);
      const g = c.createLinearGradient(0, y - 40, 0, y + 50);
      g.addColorStop(0, 'rgba(80,255,170,0)'); g.addColorStop(0.5, `rgba(80,255,170,${a})`); g.addColorStop(0.75, `rgba(140,90,255,${a * 0.7})`); g.addColorStop(1, 'rgba(140,90,255,0)');
      c.fillStyle = g; c.fillRect(x, y - 40, 1, 90);
    }
    for (let i = 0; i < 230; i++) { const b = R(); c.fillStyle = b < 0.7 ? '#6f6aa0' : b < 0.93 ? '#c8c4ee' : '#ffffff'; c.fillRect((R() * VW) | 0, (R() * VH) | 0, 1, 1); }
    for (let i = 0; i < 8; i++) { const x = (R() * VW) | 0, y = (R() * VH) | 0; c.fillStyle = '#e8e4ff'; c.fillRect(x, y - 1, 1, 3); c.fillRect(x - 1, y, 3, 1); }
    glow(c, 430, 110, 70, '230,220,255', 0.12);
    c.fillStyle = '#ece6ff'; pixEllipse(c, 430, 110, 18, 18);
    c.fillStyle = '#1b1747'; pixEllipse(c, 438, 104, 17, 17);
    // 별등대 등실(燈室)의 기둥과 아치
    c.fillStyle = '#211b45';
    c.fillRect(40, 16, 6, 48); c.fillRect(182, 16, 6, 48);
    for (let x = 46; x < 182; x++) { const t = (x - 46) / 136; c.fillRect(x, 16, 1, (6 * Math.sin(t * Math.PI)) | 0); }
    c.fillStyle = 'rgba(33,27,69,.6)'; c.fillRect(110, 16, 3, 48);
  }
  const BG = { forest: bgForest, ramparts: bgRamparts, frost: bgFrost, gale: bgGale, summit: bgSummit };

  // 화면별 동적 배경 요소(반짝이는 별)
  function makeTwinkles(s, zone) {
    if (zone !== 'summit' && zone !== 'gale') return [];
    const R = seeded(9000 + s), out = [];
    for (let i = 0; i < (zone === 'summit' ? 40 : 14); i++) out.push({ x: (R() * VW) | 0, y: (R() * VH * (zone === 'gale' ? 0.45 : 1)) | 0, ph: R() * 6.28, sp: 0.02 + R() * 0.05 });
    return out;
  }

  const screens = [];
  function prerender(world) {
    for (let s = 0; s < world.n; s++) {
      const zone = world.screens[s].zone;
      const bg = makeCanvas(VW, VH);
      BG[zone](bg.getContext('2d'), s, seeded(1000 + s * 77));
      screens[s] = { bg, tiles: renderTiles(world, s), twinkles: makeTwinkles(s, zone) };
    }
  }

  // ───────────────────────── 오브젝트 ─────────────────────────
  function drawLamp(c, o, x, y, zone, t, world) {
    const right = world.tile(o.col + 1, o.row), left = world.tile(o.col - 1, o.row);
    c.fillStyle = '#2a2030';
    if (right) c.fillRect(x + 9, y + 3, 7, 1);
    else if (left) c.fillRect(x, y + 3, 7, 1);
    else for (let j = 0; j < 4; j += 2) c.fillRect(x + 8, y + j, 1, 1);
    const flick = 0.75 + 0.25 * Math.sin(t * 0.3 + o.col) * Math.sin(t * 0.13 + o.row);
    c.fillStyle = '#2a2030'; c.fillRect(x + 5, y + 4, 7, 9);
    c.fillStyle = '#5a4630'; c.fillRect(x + 6, y + 4, 5, 1); c.fillRect(x + 6, y + 12, 5, 1);
    c.globalAlpha = flick; c.fillStyle = ZS[zone].lamp; c.fillRect(x + 6, y + 5, 5, 7);
    c.globalAlpha = 1; c.fillStyle = '#ffffff'; c.fillRect(x + 8, y + 7, 1, 3);
    return flick;
  }
  function drawStone(c, x, y, t, read) {
    const bx = x + 2, by = y - 2;
    c.fillStyle = OUTLINE; c.fillRect(bx, by + 1, 12, 17); c.fillRect(bx + 1, by, 10, 1);
    c.fillStyle = '#5c6274'; c.fillRect(bx + 1, by + 1, 10, 17);
    c.fillStyle = '#7b8296'; c.fillRect(bx + 1, by + 1, 2, 17); c.fillRect(bx + 1, by + 1, 10, 1);
    c.fillStyle = '#434858'; c.fillRect(bx + 9, by + 2, 2, 16);
    c.fillStyle = '#4d6b45'; c.fillRect(bx + 1, by + 15, 3, 3); c.fillRect(bx + 8, by + 16, 3, 2);
    const a = 0.55 + 0.45 * Math.sin(t * 0.06);
    c.fillStyle = read ? `rgba(255,214,120,${a})` : `rgba(120,240,230,${a})`;
    const rune = ['.###.', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '.###.'];
    rune.forEach((row, i) => { for (let k = 0; k < 5; k++) if (row[k] === '#') c.fillRect(bx + 4 + k, by + 4 + i, 1, 1); });
    return a;
  }
  function drawCrow(c, x, y, t, facing, talking) {
    let f = 'idle';
    if (talking && Math.floor(t / 8) % 2) f = 'caw';
    else if (t % 200 < 8) f = 'blink';
    const hop = !talking && t % 400 < 20 ? -Math.round(Math.sin((t % 400) / 20 * Math.PI) * 3) : 0;
    c.drawImage(crow[f][facing < 0 ? 1 : 0], x - 1, y - 1 + hop);
  }
  // strength 0~1: 0이면 깃발이 장대에 늘어지고 1이면 바람 방향으로 펄럭인다
  function drawFlag(c, x, y, t, wind, strength = 1) {
    const dir = wind < 0 ? -1 : 1, px = x + 7, s = Math.max(0, Math.min(1, strength));
    c.fillStyle = '#3a2e22'; c.fillRect(px, y - 10, 1, 26);
    c.fillStyle = '#c9973a'; c.fillRect(px, y - 11, 1, 1);
    for (let i = 0; i < 11; i++) {
      const dx = Math.round((i + 1) * (0.25 + 0.75 * s)), droop = Math.round(i * (1 - s) * 0.9);
      const dy = Math.round(Math.sin(t * 0.25 - i * 0.7) * (i / 10) * 1.6 * s) + droop;
      c.fillStyle = i % 4 === 3 ? '#f2d16a' : '#d14a3b';
      c.fillRect(px + dir * dx, y - 10 + dy, 1, 6);
      c.fillStyle = '#9a2f36'; c.fillRect(px + dir * dx, y - 5 + dy, 1, 1);
    }
  }

  // 불티: 위아래로 떠다니며 반짝이는 작은 별
  // 랜턴 실: 공중에 떠서 천천히 오르내리는 실 타래
  function drawThread(c, x, y, t, color) {
    const bob = Math.round(Math.sin(t * 0.05) * 1.5), cx = x + 8, cy = y + 8 + bob;
    c.fillStyle = OUTLINE;
    c.fillRect(cx - 4, cy - 3, 8, 7);
    c.fillStyle = color;
    c.fillRect(cx - 3, cy - 2, 6, 5);
    c.fillStyle = 'rgba(0,0,0,.35)';
    c.fillRect(cx - 3, cy, 6, 1); c.fillRect(cx - 3, cy + 2, 6, 1);
    c.fillStyle = 'rgba(255,255,255,.55)';
    c.fillRect(cx - 2, cy - 2, 2, 1);
    // 풀려 나온 실 한 가닥
    c.fillStyle = color;
    for (let i = 0; i < 6; i++) c.fillRect(cx + 3 + i, cy + 3 + Math.round(Math.sin(t * 0.08 + i * 0.9)), 1, 1);
  }
  function drawSpark(c, x, y, t) {
    const cx = x + 8, cy = Math.round(y + 8 + Math.sin(t * 0.08 + x) * 1.5);
    const tw = 0.6 + 0.4 * Math.abs(Math.sin(t * 0.1 + x * 0.3));
    c.globalCompositeOperation = 'lighter';
    glow(c, cx, cy, 11, '255,190,100', 0.4 * tw);
    c.globalCompositeOperation = 'source-over';
    const arm = tw > 0.85 ? 5 : 4;
    c.fillStyle = '#ff9f3a'; c.fillRect(cx - 1, cy - arm, 2, arm * 2); c.fillRect(cx - arm, cy - 1, arm * 2, 2);
    c.fillStyle = '#ffe9a0'; c.fillRect(cx - 1, cy - 2, 2, 4); c.fillRect(cx - 2, cy - 1, 4, 2);
    c.fillStyle = '#ffffff'; c.fillRect(cx - 1, cy - 1, 2, 2);
    if (tw > 0.8) { c.fillStyle = 'rgba(255,240,200,.8)'; c.fillRect(cx - 3, cy - 3, 1, 1); c.fillRect(cx + 2, cy + 2, 1, 1); c.fillRect(cx + 2, cy - 3, 1, 1); c.fillRect(cx - 3, cy + 2, 1, 1); }
  }

  // 움직이는 발판 (두께 8px, 구역마다 재질이 다르다)
  const MOVER = {
    forest:   { base: '#7a5233', top: '#a57445', dark: '#4a2f1e', trim: '#62a845' },
    ramparts: { base: '#6b6f86', top: '#8a8fa6', dark: '#3a3c4f', trim: '#9aa0b8' },
    frost:    { base: '#7cc8ec', top: '#e8fbff', dark: '#3f86b8', trim: '#bfeaff' },
    gale:     { base: '#9a7a4e', top: '#d6c29a', dark: '#5e4a2e', trim: '#e0b04a' },
    summit:   { base: '#2e2947', top: '#ffd877', dark: '#1a1630', trim: '#c99a3c' },
  };
  function drawMover(c, x, y, w, zone, t) {
    const s = MOVER[zone];
    x = Math.round(x); y = Math.round(y);
    c.fillStyle = OUTLINE; c.fillRect(x - 1, y - 1, w + 2, 10);
    c.fillStyle = s.base; c.fillRect(x, y, w, 8);
    c.fillStyle = s.top; c.fillRect(x, y, w, 2);
    c.fillStyle = s.dark; c.fillRect(x, y + 6, w, 2);
    for (let i = 8; i < w; i += 8) c.fillRect(x + i, y + 2, 1, 4);
    c.fillStyle = s.trim;
    c.fillRect(x + 2, y + 3, 1, 1); c.fillRect(x + w - 3, y + 3, 1, 1);
    if (zone === 'summit') { c.globalAlpha = 0.5 + 0.5 * Math.sin(t * 0.08); c.fillStyle = '#9be8ff'; c.fillRect(x + w / 2 - 1, y + 3, 2, 2); c.globalAlpha = 1; }
  }
  // 발판이 오가는 길을 점선으로 보여 준다
  function drawTrack(c, x1, y1, x2, y2) {
    const len = Math.hypot(x2 - x1, y2 - y1), n = Math.floor(len / 6);
    c.fillStyle = 'rgba(255,240,210,.16)';
    for (let i = 0; i <= n; i++) {
      const k = n ? i / n : 0;
      c.fillRect(Math.round(x1 + (x2 - x1) * k), Math.round(y1 + (y2 - y1) * k), 1, 1);
    }
    c.fillStyle = 'rgba(255,240,210,.28)';
    c.fillRect(Math.round(x1) - 1, Math.round(y1) - 1, 3, 3); c.fillRect(Math.round(x2) - 1, Math.round(y2) - 1, 3, 3);
  }
  // 무너지는 돌: state 0 멀쩡함, 1 흔들림(timer=남은 프레임), 2 무너짐(그리지 않음)
  function drawCrumble(c, world, i, x, y, zone, state, timer, t) {
    if (state === 2) return;
    const col = i % COLS, wr = Math.floor(i / COLS);
    const shake = state === 1 ? (t % 4 < 2 ? 1 : -1) * (timer < 20 ? 1 : t % 8 < 4 ? 1 : 0) : 0;
    const nb = { u: false, d: false, l: world.grid[i - 1] === T_CRUMBLE, r: world.grid[i + 1] === T_CRUMBLE };
    const h = (k) => hash(col, wr, k);
    tileBase(c, zone, T_SOLID, x + shake, y, nb, h, wr);
    tileTrim(c, zone, T_SOLID, x + shake, y, nb, h);
    c.fillStyle = 'rgba(20,12,24,.75)';
    const cracks = state === 1 && timer < 25 ? 3 : 2;
    for (let k = 0; k < cracks; k++) {
      let cx = x + shake + 3 + ((h(600 + k) * 10) | 0), cy = y + 3;
      for (let j = 0; j < 6; j++) { c.fillRect(cx, cy, 1, 2); cx += h(610 + k * 7 + j) < 0.5 ? -1 : 1; cy += 2; }
    }
  }
  function drawBeacon(c, x, y, t, lit) {
    const cx = x + 8, fy = y + 16;
    c.fillStyle = OUTLINE; c.fillRect(cx - 17, fy - 7, 34, 7);
    c.fillStyle = '#3d3560'; c.fillRect(cx - 16, fy - 6, 32, 6);
    c.fillStyle = '#c99a3c'; c.fillRect(cx - 16, fy - 6, 32, 1);
    c.fillStyle = OUTLINE; c.fillRect(cx - 6, fy - 15, 12, 9);
    c.fillStyle = '#2e2947'; c.fillRect(cx - 5, fy - 14, 10, 8);
    c.fillStyle = OUTLINE; c.fillRect(cx - 13, fy - 21, 26, 7);
    c.fillStyle = '#b8862f'; c.fillRect(cx - 12, fy - 20, 24, 5);
    c.fillStyle = '#ffd877'; c.fillRect(cx - 12, fy - 20, 24, 1);
    c.fillStyle = '#7a561e'; c.fillRect(cx - 10, fy - 16, 20, 1);
    if (!lit) {
      const a = 0.35 + 0.15 * Math.sin(t * 0.04);
      c.fillStyle = '#2a2836'; c.fillRect(cx - 9, fy - 22, 18, 2);
      c.fillStyle = `rgba(150,170,220,${a})`; c.fillRect(cx - 1, fy - 23, 2, 1);
    } else {
      for (let i = 0; i < 9; i++) {
        const hgt = 6 + Math.abs(Math.sin(t * 0.21 + i * 1.7)) * 9 * (1 - Math.abs(i - 4) / 6);
        c.fillStyle = '#ff7a2f'; c.fillRect(cx - 9 + i * 2, fy - 21 - hgt, 2, hgt);
        c.fillStyle = '#ffd36b'; c.fillRect(cx - 8 + i * 2, fy - 21 - hgt * 0.7, 1, hgt * 0.7);
      }
      c.fillStyle = '#fff6d0'; c.fillRect(cx - 3, fy - 27, 6, 6);
    }
  }

  // ───────────────────────── 타이틀/인트로 장면 ─────────────────────────
  let titleStatic = null;
  const titleStars = [];
  function buildTitle() {
    titleStatic = makeCanvas(VW, VH);
    const c = titleStatic.getContext('2d'), R = seeded(4242);
    vgrad(c, '#05041a', '#1d1a44');
    for (let i = 0; i < 160; i++) { const b = R(); c.fillStyle = b < 0.7 ? '#5f5a8f' : '#c8c4ee'; c.fillRect((R() * VW) | 0, (R() * 210) | 0, 1, 1); }
    for (let i = 0; i < 30; i++) titleStars.push({ x: (R() * VW) | 0, y: (R() * 200) | 0, ph: R() * 6.28, sp: 0.02 + R() * 0.05 });
    glow(c, 90, 60, 60, '230,220,255', 0.1);
    c.fillStyle = '#ece6ff'; pixEllipse(c, 90, 60, 14, 14);
    c.fillStyle = '#100d2e'; pixEllipse(c, 97, 55, 13, 13);
    c.fillStyle = '#121433';
    for (let x = 0; x < VW; x++) c.fillRect(x, (220 + Math.sin(x * 0.012) * 14 + Math.sin(x * 0.04) * 5) | 0, 1, VH);
    // 탑
    c.fillStyle = '#0b0a20';
    for (let y = 64; y < VH; y++) { const w = 22 + ((y - 64) / (VH - 64)) * 40; c.fillRect((256 - w) | 0, y, (w * 2) | 0, 1); }
    c.fillRect(238, 40, 3, 24); c.fillRect(271, 40, 3, 24); c.fillRect(234, 62, 44, 3);
    for (let y = 26; y < 40; y++) { const w = (y - 26) * 1.6; c.fillRect((256 - w) | 0, y, (w * 2) | 0, 1); }
    c.fillRect(255, 20, 2, 6);
    c.fillStyle = '#16153a';
    for (let i = 0; i < 9; i++) c.fillRect(254, 90 + i * 20, 3, 6);
    c.fillStyle = '#0a0f1c';
    for (let x = 0; x < VW; x++) c.fillRect(x, (250 + Math.sin(x * 0.02 + 2) * 8) | 0, 1, VH);
    for (let i = 0; i < 22; i++) {
      const x = (R() * VW) | 0;
      if (Math.abs(x - 256) < 70) continue;
      const hgt = 20 + R() * 30, base = 256;
      for (let j = 0; j < hgt; j++) { const w = ((j / hgt) * 7) | 0; c.fillRect(x - w, base - hgt + j, w * 2 + 1, 1); }
    }
    // 등불지기의 집
    c.fillStyle = '#0a0f1c'; c.fillRect(140, 236, 40, 22);
    for (let j = 0; j < 14; j++) c.fillRect(136 + j, 236 - j, 48 - j * 2, 1);
    c.fillRect(170, 216, 5, 12);
  }
  function drawTitleScene(c, t, o = {}) {
    if (!titleStatic) buildTitle();
    c.drawImage(titleStatic, 0, 0);
    for (const s of titleStars) { c.fillStyle = `rgba(230,228,255,${0.4 + 0.6 * Math.abs(Math.sin(t * s.sp + s.ph))})`; c.fillRect(s.x, s.y, 1, 1); }
    // 집 창문
    const win = o.lantern ? 1 : 0.5;
    c.fillStyle = `rgba(255,200,110,${0.55 * win + 0.1 * Math.sin(t * 0.1)})`; c.fillRect(150, 242, 6, 6);
    c.globalCompositeOperation = 'lighter'; glow(c, 153, 245, 20 + 10 * win, '255,180,90', 0.25 * win); c.globalCompositeOperation = 'source-over';
    // 별등대
    if (o.beacon) {
      c.globalCompositeOperation = 'lighter';
      const a = t * 0.012, side = Math.cos(a), front = Math.abs(Math.sin(a));
      glow(c, 256, 52, 60 + front * 40, '255,220,140', 0.35 + front * 0.25);
      const len = Math.abs(side) * 520, dir = side < 0 ? -1 : 1;
      const g = c.createLinearGradient(256, 52, 256 + dir * len, 52);
      g.addColorStop(0, 'rgba(255,230,160,.35)'); g.addColorStop(1, 'rgba(255,230,160,0)');
      c.fillStyle = g; c.beginPath(); c.moveTo(256, 50); c.lineTo(256 + dir * len, 52 - 26 * Math.abs(side)); c.lineTo(256 + dir * len, 52 + 26 * Math.abs(side)); c.lineTo(256, 54); c.fill();
      c.globalCompositeOperation = 'source-over';
      c.fillStyle = '#fff6d0'; c.fillRect(252, 48, 8, 8);
    } else {
      c.fillStyle = '#2a2836'; c.fillRect(252, 52, 8, 4);
    }
    if (o.lumi) {
      const lx = 196, ly = 240;
      c.globalCompositeOperation = 'lighter'; glow(c, lx + 13, ly + 12, 28 + Math.sin(t * 0.2), '255,190,90', 0.35); c.globalCompositeOperation = 'source-over';
      c.drawImage(lumi[Math.floor(t / 40) % 2 ? 'idle1' : 'idle0'][0], lx, ly);
    }
  }

  window.Art = { makeCanvas, glow, seeded, prerender, screens, lumi, crow, ZS, drawLamp, drawStone, drawCrow, drawFlag, drawBeacon, drawMover, drawTrack, drawCrumble, drawSpark, drawThread, drawTitleScene };
})();

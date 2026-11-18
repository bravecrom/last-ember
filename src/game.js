/*
 * game.js — 게임 루프와 상태(타이틀/인트로/플레이/대화/일시정지/엔딩/크레딧), 입력, 렌더링, UI, 저장.
 */
(function () {
  'use strict';
  const { TILE, COLS, CYCLE, SCREEN_W: VW, SCREEN_H: VH, P, World, createPlayer, step, gustFactor } = Physics;
  const { ZONES, SCREENS, INTRO, ENDING, FALL_LINES } = Levels;

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const view = Art.makeCanvas(VW, VH), v = view.getContext('2d');
  const shadeCv = Art.makeCanvas(VW, VH), sh = shadeCv.getContext('2d');

  const world = new World(SCREENS);
  Art.prerender(world);

  const FONT = '"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR","Nanum Gothic",sans-serif';
  const IS_ELECTRON = /Electron/i.test(navigator.userAgent);
  const SAVE_KEY = 'lastEmber.save.v1', BEST_KEY = 'lastEmber.best.v1', SETTINGS_KEY = 'lastEmber.settings.v1';
  const START = world.objects.find((o) => o.ch === 'P');
  const TOTAL_STONES = world.objects.filter((o) => o.ch === 'S').length;
  const TOTAL_SPARKS = world.objects.filter((o) => o.ch === '*').length;
  // 높이: 시작 바닥이 0m, 한 칸 = 0.5m
  const FLOOR_Y = START.y + TILE;
  const heightM = (feetY) => Math.max(0, (FLOOR_Y - feetY) / 32);
  const SUMMIT_M = heightM(world.objects.find((o) => o.ch === 'G').y + TILE);
  const sparkKey = (o) => `${o.screen}:${o.col}:${o.row}`;
  const objsByScreen = [];
  for (const o of world.objects) (objsByScreen[o.screen] = objsByScreen[o.screen] || []).push(o);
  const stoneIcon = Art.makeCanvas(16, 20);
  Art.drawStone(stoneIcon.getContext('2d'), 0, 2, 0, false);

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, val) { try { localStorage.setItem(k, JSON.stringify(val)); } catch (e) { /* 저장 불가 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } },
  };

  // 설정: 배경음악·효과음 크기(0~1), 화면 정보 표시
  const settings = Object.assign({ bgm: 0.6, sfx: 0.8, hud: true }, store.get(SETTINGS_KEY) || {});
  Sound.setVolume('bgm', settings.bgm);
  Sound.setVolume('sfx', settings.sfx);
  Sound.music('title');
  const saveSettings = () => store.set(SETTINGS_KEY, settings);
  // 기록: 예전 버전은 시간(숫자)만 저장했다
  function loadBest() { const b = store.get(BEST_KEY); return typeof b === 'number' ? { time: b } : b || {}; }
  let best = loadBest(); // 타이틀이 매 프레임 그리므로 저장소를 다시 읽지 않는다

  // ───────────────────────── 입력 ─────────────────────────
  const keys = Object.create(null), pressed = Object.create(null);
  const GAME_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter', 'Escape', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyZ', 'KeyM', 'KeyF', 'F11']);
  const CONFIRM = ['Enter', 'Space', 'KeyZ'];
  addEventListener('keydown', (e) => {
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    Sound.unlock();
    touchMode = false; // 키보드를 쓰면 화면 버튼을 숨긴다
    if (!e.repeat) {
      pressed[e.code] = true;
      if (e.code === 'KeyM') toggleMute();
      if (e.code === 'KeyF' || e.code === 'F11') toggleFullscreen();
    }
    keys[e.code] = true;
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; fingers.clear(); syncTouch(); if (G.state === 'play') openPause(); });
  addEventListener('beforeunload', () => save());
  canvas.addEventListener('pointerdown', () => { Sound.unlock(); canvas.focus(); });
  const hit = (...codes) => codes.some((c) => pressed[c]);

  // ── 터치 (휴대폰·태블릿) ──
  // 처음에 손가락이 주 입력인 기기면 화면 버튼을 띄우고, 이후 화면을 만지면 띄우고 키보드를 누르면 숨긴다.
  // 플레이 중에는 ◀ ▶ 이동, 점프(누르고 있다가 떼기), ❚❚ 일시정지. 돌·까마귀 곁에서는 그 위의 '다시 읽기' 글자를 누른다.
  // 그 밖의 화면(메뉴·대화·인트로·엔딩)에서는 누른 곳이 곧 선택이다.
  let touchMode = matchMedia('(pointer: coarse)').matches;
  const touch = Object.create(null); // 화면 버튼이 누르고 있는 가상 키
  const fingers = new Map();         // pointerId → 맡은 가상 키
  let tap = null;                    // 버튼 밖을 누른 위치 (게임 좌표), update가 한 번 쓰고 지운다
  let DPR = 1, OX = 0, OY = 0;       // render가 정하는 화면 배치 (S와 함께 터치 좌표 변환에 쓴다)
  function touchButtons() {
    const W = innerWidth, H = innerHeight, m = 16, r = Math.max(26, Math.min(44, Math.min(W, H) * 0.1));
    const y = H - m - r * 1.25, jx = W - m - r * 1.25;
    return {
      left: { x: m + r, y, r }, right: { x: m + r * 3.4, y, r },
      jump: { x: jx, y, r: r * 1.25 },
      pause: { x: W / 2, y: m + r * 0.55, r: r * 0.55 },
      height: m * 2 + r * 2.5, // 버튼이 차지하는 아래쪽 높이 (세로 화면 배치용)
    };
  }
  function fingerKey(x, y) {
    const b = touchButtons(), near = (k, f) => Math.hypot(x - b[k].x, y - b[k].y) < b[k].r * f;
    if (near('pause', 1.6)) return 'Escape';
    if (near('jump', 1.5)) return 'Space';
    if (near('left', 1.5) || near('right', 1.5)) return 'move';
    return null;
  }
  const moveKey = (x) => { const b = touchButtons(); return x < (b.left.x + b.right.x) / 2 ? 'ArrowLeft' : 'ArrowRight'; };
  function syncTouch() {
    for (const c of ['ArrowLeft', 'ArrowRight', 'Space', 'Escape']) touch[c] = false;
    for (const f of fingers.values()) if (f) touch[f] = true;
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    touchMode = true;
    const gx = (e.clientX * DPR - OX) / S, gy = (e.clientY * DPR - OY) / S;
    if (G.state !== 'play') { tap = { x: gx, y: gy }; return; }
    // 돌·까마귀 위의 '다시 읽기' 글자를 누르면 다시 읽는다. 글자 바로 위를 누르면 이동·점프 버튼보다 앞선다
    // (작은 폰에서는 첫 기억의 돌 글자가 ▶ 버튼의 누르는 범위 안에 들어온다). 돌·까마귀 자체를 눌러도 된다.
    const b = G.prompt && promptBox(), o = G.prompt;
    const onLabel = (pad) => b && gx > b.x - pad && gx < b.x + b.w + pad && gy > b.y - pad && gy < b.y + b.h + pad;
    let k = fingerKey(e.clientX, e.clientY);
    if (k !== 'Escape' && onLabel(3)) k = null;
    if (k === 'move') k = moveKey(e.clientX);
    if (k) { fingers.set(e.pointerId, k); pressed[k] = true; syncTouch(); }
    else if (onLabel(10) || (o && gx > o.x - 4 && gx < o.x + TILE + 4 && gy > b.y + b.h && gy < b.y + 18 + TILE)) pressed.ArrowUp = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    const k = fingers.get(e.pointerId);
    if (k === 'ArrowLeft' || k === 'ArrowRight') { fingers.set(e.pointerId, moveKey(e.clientX)); syncTouch(); }
  });
  const fingerUp = (e) => { Sound.unlock(); if (fingers.delete(e.pointerId)) syncTouch(); };
  canvas.addEventListener('pointerup', fingerUp);
  canvas.addEventListener('pointercancel', fingerUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 누른 곳을 그 화면의 키 입력으로 바꾼다 (메뉴 항목·설정 줄·대화 넘기기)
  const TITLE_MENU = [166, 16], PAUSE_MENU = [112, 18];
  function menuTap(t, [y0, gap], n, setI) {
    const i = Math.round((t.y - (y0 - 3)) / gap);
    if (i >= 0 && i < n && Math.abs(t.x - VW / 2) < 70) { setI(i); pressed.Enter = true; }
  }
  function applyTap() {
    const t = tap;
    tap = null;
    if (!t) return;
    const inMenu = G.state === 'title' || G.state === 'pause';
    if (inMenu && G.opt) {
      if (t.x < 96 || t.x > 416 || t.y < 52 || t.y > 236) { pressed.Escape = true; return; }
      const items = settingsItems(), i = Math.round((t.y - 103) / 22);
      if (i < 0 || i >= items.length || t.x < 100 || t.x > 412) return;
      G.opt.i = i;
      if (items[i].kind !== 'vol') pressed.Enter = true;
      else if (t.x >= 258) pressed[t.x < 311 ? 'ArrowLeft' : 'ArrowRight'] = true;
    } else if (inMenu && G.help) pressed.Enter = true;
    else if (G.state === 'title') menuTap(t, TITLE_MENU, titleItems().length, (i) => { G.menu = i; });
    else if (G.state === 'pause') menuTap(t, PAUSE_MENU, pauseItems().length, (i) => { G.menu = i; });
    else if (G.state === 'intro' && t.x > VW - 90 && t.y > 262) pressed.Escape = true; // '건너뛰기'
    else pressed.Enter = true;
  }

  // 게임패드 (표준 배치): 스틱·십자키 이동, A 점프·선택, Y 또는 ↑ 다시 읽기, Start 일시정지, B 뒤로(메뉴·대화)
  const pad = Object.create(null);
  const PAD_CODES = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Escape'];
  const held = (c) => !!(keys[c] || pad[c] || touch[c]);
  function pollPad() {
    const gp = navigator.getGamepads ? Array.from(navigator.getGamepads()).find((g) => g && g.connected) : null;
    const now = Object.create(null);
    if (gp) {
      const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed), ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      now.ArrowLeft = b(14) || ax < -0.5;
      now.ArrowRight = b(15) || ax > 0.5;
      now.ArrowUp = b(12) || b(3) || ay < -0.5;
      now.ArrowDown = b(13) || ay > 0.5;
      now.Space = b(0);
      now.Escape = b(9) || (b(1) && G.state !== 'play' && G.state !== 'intro');
    }
    for (const c of PAD_CODES) {
      if (now[c] && !pad[c]) { pressed[c] = true; Sound.unlock(); }
      pad[c] = !!now[c];
    }
  }
  addEventListener('gamepadconnected', () => { G.toast = { text: '게임패드 연결됨', t: 120 }; });

  // ───────────────────────── 상태 ─────────────────────────
  const G = {
    state: 'title', t: 0, menu: 0, help: false, opt: null, fade: 1,
    p: null, screen: 0, stats: null, read: {}, seen: {}, collected: {}, popups: [],
    dialog: null, card: null, prompt: null, toast: null, shake: 0,
    particles: [], jumpLock: false, walking: false, walkDist: 0, saveTimer: 0,
    intro: null, ending: null, quip: null, quipAt: -Infinity, quipN: 0,
  };

  function toTitle() { G.state = 'title'; G.menu = 0; G.fade = 1; G.p = null; G.particles.length = 0; G.help = false; G.opt = null; Sound.music('title'); }

  const openSettings = () => { G.opt = { i: 0 }; };
  function titleItems() {
    const items = [];
    if (store.get(SAVE_KEY)) items.push({ label: '이어하기', act: continueGame });
    items.push({ label: '새로 시작', act: startIntro });
    items.push({ label: '설정', act: openSettings });
    items.push({ label: '조작법', act: () => { G.help = true; } });
    if (IS_ELECTRON) items.push({ label: '종료', act: () => window.close() });
    return items;
  }
  function pauseItems() {
    return [
      { label: '계속하기', act: () => { G.state = 'play'; G.jumpLock = true; } },
      { label: '설정', act: openSettings },
      { label: '조작법', act: () => { G.help = true; } },
      { label: '타이틀로', act: () => { save(); toTitle(); } },
    ];
  }
  function settingsItems() {
    return [
      { label: '배경음악', kind: 'vol', key: 'bgm' },
      { label: '효과음', kind: 'vol', key: 'sfx' },
      { label: '화면 정보 (높이·점프 수)', kind: 'toggle', key: 'hud' },
      // 아이폰 사파리처럼 전체 화면을 지원하지 않는 곳에서는 숨긴다
      ...(document.fullscreenEnabled ? [{ label: '전체 화면', kind: 'act', act: toggleFullscreen }] : []),
      { label: '돌아가기', kind: 'act', act: () => { G.opt = null; } },
    ];
  }
  function updateSettings() {
    const items = settingsItems(), o = G.opt;
    if (hit('Escape')) { G.opt = null; return; }
    if (hit('ArrowUp', 'KeyW')) { o.i = (o.i + items.length - 1) % items.length; Sound.move(); }
    if (hit('ArrowDown', 'KeyS')) { o.i = (o.i + 1) % items.length; Sound.move(); }
    const it = items[o.i], dx = (hit('ArrowRight', 'KeyD') ? 1 : 0) - (hit('ArrowLeft', 'KeyA') ? 1 : 0);
    if (it.kind === 'vol' && dx) {
      settings[it.key] = Math.round(Math.max(0, Math.min(1, settings[it.key] + dx * 0.1)) * 10) / 10;
      Sound.setVolume(it.key, settings[it.key]);
      saveSettings();
      Sound.select(); // 효과음 크기를 바로 들어 볼 수 있게
    } else if (it.kind === 'toggle' && (dx || hit(...CONFIRM))) {
      settings[it.key] = !settings[it.key]; saveSettings(); Sound.move();
    } else if (it.kind === 'act' && hit(...CONFIRM)) { Sound.select(); it.act(); }
  }
  function menuNav(items) {
    if (hit('ArrowUp', 'KeyW')) { G.menu = (G.menu + items.length - 1) % items.length; Sound.move(); }
    if (hit('ArrowDown', 'KeyS')) { G.menu = (G.menu + 1) % items.length; Sound.move(); }
    G.menu = Math.min(G.menu, items.length - 1);
    if (hit(...CONFIRM)) { Sound.select(); items[G.menu].act(); }
  }

  function startIntro() { G.state = 'intro'; G.intro = { i: 0, n: 0 }; G.fade = 1; }
  function newGame() {
    G.p = createPlayer(START.x + (TILE - P.W) / 2, START.y + TILE - P.H);
    G.stats = { time: 0, jumps: 0, falls: 0, maxH: 0, maxFall: 0 };
    G.read = {}; G.seen = {}; G.collected = {};
    beginPlay();
  }
  function continueGame() {
    const s = store.get(SAVE_KEY);
    if (!s) return newGame();
    G.p = createPlayer(s.x, s.y);
    G.p.facing = s.facing || 1;
    G.stats = Object.assign({ maxH: 0, maxFall: 0 }, s.stats);
    G.read = s.read || {}; G.seen = s.seen || {}; G.collected = s.collected || {};
    beginPlay();
  }
  function beginPlay() {
    world.reset(0);
    G.state = 'play'; G.screen = -1; G.fade = 1; G.jumpLock = true; G.help = false; G.opt = null;
    G.particles.length = 0; G.popups.length = 0; G.dialog = null; G.card = null; G.quip = null;
    enterScreen(world.screenAt(G.p.y + P.H / 2));
    save();
  }
  function save() {
    const p = G.p;
    // 움직이는 발판 위에서는 저장하지 않는다 (불러올 때 발판 위치가 달라지므로)
    if (!p || !p.onGround || p.charging || p.plat || G.state === 'ending' || G.state === 'credits') return;
    store.set(SAVE_KEY, { x: p.x, y: p.y, facing: p.facing, stats: G.stats, read: G.read, seen: G.seen, collected: G.collected });
  }
  function openPause() { save(); G.state = 'pause'; G.menu = 0; G.help = false; G.opt = null; }
  function toggleMute() { Sound.setMuted(!Sound.muted); G.toast = { text: Sound.muted ? '소리 꺼짐' : '소리 켜짐', t: 90 }; }
  function toggleFullscreen() {
    if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); }
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }

  function enterScreen(s) {
    if (s === G.screen) return;
    G.screen = s;
    G.particles = G.particles.filter((q) => !q.amb);
    const zone = SCREENS[s].zone;
    Sound.music(zone);
    if (!G.seen[zone]) { G.seen[zone] = true; G.card = { zone, t: 0 }; }
  }

  // ───────────────────────── 업데이트 ─────────────────────────
  function update() {
    G.t++;
    pollPad();
    applyTap();
    switch (G.state) {
      case 'title':
        if (G.opt) updateSettings();
        else if (G.help) { if (hit('Escape', ...CONFIRM)) G.help = false; }
        else menuNav(titleItems());
        break;
      case 'intro': updateIntro(); break;
      case 'play': updatePlay(); break;
      case 'dialog': updateDialog(); break;
      case 'pause':
        if (G.opt) updateSettings();
        else if (G.help) { if (hit('Escape', ...CONFIRM)) G.help = false; }
        else if (hit('Escape')) { G.state = 'play'; G.jumpLock = true; }
        else menuNav(pauseItems());
        break;
      case 'ending': updateEnding(); break;
      case 'credits': world.tick(null); world.events.length = 0; if (G.t - G.creditsAt > 60 && hit(...CONFIRM, 'Escape')) toTitle(); break;
    }
    if (G.state === 'play' || G.state === 'dialog' || G.state === 'pause') ambient(world.screenTop(G.screen), SCREENS[G.screen].zone);
    updateParticles();
    if (G.card && ++G.card.t > 260) G.card = null;
    if (G.quip && ++G.quip.t > QUIP_T) G.quip = null;
    if (G.toast && --G.toast.t <= 0) G.toast = null;
    if (G.popups.length) G.popups = G.popups.filter((pp) => ++pp.t < 100);
    if (G.fade > 0) G.fade = Math.max(0, G.fade - 0.025);
    if (G.shake > 0) G.shake--;
    for (const k in pressed) delete pressed[k];
  }

  function typeOn(obj, len, speed) {
    if (obj.n >= len) return;
    const before = Math.floor(obj.n);
    obj.n = Math.min(len, obj.n + speed);
    if (Math.floor(obj.n) !== before && before % 3 === 0) Sound.blip();
  }

  function updateIntro() {
    const it = G.intro, len = INTRO[it.i].text.length;
    typeOn(it, len, 0.45);
    if (hit('Escape')) return newGame();
    if (hit(...CONFIRM)) {
      if (it.n < len) it.n = len;
      else if (++it.i >= INTRO.length) newGame();
      else it.n = 0;
    }
  }

  function updatePlay() {
    if (hit('Escape')) return openPause();
    const p = G.p;
    if (G.jumpLock && !held('Space')) G.jumpLock = false;
    const input = { left: held('ArrowLeft') || held('KeyA'), right: held('ArrowRight') || held('KeyD'), jump: held('Space') && !G.jumpLock };
    world.tick(p);
    handleWorldEvents();
    const sc = SCREENS[G.screen];
    if (sc.gust && sc.wind && world.t % CYCLE === 0) Sound.gust();
    step(p, input, world);
    handleEvents(p);
    if (p.charging && p.charge % 5 === 1) Sound.charge(p.charge / P.CHARGE_FRAMES);
    G.walking = p.onGround && !p.charging && (input.left || input.right) && Math.abs(p.vx) > 0.1;
    if (G.walking) {
      G.walkDist += Math.abs(p.vx);
      if (G.t % 14 === 0) puff(p.x + 5, p.y + P.H, 1);
    }
    G.stats.time++;
    const h = heightM(p.y + P.H);
    if (h > G.stats.maxH) G.stats.maxH = h;
    enterScreen(world.screenAt(p.y + P.H / 2));
    collectSparks();
    interact();
    if (++G.saveTimer > 90) { G.saveTimer = 0; save(); }
  }

  function handleEvents(p) {
    for (const e of p.events) {
      if (e.type === 'jump') { G.stats.jumps++; Sound.jump(e.power); puff(p.x + 5, p.y + P.H, 3 + Math.round(e.power * 5)); }
      else if (e.type === 'land') { Sound.land(e.fall); if (e.fall > 24) puff(p.x + 5, p.y + P.H, 2 + Math.min(6, Math.round(e.fall / 24))); }
      else if (e.type === 'splat') { G.stats.falls++; Sound.splat(); G.shake = 12; puff(p.x + 5, p.y + P.H, 12); }
      else if (e.type === 'bump') Sound.bump();
      // 4.5m(9칸) 넘게 떨어지면 잃은 높이를 띄운다
      if ((e.type === 'land' || e.type === 'splat') && e.fall >= 144) {
        const m = e.fall / 32;
        G.popups.push({ text: `−${m.toFixed(1)}m`, x: p.x + P.W / 2, y: p.y - 4, t: 0, big: e.type === 'splat' });
        if (m > G.stats.maxFall) G.stats.maxFall = m;
        if (e.fall >= VH && G.t - G.quipAt > QUIP_COOLDOWN) quip();
      }
    }
    p.events.length = 0;
  }

  // 한 화면 넘게 떨어지면 루미나 코르가 한마디 한다 (너무 잦지 않게 30초에 한 번까지)
  const QUIP_T = 240, QUIP_COOLDOWN = 1800;
  function quip() {
    const metKor = Object.keys(G.read).some((k) => k[0] === 'N');
    const pool = FALL_LINES.filter((l) => metKor || l.who !== '코르');
    const line = pool[G.quipN++ % pool.length];
    G.quip = { line, t: 0 };
    G.quipAt = G.t;
    if (line.who === '코르') Sound.caw();
  }

  function collectSparks() {
    const p = G.p;
    for (let s = Math.max(0, G.screen - 1); s <= Math.min(world.n - 1, G.screen + 1); s++) {
      for (const o of objsByScreen[s] || []) {
        if (o.ch !== '*' || G.collected[sparkKey(o)]) continue;
        if (p.x < o.x + TILE + 3 && p.x + P.W > o.x - 3 && p.y < o.y + TILE + 3 && p.y + P.H > o.y - 3) {
          G.collected[sparkKey(o)] = true;
          Sound.spark();
          for (let i = 0; i < 24; i++) {
            const a = (i / 24) * Math.PI * 2, sp = 0.6 + Math.random() * 1.6;
            particle({ x: o.x + 8, y: o.y + 8, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0.02, life: 40 + Math.random() * 30, color: '#ffe9a0', rgb: '255,210,120' });
          }
          const n = Object.keys(G.collected).length;
          G.toast = { text: n === TOTAL_SPARKS ? `불티를 모두 모았다 ✦ ${n} / ${TOTAL_SPARKS}` : `불티 ✦ ${n} / ${TOTAL_SPARKS}`, t: 150 };
        }
      }
    }
  }

  function handleWorldEvents() {
    for (const e of world.events) {
      const g = e.g, here = g.screen === G.screen;
      if (e.type === 'crack' && here) Sound.crack();
      else if (e.type === 'break') {
        if (here) Sound.crumble();
        const dust = Art.ZS[SCREENS[g.screen].zone].dust;
        for (const i of g.cells) {
          const x = (i % COLS) * TILE, y = Math.floor(i / COLS) * TILE;
          for (let k = 0; k < 6; k++) particle({ x: x + Math.random() * 16, y: y + Math.random() * 12, vx: (Math.random() - 0.5) * 1.2, vy: Math.random() * 0.5, g: 0.15, life: 40 + Math.random() * 20, color: k % 2 ? '#3a3040' : dust[0], size: Math.random() < 0.5 ? 2 : 1 });
        }
      } else if (e.type === 'restore' && here) {
        for (const i of g.cells) particle({ x: (i % COLS) * TILE + 8, y: Math.floor(i / COLS) * TILE + 4, vy: -0.3, life: 30, color: '#fff2c0', rgb: '255,242,192' });
      }
    }
    world.events.length = 0;
  }

  function interact() {
    const p = G.p;
    G.prompt = null;
    for (const o of objsByScreen[G.screen] || []) {
      if (o.ch === 'G') {
        if (p.x + P.W > o.x - 4 && p.x < o.x + 20 && p.y < o.y + TILE && p.y + P.H > o.y - 8) return startEnding(o);
        continue;
      }
      if (o.ch !== 'S' && o.ch !== 'N') continue;
      const near = p.onGround && !p.charging && p.splat === 0 && p.x + P.W > o.x - 6 && p.x < o.x + TILE + 6 && Math.abs(p.y + P.H - (o.y + TILE)) < 1;
      if (!near) continue;
      if (!G.read[o.ch + o.screen]) return openDialog(o);
      G.prompt = o;
      if (hit('ArrowUp', 'KeyW')) return openDialog(o);
    }
  }

  function openDialog(o) {
    const sc = SCREENS[o.screen];
    const lines = o.ch === 'S' ? sc.stone.lines.map((text) => ({ who: null, text })) : sc.crow;
    G.dialog = { obj: o, kind: o.ch, title: o.ch === 'S' ? sc.stone.title : null, lines, i: 0, n: 0 };
    G.read[o.ch + o.screen] = true;
    G.state = 'dialog';
    G.p.vx = 0;
    if (o.ch === 'S') Sound.stone(); else Sound.caw();
    save();
  }
  function updateDialog() {
    const d = G.dialog, len = d.lines[d.i].text.length;
    typeOn(d, len, 0.6);
    if (hit('Escape')) return closeDialog();
    if (hit(...CONFIRM, 'ArrowUp', 'KeyW')) {
      if (d.n < len) d.n = len;
      else if (++d.i >= d.lines.length) closeDialog();
      else d.n = 0;
    }
  }
  function closeDialog() { G.state = 'play'; G.dialog = null; G.jumpLock = true; }

  // ── 엔딩 ──
  const E_IGNITE = 150, E_LINE = 270;
  function startEnding(o) {
    G.state = 'ending';
    G.ending = { t: 0, o, camY: world.screenTop(world.n - 1), lit: 0, idx: -1 };
    G.p.facing = o.x + 8 < G.p.x + P.W / 2 ? -1 : 1;
    G.prompt = null; G.card = null;
    Sound.ignite();
    Sound.music('ending');
    store.del(SAVE_KEY);
    // 기록: 가장 빠른 시간, 가장 적은 점프 수를 따로 갱신한다
    const st = G.stats, sparks = Object.keys(G.collected).length;
    G.ending.newTime = !best.time || st.time < best.time;
    G.ending.newJumps = !best.jumps || st.jumps < best.jumps;
    store.set(BEST_KEY, {
      time: G.ending.newTime ? st.time : best.time,
      jumps: G.ending.newJumps ? st.jumps : best.jumps,
      sparks: Math.max(best.sparks || 0, sparks),
    });
    best = loadBest();
  }
  function updateEnding() {
    const e = G.ending, top = world.screenTop(world.n - 1);
    e.t++;
    world.tick(null); world.events.length = 0;
    if (!G.p.onGround || G.p.vx) { step(G.p, {}, world); G.p.events.length = 0; }
    e.lit = Math.max(0, Math.min(1, (e.t - 20) / 90));
    if (e.t === 40) {
      for (let i = 0; i < 60; i++) {
        const a = Math.random() * Math.PI * 2, sp = 0.5 + Math.random() * 2.5;
        particle({ x: e.o.x + 8, y: e.o.y - 6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1, g: 0.02, life: 60 + Math.random() * 60, color: '#ffd98a', rgb: '255,200,110' });
      }
    }
    if (e.t < E_IGNITE) { if (e.t > 40 && hit(...CONFIRM)) e.t = E_IGNITE; }
    else {
      const idx = Math.floor((e.t - E_IGNITE) / E_LINE);
      if (hit(...CONFIRM)) e.t = E_IGNITE + (idx + 1) * E_LINE;
      const now = Math.floor((e.t - E_IGNITE) / E_LINE);
      if (now === ENDING.length - 1 && e.idx !== now) G.fade = 1;
      e.idx = now;
      if (now >= ENDING.length) {
        G.state = 'credits'; G.creditsAt = G.t; G.fade = 1; G.particles.length = 0;
        if (e.newTime || e.newJumps) Sound.record();
        return;
      }
    }
    // 카메라: 불이 붙은 뒤 탑 아래로 내려가며 빛이 번지는 모습을 보여 주고, 마지막 줄에서 다시 꼭대기로
    const prog = Math.max(0, Math.min(1, (e.t - E_IGNITE - E_LINE * 1.3) / (E_LINE * 3)));
    const ease = prog < 0.5 ? 2 * prog * prog : 1 - Math.pow(-2 * prog + 2, 2) / 2;
    e.camY = e.idx >= ENDING.length - 1 ? top : top + ease * (world.screenTop(0) - top);
    if (G.t % 3 === 0) particle({ kind: 'mote', x: Math.random() * VW, y: e.camY + VH + 4, vy: -0.35 - Math.random() * 0.6, vx: (Math.random() - 0.5) * 0.3, life: 420, color: '#ffd98a', rgb: '255,210,120' });
  }

  // ───────────────────────── 파티클 ─────────────────────────
  function particle(o) {
    const q = Object.assign({ vx: 0, vy: 0, g: 0, life: 60, size: 1, color: '#fff', alpha: 1 }, o);
    q.max = q.life;
    G.particles.push(q);
  }
  function puff(x, y, n) {
    const cols = Art.ZS[SCREENS[G.screen] ? SCREENS[G.screen].zone : 'forest'].dust;
    for (let i = 0; i < n; i++) {
      particle({ x: x + (Math.random() - 0.5) * 8, y: y - 1 - Math.random() * 2, vx: (Math.random() - 0.5) * 1.4, vy: -Math.random() * 0.8, g: 0.03, life: 16 + Math.random() * 14, color: cols[i % 2], size: Math.random() < 0.3 ? 2 : 1 });
    }
  }
  const AMB_TARGET = { forest: 16, ramparts: 18, frost: 50, gale: 16, summit: 14 };
  function ambient(camY, zone) {
    let amb = 0;
    for (const q of G.particles) if (q.amb) amb++;
    if (amb >= AMB_TARGET[zone]) return;
    const rx = Math.random() * VW, ry = camY + Math.random() * VH, fill = amb < AMB_TARGET[zone] / 2;
    if (zone === 'forest') particle({ amb: 1, kind: 'firefly', x: rx, y: ry, life: 260 + Math.random() * 200, color: '#d8f56a', rgb: '216,245,106', ph: Math.random() * 6 });
    else if (zone === 'ramparts') particle({ amb: 1, x: rx, y: ry, vy: -0.05 - Math.random() * 0.1, vx: (Math.random() - 0.5) * 0.12, life: 320, color: '#cbb8e6', alpha: 0.5 });
    else if (zone === 'frost') particle({ amb: 1, kind: 'snow', x: rx, y: fill ? ry : camY - 2, vy: 0.25 + Math.random() * 0.35, life: 1400, color: '#e8f4ff', ph: Math.random() * 6, size: Math.random() < 0.25 ? 2 : 1, alpha: 0.8 });
    else if (zone === 'gale') {
      const sc = SCREENS[G.screen], w = sc.wind || 0.03, dir = Math.sign(w);
      if (sc.gust && Math.random() > gustFactor(world.t)) return; // 바람이 쉴 때는 바람 줄기가 줄어든다
      particle({ amb: 1, kind: 'streak', x: fill ? rx : dir > 0 ? -24 : VW + 4, y: ry, vx: dir * (3 + Math.random() * 3), life: 240, color: '#e6eeff', alpha: 0.3, len: 6 + Math.random() * 14 });
    } else particle({ amb: 1, kind: 'spark', x: rx, y: ry, life: 120 + Math.random() * 120, color: '#fff2c0', rgb: '255,242,192' });
  }
  function updateParticles() {
    const camY = currentCamY();
    for (let i = G.particles.length - 1; i >= 0; i--) {
      const q = G.particles[i];
      q.life--;
      if (q.kind === 'firefly') { q.vx = (q.vx + (Math.random() - 0.5) * 0.04) * 0.98; q.vy = (q.vy + (Math.random() - 0.5) * 0.04) * 0.98; }
      if (q.kind === 'snow') q.x += Math.sin(G.t * 0.03 + q.ph) * 0.25;
      q.vy += q.g; q.x += q.vx; q.y += q.vy;
      const out = q.amb && (q.y > camY + VH + 8 || q.x < -30 || q.x > VW + 30);
      if (q.life <= 0 || out) G.particles.splice(i, 1);
    }
  }
  function drawParticles(camY) {
    for (const q of G.particles) {
      let a = Math.min(1, q.life / 20) * q.alpha;
      if (q.kind === 'firefly') a *= 0.35 + 0.65 * Math.abs(Math.sin(G.t * 0.05 + q.ph));
      if (q.kind === 'spark') a *= Math.sin(Math.PI * (1 - q.life / q.max));
      if (a <= 0.01) continue;
      const x = Math.round(q.x), y = Math.round(q.y - camY);
      if (y < -20 || y > VH + 20) continue;
      v.globalAlpha = a;
      v.fillStyle = q.color;
      if (q.kind === 'streak') v.fillRect(x, y, Math.round(q.len), 1);
      else v.fillRect(x, y, q.size, q.size);
      if (q.rgb) { v.globalCompositeOperation = 'lighter'; Art.glow(v, x + 0.5, y + 0.5, 5, q.rgb, 0.45 * a); v.globalCompositeOperation = 'source-over'; }
    }
    v.globalAlpha = 1;
  }

  // ───────────────────────── 월드 렌더링 ─────────────────────────
  function currentCamY() {
    if (G.state === 'ending') return G.ending.camY;
    if (G.state === 'credits') return world.screenTop(world.n - 1);
    return world.screenTop(Math.max(0, G.screen));
  }

  function drawWorld(camY, lit) {
    const sTop = world.screenAt(camY), sBot = world.screenAt(camY + VH - 1);
    const lights = [];
    for (let s = sBot; s <= sTop; s++) {
      const oy = Math.round(world.screenTop(s) - camY), scr = Art.screens[s];
      v.drawImage(scr.bg, 0, oy);
      for (const tw of scr.twinkles) {
        v.fillStyle = `rgba(235,232,255,${(0.25 + 0.75 * Math.abs(Math.sin(G.t * tw.sp + tw.ph))).toFixed(2)})`;
        v.fillRect(tw.x, tw.y + oy, 1, 1);
      }
    }
    for (let s = sBot; s <= sTop; s++) v.drawImage(Art.screens[s].tiles, 0, Math.round(world.screenTop(s) - camY));
    for (const m of world.movers) {
      if (m.screen < sBot || m.screen > sTop) continue;
      Art.drawTrack(v, m.x0 + m.w / 2, m.y0 + 4 - camY, m.x0 + m.ax + m.w / 2, m.y0 + m.ay + 4 - camY);
    }
    for (const g of world.groups) {
      if (g.screen < sBot || g.screen > sTop) continue;
      const zone = SCREENS[g.screen].zone;
      for (const i of g.cells) Art.drawCrumble(v, world, i, (i % COLS) * TILE, Math.round(Math.floor(i / COLS) * TILE - camY), zone, g.state, g.timer, G.t);
    }
    for (const m of world.movers) if (m.screen >= sBot && m.screen <= sTop) Art.drawMover(v, m.x, m.y - camY, m.w, SCREENS[m.screen].zone, G.t);
    for (let s = sBot; s <= sTop; s++) {
      const zone = SCREENS[s].zone;
      for (const o of objsByScreen[s] || []) {
        const x = o.x, y = Math.round(o.y - camY);
        if (o.ch === 'L') {
          const f = Art.drawLamp(v, o, x, y, zone, G.t, world);
          lights.push({ x: x + 8, y: y + 8, r: 44 + 6 * f, glow: 0.22 * f, rgb: Art.ZS[zone].lampRGB });
        } else if (o.ch === 'S') {
          const read = !!G.read['S' + s], a = Art.drawStone(v, x, y, G.t, read);
          lights.push({ x: x + 8, y: y + 4, r: 30, glow: 0.14 * a, rgb: read ? '255,214,120' : '120,240,230' });
        } else if (o.ch === 'N') {
          const d = G.dialog;
          const talking = G.state === 'dialog' && d.obj === o && d.lines[d.i].who === '코르' && d.n < d.lines[d.i].text.length;
          Art.drawCrow(v, x, y, G.t, G.p && G.p.x + P.W / 2 < x + 8 ? -1 : 1, talking);
        } else if (o.ch === '*') {
          if (G.collected[sparkKey(o)]) continue;
          Art.drawSpark(v, x, y, G.t);
          lights.push({ x: x + 8, y: y + 8, r: 26, glow: 0.35, rgb: '255,210,120' });
        } else if (o.ch === 'f') Art.drawFlag(v, x, y, G.t, SCREENS[s].wind, SCREENS[s].gust ? gustFactor(world.t) : 1);
        else if (o.ch === 'G') {
          Art.drawBeacon(v, x, y, G.t, lit > 0);
          lights.push(lit > 0
            ? { x: x + 8, y: y - 6, r: 90 + 380 * lit, glow: 0.55 * Math.min(1, lit * 2), rgb: '255,200,110' }
            : { x: x + 8, y: y - 6, r: 26, glow: 0.08, rgb: '150,170,230' });
        }
      }
    }
    if (G.p) drawPlayer(camY, lights);
    drawParticles(camY);
    drawLighting(SCREENS[world.screenAt(camY + VH / 2)].zone, lit, lights);
  }

  function drawPlayer(camY, lights) {
    const p = G.p;
    let f;
    if (p.splat > 0) f = 'splat';
    else if (!p.onGround) f = p.vy < 0 ? 'jump' : 'fall';
    else if (p.charging) f = 'crouch';
    else if (G.walking && G.state === 'play') f = 'walk' + (Math.floor(G.walkDist / 7) % 4);
    else f = Math.floor(G.t / 45) % 2 ? 'idle1' : 'idle0';
    const left = p.facing < 0, ch = p.charging ? p.charge / P.CHARGE_FRAMES : 0;
    const px = Math.round(p.x), py = Math.round(p.y - camY);
    const tremble = ch > 0.7 && G.t % 4 < 2 ? 1 : 0;
    v.drawImage(Art.lumi[f][left ? 1 : 0], px - 4 + tremble, py - 3);

    let lx = left ? p.x + 1 : p.x + 9, ly = p.y + 9 - camY;
    if (f === 'crouch') ly += 3;
    if (f === 'splat') { lx = left ? p.x - 1 : p.x + 11; ly = p.y + 12 - camY; }
    const flick = Math.sin(G.t * 0.23) * 2 + Math.sin(G.t * 0.07) * 2;
    lights.push({ x: lx, y: ly, r: 72 + ch * 30 + flick, glow: 0.2 + ch * 0.25, rgb: '255,190,90' });

    if (p.charging) {
      const gx = px - 2, gy = py - 7 + 3;
      v.fillStyle = 'rgba(20,14,30,.85)'; v.fillRect(gx - 1, gy - 1, 16, 4);
      v.fillStyle = ch > 0.7 ? '#ff9a4a' : '#ffd36b';
      v.fillRect(gx, gy, Math.max(1, Math.round(14 * ch)), 2);
    }
    if (p.splat > 0) {
      for (let i = 0; i < 2; i++) {
        const a = G.t * 0.15 + i * Math.PI;
        v.fillStyle = '#ffe07a'; v.fillRect(Math.round(p.x + 5 + Math.cos(a) * 6), Math.round(py + 7 + Math.sin(a) * 2), 1, 1);
      }
    }
  }

  function drawLighting(zone, lit, lights) {
    const dark = ZONES[zone].dark * (1 - lit);
    if (dark > 0.01) {
      sh.globalCompositeOperation = 'source-over';
      sh.clearRect(0, 0, VW, VH);
      sh.fillStyle = `rgba(${Art.ZS[zone].darkRGB},${dark})`;
      sh.fillRect(0, 0, VW, VH);
      sh.globalCompositeOperation = 'destination-out';
      for (const L of lights) {
        const g = sh.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.r);
        g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.5, 'rgba(0,0,0,.65)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        sh.fillStyle = g; sh.fillRect(L.x - L.r, L.y - L.r, L.r * 2, L.r * 2);
      }
      v.drawImage(shadeCv, 0, 0);
    }
    v.globalCompositeOperation = 'lighter';
    for (const L of lights) if (L.glow > 0) Art.glow(v, L.x, L.y, L.r * 0.55, L.rgb, L.glow);
    if (lit > 0) { v.fillStyle = `rgba(255,160,70,${(0.07 * lit).toFixed(3)})`; v.fillRect(0, 0, VW, VH); }
    v.globalCompositeOperation = 'source-over';
  }

  // ───────────────────────── UI (고해상도 텍스트) ─────────────────────────
  let S = 1;
  function txt(s, x, y, size, color, o = {}) {
    ctx.font = `${o.weight || 500} ${size}px ${FONT}`;
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
    if (o.glow) { ctx.shadowColor = o.glow; ctx.shadowBlur = (o.blur || 8) * S; }
    else if (o.shadow !== false) { ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowOffsetX = 0.7 * S; ctx.shadowOffsetY = 0.7 * S; }
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    ctx.globalAlpha = 1;
  }
  const wrapCache = new Map();
  function wrap(s, maxW, size, weight = 500) {
    const key = `${size}|${maxW}|${s}`;
    if (wrapCache.has(key)) return wrapCache.get(key);
    ctx.font = `${weight} ${size}px ${FONT}`;
    const lines = [];
    let cur = '';
    for (const w of s.split(' ')) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width <= maxW) { cur = test; continue; }
      if (cur) lines.push(cur);
      cur = w;
    }
    if (cur) lines.push(cur);
    wrapCache.set(key, lines);
    return lines;
  }
  // 타자 효과: 글자 수 n까지만 그린다. 가운데 정렬이어도 줄 시작 위치를 고정해 글자가 흔들리지 않게 한다.
  function typed(lines, n, x, y, lh, size, color, center) {
    let rem = Math.floor(n);
    ctx.font = `500 ${size}px ${FONT}`;
    lines.forEach((ln, i) => {
      if (rem <= 0) return;
      const sx = center ? x - ctx.measureText(ln).width / 2 : x;
      txt(ln.slice(0, rem), sx, y + i * lh, size, color);
      rem -= ln.length + 1;
    });
  }
  function rrect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function panel(x, y, w, h, a = 0.9) {
    ctx.lineWidth = 1 / S * Math.max(1, Math.round(S * 0.6));
    rrect(x, y, w, h, 4); ctx.fillStyle = `rgba(12,9,26,${a})`; ctx.fill();
    ctx.strokeStyle = 'rgba(201,154,60,.75)'; ctx.stroke();
    rrect(x + 3, y + 3, w - 6, h - 6, 2); ctx.strokeStyle = 'rgba(201,154,60,.22)'; ctx.stroke();
  }
  function fmtTime(frames) {
    const s = Math.floor(frames / 60), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }

  function drawMenu(items, y0, gap) {
    items.forEach((it, i) => {
      const sel = i === G.menu, y = y0 + i * gap;
      if (sel) {
        ctx.fillStyle = 'rgba(255,190,90,.12)'; ctx.fillRect(VW / 2 - 60, y - 9, 120, 13);
        txt('◆', VW / 2 - 52, y, 6, '#ffcf70');
        txt('◆', VW / 2 + 52, y, 6, '#ffcf70', { align: 'right' });
      }
      txt(it.label, VW / 2, y, sel ? 10 : 9, sel ? '#fff1d6' : '#a9a2c6', { align: 'center', weight: sel ? 700 : 500 });
    });
  }

  function drawHelp() {
    ctx.fillStyle = 'rgba(4,3,12,.7)'; ctx.fillRect(0, 0, VW, VH);
    panel(86, 36, 340, 222, 0.95);
    txt('조작법', VW / 2, 60, 12, '#ffe7b5', { align: 'center', weight: 800 });
    const rows = touchMode ? [
      ['◀  ▶', '걷기 · 뛸 방향 고르기 · 공중에서 움직이기'],
      ['점프', '누르고 있다가 떼면 점프 (오래 누를수록 높이)'],
      ['다시 읽기', '돌·까마귀 곁에서 머리 위 글자를 누르기'],
      ['❚❚', '일시정지 · 설정'],
      ['화면 누르기', '대화 넘기기 · 메뉴 고르기'],
      ['✦', `불티 — 닿으면 모인다 (모두 ${TOTAL_SPARKS}개)`],
    ] : [
      ['← →  /  A D', '걷기 · 뛸 방향 고르기 · 공중에서 움직이기'],
      ['스페이스', '누르고 있다가 떼면 점프 (오래 누를수록 높이)'],
      ['↑  /  W', '기억의 돌 다시 읽기 · 까마귀와 대화'],
      ['Esc', '일시정지 · 설정'],
      ['M  ·  F', '소리 켜고 끄기 · 전체 화면'],
      ['게임패드', '스틱·십자키 이동 · A 점프 · Y 다시 읽기 · Start 일시정지'],
      ['✦', `불티 — 닿으면 모인다 (모두 ${TOTAL_SPARKS}개)`],
    ];
    rows.forEach(([k, d], i) => {
      txt(k, 112, 84 + i * 18, 8.5, '#ffcf70', { weight: 700 });
      txt(d, 192, 84 + i * 18, 8.5, '#e8e2f4');
    });
    txt('뛰어오른 뒤에도 ← →로 몸을 틀 수 있다. 벽에 부딪히면 튕겨 나온다.', VW / 2, 222, 8, '#b9b2d6', { align: 'center' });
    txt(touchMode ? '눌러서 닫기' : 'Enter / Esc 닫기', VW / 2, 242, 7, '#7d7698', { align: 'center' });
  }

  function drawSettings() {
    ctx.fillStyle = 'rgba(4,3,12,.7)'; ctx.fillRect(0, 0, VW, VH);
    panel(96, 52, 320, 184, 0.96);
    txt('설정', VW / 2, 78, 12, '#ffe7b5', { align: 'center', weight: 800 });
    settingsItems().forEach((it, i) => {
      const y = 106 + i * 22, sel = i === G.opt.i;
      if (sel) { ctx.fillStyle = 'rgba(255,190,90,.12)'; ctx.fillRect(108, y - 10, 296, 15); txt('◆', 114, y, 6, '#ffcf70'); }
      txt(it.label, 126, y, 8.5, sel ? '#fff1d6' : '#b9b2d6', { weight: sel ? 700 : 500 });
      if (it.kind === 'vol') {
        const val = settings[it.key], on = Math.round(val * 10);
        for (let k = 0; k < 10; k++) { ctx.fillStyle = k < on ? (sel ? '#ffcf70' : '#c9a76a') : 'rgba(255,255,255,.12)'; ctx.fillRect(266 + k * 9, y - 7, 7, 8); }
        txt(on ? `${on * 10}%` : '끔', 398, y, 7.5, '#e8e2f4', { align: 'right' });
        if (sel) { txt('◀', 261, y, 6.5, '#ffcf70', { align: 'right' }); txt('▶', 357, y, 6.5, '#ffcf70'); }
      } else if (it.kind === 'toggle') {
        txt(settings[it.key] ? '켜짐' : '꺼짐', 398, y, 7.5, settings[it.key] ? '#ffe7b5' : '#8f88ad', { align: 'right', weight: 700 });
      }
    });
    txt(touchMode ? '항목을 눌러 고르기   ·   막대의 왼쪽·오른쪽을 눌러 조절   ·   바깥을 누르면 닫기' : '↑ ↓ 고르기   ·   ← → 조절   ·   Esc 닫기', VW / 2, 224, 7, '#7d7698', { align: 'center' });
  }

  const ZONE_RGB = { forest: '120,200,110', ramparts: '170,150,220', frost: '130,210,240', gale: '220,200,150', summit: '255,210,120' };
  function drawHUD() {
    const st = G.stats, p = G.p, n = Object.keys(G.collected).length;
    rrect(8, 8, 126, 30, 4); ctx.fillStyle = 'rgba(12,9,26,.55)'; ctx.fill();
    txt(`점프 ${st.jumps}`, 16, 20, 8, '#fff1d6', { weight: 700 });
    txt(`추락 ${st.falls}`, 72, 20, 8, '#f0b8aa', { weight: 700 });
    txt(fmtTime(st.time), 16, 32, 7, '#b9b2d6');
    txt(`✦ ${n} / ${TOTAL_SPARKS}`, 72, 32, 7, '#ffd98a', { weight: 600 });
    // 오른쪽 가장자리의 높이 막대: 구역 색 띠, 최고 높이(금색 눈금), 지금 높이(점)
    const x = VW - 10, y0 = 26, y1 = VH - 22, len = y1 - y0;
    const pos = (m) => y1 - Math.min(1, m / SUMMIT_M) * len;
    for (let s = 0; s < world.n; s++) {
      const a = pos(heightM(world.screenTop(s))), b = pos(heightM(world.screenTop(s) + VH));
      ctx.fillStyle = `rgba(${ZONE_RGB[SCREENS[s].zone]},.4)`; ctx.fillRect(x - 1, a, 3, Math.max(0, b - a - 0.6));
    }
    txt('정상', x + 0.5, y0 - 5, 6, '#ffcf70', { align: 'center', weight: 700 });
    const bp = pos(st.maxH);
    ctx.fillStyle = '#ffcf70'; ctx.fillRect(x - 4, bp - 0.5, 9, 1);
    const h = heightM(p.y + P.H), cp = pos(h);
    ctx.beginPath(); ctx.arc(x + 0.5, cp, 2.6, 0, Math.PI * 2); ctx.fillStyle = '#fff1d6'; ctx.fill();
    txt(`${Math.floor(h)}m`, x - 6, cp + 2.5, 7, '#fff1d6', { align: 'right', weight: 700 });
  }

  function drawDialogBox() {
    const d = G.dialog, line = d.lines[d.i];
    // 루미가 화면 아래쪽에 있으면 대화창을 위로 올려 가리지 않게 한다
    const bx = 34, bw = 444, bh = 86, by = G.p.y - world.screenTop(G.screen) > VH / 2 ? 10 : 192;
    panel(bx, by, bw, bh, 0.92);
    rrect(bx + 9, by + 11, 46, 46, 3); ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fill();
    ctx.strokeStyle = 'rgba(201,154,60,.35)'; ctx.stroke();
    ctx.imageSmoothingEnabled = false;
    if (d.kind === 'S') ctx.drawImage(stoneIcon, bx + 16, by + 14, 32, 40);
    else if (line.who === '코르') ctx.drawImage(Art.crow[d.n < line.text.length && Math.floor(G.t / 8) % 2 ? 'caw' : 'idle'][0], bx + 10, by + 4, 45, 45);
    else ctx.drawImage(Art.lumi.idle0[0], bx + 10, by + 10, 45, 45);
    const name = d.kind === 'S' ? d.title : line.who;
    txt(name, bx + 66, by + 20, 8.5, d.kind === 'S' ? '#9be8e0' : '#e9c46a', { weight: 700 });
    typed(wrap(line.text, bw - 82, 9.5), d.n, bx + 66, by + 38, 14, 9.5, '#f3ead8', false);
    txt(`${d.i + 1} / ${d.lines.length}`, bx + 32, by + bh - 12, 6.5, '#7d7698', { align: 'center' });
    if (d.n >= line.text.length && Math.floor(G.t / 20) % 2) txt('▼', bx + bw - 12, by + bh - 9, 7, '#e9c46a', { align: 'right' });
  }

  // 돌·까마귀 머리 위 '다시 읽기' 글자의 자리 (게임 화면 좌표). 그리기와 터치 판정이 함께 쓴다.
  function promptBox() {
    const o = G.prompt, label = (touchMode ? '눌러서 ' : '↑ ') + (o.ch === 'S' ? '다시 읽기' : '대화');
    ctx.font = `600 7px ${FONT}`;
    const w = ctx.measureText(label).width + 10;
    return { label, x: o.x + 8 - w / 2, y: o.y - world.screenTop(G.screen) - 18, w, h: 11 };
  }

  function drawPlayUI(camY) {
    if (settings.hud) drawHUD();
    for (const pp of G.popups) {
      const a = Math.min(1, (100 - pp.t) / 30);
      txt(pp.text, pp.x, pp.y - camY - pp.t * 0.2, pp.big ? 10 : 8, pp.big ? '#ff8a6a' : '#ffb59a', { align: 'center', weight: 800, alpha: a });
    }
    if (G.card && G.state !== 'dialog') {
      const c = G.card, z = ZONES[c.zone];
      const a = c.t < 40 ? c.t / 40 : c.t > 210 ? Math.max(0, 1 - (c.t - 210) / 50) : 1;
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(233,196,106,.6)';
      ctx.fillRect(VW / 2 - 96, 58, 56, 0.6); ctx.fillRect(VW / 2 + 40, 58, 56, 0.6);
      txt(z.chapter, VW / 2, 61, 8, '#e9c46a', { align: 'center', weight: 700, alpha: a });
      txt(z.name, VW / 2, 86, 20, '#fff1d6', { align: 'center', weight: 800, glow: 'rgba(255,170,80,.75)', blur: 10, alpha: a });
      txt(z.sub, VW / 2, 100, 7, '#c6bfe0', { align: 'center', alpha: a });
      ctx.globalAlpha = 1;
    }
    if (G.quip && G.state === 'play') {
      const q = G.quip, a = Math.max(0, Math.min(1, q.t / 20, (QUIP_T - q.t) / 30));
      const who = q.line.who + '  ', y = VH - 16;
      ctx.font = `700 8.5px ${FONT}`; const ww = ctx.measureText(who).width;
      ctx.font = `500 8.5px ${FONT}`; const tw = ctx.measureText(q.line.text).width;
      const x0 = VW / 2 - (ww + tw) / 2;
      rrect(x0 - 9, y - 11, ww + tw + 18, 16, 4); ctx.fillStyle = `rgba(12,9,26,${(0.8 * a).toFixed(3)})`; ctx.fill();
      txt(who, x0, y, 8.5, q.line.who === '코르' ? '#e9c46a' : '#ffcf9a', { weight: 700, alpha: a });
      txt(q.line.text, x0 + ww, y, 8.5, '#f3ead8', { alpha: a });
    }
    if (G.prompt && G.state === 'play') {
      const o = G.prompt, { label, x, y, w } = promptBox();
      rrect(x, y, w, 11, 3); ctx.fillStyle = 'rgba(12,9,26,.85)'; ctx.fill();
      if (touchMode) { ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(233,196,106,.8)'; ctx.stroke(); } // 누를 수 있다는 표시
      txt(label, o.x + 8, y + 8, 7, '#ffe7b5', { align: 'center', weight: 600, shadow: false });
    }
    if (G.state === 'dialog') drawDialogBox();
    if (G.state === 'pause') {
      ctx.fillStyle = 'rgba(4,3,12,.6)'; ctx.fillRect(0, 0, VW, VH);
      panel(156, 58, 200, 170, 0.94);
      txt('일시정지', VW / 2, 84, 13, '#ffe7b5', { align: 'center', weight: 800 });
      drawMenu(pauseItems(), ...PAUSE_MENU);
      const st = G.stats;
      txt(`${fmtTime(st.time)}   ·   점프 ${st.jumps}   ·   추락 ${st.falls}`, VW / 2, 200, 7, '#8f88ad', { align: 'center' });
      txt(`최고 높이 ${Math.floor(st.maxH)}m / ${Math.floor(SUMMIT_M)}m   ·   불티 ${Object.keys(G.collected).length} / ${TOTAL_SPARKS}`, VW / 2, 213, 7, '#8f88ad', { align: 'center' });
      if (G.help) drawHelp();
      if (G.opt) drawSettings();
    }
  }

  function drawTitleUI() {
    const a = Math.min(1, G.t / 60);
    txt('마지막 불씨', VW / 2, 116, 32, '#ffe7b5', { align: 'center', weight: 800, glow: 'rgba(255,160,70,.85)', blur: 14, alpha: a });
    txt('T H E    L A S T    E M B E R', VW / 2, 132, 7, '#c9a76a', { align: 'center', weight: 600, alpha: a });
    drawMenu(titleItems(), ...TITLE_MENU);
    if (best.time) {
      const parts = [`최고 기록 ${fmtTime(best.time)}`];
      if (best.jumps) parts.push(`최소 점프 ${best.jumps}번`);
      if (best.sparks) parts.push(`불티 ${best.sparks} / ${TOTAL_SPARKS}`);
      txt(parts.join('   ·   '), VW - 12, 16, 7, '#c9a76a', { align: 'right' });
    }
    txt(touchMode ? '◀ ▶ 이동   ·   점프 버튼을 길게 눌렀다 떼기: 점프   ·   메뉴는 눌러서 고르기' : '← → 이동   ·   스페이스(패드 A) 길게 눌렀다 떼기: 점프   ·   M 소리   ·   F 전체 화면', VW / 2, 278, 6.5, '#8f88ad', { align: 'center' });
    if (G.help) drawHelp();
    if (G.opt) drawSettings();
  }

  function drawIntroUI() {
    const it = G.intro, slide = INTRO[it.i];
    const g = ctx.createLinearGradient(0, 180, 0, VH);
    g.addColorStop(0, 'rgba(4,3,14,0)'); g.addColorStop(0.35, 'rgba(4,3,14,.82)'); g.addColorStop(1, 'rgba(4,3,14,.92)');
    ctx.fillStyle = g; ctx.fillRect(0, 180, VW, VH - 180);
    typed(wrap(slide.text, 400, 11), it.n, VW / 2, 228, 17, 11, '#f3ead8', true);
    txt(`${it.i + 1} / ${INTRO.length}`, 14, 278, 6.5, '#7d7698');
    txt(touchMode ? '눌러서 넘기기     건너뛰기 ▶▶' : '스페이스 ▶     Esc 건너뛰기', VW - 14, 278, 6.5, '#7d7698', { align: 'right' });
  }

  function drawEndingUI() {
    const e = G.ending;
    if (e.t < E_IGNITE) return;
    const idx = Math.floor((e.t - E_IGNITE) / E_LINE), local = (e.t - E_IGNITE) % E_LINE;
    const line = ENDING[idx];
    if (!line) return;
    const a = Math.min(1, local / 30) * Math.min(1, (E_LINE - local) / 30);
    const g = ctx.createLinearGradient(0, 200, 0, VH);
    g.addColorStop(0, 'rgba(4,3,14,0)'); g.addColorStop(1, 'rgba(4,3,14,.75)');
    ctx.fillStyle = g; ctx.fillRect(0, 200, VW, VH - 200);
    const lines = wrap(line.text, 400, 11);
    if (line.who) txt(line.who, VW / 2, 226, 8, '#e9c46a', { align: 'center', weight: 700, alpha: a });
    lines.forEach((ln, i) => txt(ln, VW / 2, (line.who ? 244 : 238) + i * 17, 11, '#fff3dc', { align: 'center', alpha: a, glow: 'rgba(0,0,0,.9)', blur: 6 }));
  }

  function drawCreditsUI() {
    ctx.fillStyle = 'rgba(5,4,18,.62)'; ctx.fillRect(0, 0, VW, VH);
    const st = G.stats, e = G.ending || {}, read = Object.keys(G.read).filter((k) => k[0] === 'S').length;
    const sparks = Object.keys(G.collected).length;
    txt('마지막 불씨', VW / 2, 66, 24, '#ffe7b5', { align: 'center', weight: 800, glow: 'rgba(255,160,70,.85)', blur: 12 });
    txt('— 끝 —', VW / 2, 84, 8, '#c9a76a', { align: 'center' });
    const rows = [
      ['오른 시간', fmtTime(st.time), e.newTime],
      ['점프', `${st.jumps}번`, e.newJumps],
      ['추락', `${st.falls}번`],
      ['가장 긴 추락', `${(st.maxFall || 0).toFixed(1)}m`],
      ['모은 불티', `${sparks} / ${TOTAL_SPARKS}`],
      ['읽은 기록', `${read} / ${TOTAL_STONES}`],
    ];
    rows.forEach(([k, val, rec], i) => {
      const y = 110 + i * 16;
      txt(k, VW / 2 - 10, y, 9, '#b9b2d6', { align: 'right' });
      txt(val, VW / 2 + 10, y, 9, '#fff1d6', { weight: 700 });
      if (rec) { ctx.font = `700 9px ${FONT}`; txt('신기록!', VW / 2 + 18 + ctx.measureText(val).width, y, 8, '#ffcf70', { weight: 800, glow: 'rgba(255,170,80,.7)', blur: 6 }); }
    });
    if (sparks === TOTAL_SPARKS) txt('✦ 흩어진 불티를 모두 모았다 ✦', VW / 2, 222, 8.5, '#ffd98a', { align: 'center', weight: 700, glow: 'rgba(255,170,80,.6)', blur: 6 });
    if (G.t - G.creditsAt > 60 && Math.floor(G.t / 30) % 2) txt(touchMode ? '눌러서 타이틀로' : 'Enter — 타이틀로', VW / 2, 244, 8, '#e9c46a', { align: 'center' });
  }

  // ───────────────────────── 렌더 ─────────────────────────
  function render() {
    const dpr = DPR = window.devicePixelRatio || 1;
    const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
      canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px'; // 모바일 주소창 높이 변화에 맞춘다
    }
    S = Math.min(W / VW, H / VH);
    const ox = Math.round((W - VW * S) / 2);
    let oy = Math.round((H - VH * S) / 2);
    // 세로로 든 터치 기기: 게임 화면을 위로 올리고 아래 빈 곳에 버튼을 둔다
    if (touchMode && H > W) oy = Math.round(Math.max(0, Math.min(oy, (H - touchButtons().height * dpr - VH * S) / 2)));
    OX = ox; OY = oy;

    switch (G.state) {
      case 'title': Art.drawTitleScene(v, G.t, { beacon: false, lumi: true, lantern: true }); break;
      case 'intro': { const sl = INTRO[G.intro.i]; Art.drawTitleScene(v, G.t, { beacon: sl.beacon, lumi: sl.lumi, lantern: sl.lantern }); break; }
      case 'ending': drawWorld(G.ending.camY, G.ending.lit); break;
      case 'credits': drawWorld(world.screenTop(world.n - 1), 1); break;
      default: drawWorld(world.screenTop(G.screen), 0);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    const sx = G.shake ? Math.round((Math.random() - 0.5) * G.shake * 0.4) * S : 0;
    const sy = G.shake ? Math.round((Math.random() - 0.5) * G.shake * 0.4) * S : 0;
    ctx.drawImage(view, ox + sx, oy + sy, VW * S, VH * S);
    ctx.setTransform(S, 0, 0, S, ox, oy);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, VW, VH); ctx.clip();
    switch (G.state) {
      case 'title': drawTitleUI(); break;
      case 'intro': drawIntroUI(); break;
      case 'ending': drawEndingUI(); break;
      case 'credits': drawCreditsUI(); break;
      default: drawPlayUI(world.screenTop(G.screen));
    }
    if (G.toast) {
      ctx.font = `600 7.5px ${FONT}`;
      const w = ctx.measureText(G.toast.text).width + 16;
      // 오른쪽 가장자리의 높이 막대와 겹치지 않게 조금 안쪽에 띄운다
      rrect(VW - w - 26, 10, w, 14, 4); ctx.fillStyle = `rgba(12,9,26,${Math.min(0.85, G.toast.t / 20)})`; ctx.fill();
      txt(G.toast.text, VW - 26 - w / 2, 20, 7.5, '#ffe7b5', { align: 'center', weight: 600, alpha: Math.min(1, G.toast.t / 20) });
    }
    if (G.fade > 0) { ctx.fillStyle = `rgba(0,0,0,${G.fade})`; ctx.fillRect(0, 0, VW, VH); }
    ctx.restore();
    if (touchMode && G.state === 'play') drawTouch();
  }

  // 화면 버튼 (CSS 픽셀 좌표로 그린다)
  // 가로 화면에서는 버튼이 게임 위에 겹치므로, 루미가 버튼 밑에 오면 그 버튼을 흐리게 해 캐릭터가 보이게 한다.
  function drawTouch() {
    const b = touchButtons(), p = G.p, k = S / DPR, pad = 8;
    const rx = (OX + p.x * S) / DPR - pad, ry = (OY + (p.y - world.screenTop(G.screen)) * S) / DPR - pad;
    const rw = P.W * k + pad * 2, rh = P.H * k + pad * 2;
    const covers = (o) => Math.hypot(o.x - Math.max(rx, Math.min(o.x, rx + rw)), o.y - Math.max(ry, Math.min(o.y, ry + rh))) < o.r;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const circle = (o, on) => {
      ctx.globalAlpha = covers(o) ? 0.2 : 1;
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
      ctx.fillStyle = on ? 'rgba(255,190,90,.32)' : 'rgba(12,9,26,.38)'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = on ? 'rgba(255,207,112,.95)' : 'rgba(233,196,106,.5)'; ctx.stroke();
    };
    const arrow = (o, dx, dy) => { // dx·dy: 화살표가 가리키는 방향
      const s = o.r * 0.36, px = -dy, py = dx;
      ctx.beginPath();
      ctx.moveTo(o.x + dx * s, o.y + dy * s);
      ctx.lineTo(o.x - dx * s * 0.7 + px * s, o.y - dy * s * 0.7 + py * s);
      ctx.lineTo(o.x - dx * s * 0.7 - px * s, o.y - dy * s * 0.7 - py * s);
      ctx.closePath(); ctx.fillStyle = 'rgba(255,241,214,.9)'; ctx.fill();
    };
    circle(b.left, touch.ArrowLeft); arrow(b.left, -1, 0);
    circle(b.right, touch.ArrowRight); arrow(b.right, 1, 0);
    circle(b.jump, touch.Space);
    if (p.charging) { // 모으는 힘을 테두리로 보여 준다
      const ch = p.charge / P.CHARGE_FRAMES;
      ctx.beginPath(); ctx.arc(b.jump.x, b.jump.y, b.jump.r - 3, -Math.PI / 2, -Math.PI / 2 + ch * Math.PI * 2);
      ctx.lineWidth = 4; ctx.strokeStyle = ch > 0.7 ? '#ff9a4a' : '#ffd36b'; ctx.stroke();
    }
    ctx.font = `700 ${Math.round(b.jump.r * 0.42)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,241,214,.9)'; ctx.fillText('점프', b.jump.x, b.jump.y);
    circle(b.pause, touch.Escape);
    const u = b.pause.r * 0.32;
    ctx.fillStyle = 'rgba(255,241,214,.9)';
    ctx.fillRect(b.pause.x - u * 1.1, b.pause.y - u * 1.2, u * 0.7, u * 2.4);
    ctx.fillRect(b.pause.x + u * 0.4, b.pause.y - u * 1.2, u * 0.7, u * 2.4);
    ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1;
  }

  // ───────────────────────── 루프 ─────────────────────────
  const STEP_MS = 1000 / 60;
  let last = performance.now(), acc = 0;
  function frame(now) {
    acc += Math.min(250, now - last);
    last = now;
    let n = 0;
    while (acc >= STEP_MS && n < 8) { update(); acc -= STEP_MS; n++; }
    if (n === 8) acc = 0;
    render();
    requestAnimationFrame(frame);
  }
  canvas.focus();
  requestAnimationFrame(frame);
})();

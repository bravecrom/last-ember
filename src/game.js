/*
 * game.js — 게임 루프와 상태(타이틀/인트로/플레이/대화/일시정지/엔딩/크레딧), 입력, 렌더링, UI, 저장.
 */
(function () {
  'use strict';
  const { TILE, COLS, ROWS, CYCLE, SCREEN_W: VW, SCREEN_H: VH, P, World, createPlayer, step, gustFactor, setRules, mapHash } = Physics;
  const { ZONES, SCREENS: TOWER, INTRO, ENDING, FALL_LINES, FALL_MEMORIES, THREADS, DARK_INTRO, DARK_ENDING, ACHIEVEMENTS } = Levels;
  const ZONE_ORDER = Object.keys(ZONES);

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const view = Art.makeCanvas(VW, VH), v = view.getContext('2d');
  const shadeCv = Art.makeCanvas(VW, VH), sh = shadeCv.getContext('2d');

  // ── 월드: 기본 탑 / 꺼진 탑 / 커스텀 맵마다 새로 만든다 ──
  // 높이: 시작 바닥이 0m, 한 칸 = 0.5m
  let SCREENS, world, worldKey = '', START, TOTAL_STONES, TOTAL_SPARKS, FLOOR_Y, SUMMIT_M, objsByScreen, playback;
  function heightM(feetY) { return Math.max(0, (FLOOR_Y - feetY) / 32); }
  function loadWorld(screens, dark) {
    const key = (screens === TOWER ? 'tower' : mapHash(screens)) + (dark ? ':dark' : '');
    if (key === worldKey) return;
    world = new World(screens, { dark });
    worldKey = key;
    SCREENS = screens;
    Art.prerender(world);
    START = world.objects.find((o) => o.ch === 'P');
    TOTAL_STONES = world.objects.filter((o) => o.ch === 'S').length;
    TOTAL_SPARKS = world.objects.filter((o) => o.ch === '*').length;
    FLOOR_Y = START.y + TILE;
    SUMMIT_M = heightM(world.objects.find((o) => o.ch === 'G').y + TILE);
    objsByScreen = [];
    for (const o of world.objects) (objsByScreen[o.screen] = objsByScreen[o.screen] || []).push(o);
    playback = new Replay.Playback(screens, dark);
  }
  loadWorld(TOWER, false);

  const FONT = '"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR","Nanum Gothic",sans-serif';
  const IS_ELECTRON = /Electron/i.test(navigator.userAgent);
  // v2: 탑이 12개 → 21개 화면으로 바뀌어 예전 저장 위치·기록은 쓰지 않는다
  const SAVE_KEY = 'lastEmber.save.v2', REC_KEY = 'lastEmber.rec.v2', BEST_KEY = 'lastEmber.best.v2', GHOST_KEY = 'lastEmber.ghost.v2.';
  const SETTINGS_KEY = 'lastEmber.settings.v1', PROGRESS_KEY = 'lastEmber.progress.v1', TEL_KEY = 'lastEmber.telemetry.v1';
  const sparkKey = (o) => `${o.screen}:${o.col}:${o.row}`;
  const stoneIcon = Art.makeCanvas(16, 20);
  Art.drawStone(stoneIcon.getContext('2d'), 0, 2, 0, false);

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, val) { try { localStorage.setItem(k, JSON.stringify(val)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } },
  };

  // 설정: 배경음악·효과음 크기(0~1), 화면 정보, 고스트, 방송용 추락 카운터
  const settings = Object.assign({ bgm: 0.6, sfx: 0.8, hud: true, ghost: true, stream: false }, store.get(SETTINGS_KEY) || {});
  Sound.setVolume('bgm', settings.bgm);
  Sound.setVolume('sfx', settings.sfx);
  Sound.music('title');
  const saveSettings = () => store.set(SETTINGS_KEY, settings);
  // 기록: 갈래(cat)마다 { time, jumps, sparks, splits } — cat = 'tower-story' | 'tower-keeper' | 'dark-story' | 'dark-keeper'
  let best = store.get(BEST_KEY) || {}; // 타이틀이 매 프레임 그리므로 저장소를 다시 읽지 않는다
  // 오르기를 넘어 남는 것: 업적, 랜턴 실, 연 갈래, 떨어진 날의 기록, 평생 통계, 커스텀 맵 기록
  const progress = Object.assign({ ach: {}, threads: { red: true }, thread: 'red', cleared: {}, memories: {}, life: { falls: 0, lost: 0, jumps: 0, clears: 0 }, custom: {}, lastRun: { mode: 'story', dark: false } }, store.get(PROGRESS_KEY) || {});
  const saveProgress = () => store.set(PROGRESS_KEY, progress);
  // 플레이테스트 통계 (기기 안에만 쌓이고 '통계 내보내기'로 파일로 꺼낸다)
  const telemetry = store.get(TEL_KEY) || { v: 1, cats: {} };
  const saveTelemetry = () => store.set(TEL_KEY, telemetry);
  const darkUnlocked = () => Object.keys(progress.cleared).length > 0;

  // ───────────────────────── 입력 ─────────────────────────
  const keys = Object.create(null), pressed = Object.create(null);
  const GAME_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter', 'Escape', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyZ', 'KeyM', 'KeyF', 'KeyR', 'KeyC', 'F11']);
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
  addEventListener('beforeunload', () => { if (G.p && (G.state === 'play' || G.state === 'pause' || G.state === 'dialog')) noteQuit(); save(); saveTelemetry(); });
  // 커스텀 맵: 타이틀에서 창에 파일을 끌어다 놓아도 열린다
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f && G.state === 'title') readMapFile(f);
  });
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
    if (G.replayOffer && G.replayOffer.box && (() => { const r = G.replayOffer.box; return gx > r.x - 6 && gx < r.x + r.w + 6 && gy > r.y - 6 && gy < r.y + r.h + 6; })()) { pressed.KeyR = true; return; }
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
  const TITLE_MENU = [158, 15], PAUSE_MENU = [108, 17];
  const SET_ROW = [96, 20], SUB_ROW = [96, 19]; // 설정·하위 메뉴 줄의 [첫 줄 y, 간격]
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
      if (t.x < 96 || t.x > 416 || t.y < 44 || t.y > 244) { pressed.Escape = true; return; }
      const items = settingsItems(), i = Math.round((t.y - (SET_ROW[0] - 3)) / SET_ROW[1]);
      if (i < 0 || i >= items.length || t.x < 100 || t.x > 412) return;
      G.opt.i = i;
      if (items[i].kind !== 'vol') pressed.Enter = true;
      else if (t.x >= 258) pressed[t.x < 311 ? 'ArrowLeft' : 'ArrowRight'] = true;
    } else if (inMenu && (G.help || G.view)) pressed.Enter = true;
    else if (inMenu && G.sub) {
      if (t.x < 96 || t.x > 416 || t.y < 40 || t.y > 248) { pressed.Escape = true; return; }
      const items = subItems(), i = Math.round((t.y - (SUB_ROW[0] - 3)) / SUB_ROW[1]);
      if (i < 0 || i >= items.length || items[i].kind === 'info') return;
      G.sub.i = i;
      if (items[i].kind === 'pick') pressed[t.x < VW / 2 + 40 ? 'ArrowLeft' : 'ArrowRight'] = true;
      else pressed.Enter = true;
    }
    else if (G.state === 'title') menuTap(t, TITLE_MENU, titleItems().length, (i) => { G.menu = i; });
    else if (G.state === 'pause') menuTap(t, PAUSE_MENU, pauseItems().length, (i) => { G.menu = i; });
    else if (G.state === 'intro' && t.x > VW - 90 && t.y > 262) pressed.Escape = true; // '건너뛰기'
    else if (G.state === 'replay') pressed[t.y > VH - 24 && t.x > VW / 2 ? 'KeyC' : 'Escape'] = true;
    else if (G.state === 'credits' && t.y > 252) pressed.KeyC = true;
    else pressed.Enter = true;
  }

  // 게임패드 (표준 배치): 스틱·십자키 이동, A 점프·선택, Y 또는 ↑ 다시 읽기, Start 일시정지, B 뒤로(메뉴·대화)
  const pad = Object.create(null);
  const PAD_CODES = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Escape', 'PadX'];
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
      now.PadX = b(2); // X: 추락 다시 보기 · 클립 저장 · 결과 카드 저장
    }
    for (const c of PAD_CODES) {
      if (now[c] && !pad[c]) { pressed[c] = true; Sound.unlock(); }
      pad[c] = !!now[c];
    }
  }
  addEventListener('gamepadconnected', () => { G.toast = { text: '게임패드 연결됨', t: 120 }; });

  // ───────────────────────── 상태 ─────────────────────────
  const G = {
    state: 'title', t: 0, menu: 0, help: false, opt: null, sub: null, view: null, fade: 1,
    p: null, screen: 0, stats: null, read: {}, seen: {}, collected: {}, popups: [],
    dialog: null, card: null, prompt: null, toast: null, achToast: null, shake: 0,
    particles: [], jumpLock: false, walking: false, walkDist: 0, saveTimer: 0,
    intro: null, introLines: INTRO, ending: null, quip: null, quipAt: -Infinity, quipN: 0,
    // 이번 오르기의 규칙: mode 'story'(공중 조작) | 'keeper'(등불지기), dark 꺼진 탑, practice 연습, custom 커스텀 맵
    run: { mode: 'story', dark: false, practice: false, custom: null },
    ghost: null, replayOffer: null, rp: null, airStart: 0, pendingMemory: -1, streamFlash: 0,
    newRun: Object.assign({}, progress.lastRun), practiceAt: 0, customMap: null,
  };
  const hist = new Replay.History(); // 추락 다시 보기용 최근 입력
  let recorder = null;               // 고스트용 오르기 기록 (기본 탑에서만)
  const cat = () => (G.run.custom || G.run.practice ? null : `${G.run.dark ? 'dark' : 'tower'}-${G.run.mode}`);
  const official = () => !G.run.practice && !G.run.custom;
  const CAT_NAME = { 'tower-story': '이야기', 'tower-keeper': '등불지기', 'dark-story': '꺼진 탑 · 이야기', 'dark-keeper': '꺼진 탑 · 등불지기' };
  const MODE_NAME = { story: '이야기 모드', keeper: '등불지기 모드' };
  const freshStats = () => ({ time: 0, jumps: 0, falls: 0, maxH: 0, maxFall: 0, lost: 0, splits: {}, zoneFalls: {} });
  function applyRun(run) {
    G.run = Object.assign({ mode: 'story', dark: false, practice: false, custom: null }, run);
    setRules({ air: G.run.mode === 'story' });
    loadWorld(G.run.custom ? G.run.custom.screens : TOWER, G.run.dark);
  }
  function toast(text, t = 150) { G.toast = { text, t }; }
  function unlock(id) {
    if (!official() || progress.ach[id]) return;
    progress.ach[id] = Date.now();
    saveProgress();
    G.achToast = { a: ACHIEVEMENTS.find((x) => x.id === id), t: 0 };
    Sound.record();
  }

  // ── 플레이테스트 통계 (기본 탑에서만) ──
  function telCat() {
    const k = cat() || 'other';
    return telemetry.cats[k] || (telemetry.cats[k] = { runs: 0, clears: 0, clearTimes: [], screens: {}, drops: {}, quits: {} });
  }
  function telScreen(s) { const c = telCat().screens; return c[s] || (c[s] = { time: 0, jumps: 0, falls: 0 }); }
  function noteQuit() { if (official() && G.p) { const q = telCat().quits; q[G.screen] = (q[G.screen] || 0) + 1; } }

  function toTitle() {
    G.state = 'title'; G.menu = 0; G.fade = 1; G.p = null; G.ghost = null; G.particles.length = 0;
    G.help = false; G.opt = null; G.sub = null; G.view = null; G.replayOffer = null;
    Sound.music('title');
  }

  const openSettings = () => { G.opt = { i: 0 }; };
  function titleItems() {
    const items = [];
    if (store.get(SAVE_KEY)) items.push({ label: '이어하기', act: continueGame });
    items.push({ label: '새로 시작', act: () => openSub('new') });
    items.push({ label: '도전', act: () => openSub('challenge') });
    items.push({ label: '기록 · 꾸미기', act: () => openSub('records') });
    items.push({ label: '설정', act: openSettings });
    items.push({ label: '조작법', act: () => { G.help = true; } });
    if (IS_ELECTRON) items.push({ label: '종료', act: () => window.close() });
    return items;
  }
  function pauseItems() {
    const items = [
      { label: '계속하기', act: () => { G.state = 'play'; G.jumpLock = true; } },
      { label: '설정', act: openSettings },
      { label: '조작법', act: () => { G.help = true; } },
    ];
    if (G.run.practice) items.push({ label: '다른 화면 고르기', act: () => { toTitle(); openSub('practice'); } });
    items.push({ label: '타이틀로', act: () => { noteQuit(); save(); saveTelemetry(); toTitle(); } });
    return items;
  }
  function settingsItems() {
    return [
      { label: '배경음악', kind: 'vol', key: 'bgm' },
      { label: '효과음', kind: 'vol', key: 'sfx' },
      { label: '화면 정보 (높이·점프 수)', kind: 'toggle', key: 'hud' },
      { label: '고스트 (내 최고 기록과 함께 오르기)', kind: 'toggle', key: 'ghost' },
      { label: '방송용 추락 카운터', kind: 'toggle', key: 'stream' },
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
      if (it.key === 'ghost' && !settings.ghost) G.ghost = null; // 켜는 것은 다음 시작부터
    } else if (it.kind === 'act' && hit(...CONFIRM)) { Sound.select(); it.act(); }
  }
  function menuNav(items) {
    if (hit('ArrowUp', 'KeyW')) { G.menu = (G.menu + items.length - 1) % items.length; Sound.move(); }
    if (hit('ArrowDown', 'KeyS')) { G.menu = (G.menu + 1) % items.length; Sound.move(); }
    G.menu = Math.min(G.menu, items.length - 1);
    if (hit(...CONFIRM)) { Sound.select(); items[G.menu].act(); }
  }

  // ── 하위 메뉴 (새로 시작 · 도전 · 연습 · 커스텀 맵 · 기록·꾸미기) ──
  // 항목 kind: 'act' 고르면 실행, 'pick' ← →(또는 Enter)로 값 바꾸기, 'info' 고를 수 없는 설명 줄
  const SUB_TITLE = { new: '새 오르기', challenge: '도전', practice: '연습', custom: '커스텀 맵', records: '기록 · 꾸미기' };
  const SUB_PARENT = { practice: 'challenge', custom: 'challenge' };
  function openSub(id) {
    G.sub = { id, i: 0 };
    const items = subItems();
    while (items[G.sub.i] && items[G.sub.i].kind === 'info') G.sub.i++;
  }
  const flipMode = () => { G.newRun.mode = G.newRun.mode === 'story' ? 'keeper' : 'story'; };
  function subItems() {
    const id = G.sub.id, r = G.newRun;
    const back = { label: '돌아가기', kind: 'act', act: () => (SUB_PARENT[id] ? openSub(SUB_PARENT[id]) : (G.sub = null)) };
    const modeItem = { label: '조작', kind: 'pick', value: MODE_NAME[r.mode], change: flipMode };
    if (id === 'new') {
      const unlocked = darkUnlocked();
      if (!unlocked) r.dark = false;
      return [
        { label: '탑', kind: 'pick', value: r.dark ? '꺼진 탑' : '보통 탑', change: () => { if (unlocked) r.dark = !r.dark; else toast('꺼진 탑은 한 번 올라 불을 붙이면 열린다'); } },
        modeItem,
        { kind: 'info', label: r.mode === 'story' ? '뛰어오른 뒤에도 ← →로 몸을 틀 수 있다.' : '뛰는 순간 궤적이 정해진다. 공중에서 몸을 틀 수 없다.' },
        { kind: 'info', label: r.dark ? '쉰 해 전 그 밤 — 더 어둡고, 바람이 세고, 돌이 더 무너진다.' : unlocked ? '기록은 탑과 조작마다 따로 남는다.' : '한 번 올라 불을 붙이면 꺼진 탑이 열린다.' },
        { label: store.get(SAVE_KEY) ? '시작 (이어하던 오르기는 지워진다)' : '시작', kind: 'act', act: startNew },
        back,
      ];
    }
    if (id === 'challenge') {
      return [
        darkUnlocked() ? { label: '연습 — 화면을 골라 오르기', kind: 'act', act: () => openSub('practice') } : { kind: 'info', label: '연습 — 한 번 올라 불을 붙이면 열린다' },
        { label: '커스텀 맵', kind: 'act', act: () => openSub('custom') },
        { kind: 'info', label: '연습과 커스텀 맵에서는 기록·업적이 남지 않는다.' },
        back,
      ];
    }
    if (id === 'practice') {
      const n = TOWER.length, s = G.practiceAt;
      return [
        { label: '화면', kind: 'pick', value: `${s + 1} / ${n}  ·  ${ZONES[TOWER[s].zone].name}`, change: (dx) => { G.practiceAt = (s + dx + n) % n; } },
        { label: '탑', kind: 'pick', value: r.dark ? '꺼진 탑' : '보통 탑', change: () => { r.dark = !r.dark; } },
        modeItem,
        { label: '시작', kind: 'act', act: startPractice },
        back,
      ];
    }
    if (id === 'custom') {
      const m = G.customMap, items = [];
      items.push({ kind: 'info', label: m ? `「${m.name}」${m.author ? ' · ' + m.author : ''} · 화면 ${m.screens.length}개` : '불러온 맵이 없다' });
      if (m) items.push({ kind: 'info', label: m.verified ? `✓ 검증됨 (${m.verified}) — 끝까지 오를 수 있다` : '검증 안 됨 — 끝까지 오를 수 있는지 모른다' });
      items.push({ label: '맵 파일 열기…', kind: 'act', act: pickMapFile });
      items.push(modeItem);
      if (m) items.push({ label: progress.custom[m.hash] ? `시작  (최고 기록 ${fmtTime(progress.custom[m.hash].time)})` : '시작', kind: 'act', act: startCustom });
      items.push({ kind: 'info', label: '창에 맵 파일(.json)을 끌어다 놓아도 된다 · 만드는 법은 README' });
      items.push(back);
      return items;
    }
    // records
    const owned = THREADS.filter((th) => progress.threads[th.id]);
    const cur = THREADS.find((th) => th.id === progress.thread) || THREADS[0];
    return [
      { label: '업적 · 기록 보기', kind: 'act', act: () => { G.view = 'ach'; } },
      { label: '랜턴 실', kind: 'pick', value: `${cur.name}  (${owned.length} / ${THREADS.length})`, change: (dx) => {
        const ids = owned.map((th) => th.id);
        progress.thread = ids[(ids.indexOf(cur.id) + dx + ids.length) % ids.length];
        saveProgress();
      } },
      { kind: 'info', label: cur.desc + (owned.length < THREADS.length ? ' · 남은 실은 구역마다 하나씩 숨어 있다' : '') },
      { label: '통계 내보내기 (플레이테스트용)', kind: 'act', act: exportTelemetry },
      back,
    ];
  }
  function updateSub() {
    const items = subItems(), o = G.sub;
    if (hit('Escape')) { Sound.move(); items[items.length - 1].act(); return; }
    const sel = (d) => {
      for (let k = 0; k < items.length; k++) { o.i = (o.i + d + items.length) % items.length; if (items[o.i].kind !== 'info') break; }
      Sound.move();
    };
    if (hit('ArrowUp', 'KeyW')) sel(-1);
    if (hit('ArrowDown', 'KeyS')) sel(1);
    o.i = Math.min(o.i, items.length - 1);
    const it = items[o.i];
    if (it.kind === 'info') return sel(1);
    const dx = (hit('ArrowRight', 'KeyD') ? 1 : 0) - (hit('ArrowLeft', 'KeyA') ? 1 : 0);
    if (it.kind === 'pick' && (dx || hit(...CONFIRM))) { it.change(dx || 1); Sound.move(); }
    else if (it.kind === 'act' && hit(...CONFIRM)) { Sound.select(); it.act(); }
  }

  // ── 오르기 시작 ──
  function startNew() {
    const r = G.newRun;
    progress.lastRun = { mode: r.mode, dark: r.dark && darkUnlocked() };
    saveProgress();
    applyRun(progress.lastRun);
    G.sub = null;
    G.introLines = G.run.dark ? DARK_INTRO : INTRO;
    G.state = 'intro'; G.intro = { i: 0, n: 0 }; G.fade = 1;
  }
  function newGame() {
    G.p = createPlayer(START.x + (TILE - P.W) / 2, START.y + TILE - P.H);
    G.stats = freshStats();
    G.read = {}; G.seen = {}; G.collected = {};
    recorder = official() ? new Replay.Recorder() : null;
    if (official()) { store.del(SAVE_KEY); store.del(REC_KEY); telCat().runs++; }
    beginPlay();
  }
  function continueGame() {
    const s = store.get(SAVE_KEY);
    if (!s) return;
    applyRun(s.run || {});
    G.p = createPlayer(s.x, s.y);
    G.p.facing = s.facing || 1;
    G.stats = Object.assign(freshStats(), s.stats);
    G.read = s.read || {}; G.seen = s.seen || {}; G.collected = s.collected || {};
    // 기록을 저장 시점(= 오른 시간 프레임 수)까지로 맞춘다. 모자라면(저장 실패 등) 이번 오르기는 고스트로 남기지 않는다.
    const segs = Replay.decode(store.get(REC_KEY) || ''), frames = segs.reduce((a, sg) => a + sg.runs.reduce((b, r) => b + r[1], 0), 0);
    recorder = new Replay.Recorder(truncateRec(segs, G.stats.time));
    recorder.broken = frames < G.stats.time;
    beginPlay();
  }
  function truncateRec(segs, n) {
    const out = [];
    for (const sg of segs) {
      if (n <= 0) break;
      const runs = [];
      for (const [b, k] of sg.runs) { if (n <= 0) break; const take = Math.min(k, n); runs.push([b, take]); n -= take; }
      out.push({ x: sg.x, y: sg.y, facing: sg.facing, runs });
    }
    return out;
  }
  // 연습: 고른 화면의 가장 낮은 단단한 발판(두 칸 이상)에서 시작한다
  function practiceSpot(s) {
    const top = (world.n - 1 - s) * ROWS;
    for (let r = ROWS - 1; r >= 1; r--) {
      const wr = top + r;
      for (let c = 1; c < COLS - 2; c++) {
        const ok = (cc) => { const t = world.tile(cc, wr); return (t === 1 || t === 2) && !world.tile(cc, wr - 1) && !world.tile(cc, wr - 2); };
        if (ok(c) && ok(c + 1)) return { x: c * TILE + (2 * TILE - P.W) / 2, y: wr * TILE - P.H };
      }
    }
    return { x: START.x, y: START.y + TILE - P.H };
  }
  function startPractice() {
    applyRun({ mode: G.newRun.mode, dark: G.newRun.dark, practice: true });
    const sp = practiceSpot(G.practiceAt);
    G.p = createPlayer(sp.x, sp.y);
    G.stats = freshStats();
    G.read = {}; G.seen = {}; G.collected = {};
    for (const o of world.objects) if (o.ch === 'S' || o.ch === 'N') G.read[o.ch + o.screen] = true; // 연습에서는 대화가 저절로 뜨지 않게
    recorder = null;
    beginPlay();
  }
  function startCustom() {
    const m = G.customMap;
    applyRun({ mode: G.newRun.mode, custom: m });
    G.sub = null;
    recorder = null;
    G.p = createPlayer(START.x + (TILE - P.W) / 2, START.y + TILE - P.H);
    G.stats = freshStats();
    G.read = {}; G.seen = {}; G.collected = {};
    beginPlay();
  }
  function beginPlay() {
    world.reset(0);
    G.state = 'play'; G.screen = -1; G.fade = 1; G.jumpLock = true; G.help = false; G.opt = null; G.sub = null; G.view = null;
    G.particles.length = 0; G.popups.length = 0; G.dialog = null; G.card = null; G.quip = null; G.replayOffer = null; G.pendingMemory = -1;
    hist.reset();
    if (recorder) recorder.begin(G.p);
    // 고스트: 이 갈래의 최고 기록을 따로 된 월드에서 함께 재생한다 (이어하기면 지금 시각까지 빨리 감는다)
    G.ghost = null;
    const gs = official() && settings.ghost ? store.get(GHOST_KEY + cat()) : null;
    if (gs && gs.rec) {
      G.ghost = new Replay.Ghost(Replay.decode(gs.rec), SCREENS, G.run.dark);
      for (let f = 0; f < G.stats.time && !G.ghost.done; f++) G.ghost.tick();
    }
    enterScreen(world.screenAt(G.p.y + P.H / 2));
    save();
  }
  function save() {
    const p = G.p;
    // 움직이는 발판 위에서는 저장하지 않는다 (불러올 때 발판 위치가 달라지므로). 연습·커스텀 맵은 저장하지 않는다.
    if (!official() || !p || !p.onGround || p.charging || p.plat) return;
    if (G.state === 'ending' || G.state === 'credits' || G.state === 'replay') return;
    store.set(SAVE_KEY, { x: p.x, y: p.y, facing: p.facing, stats: G.stats, read: G.read, seen: G.seen, collected: G.collected, run: { mode: G.run.mode, dark: G.run.dark } });
    if (recorder && !store.set(REC_KEY, Replay.encode(recorder.segs))) recorder.broken = true;
  }
  function openPause() { save(); saveTelemetry(); G.state = 'pause'; G.menu = 0; G.help = false; G.opt = null; }
  function toggleMute() { Sound.setMuted(!Sound.muted); toast(Sound.muted ? '소리 꺼짐' : '소리 켜짐', 90); }
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
    if (!G.seen[zone]) {
      G.seen[zone] = true;
      G.card = { zone, t: 0 };
      if (G.stats && !G.run.practice) {
        // 구간 기록: 구역에 처음 들어선 시각. 최고 기록의 같은 구간과 비교해 보여 준다
        G.stats.splits[zone] = G.stats.time;
        const pb = cat() && best[cat()] && best[cat()].splits;
        if (G.stats.time > 0) {
          G.card.time = G.stats.time;
          if (pb && pb[zone] !== undefined) G.card.delta = G.stats.time - pb[zone];
        }
        // 바로 아래 구역(숲 제외)을 한 번도 엎어지지 않고 지났다
        const prev = ZONE_ORDER[ZONE_ORDER.indexOf(zone) - 1];
        if (prev && prev !== 'forest' && !(G.stats.zoneFalls[prev] > 0)) unlock('zone');
      }
    }
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
        else if (G.view) { if (hit('Escape', ...CONFIRM)) G.view = null; }
        else if (G.sub) updateSub();
        else menuNav(titleItems());
        break;
      case 'intro': updateIntro(); break;
      case 'play': updatePlay(); break;
      case 'dialog': updateDialog(); break;
      case 'replay': updateReplay(); break;
      case 'pause':
        if (G.opt) updateSettings();
        else if (G.help) { if (hit('Escape', ...CONFIRM)) G.help = false; }
        else if (hit('Escape')) { G.state = 'play'; G.jumpLock = true; }
        else menuNav(pauseItems());
        break;
      case 'ending': updateEnding(); break;
      case 'credits':
        world.tick(null); world.events.length = 0;
        if (hit('KeyC', 'PadX')) saveResultCard();
        else if (G.t - G.creditsAt > 60 && hit(...CONFIRM, 'Escape')) toTitle();
        break;
    }
    if (G.state === 'play' || G.state === 'dialog' || G.state === 'pause') ambient(world.screenTop(G.screen), SCREENS[G.screen].zone);
    updateParticles();
    if (G.card && ++G.card.t > 260) G.card = null;
    if (G.quip && ++G.quip.t > QUIP_T) G.quip = null;
    if (G.toast && --G.toast.t <= 0) G.toast = null;
    if (G.achToast && G.state !== 'ending' && ++G.achToast.t > 240) G.achToast = null; // 엔딩 연출 중에는 기다렸다가 크레딧에서 보여 준다
    if (G.replayOffer && G.state === 'play' && ++G.replayOffer.t > 300) G.replayOffer = null;
    if (G.streamFlash > 0) G.streamFlash--;
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
    const lines = G.introLines, it = G.intro, len = lines[it.i].text.length;
    typeOn(it, len, 0.45);
    if (hit('Escape')) return newGame();
    if (hit(...CONFIRM)) {
      if (it.n < len) it.n = len;
      else if (++it.i >= lines.length) newGame();
      else it.n = 0;
    }
  }

  function updatePlay() {
    if (hit('Escape')) return openPause();
    if (G.replayOffer && hit('KeyR', 'PadX')) return startReplay();
    const p = G.p;
    if (G.jumpLock && !held('Space')) G.jumpLock = false;
    const input = { left: held('ArrowLeft') || held('KeyA'), right: held('ArrowRight') || held('KeyD'), jump: held('Space') && !G.jumpLock };
    hist.before(p, world);
    const wasGround = p.onGround;
    world.tick(p);
    handleWorldEvents();
    const sc = SCREENS[G.screen];
    if (sc.gust && sc.wind && world.t % CYCLE === 0) Sound.gust();
    step(p, input, world);
    const bits = Replay.toBits(input);
    hist.push(bits);
    if (recorder) recorder.push(bits);
    if (wasGround && !p.onGround) G.airStart = hist.n - 1;
    if (G.ghost) G.ghost.tick();
    if (official()) telScreen(G.screen).time++;
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
    if (G.pendingMemory >= 0 && p.onGround && p.splat === 0 && !p.charging) return openMemory(G.pendingMemory);
    interact();
    if (++G.saveTimer > 180) { G.saveTimer = 0; save(); }
  }

  function handleEvents(p) {
    for (const e of p.events) {
      if (e.type === 'jump') {
        G.stats.jumps++; Sound.jump(e.power); puff(p.x + 5, p.y + P.H, 3 + Math.round(e.power * 5));
        if (e.power >= 1) { G.shake = Math.max(G.shake, 4); flames(p.x + P.W / 2, p.y + P.H); }
        if (official()) { telScreen(G.screen).jumps++; progress.life.jumps++; }
      }
      else if (e.type === 'land') { Sound.land(e.fall); if (e.fall > 24) puff(p.x + 5, p.y + P.H, 2 + Math.min(6, Math.round(e.fall / 24))); }
      else if (e.type === 'splat') {
        G.stats.falls++; Sound.splat(); G.shake = 12; puff(p.x + 5, p.y + P.H, 12);
        const from = world.screenAt(p.y - e.fall + P.H / 2), zone = SCREENS[from].zone;
        G.stats.zoneFalls[zone] = (G.stats.zoneFalls[zone] || 0) + 1;
        if (official()) {
          telScreen(from).falls++;
          progress.life.falls++;
          // 엎어진 횟수가 정해진 수에 닿으면 할머니의 '떨어진 날의 기록'이 열린다 (일어선 뒤에 뜬다)
          const mi = FALL_MEMORIES.findIndex((m) => m.at === G.stats.falls);
          if (mi >= 0) G.pendingMemory = mi;
          if (G.stats.falls >= 100) unlock('hundred');
        }
      }
      else if (e.type === 'bump') {
        Sound.bump();
        G.shake = Math.max(G.shake, 3);
        // 부딪힌 자리: 천장이면 머리 위, 벽이면 튕긴 반대쪽 옆구리 (step이 이미 vx를 뒤집어 두었다)
        if (e.ceiling) bumpSparks(p.x + P.W / 2, p.y, 0);
        else bumpSparks(p.vx < 0 ? p.x + P.W : p.x, p.y + P.H / 2, p.vx < 0 ? -1 : 1);
      }
      // 4.5m(9칸) 넘게 떨어지면 잃은 높이를 띄우고 쌓는다
      if ((e.type === 'land' || e.type === 'splat') && e.fall >= 144) {
        const m = e.fall / 32;
        G.popups.push({ text: `−${m.toFixed(1)}m`, x: p.x + P.W / 2, y: p.y - 4, t: 0, big: e.type === 'splat' });
        if (m > G.stats.maxFall) G.stats.maxFall = m;
        G.stats.lost += m;
        G.streamFlash = 40;
        if (official()) progress.life.lost += m;
        if (m >= 50) unlock('bigfall');
        if (G.stats.lost >= 500) unlock('lost');
        if (e.fall >= VH) {
          const from = world.screenAt(p.y - e.fall + P.H / 2), to = world.screenAt(p.y + P.H / 2);
          if (official()) { const d = telCat().drops, k = `${from}>${to}`; d[k] = (d[k] || 0) + 1; }
          if (G.t - G.quipAt > QUIP_COOLDOWN) quip(SCREENS[from].zone, SCREENS[to].zone);
          // 큰 추락은 다시 볼 수 있다 (뛰기 1초 전부터 착지 직후까지)
          const begin = G.airStart - 60;
          if (hist.snapFor(begin)) G.replayOffer = { from: begin, to: hist.n, t: 0, m };
        }
      }
    }
    p.events.length = 0;
  }

  // 한 화면 넘게 떨어지면 루미나 코르가 한마디 한다 (너무 잦지 않게 30초에 한 번까지)
  const QUIP_T = 240, QUIP_COOLDOWN = 1800;
  // zone: 떨어지기 시작한 곳의 구역(그 구역 전용 줄이 섞인다). land: 내려앉은 구역 — 다른 구역까지 떨어졌으면 그곳 줄이 먼저 나온다.
  function quip(zone, land) {
    const metKor = Object.keys(G.read).some((k) => k[0] === 'N');
    const who = (l) => metKor || l.who !== '코르';
    let pool = land !== zone ? FALL_LINES.filter((l) => l.land === land && who(l)) : [];
    if (!pool.length) pool = FALL_LINES.filter((l) => !l.land && who(l) && (!l.zone || l.zone === zone));
    const line = pool[G.quipN++ % pool.length];
    G.quip = { line, t: 0 };
    G.quipAt = G.t;
    if (line.who === '코르') Sound.caw();
  }

  const touching = (p, o) => p.x < o.x + TILE + 3 && p.x + P.W > o.x - 3 && p.y < o.y + TILE + 3 && p.y + P.H > o.y - 3;
  const threadOf = (o) => THREADS.find((th) => th.zone === SCREENS[o.screen].zone) || THREADS[1];
  function burst(o, color, rgb) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, sp = 0.6 + Math.random() * 1.6;
      particle({ x: o.x + 8, y: o.y + 8, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 0.02, life: 40 + Math.random() * 30, color, rgb });
    }
  }
  function collectSparks() {
    const p = G.p;
    for (let s = Math.max(0, G.screen - 1); s <= Math.min(world.n - 1, G.screen + 1); s++) {
      for (const o of objsByScreen[s] || []) {
        if (o.ch === '*' && !G.collected[sparkKey(o)] && touching(p, o)) {
          G.collected[sparkKey(o)] = true;
          Sound.spark();
          burst(o, '#ffe9a0', '255,210,120');
          const n = Object.keys(G.collected).length;
          toast(n === TOTAL_SPARKS ? `불티를 모두 모았다 ✦ ${n} / ${TOTAL_SPARKS}` : `불티 ✦ ${n} / ${TOTAL_SPARKS}`);
        } else if (o.ch === 't' && official() && !G.run.dark && touching(p, o)) {
          // 랜턴 실: 한 번 찾으면 계속 갖는다 (보통 탑에서만 나온다)
          const th = threadOf(o);
          if (progress.threads[th.id]) continue;
          progress.threads[th.id] = true;
          saveProgress();
          Sound.spark();
          burst(o, th.color, th.light);
          toast(`랜턴 실을 찾았다 — ${th.name}  (기록 · 꾸미기에서 감기)`, 220);
          if (THREADS.every((x) => progress.threads[x.id])) unlock('threads');
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
      const sc = SCREENS[o.screen];
      if (o.ch === 'S' ? !sc.stone : !sc.crow) continue; // 커스텀 맵에는 글이 없는 돌·까마귀도 있다
      const near = p.onGround && !p.charging && p.splat === 0 && p.x + P.W > o.x - 6 && p.x < o.x + TILE + 6 && Math.abs(p.y + P.H - (o.y + TILE)) < 1;
      if (!near) continue;
      if (!G.read[o.ch + o.screen]) return openDialog(o);
      G.prompt = o;
      if (hit('ArrowUp', 'KeyW')) return openDialog(o);
    }
  }

  // 대화 상자에서는 플레이어 상태를 건드리지 않는다 (고스트 기록이 입력만으로 재현되도록)
  function openDialog(o) {
    const sc = SCREENS[o.screen];
    const lines = o.ch === 'S' ? sc.stone.lines.map((text) => ({ who: null, text })) : sc.crow;
    G.dialog = { obj: o, kind: o.ch, title: o.ch === 'S' ? sc.stone.title : null, lines, i: 0, n: 0 };
    G.read[o.ch + o.screen] = true;
    G.state = 'dialog';
    if (o.ch === 'S') Sound.stone(); else Sound.caw();
    save();
  }
  // 떨어진 날의 기록: 기억의 돌과 같은 창
  function openMemory(i) {
    const m = FALL_MEMORIES[i];
    G.pendingMemory = -1;
    G.dialog = { obj: null, kind: 'S', title: m.title, lines: m.lines.map((text) => ({ who: null, text })), i: 0, n: 0 };
    G.read['M' + i] = true;
    progress.memories[i] = true;
    saveProgress();
    if (FALL_MEMORIES.every((_, k) => progress.memories[k])) unlock('memories');
    G.state = 'dialog';
    Sound.stone();
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

  // ── 추락 다시 보기 ──
  // 최근 입력을 따로 된 월드에서 다시 재생한다. 그동안 실제 오르기는 멈춰 있다.
  // C(패드 X): 이 장면을 영상(webm)으로 저장 — 처음부터 다시 재생하며 녹화한다.
  const CAN_CLIP = typeof MediaRecorder !== 'undefined' && !!canvas.captureStream;
  function startReplay(clip) {
    const o = G.replayOffer;
    if (!o || !playback.start(hist, o.from, o.to)) { G.replayOffer = null; return; }
    G.state = 'replay';
    G.rp = { hold: 0, m: o.m, clip: null };
    if (clip && CAN_CLIP) {
      try {
        const chunks = [], rec = new MediaRecorder(canvas.captureStream(60), { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
        rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
        rec.onstop = () => download(new Blob(chunks, { type: 'video/webm' }), `last-ember-fall-${Math.round(o.m)}m.webm`);
        rec.start();
        G.rp.clip = rec;
      } catch (err) { toast('이 브라우저에서는 영상으로 저장할 수 없다'); }
    }
  }
  function endReplay() {
    if (G.rp && G.rp.clip) { G.rp.clip.stop(); toast('추락 장면을 영상으로 저장했다', 180); }
    G.state = 'play'; G.rp = null; G.jumpLock = true; G.replayOffer = null;
  }
  function updateReplay() {
    const r = G.rp;
    if (!r.clip && hit('KeyC', 'PadX') && CAN_CLIP) return startReplay(true);
    if (!r.clip && hit('Escape', ...CONFIRM)) return endReplay();
    const ev = playback.tick();
    if (ev) {
      for (const e of ev) {
        if (e.type === 'jump') Sound.jump(e.power);
        else if (e.type === 'land') Sound.land(e.fall);
        else if (e.type === 'splat') { Sound.splat(); G.shake = 12; }
      }
    } else if (++r.hold > 70) endReplay();
  }

  // ── 엔딩 ──
  const E_IGNITE = 150, E_LINE = 270;
  function startEnding(o) {
    G.state = 'ending';
    // 불티를 모두 모았으면 엔딩 대사가 늘고 등대 빛이 더 화려해진다
    const full = TOTAL_SPARKS > 0 && Object.keys(G.collected).length === TOTAL_SPARKS;
    const lines = G.run.custom ? [{ text: `「${G.run.custom.name}」 꼭대기에 닿았다.` }]
      : G.run.dark ? DARK_ENDING : ENDING.filter((l) => full || !l.sparks);
    G.ending = { t: 0, o, camY: world.screenTop(world.n - 1), lit: 0, idx: -1, full, lines };
    G.p.facing = o.x + 8 < G.p.x + P.W / 2 ? -1 : 1;
    G.prompt = null; G.card = null; G.replayOffer = null;
    Sound.ignite();
    Sound.music('ending');
    const st = G.stats, sparks = Object.keys(G.collected).length;
    if (G.run.custom) {
      const h = G.run.custom.hash, prev = progress.custom[h];
      G.ending.newTime = !prev || st.time < prev.time;
      if (G.ending.newTime) { progress.custom[h] = { name: G.run.custom.name, time: st.time }; saveProgress(); }
      return;
    }
    if (!official()) return;
    store.del(SAVE_KEY);
    store.del(REC_KEY);
    // 기록: 갈래마다 가장 빠른 시간(구간 기록과 고스트도 함께), 가장 적은 점프 수를 따로 갱신한다
    const c = cat(), b = best[c] || {};
    G.ending.newTime = !b.time || st.time < b.time;
    G.ending.newJumps = !b.jumps || st.jumps < b.jumps;
    G.ending.pbDelta = b.time ? st.time - b.time : null;
    best[c] = {
      time: G.ending.newTime ? st.time : b.time,
      jumps: G.ending.newJumps ? st.jumps : b.jumps,
      sparks: Math.max(b.sparks || 0, sparks),
      splits: G.ending.newTime ? st.splits : b.splits || {},
    };
    store.set(BEST_KEY, best);
    if (G.ending.newTime && recorder && !recorder.broken) store.set(GHOST_KEY + c, { time: st.time, rec: Replay.encode(recorder.segs) });
    // 업적
    if (G.ghost && !G.ghost.done) unlock('ghost');
    unlock('clear');
    if (full) unlock('sparks');
    if (G.run.mode === 'keeper') unlock('keeper');
    if (G.run.dark) unlock('dark');
    if (st.falls === 0) unlock('nofall');
    if (st.time < 30 * 60 * 60) unlock('fast');
    progress.cleared[c] = true;
    progress.life.clears++;
    saveProgress();
    const tc = telCat();
    tc.clears++;
    tc.clearTimes.push(st.time);
    saveTelemetry();
  }
  function updateEnding() {
    const e = G.ending, top = world.screenTop(world.n - 1), last = e.lines.length - 1;
    e.t++;
    world.tick(null); world.events.length = 0;
    if (!G.p.onGround || G.p.vx) { step(G.p, {}, world); G.p.events.length = 0; }
    e.lit = Math.max(0, Math.min(1, (e.t - 20) / 90));
    // 불이 붙는 순간 터지는 불꽃 (불티를 다 모았으면 세 번에 걸쳐 더 크게)
    if (e.t === 40 || (e.full && (e.t === 70 || e.t === 100))) {
      const n = e.full ? 90 : 60, boost = e.full ? 1.4 : 1;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = (0.5 + Math.random() * 2.5) * boost;
        particle({ x: e.o.x + 8, y: e.o.y - 6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1, g: 0.02, life: 60 + Math.random() * 60, color: i % 4 ? '#ffd98a' : '#fff2c0', rgb: '255,200,110' });
      }
    }
    if (e.t < E_IGNITE) { if (e.t > 40 && hit(...CONFIRM)) e.t = E_IGNITE; }
    else {
      const idx = Math.floor((e.t - E_IGNITE) / E_LINE);
      if (hit(...CONFIRM)) e.t = E_IGNITE + (idx + 1) * E_LINE;
      const now = Math.floor((e.t - E_IGNITE) / E_LINE);
      if (now === last && e.idx !== now) G.fade = 1;
      e.idx = now;
      if (now > last) {
        G.state = 'credits'; G.creditsAt = G.t; G.fade = 1; G.particles.length = 0;
        if (e.newTime || e.newJumps) Sound.record();
        return;
      }
    }
    // 카메라: 불이 붙은 뒤 탑 아래로 내려가며 빛이 번지는 모습을 보여 주고, 마지막 줄에서 다시 꼭대기로
    const prog = Math.max(0, Math.min(1, (e.t - E_IGNITE - E_LINE * 1.3) / (E_LINE * 3)));
    const ease = prog < 0.5 ? 2 * prog * prog : 1 - Math.pow(-2 * prog + 2, 2) / 2;
    e.camY = e.idx >= last ? top : top + ease * (world.screenTop(0) - top);
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
  // 최대 차지로 뛸 때 발밑으로 뿜어지는 불꽃
  function flames(x, y) {
    const cols = ['#ffd36b', '#ff9a4a', '#ff6a3a'];
    for (let i = 0; i < 14; i++) {
      particle({ x: x + (Math.random() - 0.5) * 6, y: y - 1, vx: (Math.random() - 0.5) * 1.6, vy: 0.6 + Math.random() * 1.4, g: -0.02, life: 14 + Math.random() * 12, color: cols[i % 3], rgb: '255,150,70', size: Math.random() < 0.3 ? 2 : 1 });
    }
  }
  // 공중에서 벽·천장에 부딪힌 자리의 작은 불똥 (dir: 튕겨 나가는 방향, 0이면 천장)
  function bumpSparks(x, y, dir) {
    for (let i = 0; i < 6; i++) {
      const vx = dir ? dir * (0.4 + Math.random() * 1.2) : (Math.random() - 0.5) * 2;
      const vy = dir ? (Math.random() - 0.7) * 1.4 : 0.3 + Math.random() * 0.8;
      particle({ x, y: y + (dir ? (Math.random() - 0.5) * 6 : 0), vx, vy, g: 0.08, life: 10 + Math.random() * 8, color: i % 2 ? '#fff2c0' : '#ffd36b', rgb: i % 3 ? null : '255,220,150' });
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
        } else if (o.ch === 't') {
          // 랜턴 실: 보통 탑의 기본 오르기에서만, 아직 찾지 못한 것만 보인다
          if (!official() || G.run.dark || !G.p) continue;
          const th = threadOf(o);
          if (progress.threads[th.id]) continue;
          Art.drawThread(v, x, y, G.t, th.color);
          lights.push({ x: x + 8, y: y + 8, r: 24, glow: 0.3, rgb: th.light });
        } else if (o.ch === 'f') Art.drawFlag(v, x, y, G.t, SCREENS[s].wind, SCREENS[s].gust ? gustFactor(world.t) * (world.dark ? Physics.DARK_WIND : 1) : 1);
        else if (o.ch === 'G') {
          Art.drawBeacon(v, x, y, G.t, lit > 0);
          const full = lit > 0 && G.ending && G.ending.full;
          lights.push(lit > 0
            ? { x: x + 8, y: y - 6, r: 90 + (full ? 460 : 380) * lit, glow: (full ? 0.75 : 0.55) * Math.min(1, lit * 2), rgb: '255,200,110' }
            : { x: x + 8, y: y - 6, r: 26, glow: 0.08, rgb: '150,170,230' });
          // 불티를 모두 모았으면 다섯 알이 등대 둘레를 돈다
          if (full) {
            for (let k = 0; k < TOTAL_SPARKS; k++) {
              const a = G.t * 0.02 + (k / TOTAL_SPARKS) * Math.PI * 2, rr = 26 * lit;
              const sx = x + 8 + Math.cos(a) * rr, sy = y - 6 + Math.sin(a) * rr * 0.45;
              Art.drawSpark(v, Math.round(sx - 8), Math.round(sy - 8), G.t + k * 13);
              lights.push({ x: sx, y: sy, r: 20, glow: 0.3 * lit, rgb: '255,210,120' });
            }
          }
        }
      }
    }
    if (G.ghost && !G.ghost.done && (G.state === 'play' || G.state === 'dialog' || G.state === 'pause')) drawGhost(camY);
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
    // 최대 차지 직전(곧 저절로 뛴다): 떨림을 키우고 랜턴을 맥박치듯 밝힌다
    const full = ch >= 0.85;
    const tremble = full ? (G.t % 2 ? 1 : -1) : ch > 0.7 && G.t % 4 < 2 ? 1 : 0;
    v.drawImage(Art.lumi[f][left ? 1 : 0], px - 4 + tremble, py - 3);

    let lx = left ? p.x + 1 : p.x + 9, ly = p.y + 9 - camY;
    if (f === 'crouch') ly += 3;
    if (f === 'splat') { lx = left ? p.x - 1 : p.x + 11; ly = p.y + 12 - camY; }
    const flick = Math.sin(G.t * 0.23) * 2 + Math.sin(G.t * 0.07) * 2;
    // 불티를 하나 모을 때마다 랜턴이 비추는 거리가 4px씩 넓어진다
    const sparkR = Object.keys(G.collected).length * 4;
    const pulse = full ? 6 + Math.sin(G.t * 0.8) * 4 : 0;
    // 꺼진 탑에서는 랜턴 불빛이 덜 멀리 닿는다. 감은 랜턴 실에 따라 불빛 색이 달라진다.
    const th = THREADS.find((x) => x.id === progress.thread) || THREADS[0];
    const baseR = world.dark ? 54 : 72;
    lights.push({ x: lx, y: ly, r: baseR + sparkR + ch * 30 + flick + pulse, glow: 0.2 + ch * 0.25 + (full ? 0.2 : 0), rgb: th.light });
    // 손잡이에 감긴 실 (두 픽셀)
    v.fillStyle = th.color;
    v.fillRect(Math.round(lx) - 1, Math.round(ly) - 4, 2, 1);

    if (p.charging) {
      const gx = px - 2, gy = py - 7 + 3;
      v.fillStyle = 'rgba(20,14,30,.85)'; v.fillRect(gx - 1, gy - 1, 16, 4);
      v.fillStyle = full ? (G.t % 4 < 2 ? '#fff2c0' : '#ff9a4a') : ch > 0.7 ? '#ff9a4a' : '#ffd36b';
      v.fillRect(gx, gy, Math.max(1, Math.round(14 * ch)), 2);
    }
    if (p.splat > 0) {
      for (let i = 0; i < 2; i++) {
        const a = G.t * 0.15 + i * Math.PI;
        v.fillStyle = '#ffe07a'; v.fillRect(Math.round(p.x + 5 + Math.cos(a) * 6), Math.round(py + 7 + Math.sin(a) * 2), 1, 1);
      }
    }
  }

  // 고스트: 같은 갈래의 최고 기록. 반투명한 푸른 그림자로 그린다.
  function drawGhost(camY) {
    const gp = G.ghost.p, y = gp.y - camY;
    if (y < -20 || y > VH + 4) return;
    let f = gp.splat > 0 ? 'splat' : !gp.onGround ? (gp.vy < 0 ? 'jump' : 'fall') : gp.charging ? 'crouch' : 'idle0';
    v.globalAlpha = 0.32;
    v.drawImage(Art.lumi[f][gp.facing < 0 ? 1 : 0], Math.round(gp.x) - 4, Math.round(y) - 3);
    v.globalAlpha = 1;
    v.globalCompositeOperation = 'lighter';
    Art.glow(v, gp.x + 5, y + 7, 12, '120,170,255', 0.18);
    v.globalCompositeOperation = 'source-over';
  }

  function drawLighting(zone, lit, lights) {
    const dark = Math.min(0.85, ZONES[zone].dark * (world.dark ? 1.4 : 1)) * (1 - lit);
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
      ['다시 보기', '크게 떨어진 뒤 위에 뜨는 글자를 누르기'],
      ['❚❚', '일시정지 · 설정'],
      ['화면 누르기', '대화 넘기기 · 메뉴 고르기'],
      ['✦', `불티 — 닿으면 모인다 (모두 ${TOTAL_SPARKS}개)`],
    ] : [
      ['← →  /  A D', '걷기 · 뛸 방향 고르기 · 공중에서 움직이기'],
      ['스페이스', '누르고 있다가 떼면 점프 (오래 누를수록 높이)'],
      ['↑  /  W', '기억의 돌 다시 읽기 · 까마귀와 대화'],
      ['R', '크게 떨어진 뒤 그 장면 다시 보기 (C: 영상 저장)'],
      ['Esc', '일시정지 · 설정'],
      ['M  ·  F', '소리 켜고 끄기 · 전체 화면'],
      ['게임패드', '스틱·십자키 이동 · A 점프 · Y 다시 읽기 · X 다시 보기'],
      ['✦', `불티 — 닿으면 모인다 (모두 ${TOTAL_SPARKS}개)`],
    ];
    rows.forEach(([k, d], i) => {
      txt(k, 112, 82 + i * 16, 8.5, '#ffcf70', { weight: 700 });
      txt(d, 192, 82 + i * 16, 8.5, '#e8e2f4');
    });
    const keeper = G.p && G.run.mode === 'keeper';
    txt(keeper ? '등불지기 모드: 뛰는 순간 궤적이 정해진다. 벽에 부딪히면 튕겨 나온다.' : '뛰어오른 뒤에도 ← →로 몸을 틀 수 있다. 벽에 부딪히면 튕겨 나온다.', VW / 2, 222, 8, '#b9b2d6', { align: 'center' });
    txt(touchMode ? '눌러서 닫기' : 'Enter / Esc 닫기', VW / 2, 242, 7, '#7d7698', { align: 'center' });
  }

  function drawSettings() {
    ctx.fillStyle = 'rgba(4,3,12,.7)'; ctx.fillRect(0, 0, VW, VH);
    panel(96, 44, 320, 200, 0.96);
    txt('설정', VW / 2, 70, 12, '#ffe7b5', { align: 'center', weight: 800 });
    settingsItems().forEach((it, i) => {
      const y = SET_ROW[0] + i * SET_ROW[1], sel = i === G.opt.i;
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
    txt(touchMode ? '항목을 눌러 고르기   ·   막대의 왼쪽·오른쪽을 눌러 조절   ·   바깥을 누르면 닫기' : '↑ ↓ 고르기   ·   ← → 조절   ·   Esc 닫기', VW / 2, 236, 7, '#7d7698', { align: 'center' });
  }

  function drawSub() {
    ctx.fillStyle = 'rgba(4,3,12,.7)'; ctx.fillRect(0, 0, VW, VH);
    panel(96, 40, 320, 208, 0.96);
    txt(SUB_TITLE[G.sub.id], VW / 2, 66, 12, '#ffe7b5', { align: 'center', weight: 800 });
    subItems().forEach((it, i) => {
      const y = SUB_ROW[0] + i * SUB_ROW[1], sel = i === G.sub.i;
      if (it.kind === 'info') { txt(it.label, VW / 2, y, 6.8, '#9d96bb', { align: 'center' }); return; }
      if (sel) { ctx.fillStyle = 'rgba(255,190,90,.12)'; ctx.fillRect(108, y - 10, 296, 15); txt('◆', 114, y, 6, '#ffcf70'); }
      txt(it.label, 126, y, 8.5, sel ? '#fff1d6' : '#b9b2d6', { weight: sel ? 700 : 500 });
      if (it.kind === 'pick') {
        txt(it.value, 390, y, 8, sel ? '#ffe7b5' : '#c9a76a', { align: 'right', weight: 700 });
        if (sel) {
          ctx.font = `700 8px ${FONT}`;
          txt('◀', 386 - ctx.measureText(it.value).width, y, 6.5, '#ffcf70', { align: 'right' });
          txt('▶', 394, y, 6.5, '#ffcf70');
        }
      }
    });
    txt(touchMode ? '항목을 눌러 고르기   ·   값은 왼쪽·오른쪽을 눌러 바꾸기   ·   바깥을 누르면 닫기' : '↑ ↓ 고르기   ·   ← → 바꾸기   ·   Enter 선택   ·   Esc 뒤로', VW / 2, 240, 7, '#7d7698', { align: 'center' });
  }

  // 업적과 갈래별 최고 기록, 평생 통계
  function drawAchView() {
    ctx.fillStyle = 'rgba(4,3,12,.75)'; ctx.fillRect(0, 0, VW, VH);
    panel(30, 14, 452, 262, 0.97);
    const got = ACHIEVEMENTS.filter((a) => progress.ach[a.id]).length;
    txt(`업적  ${got} / ${ACHIEVEMENTS.length}`, VW / 2, 34, 11, '#ffe7b5', { align: 'center', weight: 800 });
    ACHIEVEMENTS.forEach((a, i) => {
      const col = i < 7 ? 0 : 1, row = i < 7 ? i : i - 7, x = 46 + col * 222, y = 54 + row * 21, on = !!progress.ach[a.id];
      txt(on ? '◆' : '◇', x, y, 7, on ? '#ffcf70' : '#5d5778');
      txt(a.name, x + 11, y, 8, on ? '#fff1d6' : '#8f88ad', { weight: 700 });
      txt(a.desc, x + 11, y + 9, 6.3, on ? '#c6bfe0' : '#6d6788');
    });
    const recs = Object.keys(CAT_NAME).filter((c) => best[c] && best[c].time).map((c) => `${CAT_NAME[c]} ${fmtTime(best[c].time)}`);
    txt(recs.length ? '최고 기록   ' + recs.join('   ·   ') : '아직 올라 본 기록이 없다', VW / 2, 222, 7, '#c9a76a', { align: 'center' });
    const L = progress.life;
    txt(`지금까지  올라간 횟수 ${L.clears}번   ·   엎어짐 ${L.falls}번   ·   잃은 높이 ${Math.round(L.lost)}m   ·   점프 ${L.jumps}번`, VW / 2, 238, 7, '#9d96bb', { align: 'center' });
    const mem = FALL_MEMORIES.filter((_, k) => progress.memories[k]).length, th = THREADS.filter((x) => progress.threads[x.id]).length;
    txt(`떨어진 날의 기록 ${mem} / ${FALL_MEMORIES.length}   ·   랜턴 실 ${th} / ${THREADS.length}`, VW / 2, 252, 7, '#9d96bb', { align: 'center' });
    txt(touchMode ? '눌러서 닫기' : 'Enter / Esc 닫기', VW / 2, 268, 6.5, '#7d7698', { align: 'center' });
  }

  const ZONE_RGB = { forest: '120,200,110', ramparts: '170,150,220', frost: '130,210,240', gale: '220,200,150', summit: '255,210,120' };
  function runTag() {
    if (G.run.practice) return '연습';
    if (G.run.custom) return `커스텀 · ${G.run.custom.name}`;
    return [G.run.dark ? '꺼진 탑' : null, G.run.mode === 'keeper' ? '등불지기' : null].filter(Boolean).join(' · ');
  }
  function drawHUD() {
    const st = G.stats, p = G.p, n = Object.keys(G.collected).length;
    rrect(8, 8, 126, 30, 4); ctx.fillStyle = 'rgba(12,9,26,.55)'; ctx.fill();
    txt(`점프 ${st.jumps}`, 16, 20, 8, '#fff1d6', { weight: 700 });
    txt(`추락 ${st.falls}`, 72, 20, 8, '#f0b8aa', { weight: 700 });
    txt(fmtTime(st.time), 16, 32, 7, '#b9b2d6');
    txt(`✦ ${n} / ${TOTAL_SPARKS}`, 72, 32, 7, '#ffd98a', { weight: 600 });
    const tag = runTag();
    if (tag) txt(tag, 140, 20, 6.5, '#9be8e0', { weight: 700 });
    // 오른쪽 가장자리의 높이 막대: 구역 색 띠, 최고 높이(금색 눈금), 지금 높이(점), 고스트(푸른 점)
    const x = VW - 10, y0 = 26, y1 = VH - 22, len = y1 - y0;
    const pos = (m) => y1 - Math.min(1, m / SUMMIT_M) * len;
    for (let s = 0; s < world.n; s++) {
      const a = pos(heightM(world.screenTop(s))), b = pos(heightM(world.screenTop(s) + VH));
      ctx.fillStyle = `rgba(${ZONE_RGB[SCREENS[s].zone]},.4)`; ctx.fillRect(x - 1, a, 3, Math.max(0, b - a - 0.6));
    }
    txt('정상', x + 0.5, y0 - 5, 6, '#ffcf70', { align: 'center', weight: 700 });
    const bp = pos(st.maxH);
    ctx.fillStyle = '#ffcf70'; ctx.fillRect(x - 4, bp - 0.5, 9, 1);
    if (G.ghost && !G.ghost.done) {
      const gp = pos(heightM(G.ghost.p.y + P.H));
      ctx.beginPath(); ctx.arc(x + 0.5, gp, 2, 0, Math.PI * 2); ctx.fillStyle = 'rgba(130,180,255,.85)'; ctx.fill();
    }
    const h = heightM(p.y + P.H), cp = pos(h);
    ctx.beginPath(); ctx.arc(x + 0.5, cp, 2.6, 0, Math.PI * 2); ctx.fillStyle = '#fff1d6'; ctx.fill();
    txt(`${Math.floor(h)}m`, x - 6, cp + 2.5, 7, '#fff1d6', { align: 'right', weight: 700 });
  }
  // 방송용 추락 카운터: 크게, 떨어질 때마다 붉게 번쩍인다
  function drawStream() {
    const st = G.stats, f = G.streamFlash / 40, y = settings.hud ? 44 : 8;
    rrect(8, y, 150, 34, 4); ctx.fillStyle = `rgba(${Math.round(12 + 90 * f)},9,${Math.round(26 - 10 * f)},.72)`; ctx.fill();
    ctx.lineWidth = 0.8; ctx.strokeStyle = `rgba(255,140,110,${(0.35 + 0.6 * f).toFixed(2)})`; ctx.stroke();
    txt(`추락 ${st.falls}`, 16, y + 16, 13, '#ffb59a', { weight: 800 });
    txt(`잃은 높이 ${Math.round(st.lost)}m`, 150, y + 14, 7, '#f3ead8', { align: 'right', weight: 700 });
    txt(`가장 긴 추락 ${(st.maxFall || 0).toFixed(1)}m`, 16, y + 28, 7, '#c6bfe0');
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

  const fmtDelta = (d) => `${d < 0 ? '−' : '+'}${fmtTime(Math.abs(d))}`;
  function drawPlayUI(camY) {
    if (settings.hud) drawHUD();
    if (settings.stream) drawStream();
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
      // 구간 기록: 이 구역에 들어선 시각과 최고 기록과의 차이
      if (c.time !== undefined) {
        const s = fmtTime(c.time) + (c.delta !== undefined ? `   ${fmtDelta(c.delta)}` : '');
        txt(s, VW / 2, 114, 7.5, c.delta === undefined ? '#b9b2d6' : c.delta <= 0 ? '#9be8a0' : '#ff9a8a', { align: 'center', weight: 700, alpha: a });
      }
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
    // 큰 추락 뒤: 다시 보기 안내 (위 가운데)
    if (G.replayOffer && G.state === 'play') {
      const r = G.replayOffer, a = Math.min(1, r.t / 15, (300 - r.t) / 30);
      const label = `${touchMode ? '눌러서' : 'R'}  다시 보기   −${r.m.toFixed(1)}m`;
      ctx.font = `700 7.5px ${FONT}`;
      const w = ctx.measureText(label).width + 14, bx = VW / 2 - w / 2, by = touchMode ? 40 : 30;
      r.box = { x: bx, y: by, w, h: 13 };
      rrect(bx, by, w, 13, 4); ctx.fillStyle = `rgba(12,9,26,${(0.85 * a).toFixed(3)})`; ctx.fill();
      ctx.lineWidth = 0.6; ctx.strokeStyle = `rgba(233,196,106,${(0.8 * a).toFixed(3)})`; ctx.stroke();
      txt(label, VW / 2, by + 9.5, 7.5, '#ffe7b5', { align: 'center', weight: 700, alpha: a, shadow: false });
    }
    if (G.state === 'dialog') drawDialogBox();
    if (G.state === 'pause') {
      ctx.fillStyle = 'rgba(4,3,12,.6)'; ctx.fillRect(0, 0, VW, VH);
      panel(156, 54, 200, 178, 0.94);
      txt('일시정지', VW / 2, 82, 13, '#ffe7b5', { align: 'center', weight: 800 });
      drawMenu(pauseItems(), ...PAUSE_MENU);
      const st = G.stats;
      txt(`${fmtTime(st.time)}   ·   점프 ${st.jumps}   ·   추락 ${st.falls}   ·   잃은 높이 ${Math.round(st.lost)}m`, VW / 2, 206, 7, '#8f88ad', { align: 'center' });
      txt(`최고 높이 ${Math.floor(st.maxH)}m / ${Math.floor(SUMMIT_M)}m   ·   불티 ${Object.keys(G.collected).length} / ${TOTAL_SPARKS}${runTag() ? '   ·   ' + runTag() : ''}`, VW / 2, 219, 7, '#8f88ad', { align: 'center' });
      if (G.help) drawHelp();
      if (G.opt) drawSettings();
    }
    drawAchToast();
  }
  function drawAchToast(y = VH - 44) {
    if (!G.achToast) return;
    const t = G.achToast.t, a = Math.min(1, t / 20, (240 - t) / 30), A = G.achToast.a;
    const label = `업적  ◆  ${A.name}`;
    ctx.font = `700 8.5px ${FONT}`;
    const w = Math.max(ctx.measureText(label).width, ctx.measureText(A.desc).width * 0.85) + 24;
    rrect(VW / 2 - w / 2, y - 12, w, 26, 4); ctx.fillStyle = `rgba(30,20,10,${(0.88 * a).toFixed(3)})`; ctx.fill();
    ctx.lineWidth = 0.7; ctx.strokeStyle = `rgba(255,207,112,${(0.9 * a).toFixed(3)})`; ctx.stroke();
    txt(label, VW / 2, y, 8.5, '#ffe7b5', { align: 'center', weight: 800, alpha: a });
    txt(A.desc, VW / 2, y + 10, 7, '#e8dcc0', { align: 'center', alpha: a });
  }
  // 추락 다시 보기: 위아래 띠와 안내. 녹화 중에는 안내 대신 제목을 넣는다.
  function drawReplayUI() {
    const r = G.rp;
    ctx.fillStyle = 'rgba(0,0,0,.82)'; ctx.fillRect(0, 0, VW, 18); ctx.fillRect(0, VH - 22, VW, 22);
    txt(r.clip ? '마지막 불씨' : '▶ 다시 보기', 12, 12.5, 8, '#ffe7b5', { weight: 800 });
    txt(`−${r.m.toFixed(1)}m`, VW - 12, 12.5, 8, '#ff9a7a', { align: 'right', weight: 800 });
    if (r.clip) txt('● 녹화 중', VW / 2, VH - 8, 7.5, '#ff7a6a', { align: 'center', weight: 700 });
    else {
      txt(touchMode ? '눌러서 닫기' : 'Enter / Esc 닫기', 12, VH - 8, 7, '#b9b2d6');
      if (CAN_CLIP) txt(touchMode ? '여기를 눌러 영상으로 저장' : 'C  영상으로 저장', VW - 12, VH - 8, 7, '#ffcf70', { align: 'right', weight: 700 });
    }
  }

  function drawTitleUI() {
    const a = Math.min(1, G.t / 60);
    txt('마지막 불씨', VW / 2, 108, 32, '#ffe7b5', { align: 'center', weight: 800, glow: 'rgba(255,160,70,.85)', blur: 14, alpha: a });
    txt('T H E    L A S T    E M B E R', VW / 2, 124, 7, '#c9a76a', { align: 'center', weight: 600, alpha: a });
    drawMenu(titleItems(), ...TITLE_MENU);
    const recs = Object.keys(CAT_NAME).filter((c) => best[c] && best[c].time);
    recs.forEach((c, i) => {
      const b = best[c], parts = [`${CAT_NAME[c]}  ${fmtTime(b.time)}`];
      if (b.jumps) parts.push(`점프 ${b.jumps}번`);
      if (b.sparks) parts.push(`불티 ${b.sparks} / ${TOTAL_SPARKS}`);
      txt(parts.join('  ·  '), VW - 12, 16 + i * 10, 6.5, '#c9a76a', { align: 'right' });
    });
    txt(touchMode ? '◀ ▶ 이동   ·   점프 버튼을 길게 눌렀다 떼기: 점프   ·   메뉴는 눌러서 고르기' : '← → 이동   ·   스페이스(패드 A) 길게 눌렀다 떼기: 점프   ·   M 소리   ·   F 전체 화면', VW / 2, 278, 6.5, '#8f88ad', { align: 'center' });
    if (G.sub) drawSub();
    if (G.view) drawAchView();
    if (G.help) drawHelp();
    if (G.opt) drawSettings();
  }

  function drawIntroUI() {
    const it = G.intro, slide = G.introLines[it.i];
    const g = ctx.createLinearGradient(0, 180, 0, VH);
    g.addColorStop(0, 'rgba(4,3,14,0)'); g.addColorStop(0.35, 'rgba(4,3,14,.82)'); g.addColorStop(1, 'rgba(4,3,14,.92)');
    ctx.fillStyle = g; ctx.fillRect(0, 180, VW, VH - 180);
    typed(wrap(slide.text, 400, 11), it.n, VW / 2, 228, 17, 11, '#f3ead8', true);
    txt(`${it.i + 1} / ${G.introLines.length}`, 14, 278, 6.5, '#7d7698');
    txt(touchMode ? '눌러서 넘기기     건너뛰기 ▶▶' : '스페이스 ▶     Esc 건너뛰기', VW - 14, 278, 6.5, '#7d7698', { align: 'right' });
  }

  function drawEndingUI() {
    const e = G.ending;
    if (e.t < E_IGNITE) return;
    const idx = Math.floor((e.t - E_IGNITE) / E_LINE), local = (e.t - E_IGNITE) % E_LINE;
    const line = e.lines[idx];
    if (!line) return;
    const a = Math.min(1, local / 30) * Math.min(1, (E_LINE - local) / 30);
    const g = ctx.createLinearGradient(0, 200, 0, VH);
    g.addColorStop(0, 'rgba(4,3,14,0)'); g.addColorStop(1, 'rgba(4,3,14,.75)');
    ctx.fillStyle = g; ctx.fillRect(0, 200, VW, VH - 200);
    const lines = wrap(line.text, 400, 11);
    if (line.who) txt(line.who, VW / 2, 226, 8, '#e9c46a', { align: 'center', weight: 700, alpha: a });
    lines.forEach((ln, i) => txt(ln, VW / 2, (line.who ? 244 : 238) + i * 17, 11, '#fff3dc', { align: 'center', alpha: a, glow: 'rgba(0,0,0,.9)', blur: 6 }));
  }

  function creditRows() {
    const st = G.stats, e = G.ending || {}, read = Object.keys(G.read).filter((k) => k[0] === 'S').length;
    const mem = Object.keys(G.read).filter((k) => k[0] === 'M').length;
    const rows = [
      ['오른 시간', fmtTime(st.time), e.newTime ? '신기록!' : e.pbDelta ? fmtDelta(e.pbDelta) : ''],
      ['점프', `${st.jumps}번`, e.newJumps ? '신기록!' : ''],
      ['추락', `${st.falls}번`],
      ['잃은 높이', `${Math.round(st.lost)}m`],
      ['가장 긴 추락', `${(st.maxFall || 0).toFixed(1)}m`],
      ['모은 불티', `${Object.keys(G.collected).length} / ${TOTAL_SPARKS}`],
    ];
    if (TOTAL_STONES) rows.push(['읽은 기록', `${read} / ${TOTAL_STONES}${mem ? `  · 떨어진 날 ${mem}` : ''}`]);
    return rows;
  }
  function drawCreditsUI() {
    ctx.fillStyle = 'rgba(5,4,18,.62)'; ctx.fillRect(0, 0, VW, VH);
    const sparks = Object.keys(G.collected).length;
    txt('마지막 불씨', VW / 2, 58, 24, '#ffe7b5', { align: 'center', weight: 800, glow: 'rgba(255,160,70,.85)', blur: 12 });
    txt(`— 끝 —${runTag() ? '   ' + runTag() : ''}`, VW / 2, 76, 8, '#c9a76a', { align: 'center' });
    creditRows().forEach(([k, val, note], i) => {
      const y = 100 + i * 15;
      txt(k, VW / 2 - 10, y, 9, '#b9b2d6', { align: 'right' });
      txt(val, VW / 2 + 10, y, 9, '#fff1d6', { weight: 700 });
      if (note) {
        ctx.font = `700 9px ${FONT}`;
        const rec = note === '신기록!';
        txt(note, VW / 2 + 18 + ctx.measureText(val).width, y, 8, rec ? '#ffcf70' : note[0] === '−' ? '#9be8a0' : '#ff9a8a', { weight: 800, glow: rec ? 'rgba(255,170,80,.7)' : undefined, blur: 6 });
      }
    });
    if (TOTAL_SPARKS && sparks === TOTAL_SPARKS) txt('✦ 흩어진 불티를 모두 모았다 ✦', VW / 2, 222, 8.5, '#ffd98a', { align: 'center', weight: 700, glow: 'rgba(255,170,80,.6)', blur: 6 });
    if (G.t - G.creditsAt > 60 && Math.floor(G.t / 30) % 2) txt(touchMode ? '눌러서 타이틀로' : 'Enter — 타이틀로', VW / 2, 242, 8, '#e9c46a', { align: 'center' });
    txt(touchMode ? '여기를 눌러 결과 카드(이미지) 저장' : 'C (패드 X) — 결과 카드(이미지) 저장', VW / 2, 264, 7, '#9d96bb', { align: 'center' });
  }

  // ───────────────────────── 파일 꺼내기 · 불러오기 ─────────────────────────
  function download(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const today = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  // 플레이테스트 통계: 기기 안에 쌓인 화면별 시간·점프·추락, 큰 추락의 출발→착지, 그만둔 화면, 클리어 시간
  function exportTelemetry() {
    saveTelemetry();
    const data = Object.assign({ exported: new Date().toISOString(), screens: TOWER.map((s, i) => ({ i, zone: s.zone })) }, telemetry);
    download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `last-ember-telemetry-${today()}.json`);
    toast('통계를 파일로 내보냈다');
  }
  // 결과 카드: 1200×630 이미지 (공유용)
  function saveResultCard() {
    const W = 1200, H = 630, cv = Art.makeCanvas(W, H), c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0d0a24'); g.addColorStop(1, '#2a1830');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.imageSmoothingEnabled = false;
    c.drawImage(view, W - 560, 70, 512, 288);
    c.strokeStyle = 'rgba(201,154,60,.8)'; c.lineWidth = 3; c.strokeRect(W - 560, 70, 512, 288);
    const t = (s, x, y, size, color, weight = 600, align = 'left') => { c.font = `${weight} ${size}px ${FONT}`; c.fillStyle = color; c.textAlign = align; c.fillText(s, x, y); };
    t('마지막 불씨', 64, 120, 64, '#ffe7b5', 800);
    t('THE LAST EMBER', 68, 156, 20, '#c9a76a', 600);
    t(runTag() || '이야기 모드', 68, 196, 24, '#9be8e0', 700);
    creditRows().forEach(([k, val, note], i) => {
      t(k, 68, 260 + i * 44, 26, '#b9b2d6', 500);
      t(val + (note ? `  ${note}` : ''), 300, 260 + i * 44, 30, note === '신기록!' ? '#ffcf70' : '#fff1d6', 800);
    });
    t(today(), W - 48, H - 40, 20, '#7d7698', 500, 'right');
    cv.toBlob((blob) => { if (blob) { download(blob, `last-ember-${today()}.png`); toast('결과 카드를 저장했다'); } }, 'image/png');
  }
  // 커스텀 맵: { name, author, screens: [...], verified?: { hash, modes } } (만드는 법은 README)
  function pickMapFile() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = () => { if (inp.files[0]) readMapFile(inp.files[0]); };
    inp.click();
  }
  function readMapFile(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const m = JSON.parse(fr.result);
        if (!m || !Array.isArray(m.screens) || !m.screens.length) throw new Error('screens 배열이 없다');
        m.screens.forEach((s, i) => { if (!ZONES[s.zone]) throw new Error(`화면 ${i}: zone은 ${ZONE_ORDER.join(', ')} 중 하나`); });
        const w = new World(m.screens); // 줄 수·칸 수가 틀리면 여기서 알려 준다
        if (!w.objects.some((o) => o.ch === 'P')) throw new Error('시작 위치(P)가 없다');
        if (!w.objects.some((o) => o.ch === 'G')) throw new Error('별등대(G)가 없다');
        const hash = mapHash(m.screens), vf = m.verified && m.verified.hash === hash ? m.verified : null;
        const names = { story: '이야기', keeper: '등불지기' };
        G.customMap = { name: String(m.name || file.name.replace(/\.json$/i, '')).slice(0, 24), author: String(m.author || '').slice(0, 16), screens: m.screens, hash, verified: vf ? vf.modes.map((x) => names[x] || x).join('·') : null };
        if (G.state === 'title') openSub('custom');
        toast(`맵을 불러왔다 — ${G.customMap.name}`);
      } catch (err) {
        toast(`맵을 열 수 없다: ${err.message}`, 240);
      }
    };
    fr.readAsText(file);
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
      case 'intro': { const sl = G.introLines[G.intro.i]; Art.drawTitleScene(v, G.t, { beacon: sl.beacon, lumi: sl.lumi, lantern: sl.lantern }); break; }
      case 'ending': drawWorld(G.ending.camY, G.ending.lit); break;
      case 'replay': {
        // 다시 보기: 재생용 월드와 플레이어로 잠깐 바꿔 그린다 (카메라는 재생 중인 루미를 따라간다)
        const liveW = world, liveP = G.p;
        world = playback.world; G.p = playback.p;
        drawWorld(world.screenTop(world.screenAt(G.p.y + P.H / 2)), 0);
        world = liveW; G.p = liveP;
        break;
      }
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
      case 'credits': drawCreditsUI(); drawAchToast(24); break;
      case 'replay': drawReplayUI(); break;
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

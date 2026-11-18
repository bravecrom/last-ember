#!/usr/bin/env node
/*
 * 플레이테스트 통계 모으기 — 게임의 '기록 · 꾸미기 → 통계 내보내기'로 받은 파일 여러 개를 합쳐 본다.
 *
 *   node tools/telemetry-report.js 철수.json 영희.json ...
 *
 * 갈래(탑·조작)마다: 시작·클리어 수, 클리어 시간 중앙값, 화면별 머문 시간·점프·엎어짐,
 * 그만둔 화면(어디서 손을 놓는지), 가장 많이 일어난 큰 추락(출발 화면 → 착지 화면).
 */
'use strict';
const fs = require('fs');
const L = require('../src/levels.js');

const files = process.argv.slice(2);
if (!files.length) { console.error('사용법: node tools/telemetry-report.js 파일.json ...'); process.exit(1); }
const NAMES = { 'tower-story': '이야기', 'tower-keeper': '등불지기', 'dark-story': '꺼진 탑 · 이야기', 'dark-keeper': '꺼진 탑 · 등불지기' };
const fmt = (f) => { const s = Math.round(f / 60), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`; };
const median = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

const cats = {};
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const [k, c] of Object.entries(d.cats || {})) {
    if (k === 'other') continue;
    const a = cats[k] || (cats[k] = { players: 0, runs: 0, clears: 0, clearTimes: [], screens: {}, drops: {}, quits: {} });
    a.players++; a.runs += c.runs; a.clears += c.clears; a.clearTimes.push(...c.clearTimes);
    for (const [s, v] of Object.entries(c.screens)) {
      const t = a.screens[s] || (a.screens[s] = { time: 0, jumps: 0, falls: 0, players: 0 });
      t.time += v.time; t.jumps += v.jumps; t.falls += v.falls; t.players++;
    }
    for (const [k2, n] of Object.entries(c.drops)) a.drops[k2] = (a.drops[k2] || 0) + n;
    for (const [s, n] of Object.entries(c.quits)) a.quits[s] = (a.quits[s] || 0) + n;
  }
}

for (const [k, a] of Object.entries(cats)) {
  const ct = median(a.clearTimes);
  console.log(`\n══ ${NAMES[k] || k} — 플레이어 ${a.players}명, 시작 ${a.runs}번, 클리어 ${a.clears}번${ct ? `, 클리어 시간 중앙값 ${fmt(ct)}` : ''}`);
  console.log('  화면  구역          머문 시간(1인 평균)  점프   엎어짐   그만둠');
  const totalQuit = Object.values(a.quits).reduce((x, y) => x + y, 0) || 1;
  for (let s = 0; s < L.SCREENS.length; s++) {
    const t = a.screens[s];
    if (!t && !a.quits[s]) continue;
    const z = L.ZONES[L.SCREENS[s].zone].name, q = a.quits[s] || 0;
    const per = t ? fmt(t.time / t.players) : '-';
    const warn = q / totalQuit >= 0.3 ? '  ◀ 그만둔 사람이 몰림' : '';
    console.log(`  ${String(s).padStart(3)}   ${z.padEnd(8)}      ${per.padStart(8)}        ${String(t ? t.jumps : 0).padStart(5)}  ${String(t ? t.falls : 0).padStart(5)}   ${String(q).padStart(4)}${warn}`);
  }
  const drops = Object.entries(a.drops).sort((x, y) => y[1] - x[1]).slice(0, 8);
  if (drops.length) {
    console.log('  큰 추락 (출발 화면 → 착지 화면)');
    for (const [kk, n] of drops) { const [f, t] = kk.split('>'); console.log(`    ${f} → ${t}  (${f - t}화면 아래)  ${n}번`); }
  }
}

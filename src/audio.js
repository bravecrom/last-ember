/*
 * audio.js — WebAudio로 합성하는 효과음과 배경음악 (음원 파일 없음).
 * 브라우저 정책상 첫 키 입력 후에 unlock()으로 오디오를 깨운다.
 *
 * 소리 흐름:  효과음 → sfxBus ─┐
 *            배경음악 → 곡별 gain → musicBus ─┼→ master → 스피커
 *            (종·뜯는 소리 일부는 메아리를 거친다)
 */
(function () {
  'use strict';
  let ac = null, master = null, sfxBus = null, musicBus = null, echoIn = null, noiseBuf = null;
  let muted = false;
  const vol = { bgm: 0.6, sfx: 0.8 };
  const MASTER = 0.6, MUSIC_LEVEL = 0.3;
  try { muted = localStorage.getItem('lastEmber.muted') === '1'; } catch (e) { /* 저장소 없음 */ }

  function unlock() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ac = new AC();
      master = ac.createGain(); master.gain.value = muted ? 0 : MASTER; master.connect(ac.destination);
      sfxBus = ac.createGain(); sfxBus.gain.value = vol.sfx; sfxBus.connect(master);
      musicBus = ac.createGain(); musicBus.gain.value = vol.bgm * MUSIC_LEVEL; musicBus.connect(master);
      echoIn = ac.createGain(); echoIn.gain.value = 0.3;
      const delay = ac.createDelay(1), fb = ac.createGain(), lp = ac.createBiquadFilter();
      delay.delayTime.value = 0.34; fb.gain.value = 0.38; lp.type = 'lowpass'; lp.frequency.value = 2000;
      echoIn.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay); lp.connect(musicBus);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      setInterval(schedule, 50);
      if (wanted !== undefined) { const w = wanted; wanted = undefined; music(w); }
    }
    if (ac.state === 'suspended') ac.resume();
  }

  // ───────────────────────── 효과음 ─────────────────────────
  function envelope(g, t, attack, dur, peak) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
  }
  function tone(f0, f1, dur, type, v, delay = 0) {
    if (!ac || muted) return;
    const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    envelope(g, t, 0.005, dur, v);
    o.connect(g); g.connect(sfxBus);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(dur, v, freq, delay = 0) {
    if (!ac || muted) return;
    const t = ac.currentTime + delay, src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = noiseBuf;
    f.type = 'lowpass'; f.frequency.value = freq;
    envelope(g, t, 0.004, dur, v);
    src.connect(f); f.connect(g); g.connect(sfxBus);
    src.start(t); src.stop(t + dur + 0.05);
  }

  // ───────────────────────── 배경음악 ─────────────────────────
  // 구역마다 조성·빠르기·악기가 다른 8~16마디 곡을 화음 진행에서 만들어 반복한다.
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], major: [0, 2, 4, 5, 7, 9, 11], lydian: [0, 2, 4, 6, 7, 9, 11], mixo: [0, 2, 4, 5, 7, 9, 10] };
  // chords: [조성 기준 근음(반음), 'M' 장 | 'm' 단], 화음 하나가 bars마디 동안 이어진다
  const TRACKS = {
    title:    { bpm: 66, key: 57, scale: 'minor', bars: 2, chords: [[0, 'm'], [8, 'M'], [3, 'M'], [10, 'M']], pad: 0.3, arp: { inst: 'bell', rate: 2, vol: 0.09 }, bass: { vol: 0.16, hits: [0] } },
    forest:   { bpm: 84, key: 50, scale: 'dorian', bars: 2, chords: [[0, 'm'], [10, 'M'], [5, 'M'], [7, 'm']], pad: 0.22, arp: { inst: 'pluck', rate: 2, vol: 0.05 }, bass: { vol: 0.16, hits: [0, 2] }, lead: { inst: 'flute', vol: 0.09, seed: 3 } },
    ramparts: { bpm: 96, key: 52, scale: 'minor', bars: 2, chords: [[0, 'm'], [8, 'M'], [10, 'M'], [0, 'm']], pad: 0.18, arp: { inst: 'pluck', rate: 4, vol: 0.05 }, bass: { vol: 0.18, hits: [0, 1.5, 2, 3.5] }, lead: { inst: 'flute', vol: 0.08, seed: 7 } },
    frost:    { bpm: 64, key: 54, scale: 'minor', bars: 2, chords: [[0, 'm'], [5, 'm'], [8, 'M'], [7, 'm']], pad: 0.24, arp: { inst: 'bell', rate: 1, vol: 0.09 }, bass: { vol: 0.1, hits: [0] }, lead: { inst: 'bell', vol: 0.07, seed: 11 } },
    gale:     { bpm: 108, key: 55, scale: 'mixo', bars: 2, chords: [[0, 'M'], [10, 'M'], [5, 'M'], [0, 'M']], pad: 0.18, arp: { inst: 'pluck', rate: 4, vol: 0.05 }, bass: { vol: 0.18, hits: [0, 1.5, 3] }, lead: { inst: 'flute', vol: 0.08, seed: 19 } },
    summit:   { bpm: 72, key: 48, scale: 'lydian', bars: 2, chords: [[0, 'M'], [2, 'M'], [4, 'm'], [0, 'M']], pad: 0.26, arp: { inst: 'bell', rate: 2, vol: 0.07 }, bass: { vol: 0.14, hits: [0] }, lead: { inst: 'bell', vol: 0.08, seed: 23 } },
    ending:   { bpm: 70, key: 48, scale: 'major', bars: 1, chords: [[5, 'M'], [7, 'M'], [4, 'm'], [9, 'm'], [5, 'M'], [7, 'M'], [0, 'M'], [0, 'M']], pad: 0.28, arp: { inst: 'bell', rate: 2, vol: 0.08 }, bass: { vol: 0.14, hits: [0, 2] }, lead: { inst: 'flute', vol: 0.09, seed: 29 } },
  };
  const RHYTHMS = [
    [[0, 1], [1, 1], [2, 2]],
    [[0, 1.5], [1.5, 0.5], [2, 1], [3, 1]],
    [[0, 2], [2, 1], [3, 1]],
    [[0, 1], [1, 0.5], [1.5, 0.5], [2, 2]],
    [[0, 3], [3, 1]],
    [[2, 1], [3, 1]],
  ];
  function seeded(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const norm = (n) => ((n % 12) + 12) % 12;

  function compose(tr) {
    const ev = [], scale = SCALES[tr.scale], len = tr.bars * 4;
    tr.chords.forEach(([r, q], ci) => {
      const tri = [r, r + (q === 'm' ? 3 : 4), r + 7], b0 = ci * len;
      ev.push({ beat: b0, dur: len, inst: 'pad', notes: tri.map((n) => tr.key + 12 + norm(n)), vol: tr.pad });
      for (let bar = 0; bar < tr.bars; bar++) for (const h of tr.bass.hits) ev.push({ beat: b0 + bar * 4 + h, dur: 0.9, inst: 'bass', notes: [tr.key - 12 + norm(r)], vol: tr.bass.vol });
      const step = 1 / tr.arp.rate, pat = [0, 1, 2, 3, 2, 1];
      for (let k = 0, b = 0; b < len - 1e-6; b += step, k++) {
        const idx = pat[k % pat.length];
        ev.push({ beat: b0 + b, dur: step * 0.9, inst: tr.arp.inst, notes: [tr.key + 12 + norm(tri[idx % 3]) + (idx === 3 ? 12 : 0)], vol: tr.arp.vol });
      }
    });
    if (tr.lead) {
      const R = seeded(tr.lead.seed), lo = tr.key + 19, hi = tr.key + 31;
      let cur = tr.key + 24 + norm(tr.chords[0][0]);
      const total = tr.chords.length * tr.bars;
      for (let bar = 0; bar < total; bar++) {
        const [r, q] = tr.chords[Math.floor(bar / tr.bars)];
        const chordPc = [norm(r), norm(r + (q === 'm' ? 3 : 4)), norm(r + 7)];
        const pat = RHYTHMS[Math.floor(R() * RHYTHMS.length)];
        for (const [b, d] of pat) {
          // 센박은 화음 음, 여린박은 음계 음에서 가까운 음으로 움직인다
          const pool = [];
          for (let m = lo; m <= hi; m++) {
            const pc = norm(m - tr.key);
            if (b % 2 === 0 ? chordPc.includes(pc) : scale.includes(pc)) pool.push(m);
          }
          const near = pool.filter((m) => Math.abs(m - cur) <= 4 && m !== cur);
          const pick = near.length ? near : pool;
          cur = pick[Math.floor(R() * pick.length)];
          ev.push({ beat: bar * 4 + b, dur: d * 0.95, inst: tr.lead.inst, notes: [cur], vol: tr.lead.vol });
        }
      }
    }
    ev.sort((a, b) => a.beat - b.beat);
    return { ev, beats: tr.chords.length * len };
  }

  function voice(inst, t, midi, dur, v, out, send) {
    const f = mtof(midi), g = ac.createGain();
    g.connect(out);
    if (inst === 'pad') {
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.3;
      const peak = v * 0.3, att = Math.min(1.2, dur * 0.3);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + att);
      g.gain.setValueAtTime(peak, t + dur * 0.85); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.6);
      for (const det of [-7, 7]) { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det; o.connect(lp); o.start(t); o.stop(t + dur + 0.7); }
      lp.connect(g);
    } else if (inst === 'bass') {
      const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); o.start(t); o.stop(t + dur + 0.05);
    } else if (inst === 'pluck') {
      const o = ac.createOscillator(), lp = ac.createBiquadFilter();
      o.type = 'square'; o.frequency.value = f; lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2600, t); lp.frequency.exponentialRampToValueAtTime(500, t + 0.25);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(lp); lp.connect(g); g.connect(send); o.start(t); o.stop(t + 0.4);
    } else if (inst === 'bell') {
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
      for (const [mul, a] of [[1, 1], [2.76, 0.25], [5.4, 0.08]]) {
        const o = ac.createOscillator(), og = ac.createGain();
        o.type = 'sine'; o.frequency.value = f * mul; og.gain.value = a;
        o.connect(og); og.connect(g); o.start(t); o.stop(t + 1.9);
      }
      g.connect(send);
    } else { // flute
      const o = ac.createOscillator(), lfo = ac.createOscillator(), depth = ac.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      lfo.frequency.value = 5; depth.gain.value = f * 0.004; lfo.connect(depth); depth.connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.06);
      g.gain.setValueAtTime(v, t + Math.max(0.07, dur - 0.1)); g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.12);
      o.connect(g); g.connect(send);
      o.start(t); lfo.start(t); o.stop(t + dur + 0.15); lfo.stop(t + dur + 0.15);
    }
  }

  let track = null, wanted;
  function music(name) {
    if (!ac) { wanted = name; return; }
    if ((track && track.name) === name || (!track && !name)) return;
    const now = ac.currentTime;
    if (track) {
      for (const node of [track.gain, track.send]) {
        node.gain.cancelScheduledValues(now); node.gain.setValueAtTime(node.gain.value, now); node.gain.linearRampToValueAtTime(0.0001, now + 1.5);
      }
      const old = track;
      setTimeout(() => { old.gain.disconnect(); old.send.disconnect(); }, 3000);
    }
    track = null;
    if (!name || !TRACKS[name]) return;
    const tr = TRACKS[name];
    if (!tr.comp) tr.comp = compose(tr);
    const gain = ac.createGain(), send = ac.createGain();
    gain.gain.setValueAtTime(0.0001, now); gain.gain.linearRampToValueAtTime(1, now + 1.5);
    send.gain.setValueAtTime(0.0001, now); send.gain.linearRampToValueAtTime(1, now + 1.5);
    gain.connect(musicBus); send.connect(echoIn);
    track = { name, tr, gain, send, start: now + 0.15, i: 0, loop: 0 };
  }
  function schedule() {
    if (!ac || !track) return;
    const { ev, beats } = track.tr.comp, spb = 60 / track.tr.bpm, now = ac.currentTime;
    // 오래 멈췄다가 돌아오면(창이 가려졌을 때 등) 지금 위치로 건너뛴다
    const nowBeat = (now - track.start) / spb;
    if (track.loop * beats + ev[track.i].beat < nowBeat - 2) {
      track.loop = Math.floor(nowBeat / beats);
      const within = nowBeat - track.loop * beats;
      track.i = ev.findIndex((e) => e.beat >= within);
      if (track.i < 0) { track.i = 0; track.loop++; }
    }
    for (let guard = 0; guard < 400; guard++) {
      const e = ev[track.i], t = track.start + (track.loop * beats + e.beat) * spb;
      if (t > now + 0.25) break;
      if (t >= now - 0.02) for (const n of e.notes) voice(e.inst, t, n, e.dur * spb, e.vol, track.gain, track.send);
      if (++track.i >= ev.length) { track.i = 0; track.loop++; }
    }
  }

  window.Sound = {
    unlock,
    music,
    get muted() { return muted; },
    setMuted(m) {
      muted = m;
      try { localStorage.setItem('lastEmber.muted', m ? '1' : '0'); } catch (e) { /* 무시 */ }
      if (master) master.gain.value = m ? 0 : MASTER;
    },
    // kind: 'bgm' | 'sfx', v: 0~1
    setVolume(kind, v) {
      vol[kind] = v;
      const bus = kind === 'bgm' ? musicBus : sfxBus;
      if (bus) bus.gain.setTargetAtTime(kind === 'bgm' ? v * MUSIC_LEVEL : v, ac.currentTime, 0.05);
    },
    jump(p) { tone(200 + p * 220, 420 + p * 520, 0.13, 'square', 0.06); noise(0.07, 0.05, 2600); },
    land(fall) { const v = Math.min(1, 0.3 + fall / 160); noise(0.08, 0.14 * v, 900); tone(150, 70, 0.08, 'triangle', 0.12 * v); },
    splat() { noise(0.3, 0.32, 520); tone(170, 45, 0.35, 'triangle', 0.28); tone(90, 40, 0.4, 'sine', 0.2, 0.05); },
    bump() { tone(320, 190, 0.05, 'square', 0.045); },
    charge(p) { tone(260 + p * 520, 0, 0.035, 'sine', 0.035); },
    blip() { tone(760 + Math.random() * 80, 0, 0.02, 'square', 0.015); },
    stone() { [523.25, 659.25, 783.99].forEach((f, i) => tone(f, 0, 0.7, 'sine', 0.06, i * 0.09)); },
    caw() { tone(620, 380, 0.12, 'sawtooth', 0.04); tone(560, 340, 0.14, 'sawtooth', 0.035, 0.16); },
    crack() { noise(0.05, 0.12, 3200); tone(240, 160, 0.05, 'square', 0.03); },
    crumble() { noise(0.35, 0.22, 700); tone(120, 50, 0.3, 'triangle', 0.12); },
    spark() { [783.99, 987.77, 1174.66, 1567.98].forEach((f, i) => tone(f, 0, 0.5, 'sine', 0.07, i * 0.06)); },
    record() { [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, 0, 0.6, 'triangle', 0.06, i * 0.1)); },
    gust() {
      if (!ac || muted) return;
      const t = ac.currentTime, src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = noiseBuf; src.loop = true;
      f.type = 'bandpass'; f.Q.value = 0.8;
      f.frequency.setValueAtTime(300, t); f.frequency.linearRampToValueAtTime(900, t + 0.6); f.frequency.linearRampToValueAtTime(400, t + 2);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
      src.connect(f); f.connect(g); g.connect(sfxBus);
      src.start(t); src.stop(t + 2.3);
    },
    select() { tone(660, 880, 0.06, 'square', 0.04); },
    move() { tone(520, 0, 0.03, 'square', 0.025); },
    ignite() {
      noise(1.6, 0.12, 1400);
      tone(110, 440, 1.4, 'sawtooth', 0.05);
      [392, 523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0, 2.2, 'sine', 0.07, 1.2 + i * 0.14));
    },
  };
})();

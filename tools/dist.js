// 배포판 정리 — npm run dist:mac / dist:win 끝에 자동으로 돌고, dist:web은 이것만 쓴다.
//   win: Chromium 언어팩(locales/*.pak, 약 49MB)을 한국어·영어만 남긴다. 게임 글자는 캔버스로 그리므로 영향 없음.
//   mac: 언어팩은 서명된 프레임워크 안에 있어 손대지 않는다 (지우면 애플 실리콘에서 앱이 안 열린다).
//   web: index.html + src/를 dist/LastEmber-web/에 복사 (itch.io 같은 곳에 올리는 HTML5 판).
//   모두 끝에 올리기 좋은 zip을 만든다 (맥에서만, ditto 사용 — .app 안의 심볼릭 링크를 지켜 준다).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIST = path.join(__dirname, '..', 'dist');
const KEEP_LOCALES = new Set(['ko.pak', 'en-US.pak']);
const target = process.argv[2];
const mb = (n) => (n < 1048576 ? `${Math.round(n / 1024)}KB` : `${(n / 1048576).toFixed(1)}MB`);

function dirSize(p) {
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((sum, f) => sum + dirSize(path.join(p, f)), 0);
}

function zip(dir) {
  const out = `${dir}.zip`;
  if (process.platform !== 'darwin') return console.log(`  zip 건너뜀 (맥에서만): ${path.basename(dir)}`);
  fs.rmSync(out, { force: true });
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', dir, out]);
  console.log(`  ${path.basename(dir)}: 폴더 ${mb(dirSize(dir))} → zip ${mb(fs.statSync(out).size)}`);
}

function slimWindows(dir) {
  const loc = path.join(dir, 'locales');
  let freed = 0;
  for (const f of fs.readdirSync(loc)) {
    if (KEEP_LOCALES.has(f)) continue;
    freed += fs.statSync(path.join(loc, f)).size;
    fs.rmSync(path.join(loc, f));
  }
  console.log(`  ${path.basename(dir)}: 언어팩 ${mb(freed)} 지움 (남김: ${[...KEEP_LOCALES].join(', ')})`);
}

function buildWeb() {
  const root = path.join(__dirname, '..'), out = path.join(DIST, 'LastEmber-web');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(path.join(root, 'index.html'), path.join(out, 'index.html'));
  fs.cpSync(path.join(root, 'src'), path.join(out, 'src'), { recursive: true });
  return out;
}

const builds = {
  mac: () => ['darwin-arm64', 'darwin-x64'].map((a) => path.join(DIST, `LastEmber-${a}`)).filter(fs.existsSync),
  win: () => [path.join(DIST, 'LastEmber-win32-x64')].filter(fs.existsSync),
  web: () => [buildWeb()],
};
if (!builds[target]) { console.error('사용법: node tools/dist.js mac|win|web'); process.exit(1); }
console.log(`배포판 정리 (${target})`);
for (const dir of builds[target]()) {
  if (target === 'win') slimWindows(dir);
  zip(dir);
}

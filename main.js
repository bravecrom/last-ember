// Electron 메인 프로세스 — 게임(index.html)을 데스크톱 창으로 띄운다.
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    backgroundColor: '#000000',
    title: '마지막 불씨',
    autoHideMenuBar: true,
    // 게임패드만 쓰는 경우에도 소리가 나도록 자동 재생을 허용한다
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.removeMenu(); // 윈도우에서 메뉴 막대 숨김 (맥은 기본 앱 메뉴가 남아 Cmd+Q로 종료 가능)
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

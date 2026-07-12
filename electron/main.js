const { app, BrowserWindow, session } = require('electron');
const PORT = 7749;
const APP_TOKEN = 'music-buddy-electron';

app.whenReady().then(() => {
  // Inject token into all requests from Electron
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    details.requestHeaders['X-App-Token'] = APP_TOKEN;
    cb({ requestHeaders: details.requestHeaders });
  });

  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 800, minHeight: 600,
    title: '音乐老友', backgroundColor: '#0a0a0f',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
  win.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());

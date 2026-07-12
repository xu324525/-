const { app, BrowserWindow } = require('electron');
const PORT = 7749;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 800, minHeight: 600,
    title: '音乐老友', backgroundColor: '#0a0a0f',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
  win.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());

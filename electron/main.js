const { app, BrowserWindow, session } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 7749;
const APP_TOKEN = 'music-buddy-electron';

let serverProcess = null;

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn('node', ['agent-server.js'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe',
      env: { ...process.env, ELECTRON_RUN: '1' },
    });
    serverProcess.stdout.on('data', d => process.stdout.write(d));
    serverProcess.stderr.on('data', d => process.stderr.write(d));
    serverProcess.on('error', reject);

    // Poll until ready
    const check = () => {
      http.get(`http://127.0.0.1:${PORT}/health`, res => {
        if (res.statusCode === 200) resolve();
        else setTimeout(check, 500);
      }).on('error', () => setTimeout(check, 500));
    };
    check();
  });
}

app.whenReady().then(async () => {
  // Inject token into all requests
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    details.requestHeaders['X-App-Token'] = APP_TOKEN;
    cb({ requestHeaders: details.requestHeaders });
  });

  await startServer();

  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 800, minHeight: 600,
    title: '音乐老友', backgroundColor: '#0a0a0f',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
  win.on('closed', () => app.quit());
});

app.on('before-quit', () => {
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
});
app.on('window-all-closed', () => app.quit());

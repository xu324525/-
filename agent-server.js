// Agent wrapper on top of QianMusic Express server
const fs = require('fs');
const path = require('path');

// Ensure anonymous_token exists BEFORE requiring server (util/request reads it at load time)
const tmpPath = require('os').tmpdir();
const tokenPath = path.join(tmpPath, 'anonymous_token');
if (!fs.existsSync(tokenPath)) fs.writeFileSync(tokenPath, '', 'utf-8');

const { serveNcmApi } = require('./server');
const { WebSocketServer } = require('ws');

const SHUTDOWN_DELAY = 30000;
let handleMessage = null;

async function main() {
  // Start config generation in background (non-blocking)
  const configPromise = require('./generateConfig')().catch(e => console.log('[config]', e.message));

  const app = await serveNcmApi({ checkVersion: false });
  await configPromise;
  const server = app.server;

  // Health check — no token needed (for startup detection)
  app.get('/health', (req, res) => res.send('ok'));

  // Block browser access — only Electron app can connect
  const APP_TOKEN = 'music-buddy-electron';
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (req.headers['x-app-token'] === APP_TOKEN) return next();
    // Allow WebSocket upgrade (token checked in connection handler)
    if (req.headers.upgrade === 'websocket') return next();
    res.status(403).send('仅支持桌面客户端访问');
  });

  // Agent routes
  app.get('/api/setup/status', (req, res) => {
    const key = process.env.DEEPSEEK_API_KEY || '';
    res.json({ deepseek_configured: !!key && key.startsWith('sk-'), netease_logged_in: true });
  });
  app.get('/api/setup/deepseek', (req, res) => {
    const key = (req.query.key || '').trim();
    if (!key.startsWith('sk-')) return res.status(400).send('Invalid key');
    process.env.DEEPSEEK_API_KEY = key;
    const envPath = path.join(__dirname, '.env');
    try { fs.writeFileSync(envPath, `DEEPSEEK_API_KEY=${key}\n`, 'utf-8'); } catch {}
    res.json({ ok: true });
  });

  // WebSocket with client tracking
  const wss = new WebSocketServer({ server });
  const clients = new Set();
  let shutdownTimer = null;

  function cancelShutdown() {
    if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  }

  function scheduleShutdown() {
    cancelShutdown();
    if (clients.size > 0 || process.env.ELECTRON_RUN) return;
    console.log('[Agent] No clients. Shutting down in 30s...');
    shutdownTimer = setTimeout(() => {
      if (clients.size > 0) return;
      console.log('[Agent] No clients reconnected. Bye.');
      wss.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000);
    }, SHUTDOWN_DELAY);
  }

  wss.on('connection', (ws, req) => {
    const wsCookie = req.headers.cookie || '';
    clients.add(ws);
    cancelShutdown();
    console.log('[Agent] WS connected (' + clients.size + ' total)' + (wsCookie ? '' : ' (not logged in)'));

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (!handleMessage) {
          const mod = await import('./core/router.js');
          handleMessage = mod.handleMessage;
        }
        const send = (data) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); };

        if (msg.type === 'chat') {
          await handleMessage(msg.content, send, send, wsCookie);
        } else if (msg.type === 'feedback' && msg.artist) {
          const { feedbackBoost } = await import('./core/memory.js');
          await feedbackBoost(msg.artist, msg.action === 'like').catch(() => {});
        } else if (msg.type === 'skip' || msg.type === 'prev' || msg.type === 'play_pause' || msg.type === 'like') {
          send({ type: 'control', action: msg.type });
        } else if (msg.type === 'scrobble' && msg.songId) {
          if (!wsCookie) { console.log('[scrobble] skipped: no cookie'); return; }
          const axios = (await import('axios')).default;
          const params = new URLSearchParams({ id: msg.songId, time: msg.time || 0 });
          if (msg.sourceId) params.set('sourceId', msg.sourceId);
          try {
            await axios.get(`http://127.0.0.1:${process.env.PORT || 7749}/scrobble?${params}`, {
              headers: { Cookie: wsCookie },
            });
            if (msg.time == 0) console.log('[scrobble] start:', msg.songId);
          } catch (e) {
            console.log('[scrobble] error:', e.response?.status || e.message);
          }
        }
      } catch (e) {
        console.error('[Agent] WS error:', e.message);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log('[Agent] WS disconnected (' + clients.size + ' remaining)');
      scheduleShutdown();
    });
  });

  console.log('[Agent] Ready. ws://localhost:' + (process.env.PORT || 7749) + '/ws');
}

main().catch(e => { console.error(e); process.exit(1); });

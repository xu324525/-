import { chat, parseResponse } from './claude.js';
import { buildSystemPrompt, buildChatHistory } from './context.js';
import { addMessage, addPlay, updatePrefs, getPrefs, getRecentPlays, getRecentMessages, getSongStats, getArtistStats, getTopArtistsLongTerm, wasPlayedRecently, getSessionStats } from '../state/db.js';
import { analyzePatterns, maybeSummarize, rememberLine, forgetLine } from './memory.js';
import { state } from './list-state.js';
import config from '../config.js';
import axios from 'axios';

const API = `http://${config.HOST}:${config.PORT}`;

// Session-level dedup — no song repeats within the same run
const sessionPlayedIds = new Set();
function markPlayed(id) { sessionPlayedIds.add(id); }
function isRecentlyPlayed(id) { return getRecentPlays(50).some(p => p.id === id) || sessionPlayedIds.has(id) || wasPlayedRecently(id, 24); }

// Fisher-Yates shuffle
function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

// Artist cooldown: reorder so same primary artist doesn't repeat within window
function artistCooldown(songs, window = 4) {
  if (songs.length <= 1) return songs;
  const result = [songs[0]];
  const pool = songs.slice(1);
  const lastArtist = (s) => (s.ar || [])[0] || '';
  while (pool.length) {
    // Find a song whose artist is not in the last 'window' results
    const recentArtists = new Set(result.slice(-window).map(lastArtist).filter(Boolean));
    let idx = pool.findIndex(s => !recentArtists.has(lastArtist(s)));
    if (idx < 0) idx = Math.floor(Math.random() * pool.length); // fallback: random
    result.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return result;
}

function mapSong(s) {
  let ar = s.ar || s.artists || [];
  if (typeof ar === 'string') ar = ar.split(',').map(a => a.trim()).filter(Boolean);
  const al = s.al || s.album || {};
  return {
    id: String(s.id), name: s.name,
    ar: Array.isArray(ar) ? ar.map(a => typeof a === 'string' ? a : a.name) : [],
    al: typeof al === 'string' ? al : al.name || '',
    alId: al.id || '', dt: s.dt || s.duration || 0,
    picUrl: (typeof al === 'string' ? '' : al.picUrl) || s.picUrl || '',
  };
}

function currentSongObj(s) {
  return {
    id: s.id, name: s.name,
    ar: (s.ar || []).map(a => typeof a === 'string' ? { name: a } : a),
    al: { name: s.al, picUrl: s.picUrl },
    dt: s.dt, play_url: s.play_url
  };
}

function setList(type, data) {
  state.lastType = type;
  state.lastData = data;
}

function cookieHeaders(cookie) {
  return cookie ? { headers: { Cookie: cookie } } : {};
}

async function search(keywords, limit = 10, cookie = '') {
  try {
    const r = await axios.get(`${API}/search?keywords=${encodeURIComponent(keywords)}&limit=${limit}&type=1`, cookieHeaders(cookie));
    return (r.data?.result?.songs || []).map(mapSong);
  } catch { return []; }
}

async function songUrl(ids, cookie = '') {
  try {
    const r = await axios.get(`${API}/song/url?id=${ids.join(',')}`, cookieHeaders(cookie));
    const map = {};
    for (const d of (r.data?.data || [])) { if (d.url) map[String(d.id)] = d.url; }
    return map;
  } catch { return {}; }
}

async function personalFM(cookie = '') {
  try {
    const r = await axios.get(`${API}/personal_fm`, cookieHeaders(cookie));
    return (r.data?.data || []).map(mapSong);
  } catch { return []; }
}

async function fetchLyrics(id) {
  try {
    const r = await axios.get(`${API}/lyric?id=${id}`);
    const lrc = r.data?.lrc?.lyric || '';
    const parsed = [];
    const regex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/g;
    let m;
    while ((m = regex.exec(lrc)) !== null) {
      const t = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3]) / (m[3].length === 3 ? 1000 : 100);
      const text = m[4].trim();
      if (text) parsed.push({ time: t, text });
    }
    return parsed;
  } catch { return []; }
}

async function fetchUserPlaylists(uid, cookie = '') {
  try {
    const r = await axios.get(`${API}/user/playlist?uid=${uid}`, cookieHeaders(cookie));
    return (r.data?.playlist || []).filter(p => !p.subscribed || p.creator?.userId == uid).slice(0, 10).map(p => ({
      id: p.id, name: p.name, count: p.trackCount, subscribed: p.subscribed
    }));
  } catch { return []; }
}

async function fetchLikedSongs(cookie = '') {
  try {
    const lr = await axios.get(`${API}/likelist`, cookieHeaders(cookie));
    const ids = lr.data?.ids || [];
    if (!ids.length) return [];
    // Get details for first 20
    const detailR = await axios.get(`${API}/song/detail?ids=${ids.slice(0, 20).join(',')}`, cookieHeaders(cookie));
    return (detailR.data?.songs || []).map(mapSong);
  } catch { return []; }
}

async function fetchHeartbeatSongs(songId, cookie = '') {
  try {
    const r = await axios.get(`${API}/playmode/intelligence/list?id=${songId}&count=5`, cookieHeaders(cookie));
    return (r.data?.data || []).map(mapSong);
  } catch { return []; }
}

async function fetchToplist() {
  try {
    const r = await axios.get(`${API}/toplist`);
    return (r.data?.list || r.data?.topList || []).map(t => ({
      id: t.id, name: t.name, description: t.description || '', coverUrl: t.coverImgUrl || '',
    }));
  } catch { return []; }
}

async function fetchTopListSongs(id) {
  try {
    const r = await axios.get(`${API}/top/list?id=${id}&limit=20`);
    return (r.data?.playlist?.tracks || []).map(mapSong);
  } catch { return []; }
}

async function fetchNewSongs(areaId = 0) {
  try {
    const r = await axios.get(`${API}/top/song?type=${areaId}`);
    return (r.data?.data || []).map(mapSong);
  } catch { return []; }
}

async function fetchHotArtists(limit = 10) {
  try {
    const r = await axios.get(`${API}/top/artists?limit=${limit}`);
    return (r.data?.artists || []).map(a => ({
      id: a.id, name: a.name, picUrl: a.picUrl || '',
    }));
  } catch { return []; }
}

async function fetchArtistTopSongs(artistId) {
  try {
    const r = await axios.get(`${API}/artist/top/song?id=${artistId}`);
    return (r.data?.songs || []).map(mapSong);
  } catch { return []; }
}

async function fetchSimilarSongs(songId) {
  try {
    const r = await axios.get(`${API}/simi/song?id=${songId}`);
    return (r.data?.songs || []).map(mapSong);
  } catch { return []; }
}

function scoreSong(song, prefs) {
  let score = 0;
  // Long-term artist affinity (from play history, not just prefs)
  const topArtists = getTopArtistsLongTerm(10).map(a => a.name);
  for (const a of (song.ar || []).filter(Boolean)) {
    const idx = topArtists.indexOf(a);
    if (idx >= 0) score += (topArtists.length - idx) * 2;
    // Bonus for artists with high play count
    const stats = getArtistStats(a);
    if (stats && stats.playCount > 10) score += Math.min(stats.playCount, 30);
  }
  if ((song.dt || 0) > 180000) score += 2;
  // Penalize overplayed songs (long-term fatigue)
  const songStats = getSongStats(song.id);
  if (songStats && songStats.playCount > 20) score -= songStats.playCount;
  // Penalize recently played songs (last 50, exponential decay for recency)
  const recent = getRecentPlays(50);
  const idx = recent.findIndex(p => p.id === song.id);
  if (idx >= 0) score -= 200 + (50 - idx) * 10;
  return score;
}

function relevanceScore(song, query) {
  let s = 0;
  const q = (query || '').toLowerCase();
  if (!q) return s;
  // Match song name (strongest signal)
  if (q.includes(song.name.toLowerCase()) || song.name.toLowerCase().includes(q)) s += 10;
  // Match artist names (each matched artist adds points)
  for (const a of (song.ar || [])) {
    const aname = (typeof a === 'string' ? a : a.name || '').toLowerCase();
    if (aname && q.includes(aname)) s += 8;
  }
  // Exact artist match bonus (query targets this specific artist)
  const arNames = (song.ar || []).map(a => typeof a === 'string' ? a : a.name || '').join(' ').toLowerCase();
  if (arNames && q.includes(arNames)) s += 5;
  return s;
}

function pickBest(songs, prefs, count = 3, query = '') {
  if (!songs.length) return [];
  return songs.map(s => ({
    song: s,
    score: scoreSong(s, prefs) + relevanceScore(s, query)
  }))
    .sort((a, b) => b.score - a.score).slice(0, count).map(x => x.song);
}

// Login status cache (5min TTL to avoid redundant API calls)
let loginCache = { time: 0, info: { loggedIn: false, nickname: '', uid: '' } };

export async function handleMessage(msg, send, broadcast, cookie = '') {
  if (!msg || typeof msg !== 'string') return;
  const isAutoContinue = msg.trim() === '__prefetch__' || msg.trim() === '继续';
  let text = msg.trim();
  // Internal prefetch -> natural message for LLM
  if (text === '__prefetch__') text = '继续';
  await addMessage('user', text);

  // Capture previous state before cache update
  const prevLoggedIn = loginCache.info.loggedIn;

  let loginInfo;
  if (!cookie) {
    loginInfo = { loggedIn: false, nickname: '', uid: '' };
  } else if (Date.now() - loginCache.time < 300000) {
    loginInfo = loginCache.info;
  } else {
    try {
      const r = await axios.get(`${API}/login/status`, cookieHeaders(cookie));
      const profile = r.data?.data?.profile || r.data?.profile;
      if (profile?.userId) {
        loginInfo = { loggedIn: true, nickname: profile.nickname || '', uid: String(profile.userId) };
      } else {
        loginInfo = { loggedIn: false, nickname: '', uid: '' };
      }
      loginCache = { time: Date.now(), info: loginInfo };
    } catch { loginInfo = { loggedIn: false, nickname: '', uid: '' }; }
  }
  // Only log on status change
  if (prevLoggedIn !== loginInfo.loggedIn) console.log('[login]', loginInfo.loggedIn ? `✓ ${loginInfo.nickname}` : '✗ not logged in');
  
  // 0b. "放第X首/第X个" — select from last list
  const selMatch = text.match(/^(?:放|播放|来|来个|来首)?(?:第|第\s*)([一二三四五六七八九十\d]+)(?:首|个|号)?$/);
  if (selMatch) {
    const numStr = selMatch[1];
    const numMap = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10 };
    const idx = (numMap[numStr] || parseInt(numStr)) - 1;

    // Select from last context based on type
    if (state.lastType && state.lastData.length && idx >= 0 && idx < state.lastData.length) {
      if (state.lastType === 'rankings') {
        const ranking = state.lastData[idx];
        const songs = await fetchTopListSongs(ranking.id);
        if (songs.length) {
          setList('songs', songs);
          const names = songs.slice(0, 10).map((s,i) => `${i+1}. ${s.name} - ${s.ar?.join('/') || ''}`).join('\n');
          send({ type: 'reply', content: `📊 ${ranking.name}：\n${names}\n\n说"放第X首"来选择`, typing: false });
          const ids = songs.slice(0, 5).map(s => s.id);
          const [urlMap, lyrics] = await Promise.all([songUrl(ids, cookie), fetchLyrics(songs[0].id)]);
          for (const s of songs) s.play_url = urlMap[s.id] || '';
          send({ type: 'playlist_updated', playlist: songs.slice(0, 5), current_index: 0, lyrics, current_song: currentSongObj(songs[0]) });
markPlayed(songs[0].id);
          await addPlay({ name: songs[0].name, ar: songs[0].ar?.join('/') || '', id: songs[0].id });
        }
        return;
      }
      if (state.lastType === 'playlists') {
        const pl = state.lastData[idx];
        try {
          const r = await axios.get(`${API}/playlist/track/all?id=${pl.id}`, cookieHeaders(cookie));
          const songs = (r.data?.songs || []).slice(0, 15).map(mapSong);
          if (songs.length) {
            setList('songs', songs);
            const names = songs.slice(0, 10).map((s,i) => `${i+1}. ${s.name} - ${s.ar?.join('/') || ''}`).join('\n');
            send({ type: 'reply', content: `📂 ${pl.name}（共${songs.length}首）：\n${names}\n\n说"放第X首"来选择`, typing: false });
            const ids = songs.slice(0, 5).map(s => s.id);
            const [urlMap, lyrics] = await Promise.all([songUrl(ids, cookie), fetchLyrics(songs[0].id)]);
            for (const s of songs) s.play_url = urlMap[s.id] || '';
            send({ type: 'playlist_updated', playlist: songs.slice(0, 5), current_index: 0, lyrics, current_song: currentSongObj(songs[0]) });
markPlayed(songs[0].id);
            await addPlay({ name: songs[0].name, ar: songs[0].ar?.join('/') || '', id: songs[0].id });
          }
        } catch {}
        return;
      }
      // songs type
      const s = state.lastData[idx];
      const [urlMap, lyrics] = await Promise.all([songUrl([s.id], cookie), fetchLyrics(s.id)]);
      s.play_url = urlMap[s.id] || '';
      send({ type: 'playlist_updated', playlist: [s], current_index: 0, lyrics, current_song: currentSongObj(s) });
markPlayed(s.id);
      await addPlay({ name: s.name, ar: s.ar?.join('/') || '', id: s.id });
      return;
    }
  }

  // 1. Simple commands
  const simpleMap = {
    '暂停': 'pause', '停止': 'pause', '别放了': 'pause',
    '下一首': 'skip', '切歌': 'skip', '跳过': 'skip', '换一首': 'skip', 'next': 'skip',
    '上一首': 'prev', '前一首': 'prev',
    '播放': 'play',
  };
  if (simpleMap[text]) { send({ type: 'control', action: simpleMap[text] }); send({ type: 'reply', content: '👌', typing: false }); return; }

  // 1b. Toggle recommendation reason
  if (/^(显示|隐藏|打开|关闭)推荐理由$|^推荐理由(开|关|打开|隐藏|显示)$/.test(text)) {
    const show = /显示|打开|开/.test(text);
    await updatePrefs({ showReason: show });
    send({ type: 'reply', content: show ? '已打开推荐理由，我会告诉你为什么选这首歌' : '已关闭推荐理由，安静听歌', typing: false });
    return;
  }

  // 1c. Ask for recommendation reason
  if (/^推荐理由/.test(text)) {
    const songInfo = text.replace(/^推荐理由[：:]\s*/, '').trim();
    const songName = songInfo || (() => { const p = getRecentPlays(1); return p[0] ? `${p[0].name} - ${p[0].ar || ''}` : ''; })();
    if (songName) {
      const prefs = getPrefs();
      const recent = getRecentPlays(5).map(p => p.name).join('、');
      const sp = '你是阿乐，用户的音乐老友，说话自然随意。';
      const prompt = `用户正在听《${songName}》。ta最近循环：${recent}。用一两句话（30字左右）说说这歌跟ta最近状态怎么对上号的。自然点，别提歌名别说教。`;
      const raw = await chat(sp, prompt, [], 100);
      const clean = (raw || '').replace(/```[\s\S]*?```/g, '').replace(/\{[\s\S]*\}/g, '').trim();
      const reason = clean.split(/[。！？\n]/).filter(s => s.trim().length > 3).slice(0, 2).join('。') || '这首挺对味';
      send({ type: 'reply', content: '💡 ' + reason, typing: false });
    } else {
      send({ type: 'reply', content: '还没放过歌呢，先来一首', typing: false });
    }
    return;
  }


  // 3. Discovery intents - only exact commands, let LLM handle general requests
  if (/^今日推荐$|^每日推荐$|^发现$|^今天听什么$|^有什么新歌$/.test(text)) {
    if (!cookie) {
      send({ type: 'reply', content: '每日推荐需要登录网易云账号，点右上角扫码登录', typing: false });
      return;
    }
    try {
      const r = await axios.get(`${API}/recommend/songs`, cookieHeaders(cookie));
      const rawSongs = (r.data?.data?.dailySongs || []).slice(0, 10);
      if (rawSongs.length) {
        const songs = rawSongs.map(mapSong);
        setList('songs', songs);
        const names = songs.map((s,i) => `${i+1}. ${s.name} - ${s.ar.join('/')}`).join('\n');
        send({ type: 'reply', content: `📡 今日推荐：\n${names}\n\n说"放第X首"来播放`, typing: false });
        const ids = songs.slice(0, 5).map(s => s.id);
        const [urlMap, lyrics] = await Promise.all([songUrl(ids, cookie), fetchLyrics(songs[0].id)]);
        for (const s of songs) s.play_url = urlMap[s.id] || '';
        send({ type: 'playlist_updated', playlist: songs.slice(0, 5), current_index: 0, lyrics, current_song: currentSongObj(songs[0]) });
        return;
      }
      send({ type: 'reply', content: '每日推荐暂时获取不到，试试重新登录', typing: false });
      return;
    } catch {
      send({ type: 'reply', content: '每日推荐需要登录，点右上角扫码', typing: false });
      return;
    }
  }

  if (/我的歌单|我的收藏|我歌单|个人歌单/.test(text)) {
    try {
      const uid = loginInfo.uid;
      if (uid) {
        const r = await axios.get(`${API}/user/playlist?uid=${uid}`, cookieHeaders(cookie));
        const pls = (r.data?.playlist || []).filter(p => !p.subscribed || p.creator?.userId === uid).slice(0, 10);
        if (pls.length) {
          setList('playlists', pls.map(p => ({ id: p.id, name: p.name, trackCount: p.trackCount })));
          const list = pls.map((p,i) => `${i+1}. ${p.name} (${p.trackCount}首) - ${p.subscribed?'收藏':'创建'}`).join('\n');
          send({ type: 'reply', content: `📂 你的歌单：\n${list}\n\n说"放第X个"来播放`, typing: false });
          return;
        }
      }
      send({ type: 'reply', content: '需要先登录网易云账号才能查看歌单', typing: false });
      return;
    } catch { send({ type: 'reply', content: '获取歌单失败', typing: false }); return; }
  }

  // 3. LLM-first
  const systemPrompt = buildSystemPrompt(loginInfo);
  const history = buildChatHistory();
  const raw = await chat(systemPrompt, text, history.slice(0, -1));
  let result = parseResponse(raw);
  console.log('[parsed]', JSON.stringify(result).slice(0, 300));

  // Handle remember tool (Hermes pattern: agent-controlled memory)
  if (result.remember) {
    try {
      if (result.remember.action === 'add' && result.remember.text) {
        await rememberLine(result.remember.text);
        console.log('[memory] added:', result.remember.text);
      } else if (result.remember.action === 'forget' && result.remember.pattern) {
        await forgetLine(result.remember.pattern);
        console.log('[memory] forgot:', result.remember.pattern);
      }
    } catch (e) { console.error('[memory] error:', e.message); }
  }

  // 4. Fallback: if LLM returned no play but user clearly wants music, auto-fm
  const reply1 = result.say || '';
  const userWantsMusic = /放|播|听|来[首点个]|想听|搜|推|漫游|排行|新歌|热门|歌单|换[首点]|切歌|下一首|上一首|继续|再来|串烧|整|搞|有什么|来一|有没有|推荐|给[我来]|换个|换点/.test(text);
  if ((!result.play || result.play.length === 0) && userWantsMusic) {
    // Try to extract song name from LLM reply first
    let q = '';
    const allBooks = [...reply1.matchAll(/《([^》]+)》/g)];
    if (allBooks.length) q = allBooks[allBooks.length - 1][1];
    if (!q) { const m = reply1.match(/「([^」]+)」/); if (m) q = m[1]; }
    if (!q) { const m = reply1.match(/"([^"]+)"/); if (m) q = m[1]; }
    if (q) {
      q = q.replace(/[，。！？《》「」""\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
      result.play = [{ type: 'search', query: q }];
    } else {
      result.play = [{ type: 'fm' }];
    }
  }

  // Execute
  const reply = result.say || '';
  await addMessage('assistant', isAutoContinue ? '' : reply, 'music');
  maybeSummarize().catch(() => {});
  if (!isAutoContinue && reply) send({ type: 'reply', content: reply, typing: false });

  const plays = result.play || [];
  // Execute play actions from LLM (LLM already decided user wants music)
  if (plays.length > 0) {
    (async () => {
      const prefs = getPrefs();
      // Parallelize independent play actions
      const results = await Promise.all(plays.map(p => {
        if (p.type === 'fm') return personalFM(cookie).then(songs => ({ songs: songs.slice(0, 5), list: null, sendMsg: null }));
        if (p.type === 'search' && p.query) return search(p.query, 10, cookie).then(songs => {
          if (!songs.length) return { songs: [], list: null, sendMsg: null };
          const best = pickBest(songs, prefs, 1, p.query);
          const result = best.length ? best : songs.slice(0, 1);
          if (p.alternatives && Array.isArray(p.alternatives)) {
            const others = songs.filter(s => !best.find(b => b.id === s.id)).slice(0, 2);
            result.push(...others);
          }
          return { songs: result, list: null, sendMsg: null };
        });
        if (p.type === 'liked' && cookie) return fetchLikedSongs(cookie).then(songs => ({ songs: songs.slice(0, 10), list: null, sendMsg: null }));
        if (p.type === 'heartbeat' && cookie) {
          const recent = getRecentPlays(1);
          if (!recent[0]?.id) return { songs: [], list: null, sendMsg: null };
          return fetchHeartbeatSongs(recent[0].id, cookie).then(songs => ({ songs: songs.slice(0, 5), list: null, sendMsg: null }));
        }
        if (p.type === 'playlist' && p.query && cookie && loginInfo.uid) {
          return fetchUserPlaylists(loginInfo.uid, cookie).then(async pls => {
            const match = pls.find(pl => pl.name.includes(p.query));
            if (!match) return { songs: [], list: null, sendMsg: null };
            try {
              const r = await axios.get(`${API}/playlist/track/all?id=${match.id}`, cookieHeaders(cookie));
              return { songs: (r.data?.songs || []).slice(0, 10).map(mapSong), list: null, sendMsg: null };
            } catch { return { songs: [], list: null, sendMsg: null }; }
          });
        }
        if (p.type === 'toplist') {
          if (p.id) return fetchTopListSongs(p.id).then(songs => ({ songs: songs.slice(0, 10), list: ['songs', songs], sendMsg: null }));
          return fetchToplist().then(async lists => {
            if (!lists.length) return { songs: [], list: null, sendMsg: null };
            const q = (p.query || '').toLowerCase();
            const matched = q ? lists.find(l => l.name.toLowerCase().includes(q) || q.includes(l.name.toLowerCase())) : null;
            if (matched) {
              const songs = await fetchTopListSongs(matched.id);
              return { songs: songs.slice(0, 10), list: ['songs', songs], sendMsg: null };
            }
            return { songs: [], list: ['rankings', lists], sendMsg: lists.map((l, i) => `${i+1}. ${l.name}`).join('\n') };
          });
        }
        if (p.type === 'newsong') {
          const areaMap = { '华语': 7, '欧美': 96, '日语': 8, '韩语': 16, '日本': 8, '韩国': 16 };
          const areaId = areaMap[p.area] || areaMap[p.query] || 0;
          return fetchNewSongs(areaId).then(songs => ({ songs: songs.slice(0, 10), list: ['songs', songs], sendMsg: null }));
        }
        if (p.type === 'artist_songs' && p.query) {
          return axios.get(`${API}/search?keywords=${encodeURIComponent(p.query)}&type=100&limit=1`, cookieHeaders(cookie))
            .then(async sr => {
              const artist = sr.data?.result?.artists?.[0];
              if (!artist?.id) return { songs: [], list: null, sendMsg: null };
              const songs = await fetchArtistTopSongs(artist.id);
              return { songs: songs.slice(0, 10), list: ['songs', songs], sendMsg: null };
            }).catch(() => ({ songs: [], list: null, sendMsg: null }));
        }
        if (p.type === 'similar') {
          const recent = getRecentPlays(1);
          if (!recent[0]?.id) return { songs: [], list: null, sendMsg: null };
          return fetchSimilarSongs(recent[0].id).then(songs => ({ songs: songs.slice(0, 5), list: ['songs', songs], sendMsg: null }));
        }
        if (p.type === 'hot_artists') {
          return fetchHotArtists(10).then(artists => ({
            songs: [], list: null,
            sendMsg: artists.length ? `🎤 热门歌手：\n${artists.map((a,i) => `${i+1}. ${a.name}`).join('\n')}\n\n说"放XX的歌"来播放` : null
          }));
        }
        return { songs: [], list: null, sendMsg: null };
      }));
      // Flatten results
      const allSongs = [];
      for (const r of results) {
        if (r.songs.length) allSongs.push(...r.songs);
        if (r.list) setList(r.list[0], r.list[1]);
        if (r.sendMsg) send({ type: 'reply', content: r.sendMsg, typing: false });
      }
      // Dedup: session + DB combined, within batch, artist cooldown
      const seen = new Set();
      const unique = [];
      for (const s of allSongs) {
        if (!seen.has(s.id) && !isRecentlyPlayed(s.id)) { seen.add(s.id); unique.push(s); }
      }
      const deduped = artistCooldown(shuffle(unique));
      if (deduped.length) {
        deduped.forEach(s => markPlayed(s.id));
        const ids = deduped.slice(0, 10).map(s => s.id);
        const [urlMap, lyrics] = await Promise.all([songUrl(ids, cookie), fetchLyrics(deduped[0].id)]);
        for (const s of deduped) s.play_url = urlMap[s.id] || '';
        const s = deduped[0];
        const showReason = prefs.showReason !== false;
        send({ type: 'playlist_updated', playlist: deduped, current_index: 0, lyrics, append: isAutoContinue, reason: showReason ? (result.reason || '') : '', current_song: currentSongObj(s) });
        await addPlay({ name: s.name, ar: s.ar?.join('/') || '', id: s.id });
        const artists = [...new Set(unique.map(s => s.ar?.[0]).filter(Boolean))];
        if (artists.length) await updatePrefs({ topArtists: [...new Set([...(prefs.topArtists || []), ...artists])].slice(0, 15) });
        analyzePatterns();
      }
    })().catch(e => console.error('[router] play error:', e.message));
  }
}

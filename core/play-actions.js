import { getRecentPlays, wasPlayedRecently } from '../state/db.js';
import { state } from './list-state.js';
import { error as logError } from './logger.js';
import config from '../config.js';
import axios from 'axios';

const API = `http://${config.HOST}:${config.PORT}`;

// Session-level dedup — no song repeats within the same run
const sessionPlayedIds = new Set();
export function markPlayed(id) { sessionPlayedIds.add(id); }
export function isRecentlyPlayed(id) { return getRecentPlays(50).some(p => p.id === id) || sessionPlayedIds.has(id) || wasPlayedRecently(id, 24); }

// Fisher-Yates shuffle
export function shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

// Artist cooldown: reorder so same primary artist doesn't repeat within window
export function artistCooldown(songs, window = 4) {
  if (songs.length <= 1) return songs;
  const result = [songs[0]];
  const pool = songs.slice(1);
  const lastArtist = (s) => (s.ar || [])[0] || '';
  while (pool.length) {
    const recentArtists = new Set(result.slice(-window).map(lastArtist).filter(Boolean));
    let idx = pool.findIndex(s => !recentArtists.has(lastArtist(s)));
    if (idx < 0) idx = Math.floor(Math.random() * pool.length);
    result.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return result;
}

export function mapSong(s) {
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

export function currentSongObj(s) {
  return {
    id: s.id, name: s.name,
    ar: (s.ar || []).map(a => typeof a === 'string' ? { name: a } : a),
    al: { name: s.al, picUrl: s.picUrl },
    dt: s.dt, play_url: s.play_url
  };
}

export function setList(type, data) {
  state.lastType = type;
  state.lastData = data;
}

export function cookieHeaders(cookie) {
  return cookie ? { headers: { Cookie: cookie } } : {};
}

export async function search(keywords, limit = 10, cookie = '') {
  try {
    const r = await axios.get(`${API}/search?keywords=${encodeURIComponent(keywords)}&limit=${limit}&type=1`, cookieHeaders(cookie));
    return (r.data?.result?.songs || []).map(mapSong);
  } catch (e) { logError('search api error:', e.message); return []; }
}

export async function songUrl(ids, cookie = '') {
  try {
    const r = await axios.get(`${API}/song/url?id=${ids.join(',')}`, cookieHeaders(cookie));
    const map = {};
    for (const d of (r.data?.data || [])) { if (d.url) map[String(d.id)] = d.url; }
    return map;
  } catch (e) { logError('songUrl api error:', e.message); return {}; }
}

export async function personalFM(cookie = '') {
  try {
    const r = await axios.get(`${API}/personal_fm`, cookieHeaders(cookie));
    return (r.data?.data || []).map(mapSong);
  } catch (e) { logError('api error:', e.message); return []; }
}

export async function fetchLyrics(id) {
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
  } catch (e) { logError('api error:', e.message); return []; }
}

export async function fetchUserPlaylists(uid, cookie = '') {
  try {
    const r = await axios.get(`${API}/user/playlist?uid=${uid}`, cookieHeaders(cookie));
    return (r.data?.playlist || []).filter(p => !p.subscribed || p.creator?.userId == uid).slice(0, 10).map(p => ({
      id: p.id, name: p.name, count: p.trackCount, subscribed: p.subscribed
    }));
  } catch (e) { logError('api error:', e.message); return []; }
}

export async function fetchLikedSongs(cookie = '') {
  try {
    const lr = await axios.get(`${API}/likelist`, cookieHeaders(cookie));
    const ids = lr.data?.ids || [];
    if (!ids.length) return [];
    const detailR = await axios.get(`${API}/song/detail?ids=${ids.slice(0, 20).join(',')}`, cookieHeaders(cookie));
    return (detailR.data?.songs || []).map(mapSong);
  } catch (e) { logError('api error:', e.message); return []; }
}

export async function fetchHeartbeatSongs(songId, cookie = '') {
  try {
    const r = await axios.get(`${API}/playmode/intelligence/list?id=${songId}&count=5`, cookieHeaders(cookie));
    return (r.data?.data || []).map(mapSong);
  } catch (e) { logError('api error:', e.message); return []; }
}

export async function fetchToplist() {
  try {
    const r = await axios.get(`${API}/toplist`);
    return (r.data?.list || r.data?.topList || []).map(t => ({
      id: t.id, name: t.name, description: t.description || '', coverUrl: t.coverImgUrl || '',
    }));
  } catch (e) { logError('api error:', e.message); return []; }
}

export async function fetchTopListSongs(id) {
  try {
    const r = await axios.get(`${API}/top/list?id=${id}&limit=20`);
    return (r.data?.playlist?.tracks || []).map(mapSong);
  } catch (e) { logError('api error:', e.message); return []; }
}

export async function fetchNewSongs(areaId = 0) {
  try {
    const r = await axios.get(`${API}/top/song?type=${areaId}`);
    return (r.data?.data || []).map(mapSong);
  } catch (e) { logError('api error:', e.message); return []; }
}

export async function fetchHotArtists(limit = 10) {
  try {
    const r = await axios.get(`${API}/top/artists?limit=${limit}`);
    return (r.data?.artists || []).map(a => ({
      id: a.id, name: a.name, picUrl: a.picUrl || '',
    }));
  } catch (e) { logError('api error:', e.message); return []; }
}

export async function fetchArtistTopSongs(artistId) {
  try {
    const r = await axios.get(`${API}/artist/top/song?id=${artistId}`);
    return (r.data?.songs || []).map(mapSong);
  } catch (e) { logError('api error:', e.message); return []; }
}

export async function fetchSimilarSongs(songId) {
  try {
    const r = await axios.get(`${API}/simi/song?id=${songId}`);
    return (r.data?.songs || []).map(mapSong);
  } catch (e) { logError('api error:', e.message); return []; }
}

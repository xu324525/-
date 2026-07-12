import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import config from '../config.js';

const adapter = new JSONFile(config.STATE_PATH);
const defaults = {
  messages: [],
  plays: [],
  // Long-term memory structures
  songStats: {},     // { songId: { name, artist, playCount, lastPlayed, firstPlayed } }
  artistStats: {},   // { artistName: { playCount, lastPlayed } }
  session: { totalPlays: 0, totalMinutes: 0 },
  prefs: { topArtists: [], topGenres: [], moodHistory: [] },
};
const db = new Low(adapter, defaults);

try { await db.read(); } catch {
  db.data = { ...defaults };
  await db.write();
}

// ---- Migrate existing data ----
if (!db.data.songStats) db.data.songStats = {};
if (!db.data.artistStats) db.data.artistStats = {};
if (!db.data.session) db.data.session = { totalPlays: 0, totalMinutes: 0 };

// Debounced write
let writeTimer = null;
let writePending = false;
function scheduleWrite() {
  writePending = true;
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    if (writePending) { writePending = false; await db.write(); }
  }, 500);
}

export async function flushWrite() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (writePending) { writePending = false; await db.write(); }
}

// ---- Recent data (capped) ----

export async function addMessage(role, content, intent = '') {
  db.data.messages.push({ role, content, intent, time: new Date().toISOString() });
  if (db.data.messages.length > 200) db.data.messages = db.data.messages.slice(-200);
  scheduleWrite();
}

export async function addPlay(song) {
  const now = new Date().toISOString();
  db.data.plays.push({ ...song, time: now });
  if (db.data.plays.length > 500) db.data.plays = db.data.plays.slice(-500);

  // Update long-term song stats
  const sid = song.id;
  if (!db.data.songStats[sid]) {
    db.data.songStats[sid] = { name: song.name, artist: (song.ar || [])[0] || '', playCount: 0, lastPlayed: now, firstPlayed: now };
  }
  db.data.songStats[sid].playCount++;
  db.data.songStats[sid].lastPlayed = now;
  db.data.songStats[sid].name = song.name; // keep name updated

  // Update long-term artist stats
  const artist = (song.ar || [])[0];
  if (artist) {
    if (!db.data.artistStats[artist]) {
      db.data.artistStats[artist] = { playCount: 0, lastPlayed: now };
    }
    db.data.artistStats[artist].playCount++;
    db.data.artistStats[artist].lastPlayed = now;
  }

  // Update session stats
  db.data.session.totalPlays++;
  if (song.dt) db.data.session.totalMinutes += Math.round(song.dt / 60000);

  scheduleWrite();
}

export function getRecentMessages(limit = 20) {
  return db.data.messages.slice(-limit);
}

export function getRecentPlays(limit = 30) {
  return db.data.plays.slice(-limit);
}

export function getPrefs() {
  return { ...db.data.prefs, topArtists: [...(db.data.prefs.topArtists || [])] };
}

export async function updatePrefs(partial) {
  Object.assign(db.data.prefs, partial);
  scheduleWrite();
}

// ---- Long-term memory queries ----

export function getSongStats(songId) {
  return db.data.songStats[songId] || null;
}

export function getArtistStats(artistName) {
  return db.data.artistStats[artistName] || null;
}

// Get top N artists by play count (long-term, not just recent)
export function getTopArtistsLongTerm(n = 10) {
  return Object.entries(db.data.artistStats)
    .sort((a, b) => b[1].playCount - a[1].playCount)
    .slice(0, n)
    .map(([name, stats]) => ({ name, ...stats }));
}

// Get top N songs by play count
export function getTopSongs(n = 10) {
  return Object.values(db.data.songStats)
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, n);
}

// Check if song was played in the last N hours (cross-session dedup)
export function wasPlayedRecently(songId, hours = 24) {
  const s = db.data.songStats[songId];
  if (!s) return false;
  return (Date.now() - new Date(s.lastPlayed).getTime()) < hours * 3600000;
}

export function getSessionStats() {
  return { ...db.data.session };
}

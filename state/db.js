import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import config from '../config.js';

const adapter = new JSONFile(config.STATE_PATH);
const defaults = {
  messages: [],
  plays: [],
  prefs: { topArtists: [], topGenres: [], moodHistory: [] },
};
const db = new Low(adapter, defaults);

try { await db.read(); } catch {
  db.data = { ...defaults };
  await db.write();
}

// Debounced write — batch mutations within 500ms window
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
// Force immediate write (for shutdown)
async function flushWrite() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (writePending) { writePending = false; await db.write(); }
}

export async function addMessage(role, content, intent = '') {
  db.data.messages.push({ role, content, intent, time: new Date().toISOString() });
  if (db.data.messages.length > 200) db.data.messages = db.data.messages.slice(-200);
  scheduleWrite();
}

export async function addPlay(song) {
  db.data.plays.push({ ...song, time: new Date().toISOString() });
  if (db.data.plays.length > 500) db.data.plays = db.data.plays.slice(-500);
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

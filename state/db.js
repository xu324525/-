import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import config from '../config.js';

const adapter = new JSONFile(config.STATE_PATH);
const defaults = {
  messages: [],
  plays: [],
  songStats: {},
  artistStats: {},
  session: { totalPlays: 0, totalMinutes: 0 },
  // Tiered memory storage
  playedInSession: [],       // L1: session footprint { id, name, artist } (last 20)
  emotionTrajectory: [],     // L1: emotional flow [{ valence, time }] valence∈[-1,1]
  transitions: {},           // L2: Markov chain { artistA: { artistB: count } }
  termDF: {},                // L2: Document frequency for BM25 { term: count_of_docs_containing }
  cutHistory: [],            // L2: Per-song cut tracking [{songId, artist, time}]
  prefs: {
    topArtists: [], topGenres: [], moodHistory: [],
    facts: [],               // LTM core: high-confidence facts (≤30)
    extensionFacts: [],       // LTM extension: all facts (≤500)
    candidateFacts: [],       // Candidate pool: scoring-based promotion
    deprecatedFacts: [],      // Soft-deleted facts with supersedes info
    dislikes: [],             // Negative preferences: artists to avoid
    patternMatrix: {},        // { artist: { timeSlot: count } }
    summary: '',
    lastSummaryIdx: 0,
  },
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
if (!db.data.prefs.candidateFacts) db.data.prefs.candidateFacts = [];
if (!db.data.prefs.extensionFacts) db.data.prefs.extensionFacts = [];
if (!db.data.prefs.dislikes) db.data.prefs.dislikes = [];
if (!db.data.prefs.patternMatrix) db.data.prefs.patternMatrix = {};
if (!db.data.prefs.deprecatedFacts) db.data.prefs.deprecatedFacts = [];
if (!db.data.playedInSession) db.data.playedInSession = [];
if (!db.data.emotionTrajectory) db.data.emotionTrajectory = [];
if (!db.data.transitions) db.data.transitions = {};
if (!db.data.termDF) db.data.termDF = {};
if (!db.data.cutHistory) db.data.cutHistory = [];

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

  // Update session footprint
  const list = db.data.playedInSession || [];
  list.push({ id: song.id, name: song.name, artist: (song.ar || [])[0] || '' });
  if (list.length > 20) list.shift();
  db.data.playedInSession = list;

  // Update session stats
  db.data.session.totalPlays++;
  if (song.dt) db.data.session.totalMinutes += Math.round(song.dt / 60000);

  // Update artist × timeSlot pattern matrix
  if (artist) {
    const h = new Date().getHours();
    const slot = h < 6 ? 'night' : h < 9 ? 'morning' : h < 14 ? 'noon' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night';
    if (!db.data.prefs.patternMatrix[artist]) db.data.prefs.patternMatrix[artist] = {};
    db.data.prefs.patternMatrix[artist][slot] = (db.data.prefs.patternMatrix[artist][slot] || 0) + 1;

    // Update Markov transition matrix (use second-to-last = previous song)
    const played = db.data.playedInSession || [];
    if (played.length >= 2) {
      const prev = played[played.length - 2];
      if (prev.artist && prev.artist !== artist) {
        if (!db.data.transitions[prev.artist]) db.data.transitions[prev.artist] = {};
        db.data.transitions[prev.artist][artist] = (db.data.transitions[prev.artist][artist] || 0) + 1;
      }
    }
  }

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

// ---- Session footprint (played-in-session) ----

export function addPlayedInSession(song) {
  const list = db.data.playedInSession || [];
  list.push({ id: song.id, name: song.name, artist: (song.ar || [])[0] || '' });
  if (list.length > 20) list.shift();
  db.data.playedInSession = list;
  scheduleWrite();
}

export function getPlayedInSession(n = 5) {
  return (db.data.playedInSession || []).slice(-n);
}

// ---- Deprecated facts (conflict versioning) ----

export function getDeprecatedFacts() {
  return db.data.prefs.deprecatedFacts || [];
}

export async function deprecateFact(factId, reason = '') {
  const facts = db.data.prefs.facts || [];
  const ext = db.data.prefs.extensionFacts || [];
  const target = facts.find(f => f.id === factId) || ext.find(f => f.id === factId);
  if (target) {
    db.data.prefs.deprecatedFacts.push({
      ...target,
      deprecatedAt: new Date().toISOString(),
      reason,
      supersededBy: reason,
    });
    db.data.prefs.facts = facts.filter(f => f.id !== factId);
    db.data.prefs.extensionFacts = ext.filter(f => f.id !== factId);
    scheduleWrite();
  }
}

export function getSessionStats() {
  return { ...db.data.session };
}

// ---- Markov transition matrix (Laplace + global decay) ----

export function decayTransitions(factor = 0.995) {
  const trans = db.data.transitions || {};
  for (const [from, targets] of Object.entries(trans))
    for (const to of Object.keys(targets))
      trans[from][to] = Math.max(1, Math.round(trans[from][to] * factor));
  scheduleWrite();
}
decayTransitions();

export function getNextArtist(currentArtist, n = 3) {
  const trans = db.data.transitions || {};
  const next = trans[currentArtist] || {};
  const allA = new Set(Object.keys(trans));
  const smoothed = {};
  for (const a of allA) if (a !== currentArtist) smoothed[a] = (next[a] || 0) + 1;
  for (const [a, c] of Object.entries(next)) smoothed[a] = Math.max(smoothed[a] || 0, c);
  return Object.entries(smoothed).sort((a, b) => b[1] - a[1]).slice(0, n).map(([a, c]) => ({ artist: a, count: c }));
}

// ---- Cut history (two-level penalty) ----

export function addCutRecord(songId, artist) {
  const h = db.data.cutHistory || [];
  h.push({ songId, artist, time: new Date().toISOString() });
  if (h.length > 50) h.shift();
  db.data.cutHistory = h;
  scheduleWrite();
}

export function shouldPenalizeArtist(artist) {
  const recent = (db.data.cutHistory || []).slice(-10).filter(c => c.artist === artist);
  return new Set(recent.map(c => c.songId)).size >= 2;
}

// ---- Emotion trajectory ----

export function addEmotionPoint(valence) {
  const traj = db.data.emotionTrajectory || [];
  traj.push({ valence, time: new Date().toISOString() });
  if (traj.length > 20) traj.shift();
  db.data.emotionTrajectory = traj;
  scheduleWrite();
}

export function getEmotionTrajectory(n = 5) {
  return (db.data.emotionTrajectory || []).slice(-n);
}

export function isEmotionDropping() {
  const traj = db.data.emotionTrajectory || [];
  if (traj.length < 3) return false;
  const last3 = traj.slice(-3);
  const vals = last3.map(t => t.valence);
  if (!(vals[0] > vals[1] && vals[1] > vals[2])) return false;
  if (Math.abs(vals[2] - vals[0]) < 0.3) return false;
  const dur = (new Date(last3[2].time).getTime() - new Date(last3[0].time).getTime()) / 60000;
  return dur >= 5;
}

// ---- BM25 document frequency ----

export function updateBM25DF(factContent) {
  const words = new Set(factContent.toLowerCase().replace(/[，。！？、；：""''【】《》\s]/g, ' ').split(/\s+/).filter(w => w.length > 0));
  const df = db.data.termDF || {};
  for (const w of words) df[w] = (df[w] || 0) + 1;
  db.data.termDF = df;
}

export function getTermDF() { return db.data.termDF || {}; }
export function getTotalDocCount() { return (db.data.prefs?.facts?.length || 0) + (db.data.prefs?.extensionFacts?.length || 0) + 1; }

// Get pattern matrix for a specific time slot
export function getPatternForSlot(slot, n = 5) {
  const matrix = db.data.prefs.patternMatrix || {};
  return Object.entries(matrix)
    .filter(([, slots]) => slots[slot] > 0)
    .sort((a, b) => (b[1][slot] || 0) - (a[1][slot] || 0))
    .slice(0, n)
    .map(([artist, slots]) => ({ artist, count: slots[slot] }));
}

// Get dislikes list
export function getDislikes() {
  return db.data.prefs.dislikes || [];
}

export async function addDislike(artist) {
  if (!db.data.prefs.dislikes.includes(artist)) {
    db.data.prefs.dislikes.push(artist);
    if (db.data.prefs.dislikes.length > 50) db.data.prefs.dislikes.shift();
    scheduleWrite();
  }
}

export async function removeDislike(artist) {
  db.data.prefs.dislikes = db.data.prefs.dislikes.filter(d => d !== artist);
  scheduleWrite();
}

// Get candidate facts (pending confirmation)
export function getCandidateFacts() {
  return db.data.prefs.candidateFacts || [];
}

export async function addCandidateFact(fact) {
  const candidates = db.data.prefs.candidateFacts || [];
  const existing = candidates.find(c => c.id === fact.id);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.updated = new Date().toISOString();
    // Promote to core facts if observed ≥2 times
    if (existing.count >= 2) {
      const coreFacts = db.data.prefs.facts || [];
      existing.confidence = Math.min(0.9, existing.confidence + 0.3);
      coreFacts.push({ ...existing, category: fact.category, content: fact.content });
      if (coreFacts.length > 30) coreFacts.sort((a, b) => (b.confidence * b.count) - (a.confidence * a.count)).splice(30);
      db.data.prefs.facts = coreFacts;
      db.data.prefs.candidateFacts = candidates.filter(c => c.id !== fact.id);
    }
  } else {
    candidates.push({ ...fact, count: 1, created: new Date().toISOString(), updated: new Date().toISOString() });
    if (candidates.length > 100) candidates.shift();
    db.data.prefs.candidateFacts = candidates;
  }
  scheduleWrite();
}

// Get extension facts (for search, not injected into context)
export function getExtensionFacts() {
  return db.data.prefs.extensionFacts || [];
}

export async function addExtensionFact(fact) {
  const ext = db.data.prefs.extensionFacts || [];
  const existing = ext.find(e => e.id === fact.id);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.updated = new Date().toISOString();
  } else {
    ext.push({ ...fact, created: new Date().toISOString(), updated: new Date().toISOString() });
    if (ext.length > 500) ext.sort((a, b) => (b.confidence * b.count) - (a.confidence * a.count)).splice(500);
    // Update BM25 document frequency for new fact
    updateBM25DF(fact.content);
  }
  db.data.prefs.extensionFacts = ext;
  scheduleWrite();
}

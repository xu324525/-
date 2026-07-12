import { getTopArtistsLongTerm, getArtistStats, getSongStats, getRecentPlays } from '../state/db.js';

export function scoreSong(song, prefs) {
  let score = 0;
  const topArtists = getTopArtistsLongTerm(10).map(a => a.name);
  for (const a of (song.ar || []).filter(Boolean)) {
    const idx = topArtists.indexOf(a);
    if (idx >= 0) score += (topArtists.length - idx) * 2;
    const stats = getArtistStats(a);
    if (stats && stats.playCount > 10) score += Math.min(stats.playCount, 30);
  }
  if ((song.dt || 0) > 180000) score += 2;
  const songStats = getSongStats(song.id);
  if (songStats && songStats.playCount > 20) score -= songStats.playCount;
  const recent = getRecentPlays(50);
  const idx = recent.findIndex(p => p.id === song.id);
  if (idx >= 0) score -= 200 + (50 - idx) * 10;
  return score;
}

export function relevanceScore(song, query) {
  let s = 0;
  const q = (query || '').toLowerCase();
  if (!q) return s;
  if (q.includes(song.name.toLowerCase()) || song.name.toLowerCase().includes(q)) s += 10;
  for (const a of (song.ar || [])) {
    const aname = (typeof a === 'string' ? a : a.name || '').toLowerCase();
    if (aname && q.includes(aname)) s += 8;
  }
  const arNames = (song.ar || []).map(a => typeof a === 'string' ? a : a.name || '').join(' ').toLowerCase();
  if (arNames && q.includes(arNames)) s += 5;
  return s;
}

export function pickBest(songs, prefs, count = 3, query = '') {
  if (!songs.length) return [];
  return songs.map(s => ({
    song: s,
    score: scoreSong(s, prefs) + relevanceScore(s, query)
  }))
    .sort((a, b) => b.score - a.score).slice(0, count).map(x => x.song);
}

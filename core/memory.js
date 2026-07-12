import { readFileSync, existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import config from '../config.js';
import { getRecentMessages, getRecentPlays, getPrefs, updatePrefs } from '../state/db.js';

const MEMORY_PATH = resolve(config.USER_DIR, 'memory.md');

// ---- 1. HERMES FROZEN SNAPSHOT: memory.md ----

// Read once at module load (frozen snapshot pattern)
let _snapshot = null;
export function getMemorySnapshot() {
  if (_snapshot === null) {
    try { _snapshot = existsSync(MEMORY_PATH) ? readFileSync(MEMORY_PATH, 'utf-8').trim() : ''; } catch { _snapshot = ''; }
  }
  return _snapshot;
}

// Agent-controlled memory writes (add/remove lines)
export async function rememberLine(text) {
  const current = getMemorySnapshot();
  const line = `- ${text}`;
  const updated = current.includes(line) ? current : current + '\n' + line;
  await writeFile(MEMORY_PATH, updated, 'utf-8');
  _snapshot = updated;
}

export async function forgetLine(pattern) {
  const current = getMemorySnapshot();
  const lines = current.split('\n');
  const filtered = lines.filter(l => !l.includes(pattern));
  const updated = filtered.join('\n');
  await writeFile(MEMORY_PATH, updated, 'utf-8');
  _snapshot = updated;
}

// ---- 2. STRUCTURED FACTS STORE ----

// Facts format: { id, category, content, confidence, created, updated }
// Categories: user_habit, preference, mood, event, relationship, discovery

function factId(content) {
  // Simple stable hash for dedup
  let h = 0;
  for (let i = 0; i < content.length; i++) { h = ((h << 5) - h) + content.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

function getFacts() {
  return getPrefs().facts || [];
}

async function addFact(category, content, confidence = 0.5) {
  const prefs = getPrefs();
  const facts = prefs.facts || [];
  const id = factId(content.slice(0, 60));
  const existing = facts.find(f => f.id === id);
  const now = new Date().toISOString();

  if (existing) {
    // Update existing fact: bump confidence, update time
    existing.content = content;
    existing.confidence = Math.min(1, existing.confidence + confidence * 0.3);
    existing.updated = now;
    existing.count = (existing.count || 1) + 1;
  } else {
    facts.push({ id, category, content, confidence, created: now, updated: now, count: 1 });
    // Keep max 100 facts
    if (facts.length > 100) facts.splice(0, facts.length - 100);
  }
  await updatePrefs({ facts });
}

function formatFacts(facts) {
  if (!facts || !facts.length) return '';
  const byCat = {};
  for (const f of facts.sort((a, b) => (b.confidence * (b.count || 1)) - (a.confidence * (a.count || 1)))) {
    (byCat[f.category] = byCat[f.category] || []).push(f);
  }
  const catLabels = { user_habit: '习惯', preference: '偏好', mood: '情绪', event: '事件', relationship: '关联', discovery: '发现' };
  let text = '';
  for (const [cat, items] of Object.entries(byCat)) {
    const label = catLabels[cat] || cat;
    text += `\n${label}: ${items.slice(0, 3).map(f => f.content).join('；')}`;
  }
  return text.trim();
}

// ---- 3. WRITE-BEFORE-COMPRESS: LLM Fact Extraction ----

async function extractFacts() {
  const messages = getRecentMessages(80);
  if (messages.length < 20) return;

  // Build conversation transcript for analysis
  const transcript = messages.map(m => `[${m.role}] ${m.content}`).join('\n');
  const userMsgs = messages.filter(m => m.role === 'user').slice(-20);

  // Heuristic fact extraction — categories with patterns
  const facts = [];

  // Mood detection
  const moodMap = {
    '累': { cat: 'mood', fact: '用户感到疲惫', conf: 0.6 },
    '困': { cat: 'mood', fact: '用户睡眠不足', conf: 0.5 },
    '烦': { cat: 'mood', fact: '用户心情烦躁，需要舒缓', conf: 0.6 },
    '难过|伤心|emo|down|sad': { cat: 'mood', fact: '用户情绪低落', conf: 0.7 },
    '开心|高兴|太好了|哈哈|爽|nice': { cat: 'mood', fact: '用户心情不错', conf: 0.6 },
    '焦虑|压力|紧张': { cat: 'mood', fact: '用户感到压力/焦虑', conf: 0.7 },
    '无聊': { cat: 'mood', fact: '用户感到无聊，想听新鲜的', conf: 0.5 },
    '深夜|凌晨|失眠|睡不着': { cat: 'user_habit', fact: '用户经常深夜听歌', conf: 0.8 },
  };
  for (const m of userMsgs) {
    for (const [pattern, { cat, fact, conf }] of Object.entries(moodMap)) {
      if (new RegExp(pattern).test(m.content)) {
        facts.push({ cat, fact, conf });
      }
    }
  }

  // Habit detection
  if (userMsgs.filter(m => /^漫游$/.test(m.content.trim())).length >= 3) {
    facts.push({ cat: 'user_habit', fact: '偏好漫游模式听歌，不喜欢自己选', conf: 0.8 });
  }
  if (userMsgs.filter(m => /继续/.test(m.content)).length >= 3) {
    facts.push({ cat: 'user_habit', fact: '经常连续听歌不停歇', conf: 0.7 });
  }

  // Time-based habit
  const nightMsgs = userMsgs.filter(m => {
    const t = m.time ? new Date(m.time) : null;
    return t && (t.getHours() >= 23 || t.getHours() < 5);
  });
  if (nightMsgs.length >= 3) {
    facts.push({ cat: 'user_habit', fact: '深夜听歌频次高', conf: 0.9 });
  }

  // Artist preferences from conversation
  for (const m of userMsgs) {
    const artists = m.content.match(/周杰伦|林俊杰|陈奕迅|丁世光|陈粒|孙燕姿|A-Lin|邓紫棋|薛之谦|Taylor|Ed Sheeran|Justin Bieber|陶喆|方大同|李荣浩|林宥嘉|五月天|苏打绿|告五人|草东|万能青年旅店/g);
    if (artists) {
      for (const a of artists) {
        facts.push({ cat: 'preference', fact: `喜欢听${a}`, conf: 0.7 });
      }
    }
  }

  // Song name extraction — from ALL messages (user + assistant)
  for (const m of messages) {
    // Match 《song name》 and "song name" patterns
    const bookMatches = [...m.content.matchAll(/《([^》]{1,40})》/g)];
    for (const match of bookMatches) {
      const songName = match[1].trim();
      if (songName.length >= 2 && songName.length <= 40) {
        // Check if it's a song mention (not just random text in quotes)
        const ctx = m.content;
        const isMusicCtx = /歌|曲|听|唱|播|放|推荐|喜欢|爱/.test(ctx.slice(Math.max(0, match.index - 10), match.index));
        if (isMusicCtx || m.role === 'assistant') {
          facts.push({ cat: 'discovery', fact: `听过《${songName}》`, conf: 0.6 });
        }
      }
    }
    // Also match quoted song names: "song name" (assistant replies often use this)
    const quoteMatches = [...m.content.matchAll(/"([^"]{1,40})"/g)];
    for (const match of quoteMatches) {
      const songName = match[1].trim();
      if (songName.length >= 2 && songName.length <= 40 && !/[，。！？、；：]/.test(songName)) {
        facts.push({ cat: 'discovery', fact: `听过《${songName}》`, conf: 0.5 });
      }
    }
    // Extract from assistant's song recommendations
    if (m.role === 'assistant') {
      const reasonMatch = m.content.match(/《([^》]+)》/g);
      if (reasonMatch) {
        for (const rm of reasonMatch) {
          const name = rm.replace(/[《》]/g, '').trim();
          if (name.length >= 2 && name.length <= 40) {
            facts.push({ cat: 'discovery', fact: `推荐过《${name}》`, conf: 0.5 });
          }
        }
      }
    }
  }

  // Interaction style
  const shortMsgs = userMsgs.filter(m => m.content.trim().length < 4);
  if (shortMsgs.length >= 5 && userMsgs.length >= 10) {
    facts.push({ cat: 'user_habit', fact: '聊天简洁，喜欢短指令', conf: 0.6 });
  }
  const longMsgs = userMsgs.filter(m => m.content.trim().length > 30);
  if (longMsgs.length >= 3) {
    facts.push({ cat: 'user_habit', fact: '愿意跟agent深度交流', conf: 0.5 });
  }

  // Dedup and store
  const seen = new Set();
  for (const { cat, fact, conf } of facts) {
    const key = cat + ':' + fact;
    if (!seen.has(key)) {
      seen.add(key);
      await addFact(cat, fact, conf);
    }
  }
}

// ---- 4. SUMMARIZE WITH LLM (Write-Before-Compress) ----

export async function maybeSummarize(force = false) {
  const messages = getRecentMessages(200);
  const prefs = getPrefs();
  const lastIdx = prefs.lastSummaryIdx || 0;
  const newMsgs = messages.slice(lastIdx);

  if (!force && newMsgs.length < 30) return;

  // STEP 1: Write-before-compress — extract critical facts first
  await extractFacts();

  // STEP 2: Build structured session block
  const userMsgs = newMsgs.filter(m => m.role === 'user');
  const assistantMsgs = newMsgs.filter(m => m.role === 'assistant');
  const blocks = [];

  // Time range
  const firstTime = newMsgs[0]?.time;
  const lastTime = newMsgs[newMsgs.length - 1]?.time;
  if (firstTime && lastTime) {
    const d1 = new Date(firstTime);
    const d2 = new Date(lastTime);
    if (d1.toDateString() === d2.toDateString()) {
      blocks.push(`${d1.getMonth() + 1}月${d1.getDate()}日`);
    } else {
      blocks.push(`${d1.getMonth() + 1}/${d1.getDate()}-${d2.getMonth() + 1}/${d2.getDate()}`);
    }
  }

  // Operations
  const ops = [...new Set(userMsgs.map(m => m.content.trim()).filter(c => {
    return /^漫游$|^继续$|^排行榜$|^歌单$|^推荐$|^新歌$|^热门歌手$|^搜索|^播放/.test(c);
  }))];
  if (ops.length) blocks.push(`操作: ${ops.slice(0, 5).join('→')}`);

  // Mood signals (from fact extraction results)
  const facts = getFacts();
  const recentMoods = facts.filter(f => f.category === 'mood').slice(0, 3);
  if (recentMoods.length) blocks.push(`情绪: ${recentMoods.map(f => f.content).join('，')}`);

  // Key agent replies (sample unique ones)
  const replies = assistantMsgs.slice(-5).map(m => m.content);
  if (replies.length) blocks.push(`回复: ${[...new Set(replies)].slice(-3).join(' | ')}`);

  // Merge
  const oldSummary = prefs.summary || '';
  const newBlock = blocks.join(' — ');
  const oldBlocks = oldSummary ? oldSummary.split('\n---\n').filter(Boolean) : [];
  oldBlocks.push(newBlock);
  const summary = oldBlocks.slice(-5).join('\n---\n');

  if (summary) {
    await updatePrefs({ summary, lastSummaryIdx: messages.length });
  }
}

// ---- 5. STATISTICAL PLAY PATTERNS ----

const DECAY_HALF = 7;
function decayWeight(timestamp, now = Date.now()) {
  const daysAgo = (now - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, daysAgo / DECAY_HALF);
}

export function analyzePatterns() {
  const plays = getRecentPlays(500);
  const prefs = getPrefs();
  if (plays.length < 5) return '';

  const now = Date.now();
  let totalWeight = 0;
  const buckets = { morning: 0, noon: 0, afternoon: 0, evening: 0, night: 0 };
  const artistWeights = {};
  const artistTimes = {};

  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    if (!p.time) continue;
    const w = decayWeight(p.time, now);
    totalWeight += w;
    const h = new Date(p.time).getHours();
    const bucket = h < 6 ? 'night' : h < 9 ? 'morning' : h < 12 ? 'noon' : h < 14 ? 'noon' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night';
    buckets[bucket] += w;
    const artist = typeof p.ar === 'string' ? p.ar : (p.ar || [])[0];
    if (artist) {
      artistWeights[artist] = (artistWeights[artist] || 0) + w;
      if (!artistTimes[artist]) artistTimes[artist] = { morning: 0, noon: 0, afternoon: 0, evening: 0, night: 0 };
      artistTimes[artist][bucket] += w;
    }
  }

  const timeLabels = { morning: '早上', noon: '中午', afternoon: '下午', evening: '晚上', night: '深夜' };
  const total = totalWeight || 1;
  const topTimes = Object.entries(buckets).filter(([, v]) => v / total > 0.1).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${timeLabels[k]}(${Math.round(v / total * 100)}%)`);

  const topArtists = Object.entries(artistWeights).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => name);

  const artistAffinity = topArtists.slice(0, 3).map(a => {
    const times = artistTimes[a] || {};
    const best = Object.entries(times).sort((x, y) => y[1] - x[1])[0];
    return best && best[1] > 0 ? `${a}→${timeLabels[best[0]] || best[0]}` : a;
  });

  let patterns = `时段: ${topTimes.join('、')}`;
  patterns += `\n歌手: ${topArtists.slice(0, 5).join('、')}`;
  if (artistAffinity.some(a => a.includes('→'))) patterns += `\n关联: ${artistAffinity.join(' ')}`;
  updatePrefs({ patterns }).catch(() => {});
  return patterns;
}

// ---- 6. BUILD MEMORY CONTEXT (injected into system prompt) ----

export function buildMemoryContext() {
  const prefs = getPrefs();
  const parts = [];

  // Frozen snapshot: memory.md
  const snapshot = getMemorySnapshot();
  if (snapshot && snapshot.replace(/^#.*\n?/gm, '').trim()) {
    parts.push(`## 长期记忆\n${snapshot}`);
  }

  // Structured facts (high confidence only)
  const facts = (prefs.facts || []).filter(f => f.confidence >= 0.5).sort((a, b) => (b.confidence * (b.count || 1)) - (a.confidence * (a.count || 1)));
  if (facts.length > 0) {
    parts.push(`## 结构化事实\n${formatFacts(facts)}`);
  }

  // Cross-session summary
  if (prefs.summary) {
    parts.push(`## 会话历史\n${prefs.summary}`);
  }

  // Play patterns
  if (prefs.patterns) {
    parts.push(`## 听歌模式\n${prefs.patterns}`);
  }

  // Active session (last few user messages)
  const recentMsgs = getRecentMessages(5);
  if (recentMsgs.length > 1) {
    const flow = recentMsgs.filter(m => m.role === 'user').slice(-3).map(m => m.content).join(' → ');
    if (flow) parts.push(`## 当前\n${flow}`);
  }

  const ctx = parts.join('\n\n');
  return ctx.length > 1000 ? ctx.slice(0, 1000) + '…' : ctx;
}

// ---- 7. SESSION TOPIC TRACKING ----

export function getSessionTopic() {
  const msgs = getRecentMessages(16);
  const userMsgs = msgs.filter(m => m.role === 'user').slice(-6);
  if (!userMsgs.length) return '';

  // Detect topic keywords
  const keywords = [];
  const topicPatterns = [
    { re: /加班|工作|上班|忙|累|压力|996/i, topic: '工作压力大，需要放松' },
    { re: /考试|复习|学习|背书|刷题/i, topic: '正在备考，需要专注音乐' },
    { re: /失恋|分手|难过|伤心|想哭|emo/i, topic: '情绪低落，需要安慰' },
    { re: /运动|跑步|健身|举铁|gym/i, topic: '在运动，需要节奏感' },
    { re: /睡前|睡觉|失眠|躺/i, topic: '准备入睡，需要安静' },
    { re: /开车|通勤|路上|地铁/i, topic: '在路上，需要陪伴感' },
    { re: /聚会|派对|喝酒|party|嗨/i, topic: '聚会中，需要活跃气氛' },
    { re: /下雨|雨天|雨声/i, topic: '下雨天，需要氛围感' },
  ];

  for (const m of userMsgs) {
    for (const { re, topic } of topicPatterns) {
      if (re.test(m.content)) return topic;
    }
  }

  // Detect if user keeps asking for specific genre/mood
  const genres = userMsgs.map(m => m.content.match(/(?:来点|放|听|换)\s*(.{1,10}?)(?:的|歌|音乐|吧|$)/))
    .filter(Boolean).map(m => m[1]);
  if (genres.length >= 2) return `用户想听${genres[genres.length - 1]}风格`;

  return '';
}


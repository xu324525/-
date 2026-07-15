/**
 * 音乐老友 — 分层记忆系统 v2
 *
 * ┌──────────┬──────────────┬─────────────────────────┐
 * │ 工作记忆  │  情景记忆     │  长期偏好                │
 * │ LLM窗口   │ songStats    │  facts (core ≤30)       │
 * │ 当前会话   │ patternMatrix│  extension (≤500)       │
 * │          │ plays (500)  │  candidate pool (≤100)  │
 * └──────────┴──────────────┴─────────────────────────┘
 *
 * 写: 候选池机制 → 2次确认晋升核心库
 * 管: SM-2衰减(动态半衰期) + 分级存储
 * 读: 语义检索(双字组重叠) + 动态预算上下文
 */

import { readFileSync, existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import config from '../config.js';
import {
  getRecentMessages, getRecentPlays, getPrefs, updatePrefs,
  getTopArtistsLongTerm, getSessionStats, getPatternForSlot,
  getDislikes, addDislike, getCandidateFacts, addCandidateFact,
  getExtensionFacts, addExtensionFact
} from '../state/db.js';

const MEMORY_PATH = resolve(config.USER_DIR, 'memory.md');

// ═══════════════════════════════════════
// LAYER 1: 工作记忆 (LLM context 自带)
// LAYER 2: 情景记忆 — memory.md 快照
// ═══════════════════════════════════════

let _snapshot = null;
export function getMemorySnapshot() {
  if (_snapshot === null) {
    try { _snapshot = existsSync(MEMORY_PATH) ? readFileSync(MEMORY_PATH, 'utf-8').trim() : ''; } catch { _snapshot = ''; }
  }
  return _snapshot;
}

export async function rememberLine(text) {
  const current = getMemorySnapshot();
  const line = `- ${text}`;
  const updated = current.includes(line) ? current : current + '\n' + line;
  await writeFile(MEMORY_PATH, updated, 'utf-8');
  _snapshot = updated;
}

export async function forgetLine(pattern) {
  const current = getMemorySnapshot();
  const filtered = current.split('\n').filter(l => !l.includes(pattern));
  const updated = filtered.join('\n');
  await writeFile(MEMORY_PATH, updated, 'utf-8');
  _snapshot = updated;
}

// ═══════════════════════════════════════
// LAYER 3: 长期偏好 — 分级事实存储
// ═══════════════════════════════════════

function factId(content) {
  let h = 0;
  for (let i = 0; i < content.length; i++) { h = ((h << 5) - h) + content.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

function getCoreFacts() {
  return (getPrefs().facts || []).filter(f => f.confidence >= 0.3);
}

// ---- 语义检索：双字组重叠 + 置信度加权 ----

function bigrams(text) {
  const set = new Set();
  const s = text.toLowerCase().replace(/[，。！？、；：""''【】《》\s]/g, '');
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function semanticScore(factContent, query) {
  const fb = bigrams(factContent);
  const qb = bigrams(query);
  if (qb.size === 0) return 0;
  let overlap = 0;
  for (const b of qb) { if (fb.has(b)) overlap++; }
  // Jaccard-like: overlap / (union * 0.5 + overlap * 0.5)
  const union = new Set([...fb, ...qb]).size;
  return union > 0 ? overlap / (union * 0.3 + overlap * 0.7) : 0;
}

// ---- 候选池：待确认事实（confidence < 0.6，需 ≥2 次观察才晋升） ----

async function addCandidateOrPromote(category, content, confidence = 0.5) {
  const id = factId(content.slice(0, 60));
  const coreFacts = getCoreFacts();
  const inCore = coreFacts.find(f => f.id === id);

  if (inCore) {
    // Already in core: boost confidence
    inCore.confidence = Math.min(1, inCore.confidence + confidence * 0.15);
    inCore.updated = new Date().toISOString();
    inCore.count = (inCore.count || 1) + 1;
    await updatePrefs({ facts: coreFacts });
    // Also add to extension for search
    await addExtensionFact(inCore);
  } else {
    // Not in core → candidate pool
    await addCandidateFact({ id, category, content, confidence });
  }
}

// ---- 负向偏好 ----

export async function dislikeArtist(artist) {
  await addDislike(artist);
  // Remove any positive preference facts about this artist
  const coreFacts = getCoreFacts();
  const filtered = coreFacts.filter(f => !f.content.includes(artist) || f.category !== 'preference');
  await updatePrefs({ facts: filtered });
}

// ---- SM-2 启发衰减：动态半衰期 ----

const HALF_LIFE = { mood: 3, preference: 30, user_habit: 14, event: 10, discovery: 21, relationship: 20 };

function decayFacts() {
  const coreFacts = getCoreFacts();
  if (!coreFacts.length) return;
  const now = Date.now();
  let changed = false;

  for (const f of coreFacts) {
    if (!f.updated) continue;
    const days = (now - new Date(f.updated).getTime()) / (1000 * 60 * 60 * 24);
    const half = HALF_LIFE[f.category] || 14;
    // SM-2: Confidence = Base * 0.5^(days/half_life)
    // Base is the observed confidence (stored as "peak")
    const peak = f.peak || f.confidence;
    f.peak = peak; // store peak
    const decayed = peak * Math.pow(0.5, Math.max(0, days) / half);
    f.confidence = Math.max(0, Math.min(peak, decayed));
    if (f.confidence < 0.3) f._remove = true;
    changed = true;
  }

  if (changed) {
    const kept = coreFacts.filter(f => !f._remove).map(f => { delete f._remove; delete f.peak; return f; });
    updatePrefs({ facts: kept }).catch(() => {});
  }
}

decayFacts();

// ---- 整合：相似事实合并 ----

function consolidateFacts() {
  const coreFacts = getCoreFacts();
  if (coreFacts.length < 3) return;
  const merged = [];
  for (const f of coreFacts) {
    const similar = merged.find(m => m.category === f.category && semanticScore(m.content, f.content) > 0.5);
    if (similar) {
      similar.confidence = Math.max(similar.confidence, f.confidence);
      similar.count = (similar.count || 1) + (f.count || 1);
    } else {
      merged.push(f);
    }
  }
  if (merged.length < coreFacts.length) {
    updatePrefs({ facts: merged.slice(0, 30) }).catch(() => {});
  }
}

// ---- 启发式事实提取 ----

const artistList = /周杰伦|林俊杰|陈奕迅|丁世光|陈粒|孙燕姿|邓紫棋|薛之谦|陶喆|方大同|李荣浩|五月天|苏打绿|告五人|草东没有派对|草东|万能青年旅店|王心凌|郑宜农|Coldplay|Adele|郭顶|许嵩|蔡健雅|张惠妹|Taylor Swift|Ed Sheeran|陈绮贞|张悬|安溥/g;

async function extractFacts() {
  const messages = getRecentMessages(60);
  if (messages.length < 15) return;

  const userMsgs = messages.filter(m => m.role === 'user').slice(-15);
  const facts = [];

  const moodMap = [
    { re: /累|疲惫|困|乏|没精神/, cat: 'mood', fact: '用户感到疲惫/困倦', conf: 0.6 },
    { re: /烦|躁|不爽|生气|火大/, cat: 'mood', fact: '用户心情烦躁', conf: 0.6 },
    { re: /难过|伤心|哭|emo|低落|down/, cat: 'mood', fact: '用户情绪低落', conf: 0.7 },
    { re: /开心|高兴|爽|哈哈|快乐|nice/, cat: 'mood', fact: '用户心情不错', conf: 0.6 },
    { re: /焦虑|紧张|慌|担心|怕/, cat: 'mood', fact: '用户焦虑/有压力', conf: 0.7 },
    { re: /失眠|睡不着|深夜|凌晨/, cat: 'user_habit', fact: '用户深夜听歌', conf: 0.8 },
    { re: /加班|工作|忙|996/, cat: 'event', fact: '用户最近工作很忙', conf: 0.6 },
    { re: /复习|考试|学习|看书/, cat: 'event', fact: '用户在备考/学习', conf: 0.7 },
  ];

  for (const m of userMsgs) {
    for (const { re, cat, fact, conf } of moodMap) {
      if (re.test(m.content)) facts.push({ cat, fact, conf });
    }
  }

  if (userMsgs.filter(m => /^漫游$/.test(m.content.trim())).length >= 2)
    facts.push({ cat: 'user_habit', fact: '偏好漫游模式', conf: 0.8 });
  if (userMsgs.filter(m => /继续/.test(m.content)).length >= 3)
    facts.push({ cat: 'user_habit', fact: '喜欢连续听歌不停歇', conf: 0.7 });

  const artistSet = new Set();
  for (const m of userMsgs) {
    const matches = m.content.match(artistList);
    if (matches) for (const a of matches) artistSet.add(a);
  }
  for (const a of artistSet) {
    // Check negative: "不喜欢X" / "别放X"
    const negMatch = userMsgs.some(m => new RegExp(`(?:不喜欢|别放|不要|讨厌|别播).*${a}`).test(m.content));
    if (negMatch) {
      await addDislike(a);
    } else {
      facts.push({ cat: 'preference', fact: `喜欢听${a}`, conf: 0.5 }); // 降低初始置信度→候选池
    }
  }

  if (userMsgs.filter(m => m.content.trim().length < 4).length >= 5)
    facts.push({ cat: 'user_habit', fact: '聊天简洁，习惯短指令', conf: 0.5 });

  // All facts go through candidate pool for verification
  const seen = new Set();
  for (const { cat, fact, conf } of facts) {
    const key = cat + ':' + fact;
    if (!seen.has(key)) { seen.add(key); await addCandidateOrPromote(cat, fact, conf); }
  }
}

// ---- LLM 深度提取 ----

async function extractFactsLLM() {
  const messages = getRecentMessages(50);
  if (messages.length < 25) return;
  const prefs = getPrefs();
  const lastIdx = prefs.lastLLMExtractIdx || 0;
  if (messages.length - lastIdx < 30) return;

  try {
    const { askLLM } = await import('./llm.js');
    const transcript = messages.slice(-30).map(m =>
      `[${m.role === 'user' ? '用户' : '阿乐'}]: ${m.content.slice(0, 120)}`
    ).join('\n');

    const prompt = `从对话提取用户信息。返回JSON数组: [{"category":"偏好/preference|情绪/mood|习惯/user_habit|事件/event","content":"简短中文","confidence":0.3-0.7}]

${transcript}

[{"category":"`;

    const raw = await askLLM('你是用户画像分析师。只返回JSON。', prompt, [], 200);
    if (!raw) return;

    const jsonStr = '{"category":"' + (raw.includes('{"category"') ? raw.split('{"category"').slice(1).join('{"category"') : '');
    try {
      const extracted = JSON.parse('[' + jsonStr + ']');
      if (Array.isArray(extracted)) {
        for (const f of extracted) {
          if (f.category && f.content && f.confidence) {
            await addCandidateOrPromote(f.category, f.content.slice(0, 40), Math.min(0.7, f.confidence));
          }
        }
        await updatePrefs({ lastLLMExtractIdx: messages.length });
      }
    } catch { /* JSON parse failed */ }
  } catch { /* LLM unavailable */ }
}

// ═══════════════════════════════════════
// 读取：语义搜索 + 分层上下文
// ═══════════════════════════════════════

/** 语义检索：双字组重叠 + 置信度加权 */
export function recallMemory(query, maxResults = 5) {
  if (!query) return [];
  const coreFacts = getCoreFacts().filter(f => f.confidence >= 0.3);
  const extension = getExtensionFacts().filter(f => f.confidence >= 0.3);
  const all = [...coreFacts, ...extension];

  // Dedup by id
  const seen = new Set();
  const unique = all.filter(f => { const k = f.id; if (seen.has(k)) return false; seen.add(k); return true; });

  const scored = unique.map(f => ({
    fact: f,
    score: semanticScore(f.content, query) * 10 + f.confidence * 3 + (f.count || 0) * 0.5,
  }));

  // Filter out dislikes
  const dislikes = getDislikes();
  const filtered = scored.filter(s => !dislikes.some(d => s.fact.content.includes(d)));

  return filtered.filter(s => s.score > 0).sort((a, b) => b.score - a.score)
    .slice(0, maxResults).map(s => s.fact);
}

export function getTopFacts(n = 5) {
  return getCoreFacts().filter(f => f.confidence >= 0.5)
    .sort((a, b) => (b.confidence * (b.count || 1)) - (a.confidence * (a.count || 1)))
    .slice(0, n).map(f => f.content);
}

export function getRelevantFacts(topic = '', n = 5) {
  if (topic) return recallMemory(topic, n);
  return getTopFacts(n);
}

// ═══════════════════════════════════════
// 上下文反馈（context-bound feedback）
// ═══════════════════════════════════════

export async function feedbackBoost(pattern, positive = true) {
  const now = new Date();
  const h = now.getHours();
  const slot = h < 6 ? 'night' : h < 9 ? 'morning' : h < 14 ? 'noon' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night';
  const timeLabels = { morning: '早上', noon: '中午', afternoon: '下午', evening: '晚上', night: '深夜' };

  if (!positive) {
    // Negative: add to dislikes instead of penalizing preference
    await addDislike(pattern);
    return;
  }

  // Positive feedback: boost matching facts in core + extension
  const coreFacts = getCoreFacts();
  let found = false;
  for (const f of coreFacts) {
    if (f.content.includes(pattern) || pattern.includes(f.content.slice(0, 20))) {
      f.confidence = Math.min(1, f.confidence + 0.15);
      f.count = (f.count || 1) + 1;
      f.updated = new Date().toISOString();
      found = true;
    }
  }
  if (found) {
    await updatePrefs({ facts: coreFacts });
  } else {
    // New preference → candidate pool
    await addCandidateOrPromote('preference', `喜欢听${pattern}`, 0.5);
  }

  // Contextual boost: create composite fact if mood + artist pattern detected
  const moods = coreFacts.filter(f => f.category === 'mood' && f.confidence >= 0.5);
  const recentMood = moods.slice(-1)[0];
  if (recentMood && found) {
    const compositeContent = `${timeLabels[slot]}${recentMood.content.replace('用户', '')}时偏好${pattern}`;
    await addCandidateOrPromote('relationship', compositeContent, 0.6);
  }

  // Store in extension for future search
  await addExtensionFact({ id: factId(`feedback:${pattern}`), category: 'preference', content: `喜欢听${pattern}`, confidence: 0.7, count: 1 });
}

// ═══════════════════════════════════════
// 摘要 + 模式
// ═══════════════════════════════════════

function formatFacts(facts) {
  if (!facts || !facts.length) return '';
  const byCat = {};
  for (const f of facts.sort((a, b) => (b.confidence * (b.count || 1)) - (a.confidence * (a.count || 1)))) {
    (byCat[f.category] = byCat[f.category] || []).push(f);
  }
  const labels = { user_habit: '习惯', preference: '偏好', mood: '情绪', event: '事件', relationship: '关联', discovery: '发现' };
  let text = '';
  for (const [cat, items] of Object.entries(byCat)) {
    text += `\n${labels[cat] || cat}: ${items.slice(0, 3).map(f => f.content).join('；')}`;
  }
  return text.trim();
}

export async function maybeSummarize(force = false) {
  const messages = getRecentMessages(200);
  const prefs = getPrefs();
  const lastIdx = prefs.lastSummaryIdx || 0;
  const newMsgs = messages.slice(lastIdx);
  if (!force && newMsgs.length < 30) return;

  await extractFacts();
  extractFactsLLM().catch(() => {});
  decayFacts();
  consolidateFacts();

  const userMsgs = newMsgs.filter(m => m.role === 'user');
  const assistantMsgs = newMsgs.filter(m => m.role === 'assistant');
  const blocks = [];

  const ft = newMsgs[0]?.time, lt = newMsgs[newMsgs.length - 1]?.time;
  if (ft && lt) {
    const d1 = new Date(ft), d2 = new Date(lt);
    blocks.push(d1.toDateString() === d2.toDateString()
      ? `${d1.getMonth() + 1}月${d1.getDate()}日`
      : `${d1.getMonth() + 1}/${d1.getDate()}-${d2.getMonth() + 1}/${d2.getDate()}`);
  }

  const ops = [...new Set(userMsgs.map(m => m.content.trim()).filter(c =>
    /^漫游$|^继续$|^排行榜$|^歌单$|^推荐$|^新歌$|^热门歌手$|^搜索|^播放/.test(c)
  ))];
  if (ops.length) blocks.push(`操作: ${ops.slice(0, 5).join('→')}`);

  const topF = getTopFacts(3);
  if (topF.length) blocks.push(`关键: ${topF.join('；')}`);

  const replies = assistantMsgs.slice(-3).map(m => m.content.replace(/\n/g, ' ').slice(0, 80));
  if (replies.length) blocks.push(`回复: ${[...new Set(replies)].join(' | ')}`);

  const oldSummary = prefs.summary || '';
  const newBlock = blocks.join(' — ');
  const oldBlocks = oldSummary ? oldSummary.split('\n---\n').filter(Boolean) : [];
  oldBlocks.push(newBlock);
  const summary = oldBlocks.slice(-5).join('\n---\n');

  if (summary) {
    await updatePrefs({ summary, lastSummaryIdx: messages.length });
  }
}

// ═══════════════════════════════════════
// 播放模式
// ═══════════════════════════════════════

const DECAY_HALF = 7;
function decayWeight(timestamp, now = Date.now()) {
  return Math.pow(0.5, (now - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24) / DECAY_HALF);
}

export function analyzePatterns() {
  const plays = getRecentPlays(500);
  if (plays.length < 5) return '';
  const now = Date.now();
  let totalWeight = 0;
  const buckets = { morning: 0, noon: 0, afternoon: 0, evening: 0, night: 0 };
  const artistWeights = {};

  for (const p of plays) {
    if (!p.time) continue;
    const w = decayWeight(p.time, now);
    totalWeight += w;
    const h = new Date(p.time).getHours();
    buckets[h < 6 ? 'night' : h < 9 ? 'morning' : h < 12 ? 'noon' : h < 14 ? 'noon' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night'] += w;
    const artist = typeof p.ar === 'string' ? p.ar : (p.ar || [])[0];
    if (artist) artistWeights[artist] = (artistWeights[artist] || 0) + w;
  }

  const timeLabels = { morning: '早上', noon: '中午', afternoon: '下午', evening: '晚上', night: '深夜' };
  const total = totalWeight || 1;
  const topTimes = Object.entries(buckets).filter(([, v]) => v / total > 0.1)
    .sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([k, v]) => `${timeLabels[k]}(${Math.round(v / total * 100)}%)`);

  const topArtists = Object.entries(artistWeights).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);
  const longTerm = getTopArtistsLongTerm(5).map(a => a.name);
  const allArtists = [...new Set([...topArtists, ...longTerm])].slice(0, 6);

  let patterns = '';
  if (topTimes.length) patterns += `时段: ${topTimes.join('、')}`;
  if (allArtists.length) patterns += `\n歌手: ${allArtists.join('、')}`;

  updatePrefs({ patterns }).catch(() => {});
  return patterns;
}

// ═══════════════════════════════════════
// 读取：动态预算上下文构建
// ═══════════════════════════════════════

/** 取当前时段 Top N 歌手 */
function getTopForCurrentSlot(n = 3) {
  const h = new Date().getHours();
  const slot = h < 6 ? 'night' : h < 9 ? 'morning' : h < 14 ? 'noon' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night';
  return getPatternForSlot(slot, n);
}

export function buildMemoryContext() {
  const prefs = getPrefs();
  const parts = [];
  const dislikes = getDislikes();

  // ① System prompt (角色设定在 context.js 中，这里只拼数据)

  // ② 长期记忆快照 — Top 5 事实 + 负向过滤 (≤300字)
  const snapshot = getMemorySnapshot();
  if (snapshot && snapshot.replace(/^#.*\n?/gm, '').trim()) {
    const lines = snapshot.split('\n').filter(l => l.trim().startsWith('-'));
    const filtered = lines.filter(l => !dislikes.some(d => l.includes(d)));
    if (filtered.length) parts.push(`## 长期记忆\n${filtered.slice(-10).join('\n')}`);
  }

  // ③ 当前时段场景模式 (≤200字) —— 过滤 dislikes
  const slotArtists = getTopForCurrentSlot(10).filter(a => !dislikes.includes(a.artist)).slice(0, 3);
  if (slotArtists.length) {
    const slotNames = slotArtists.map(a => `${a.artist}(${a.count}次)`).join('、');
    parts.push(`## 当前时段偏好\n${slotNames}`);
  }

  // ④ 高置信度 facts — 排除 dislikes (≤300字)
  const facts = getCoreFacts().filter(f => f.confidence >= 0.5 && !dislikes.some(d => f.content.includes(d)));
  if (facts.length > 0) {
    parts.push(`## 用户画像\n${formatFacts(facts)}`);
  }

  // ⑤ 听歌模式
  if (prefs.patterns) {
    parts.push(`## 听歌模式\n${prefs.patterns}`);
  }

  // ⑥ 最近摘要 — 仅取最近1次
  if (prefs.summary) {
    const blocks = prefs.summary.split('\n---\n');
    const recent = blocks.slice(-1)[0];
    if (recent && recent.length < 400) parts.push(`## 近期回顾\n${recent}`);
  }

  // ⑦ 当前对话流 (≤5轮)
  const recentMsgs = getRecentMessages(10);
  if (recentMsgs.length > 1) {
    const flow = recentMsgs.filter(m => m.role === 'user').slice(-5).map(m => m.content.slice(0, 40)).join(' → ');
    if (flow) parts.push(`## 当前\n${flow}`);
  }

  const ctx = parts.join('\n\n');
  return ctx.length > 1500 ? ctx.slice(0, 1500) + '…' : ctx;
}

// ═══════════════════════════════════════
// 话题 + 情绪检测
// ═══════════════════════════════════════

export function getEmotionalContext() {
  const msgs = getRecentMessages(10);
  const userMsgs = msgs.filter(m => m.role === 'user').slice(-4);
  if (!userMsgs.length) return '';

  const moodPatterns = [
    { re: /累|疲惫|困|乏|没精神/, label: '疲惫' },
    { re: /烦|躁|不爽|生气|火大/, label: '烦躁' },
    { re: /难过|伤心|哭|emo|低落|down/, label: '低落' },
    { re: /开心|高兴|爽|哈哈|快乐|nice/, label: '开心' },
    { re: /焦虑|紧张|慌|担心|怕/, label: '焦虑' },
    { re: /无聊|没劲|没意思/, label: '无聊' },
    { re: /安静|平静|放松|舒服/, label: '平静' },
  ];
  for (const m of userMsgs) {
    for (const { re, label } of moodPatterns) {
      if (re.test(m.content)) return label;
    }
  }
  return '';
}

export function getSessionTopic() {
  const msgs = getRecentMessages(16);
  const userMsgs = msgs.filter(m => m.role === 'user').slice(-6);
  if (!userMsgs.length) return '';

  const patterns = [
    { re: /加班|工作|上班|忙|压力|996/, topic: '工作压力' },
    { re: /考试|复习|学习|背书|刷题/, topic: '备考学习' },
    { re: /睡前|睡觉|失眠|躺/, topic: '睡前放松' },
    { re: /运动|跑步|健身/, topic: '运动' },
    { re: /开车|通勤|路上|地铁/, topic: '通勤' },
    { re: /聚会|派对|喝酒|party/, topic: '聚会' },
    { re: /下雨|雨天/, topic: '下雨天' },
  ];
  for (const m of userMsgs) {
    for (const { re, topic } of patterns) {
      if (re.test(m.content)) return topic;
    }
  }

  const moods = getCoreFacts().filter(f => f.category === 'mood' && f.confidence >= 0.4);
  if (moods.length) return moods.slice(-1)[0].content;
  return '';
}

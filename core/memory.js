/**
 * 音乐老友 — 分层记忆系统
 *
 * ┌─────────────────┬──────────────────┬─────────────────────┐
 * │  工作记忆 (WM)   │  情景记忆 (EM)    │  长期偏好 (LTM)      │
 * │  当前会话上下文   │  近期交互+状态     │  稳定用户画像         │
 * │  LLM context窗口 │  songStats/plays  │  facts + taste + md │
 * │  仅限当前会话     │  数小时~数周 衰减   │  持久化              │
 * └─────────────────┴──────────────────┴─────────────────────┘
 *
 * 写入：LLM remember字段 + 反馈信号（喜欢/跳过）→ 更新置信度
 * 管理：时间衰减 + 去重 + 定期清理低置信度事实
 * 读取：按相关性分层检索，只注入最相关的记忆到 LLM 上下文
 */

import { readFileSync, existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import config from '../config.js';
import { getRecentMessages, getRecentPlays, getPrefs, updatePrefs, getTopArtistsLongTerm } from '../state/db.js';

const MEMORY_PATH = resolve(config.USER_DIR, 'memory.md');

// ═══════════════════════════════════════════
// LAYER 1: 工作记忆 — LLM context 窗口自带
// ═══════════════════════════════════════════
// (由 context.js 的 buildChatHistory 实现)

// ═══════════════════════════════════════════
// LAYER 2: 情景记忆 — 冻结快照 memory.md
// ═══════════════════════════════════════════

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
  const lines = current.split('\n');
  const filtered = lines.filter(l => !l.includes(pattern));
  const updated = filtered.join('\n');
  await writeFile(MEMORY_PATH, updated, 'utf-8');
  _snapshot = updated;
}

// ═══════════════════════════════════════════
// LAYER 3: 长期偏好 — 结构化事实存储
// ═══════════════════════════════════════════
// Facts: { id, category, content, confidence, created, updated, count }
// Categories: user_habit, preference, mood, event, relationship, discovery

function factId(content) {
  let h = 0;
  for (let i = 0; i < content.length; i++) { h = ((h << 5) - h) + content.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36);
}

function getFacts() {
  return (getPrefs().facts || []).filter(f => f.confidence >= 0.3);
}

async function addFact(category, content, confidence = 0.5) {
  const prefs = getPrefs();
  const facts = prefs.facts || [];
  const id = factId(content.slice(0, 60));
  const existing = facts.find(f => f.id === id);
  const now = new Date().toISOString();

  if (existing) {
    existing.content = content;
    existing.confidence = Math.min(1, existing.confidence + confidence * 0.3);
    existing.updated = now;
    existing.count = (existing.count || 1) + 1;
  } else {
    facts.push({ id, category, content, confidence, created: now, updated: now, count: 1 });
    if (facts.length > 100) facts.splice(0, facts.length - 100);
  }
  await updatePrefs({ facts });
}

// ---- 反馈驱动：显式信号（喜欢/跳过）调整置信度 ----

export async function feedbackBoost(pattern, positive = true) {
  const prefs = getPrefs();
  const facts = prefs.facts || [];
  let changed = false;
  for (const f of facts) {
    if (f.content.includes(pattern) || pattern.includes(f.content.slice(0, 20))) {
      f.confidence = Math.min(1, f.confidence + (positive ? 0.15 : -0.15));
      f.updated = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) {
    prefs.facts = facts.filter(f => f.confidence >= 0.3);
    await updatePrefs({ facts: prefs.facts });
  }
}

// ---- 管理：时间衰减 ----

function decayFacts() {
  const prefs = getPrefs();
  const facts = prefs.facts || [];
  if (!facts.length) return;
  const now = Date.now();
  let changed = false;
  for (const f of facts) {
    const days = (now - new Date(f.updated).getTime()) / (1000 * 60 * 60 * 24);
    if (f.category === 'mood') {
      // 情绪：指数衰减，半衰期 3 天
      f.confidence = f.confidence * Math.pow(0.5, Math.max(0, days - 1) / 3);
    } else if (days > 7) {
      // 偏好/习惯：线性慢衰减
      f.confidence = Math.max(0, f.confidence - (days - 7) * 0.01);
    }
    if (f.confidence < 0.3) f.confidence = 0; // flaga for removal
    changed = true;
  }
  if (changed) {
    prefs.facts = facts.filter(f => f.confidence >= 0.3);
    updatePrefs({ facts: prefs.facts }).catch(() => {});
  }
}

decayFacts(); // module load 时执行

// ---- 管理：去重合并 ----

function consolidateFacts() {
  const prefs = getPrefs();
  const facts = prefs.facts || [];
  if (facts.length < 5) return;
  const merged = [];
  const seen = new Set();
  // 按置信度排序，高置信度优先保留
  const sorted = [...facts].sort((a, b) => (b.confidence * (b.count || 1)) - (a.confidence * (a.count || 1)));
  for (const f of sorted) {
    const key = f.category + ':' + f.id;
    const similar = merged.find(m => m.category === f.category && m.id === f.id);
    if (similar) {
      similar.confidence = Math.max(similar.confidence, f.confidence);
      similar.count += f.count || 1;
    } else if (!seen.has(key)) {
      seen.add(key);
      merged.push(f);
    }
  }
  if (merged.length < facts.length) {
    updatePrefs({ facts: merged.slice(0, 100) }).catch(() => {});
  }
}

// ---- 写入：从对话提取事实（启发式 + 可升级为 LLM） ----

async function extractFacts() {
  const messages = getRecentMessages(60);
  if (messages.length < 15) return;

  const userMsgs = messages.filter(m => m.role === 'user').slice(-15);
  const facts = [];

  // 情绪检测
  const moodMap = {
    '累|疲惫|困|乏': { cat: 'mood', fact: '用户感到疲惫/困倦', conf: 0.6 },
    '烦|躁|不爽|生气': { cat: 'mood', fact: '用户心情烦躁', conf: 0.6 },
    '难过|伤心|emo|down|sad|哭|低落': { cat: 'mood', fact: '用户情绪低落', conf: 0.7 },
    '开心|高兴|爽|nice|哈哈|快乐': { cat: 'mood', fact: '用户心情不错', conf: 0.6 },
    '焦虑|压力|紧张|慌|担心': { cat: 'mood', fact: '用户焦虑/有压力', conf: 0.7 },
    '失眠|睡不着|深夜|凌晨': { cat: 'user_habit', fact: '用户深夜听歌', conf: 0.8 },
    '加班|工作|忙|996': { cat: 'event', fact: '用户最近工作很忙', conf: 0.6 },
    '复习|考试|学习|看书': { cat: 'event', fact: '用户在备考/学习', conf: 0.7 },
  };
  for (const m of userMsgs) {
    for (const [pattern, { cat, fact, conf }] of Object.entries(moodMap)) {
      if (new RegExp(pattern).test(m.content)) {
        facts.push({ cat, fact, conf });
      }
    }
  }

  // 行为模式
  if (userMsgs.filter(m => /^漫游$/.test(m.content.trim())).length >= 2)
    facts.push({ cat: 'user_habit', fact: '偏好漫游模式', conf: 0.8 });
  if (userMsgs.filter(m => /继续/.test(m.content)).length >= 3)
    facts.push({ cat: 'user_habit', fact: '喜欢连续听歌不停歇', conf: 0.7 });

  // 歌手偏好
  const artistSet = new Set();
  const artistRegex = /周杰伦|林俊杰|陈奕迅|丁世光|陈粒|孙燕姿|邓紫棋|薛之谦|陶喆|方大同|李荣浩|五月天|苏打绿|告五人|草东|万能青年旅店|王心凌|郑宜农|Coldplay|Adele|郭顶|许嵩|蔡健雅|张惠妹|Taylor Swift|Ed Sheeran/g;
  for (const m of userMsgs) {
    const matches = m.content.match(artistRegex);
    if (matches) for (const a of matches) artistSet.add(a);
  }
  for (const a of artistSet) {
    facts.push({ cat: 'preference', fact: `喜欢听${a}`, conf: 0.7 });
  }

  // 互动风格
  if (userMsgs.filter(m => m.content.trim().length < 4).length >= 5)
    facts.push({ cat: 'user_habit', fact: '聊天简洁，习惯短指令', conf: 0.6 });

  // 去重写入
  const seen = new Set();
  for (const { cat, fact, conf } of facts) {
    const key = cat + ':' + fact;
    if (!seen.has(key)) { seen.add(key); await addFact(cat, fact, conf); }
  }
}

// ---- LLM-powered extraction: deep analysis of conversation ----

async function extractFactsLLM() {
  const messages = getRecentMessages(50);
  if (messages.length < 25) return;
  // Only run if we haven't run in the last 30 messages
  const prefs = getPrefs();
  const lastLLMExtract = prefs.lastLLMExtractIdx || 0;
  if (messages.length - lastLLMExtract < 30) return;

  try {
    const { askLLM } = await import('./llm.js');
    const recent = messages.slice(-30);
    const transcript = recent.map(m => `[${m.role === 'user' ? '用户' : '阿乐'}]: ${m.content.slice(0, 150)}`).join('\n');
    const prompt = `分析这段音乐对话，提取用户的关键信息。返回 JSON 数组，每条包含 category(偏好/preference, 情绪/mood, 习惯/user_habit, 事件/event), content(简短中文, ≤15字), confidence(0.3-0.9)。

${transcript}

[{"category":"`;

    const raw = await askLLM('你是用户画像分析师。只返回 JSON。', prompt, [], 200);
    if (!raw) return;

    // Parse: [{"category":"mood","content":"用户感到疲惫","confidence":0.7},...]
    const jsonStr = '{"category":"' + (raw.includes('{"category"') ? raw.split('{"category"').slice(1).join('{"category"') : '');
    try {
      const facts = JSON.parse('[' + jsonStr + ']');
      if (Array.isArray(facts)) {
        for (const f of facts) {
          if (f.category && f.content && f.confidence) {
            await addFact(f.category, f.content.slice(0, 40), Math.min(0.9, f.confidence));
          }
        }
        await updatePrefs({ lastLLMExtractIdx: messages.length });
      }
    } catch {
      // JSON parse failed, fall back to heuristic — already done
    }
  } catch (e) {
    // LLM unavailable, no problem
    console.log('[memory] LLM extraction skipped:', e.message);
  }
}

// ═══════════════════════════════════════════
// 读取：按相关性分层检索
// ═══════════════════════════════════════════

/** 按关键词搜索记忆（用于 agent 主动回忆） */
export function recallMemory(query, maxResults = 5) {
  if (!query) return [];
  const q = query.toLowerCase();
  const facts = getFacts().filter(f => f.confidence >= 0.4);
  const scored = facts.map(f => {
    let score = 0;
    const c = f.content.toLowerCase();
    if (c.includes(q)) score += 10;
    // Category bonus
    if (q.includes('喜欢') && f.category === 'preference') score += 5;
    if ((q.includes('心情') || q.includes('情绪')) && f.category === 'mood') score += 5;
    score += f.confidence * 3 + (f.count || 0) * 0.5;
    return { fact: f, score };
  });
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, maxResults).map(s => s.fact);
}

/** 获取与当前话题最相关的记忆 */
export function getRelevantFacts(topic = '', maxResults = 5) {
  if (topic) return recallMemory(topic, maxResults);
  // 无话题时返回最高置信度事实
  return getFacts().filter(f => f.confidence >= 0.5)
    .sort((a, b) => (b.confidence * (b.count || 1)) - (a.confidence * (a.count || 1)))
    .slice(0, maxResults);
}

/** Top N 事实摘要 */
export function getTopFacts(n = 5) {
  return getFacts().filter(f => f.confidence >= 0.5)
    .sort((a, b) => (b.confidence * (b.count || 1)) - (a.confidence * (a.count || 1)))
    .slice(0, n).map(f => f.content);
}

// ═══════════════════════════════════════════
// 摘要 + 模式分析
// ═══════════════════════════════════════════

function formatFacts(facts) {
  if (!facts || !facts.length) return '';
  const byCat = {};
  for (const f of facts.sort((a, b) => (b.confidence * (b.count || 1)) - (a.confidence * (a.count || 1)))) {
    (byCat[f.category] = byCat[f.category] || []).push(f);
  }
  const catLabels = { user_habit: '习惯', preference: '偏好', mood: '情绪', event: '事件', relationship: '关联', discovery: '发现' };
  let text = '';
  for (const [cat, items] of Object.entries(byCat)) {
    text += `\n${catLabels[cat] || cat}: ${items.slice(0, 3).map(f => f.content).join('；')}`;
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
  extractFactsLLM().catch(() => {}); // fire-and-forget, don't block summarization
  decayFacts();
  consolidateFacts();

  const userMsgs = newMsgs.filter(m => m.role === 'user');
  const assistantMsgs = newMsgs.filter(m => m.role === 'assistant');
  const blocks = [];

  const firstTime = newMsgs[0]?.time;
  const lastTime = newMsgs[newMsgs.length - 1]?.time;
  if (firstTime && lastTime) {
    const d1 = new Date(firstTime), d2 = new Date(lastTime);
    blocks.push(d1.toDateString() === d2.toDateString()
      ? `${d1.getMonth() + 1}月${d1.getDate()}日`
      : `${d1.getMonth() + 1}/${d1.getDate()}-${d2.getMonth() + 1}/${d2.getDate()}`);
  }

  const ops = [...new Set(userMsgs.map(m => m.content.trim()).filter(c =>
    /^漫游$|^继续$|^排行榜$|^歌单$|^推荐$|^新歌$|^热门歌手$|^搜索|^播放/.test(c)
  ))];
  if (ops.length) blocks.push(`操作: ${ops.slice(0, 5).join('→')}`);

  const topFacts = getTopFacts(3);
  if (topFacts.length) blocks.push(`关键: ${topFacts.join('；')}`);

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

// ═══════════════════════════════════════════
// 播放模式分析（情景记忆 → 长期偏好）
// ═══════════════════════════════════════════

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

  let patterns = ``;
  if (topTimes.length) patterns += `时段: ${topTimes.join('、')}`;
  if (allArtists.length) patterns += `\n歌手: ${allArtists.join('、')}`;

  updatePrefs({ patterns }).catch(() => {});
  return patterns;
}

// ═══════════════════════════════════════════
// 读取：构建分层记忆上下文（注入 LLM）
// ═══════════════════════════════════════════

export function buildMemoryContext() {
  const prefs = getPrefs();
  const parts = [];

  // 1. 长期记忆快照（最重要——用户手动写的或 agent 长期记录的）
  const snapshot = getMemorySnapshot();
  if (snapshot && snapshot.replace(/^#.*\n?/gm, '').trim()) {
    parts.push(`## 长期记忆\n${snapshot}`);
  }

  // 2. 高置信度事实（结构化、已衰减筛选）
  const facts = getFacts().filter(f => f.confidence >= 0.5);
  if (facts.length > 0) {
    parts.push(`## 用户画像\n${formatFacts(facts)}`);
  }

  // 3. 播放模式（统计得出）
  if (prefs.patterns) {
    parts.push(`## 听歌模式\n${prefs.patterns}`);
  }

  // 4. 跨会话摘要
  if (prefs.summary) {
    parts.push(`## 近期回顾\n${prefs.summary}`);
  }

  // 5. 当前对话流（工作记忆）
  const recentMsgs = getRecentMessages(5);
  if (recentMsgs.length > 1) {
    const flow = recentMsgs.filter(m => m.role === 'user').slice(-3).map(m => m.content).join(' → ');
    if (flow) parts.push(`## 正在\n${flow}`);
  }

  const ctx = parts.join('\n\n');
  return ctx.length > 1200 ? ctx.slice(0, 1200) + '…' : ctx;
}

// ═══════════════════════════════════════════
// 会话话题检测
// ═══════════════════════════════════════════

export function getSessionTopic() {
  const msgs = getRecentMessages(16);
  const userMsgs = msgs.filter(m => m.role === 'user').slice(-6);
  if (!userMsgs.length) return '';

  const topicPatterns = [
    { re: /加班|工作|上班|忙|压力|996/i, topic: '工作压力', mood: '紧绷的' },
    { re: /考试|复习|学习|背书|刷题/i, topic: '备考学习', mood: '专注的' },
    { re: /失恋|分手|难过|伤心|想哭|emo/i, topic: '情绪低落', mood: '低落的' },
    { re: /运动|跑步|健身|举铁|gym/i, topic: '运动', mood: '充满活力的' },
    { re: /睡前|睡觉|失眠|躺/i, topic: '睡前放松', mood: '疲惫的' },
    { re: /开车|通勤|路上|地铁/i, topic: '通勤路上', mood: '放空的' },
    { re: /聚会|派对|喝酒|party|嗨/i, topic: '聚会', mood: '兴奋的' },
    { re: /下雨|雨天|雨声/i, topic: '下雨天', mood: '安静的' },
    { re: /无聊|没劲|没意思/i, topic: '无聊', mood: '无聊的' },
    { re: /开心|高兴|爽|nice|哈哈|快乐/i, topic: '心情不错', mood: '开心的' },
  ];
  for (const m of userMsgs) {
    for (const { re, topic } of topicPatterns) {
      if (re.test(m.content)) return topic;
    }
  }

  // Fall back to stored mood facts
  const moods = getFacts().filter(f => f.category === 'mood' && f.confidence >= 0.4);
  if (moods.length) return moods.slice(-1)[0].content;

  return '';
}

/** Get detected emotional state for context injection */
export function getEmotionalContext() {
  const msgs = getRecentMessages(10);
  const userMsgs = msgs.filter(m => m.role === 'user').slice(-4);
  if (!userMsgs.length) return '';

  const moodPatterns = [
    { re: /累|疲惫|困|乏|没精神/i, label: '疲惫' },
    { re: /烦|躁|不爽|生气|火大/i, label: '烦躁' },
    { re: /难过|伤心|哭|emo|低落|down/i, label: '低落' },
    { re: /开心|高兴|爽|哈哈|快乐|nice/i, label: '开心' },
    { re: /焦虑|紧张|慌|担心|怕/i, label: '焦虑' },
    { re: /无聊|没劲|没意思/i, label: '无聊' },
    { re: /安静|平静|放松|舒服/i, label: '平静' },
  ];
  for (const m of userMsgs) {
    for (const { re, label } of moodPatterns) {
      if (re.test(m.content)) return label;
    }
  }
  return '';
}

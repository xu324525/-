import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import config from '../config.js';
import { getRecentMessages, getRecentPlays, getPrefs, getTopArtistsLongTerm, getSessionStats } from '../state/db.js';
import { buildMemoryContext, getSessionTopic, recallMemory, getEmotionalContext } from './memory.js';

function readUserFile(name) {
  const p = resolve(config.USER_DIR, name);
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

let cachedPersona = null;
function getPersona() {
  if (!cachedPersona) {
    try { cachedPersona = readFileSync(resolve(config.PROMPTS_DIR, 'dj_persona.md'), 'utf-8'); } catch { cachedPersona = '你是用户的音乐老友。'; }
  }
  return cachedPersona;
}

function timeContext() {
  const now = new Date();
  const h = now.getHours();
  const w = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  let vibe = h < 6 ? '深夜' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 22 ? '晚上' : '深夜';
  let special = '';
  if (w === '五' && h > 17) special = '周五晚';
  else if (w === '六' || w === '日') special = '周末';
  return `现在是周${w} ${h}点，${vibe}。${special}`;
}

// Short TTL cache — system prompt is expensive to rebuild (memory context, file reads)
let _promptCache = { key: '', value: '', time: 0 };

export function buildSystemPrompt(loginInfo = {}) {
  const cacheKey = `${loginInfo.loggedIn ? '1' + loginInfo.nickname : '0'}_${new Date().getHours()}_${getRecentPlays(3).map(p => p.id).join(',')}`;
  if (_promptCache.key === cacheKey && Date.now() - _promptCache.time < 15000) return _promptCache.value;

  const djPersona = getPersona();
  const taste = readUserFile('taste.md');
  const prefs = getPrefs();
  const plays = getRecentPlays(10);
  const recentTracks = plays.map(p => {
    const ar = typeof p.ar === 'string' ? p.ar : (p.ar || []).join('/');
    return p.name + (ar ? ' - ' + ar : '');
  }).filter(Boolean).join('、');

  _promptCache.key = cacheKey;
  _promptCache.value = `${djPersona}

${timeContext()}
${loginInfo.loggedIn ? `用户已登录网易云：${loginInfo.nickname}` : '用户未登录'}
${taste ? '用户自述口味：' + taste.slice(0,200) : ''}

${(() => {
  const topic = getSessionTopic();
  const emotion = getEmotionalContext();
  const parts = [];
  if (emotion) parts.push(`用户情绪: ${emotion}`);
  if (topic) {
    const relevant = recallMemory(topic, 3);
    if (relevant.length) parts.push(`相关记忆: ${relevant.map(f => f.content).join('；')}`);
  }
  return parts.length ? `## 当前感知\n${parts.join('\n')}` : '';
})()}

${buildMemoryContext()}

${(() => {
  const topA = getTopArtistsLongTerm(5);
  const sess = getSessionStats();
  if (topA.length || sess.totalPlays > 0) {
    let s = '';
    if (topA.length) s += `长期最爱歌手: ${topA.map(a => a.name + '(' + a.playCount + '次)').join('、')}`;
    if (sess.totalPlays > 10) s += ` | 累计播放${sess.totalPlays}首`;
    return s;
  }
  return '';
})()}

最近播放过：${recentTracks || '暂无记录'}

你主动管理记忆，发现重要信息就用remember字段记录。根据当前时段和用户情绪，偶尔主动问问ta想不想听点合适的——但别太频繁，自然点。别啰嗦。`;
  _promptCache.time = Date.now();
  return _promptCache.value;
}

export function buildChatHistory() {
  return getRecentMessages(16).map(m => {
    let content = m.content;
    // Skip pure list responses (numbered items) — they waste tokens
    if (m.role === 'assistant' && /^(\d+\.\s|[📊📂🎤📡])/.test(content)) {
      const firstLine = content.split('\n')[0].slice(0, 80);
      content = firstLine + '…';
    }
    // Truncate long messages
    const limit = m.role === 'user' ? 120 : 150;
    if (content.length > limit) content = content.slice(0, limit) + '…';
    return { role: m.role, content };
  });
}

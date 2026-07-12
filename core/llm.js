import axios from 'axios';
import config from '../config.js';

export async function askLLM(systemPrompt, userMessage, history = [], maxTokens = 800) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.post(config.DEEPSEEK_URL, {
        model: config.DEEPSEEK_MODEL,
        messages,
        temperature: 1.1,
        max_tokens: maxTokens,
      }, {
        headers: {
          'Authorization': `Bearer ${config.DEEPSEEK_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });
      return res.data.choices[0].message.content;
    } catch (e) {
      lastError = e;
      if (e.response?.status === 429 || e.response?.status >= 500) {
        // Rate limit or server error — retry with backoff
        if (attempt < 2) await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
      } else {
        // Client error (4xx except 429) — no point retrying
        break;
      }
    }
  }
  console.error('[llm] API error after retries:', lastError?.response?.status, lastError?.message);
  return null;
}

export function parseResponse(raw) {
  if (!raw) return { say: '我好像走神了...再说一次？' };

  try {
    let text = raw.trim();
    // Strip markdown code blocks: ```json ... ``` or ``` ... ```
    text = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
    // Try to extract JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) text = jsonMatch[0];
    const parsed = JSON.parse(text);

    // Normalize play: single object or array
    let plays = [];
    if (Array.isArray(parsed.play)) {
      plays = parsed.play.filter(p => p.type);
    } else if (parsed.play && typeof parsed.play === 'object') {
      plays = [parsed.play];
    }

    return {
      say: parsed.say || raw.slice(0, 200),
      reason: parsed.reason || '',
      segue: parsed.segue || '',
      play: plays.length > 0 ? plays : null,
    };
  } catch {
    // Failed to parse JSON — extract intent from natural text
    const text = raw.slice(0, 500);
    let say = text.replace(/\{[\s\S]*\}/g, '').replace(/```[\s\S]*?```/g, '').trim() || text.slice(0, 200);
    // Try quoted song names first
    let m = text.match(/《(.+?)》/) || text.match(/「(.+?)」/) || text.match(/"(.+?)"/);
    if (m) return { say, play: [{ type: 'search', query: m[1].slice(0, 30) }] };
    // Try "来一首/放一首 XXX" patterns
    m = text.match(/(?:来|放|听|播)(?:一[首个]|首|个)?[《「"]?(.+?)[》」"]?(?:吧|呗|吧|$)/);
    if (m && m[1].length > 1 && m[1].length < 40) return { say, play: [{ type: 'search', query: m[1].slice(0, 30) }] };
    // Try to find any artist/song mention
    m = text.match(/(?:听|放|换|播|推荐|来点)(.{2,20}?)(?:的|歌|音乐|吧|$)/);
    if (m && m[1].trim().length > 1) return { say, play: [{ type: 'search', query: m[1].trim().slice(0, 30) }] };
    return { say, play: null };
  }
}

## 音乐老友 记忆系统框架 v2.1

### 分层架构

```
┌──────────────────────────────────────────────────────────┐
│                    记 忆 分 层                            │
├─────────┬──────────────┬────────────────────────────────┤
│ L1: WM  │  L2: EM      │  L3: LTM                        │
│ 工作记忆 │  情景记忆     │  长期偏好                        │
├─────────┼──────────────┼────────────────────────────────┤
│ LLM窗口  │ DB + 预聚合   │  三级存储 + 版本仲裁              │
│ 会话足迹 │ patternMatrix │  候选池→核心→扩展                │
│ 仅当前   │ 小时~周       │  永久                            │
└─────────┴──────────────┴────────────────────────────────┘
```

---

### 数据模型

```
db.json
├── messages[200]         ← L1: 聊天记录
├── plays[500]            ← L2: 播放记录
├── playedInSession[20]   ← L1: 会话足迹（防止重复推荐）
├── songStats{}           ← L2: 歌曲级统计
├── artistStats{}         ← L2: 歌手级统计
├── session{}             ← L2: 累计统计
└── prefs
    ├── facts[≤30]            ← L3 Core: 高置信度（LLM 上下文注入）
    ├── extensionFacts[≤500]  ← L3 Extension: 全量（检索用）
    ├── candidateFacts[≤100]  ← L3 Pool: 待确认（加权积分晋升）
    ├── deprecatedFacts[]     ← L3 Archive: 软删除 + supersedes
    ├── dislikes[≤50]         ← L3: 负向偏好（独立，不污染 preference）
    ├── patternMatrix{}       ← L2: { 歌手: { 时段: 次数 } }
    ├── summary               ← L3: 跨会话摘要
    └── patterns              ← L3: 播放模式文本

user/
└── memory.md             ← L3: Agent 手写长期记忆快照
```

### 三级存储 + 生命线

```
候选池 (candidateFacts ≤100)
  │  加权积分制: Score = 次数×1.0 + 反馈×2.0
  │  晋升条件: Score ≥ 3.0 AND confidence ≥ 0.65
  │  情绪加权: "超喜欢X" → 初始置信度 0.8
  ▼
核心库 (facts ≤30)
  │  注入 LLM 上下文
  │  SM-2 衰减 + 召回回血
  │  ≥3次命中 → 半衰期永久×2
  ▼
扩展层 (extensionFacts ≤500)
  │  仅用于 recallMemory 检索
  │  不注入上下文
  ▼
废弃层 (deprecatedFacts)
  │  软删除 + supersedes 指针
  │  LLM 上下文自动过滤
```

---

### 语义检索

```
输入: "来点带劲的"
  │
  ├─→ 同义词扩展: 带劲→[摇滚, 电子, 节奏, 嗨]
  │
  ├─→ BM25 (双字组重叠, 权重 0.3): 字符级匹配
  │
  ├─→ 语义评分 (权重 0.7): Jaccard 重叠系数 ×10 + 置信度×3
  │
  ├─→ 过滤: dislikes + deprecatedFacts
  │
  └─→ SM-2 回血: 命中事实 confidence +0.08

音乐同义词典 (9组):
  带劲→摇滚/电子/节奏/嗨   躁动→摇滚/金属/朋克/嗨
  安静→民谣/钢琴/轻音乐/治愈  放松→轻音乐/民谣/爵士/治愈
  嗨→电子/摇滚/舞曲/派对    丧→低落/emo/悲伤/后摇
  甜→流行/恋爱/少女          复古→disco/蒸汽波/citypop
  唯美→古风/纯音乐/钢琴/氛围
```

---

### SM-2 衰减 + 复习回血

| Category | 半衰期 | 公式 |
|----------|--------|------|
| mood | 3天 | `peak × 0.5^(days/3)` |
| preference | 30天 | `peak × 0.5^(days/30)` |
| user_habit | 14天 | `peak × 0.5^(days/14)` |
| event | 10天 | `peak × 0.5^(days/10)` |
| discovery | 21天 | `peak × 0.5^(days/21)` |
| relationship | 20天 | `peak × 0.5^(days/20)` |

**复习回血**: `recallMemory` 命中 → confidence +0.08，重置衰减起点
**固化记忆**: 同一事实 ≥3 次被召回 → 半衰期永久 ×2

---

### 意图感知动态路由

```
用户消息 → detectIntent()
  │
  ├─ 推荐意图 ("漫游"/"放歌"/"继续")
  │   预算: 时段矩阵40% + 画像30% + 模式20% + 回顾10%
  │   加载: patternMatrix + 高置信偏好 + dislikes过滤
  │
  ├─ 闲聊意图 ("好累"/"在干嘛")
  │   预算: 情绪50% + 回顾30% + 快照10% + 画像10%
  │   加载: 情绪事实 + 近期摘要 + 对话流
  │
  └─ 指令意图 ("把X加到歌单")
      预算: 对话流70% + 画像20% + dislikes10% (防误操作)
      加载: 最近对话 + dislikes过滤
```

---

### 反馈信号映射

| 行为 | L1 (工作) | L2 (情景) | L3 (长期) |
|------|-----------|-----------|-----------|
| 点赞 ♡ | — | patternMatrix +1 | confidence +0.15, 反馈权重×2 |
| 切歌 ⏭ | playedInSession +1 | patternMatrix +1 | → **addDislike**（不降 preference） |
| 说"别放X" | — | — | → dislikeArtist, 软删除 deprecated |
| 完整听完 | — | songStats +1 | — |
| "超喜欢X" | — | — | 候选池初始置信度 0.8 |
| recallMemory命中 | — | — | confidence +0.08 回血 |

---

### LLM 上下文示例

```
## 当前时段偏好 (深夜)
草东(8次)、陈粒(5次)

## 用户画像
习惯: 喜欢连续听歌不停歇；聊天简洁
偏好: 喜欢听草东

## 听歌模式
时段: 深夜(60%)、晚上(25%)

## 近期回顾
7/13-7/15 — 深夜疲惫时偏好草东

## 当前
好累 来点草东 → 漫游 → 继续

## 禁止重复
最近5首已播放: 山海 - 草东、晴天 - 周杰伦、大风吹 - 草东
推荐时必须排除，优先推荐同歌手的不同歌曲。
```

---

### API 清单

```js
// === 写入 ===
rememberLine(text)              // Agent 写 memory.md
forgetLine(pattern)             // Agent 删 memory.md
feedbackBoost(artist, positive) // 反馈: positive→boost, !positive→addDislike
dislikeArtist(artist)           // 软删除 deprecated

// === 管理（自动触发）===
decayFacts()                    // SM-2 衰减
consolidateFacts()              // 语义去重合并

// === 读取 ===
recallMemory(query, n)          // 语义检索（同义词+双字组+回血）
getTopFacts(n)                  // Top N 摘要
getEmotionalContext()           // 实时情绪
getSessionTopic()               // 当前场景
buildMemoryContext()            // 意图路由 + 动态预算 + 足迹警告

// === 数据层 (db.js) ===
getPatternForSlot(slot, n)      // 预聚合矩阵查询
getDislikes()                   // 负向偏好
getPlayedInSession(n)           // 会话足迹
getDeprecatedFacts()            // 已废弃事实
addCandidateFact(fact)          // 候选池管理
addExtensionFact(fact)          // 扩展层管理
```

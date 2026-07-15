## 音乐老友 记忆系统框架 v2.2

### 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│                       记 忆 分 层                             │
├───────────┬──────────────────┬───────────────────────────────┤
│ L1: WM    │  L2: EM          │  L3: LTM                       │
│ 工作记忆   │  情景记忆          │  长期偏好                      │
├───────────┼──────────────────┼───────────────────────────────┤
│ LLM 窗口  │ DB + 预聚合        │ 三级存储 + 版本仲裁             │
│ 会话足迹   │ patternMatrix     │ 候选池→核心→扩展→废弃          │
│ 情绪轨迹   │ Markov transitions │ SM-2 衰减 + 复习回血          │
│ 仅当前会话 │ 小时~周            │ 永久                           │
└───────────┴──────────────────┴───────────────────────────────┘
```

---

### 数据模型

```
db.json
├── messages[200]             ← L1: 聊天记录
├── plays[500]                ← L2: 播放记录
├── playedInSession[20]       ← L1: 会话足迹（去重 + 转移矩阵输入）
├── emotionTrajectory[20]     ← L1: 情绪轨迹 [{valence, time}]
├── transitions{}             ← L2: 马尔可夫转移 {artistA: {artistB: count}}
├── songStats{}               ← L2: 歌曲统计
├── artistStats{}             ← L2: 歌手统计
├── session{}                 ← L2: 累计统计
└── prefs
    ├── facts[≤30]                ← L3 Core: 高置信度（LLM上下文注入）
    ├── extensionFacts[≤500]      ← L3 Extension: 全量（检索用）
    ├── candidateFacts[≤100]      ← L3 Pool: 待确认（加权积分+时间折扣）
    ├── deprecatedFacts[]         ← L3 Archive: 软删除 + supersedes
    ├── dislikes[≤50]             ← L3: 负向偏好
    ├── patternMatrix{}           ← L2: {artist: {timeSlot: count}}
    ├── summary                   ← L3: 跨会话摘要
    └── patterns                  ← L3: 播放模式文本

user/
└── memory.md                 ← L3: Agent 手写长期记忆快照
```

---

### 马尔可夫转移矩阵（序列推荐）

```
播放序列: 草东 → 陈粒 → 草东 → 陈粒 → 草东 → 周杰伦
                    ↓
         transitions[草东] = { 陈粒: 2, 周杰伦: 1 }
         transitions[陈粒] = { 草东: 2 }

查询: getNextArtist("草东") → [{artist: "陈粒", count: 2}, {artist: "周杰伦", count: 1}]

LLM 上下文注入: "## 序列规则\n草东后常接: 陈粒(67%)、周杰伦(33%)"
```

---

### 情绪轨迹 + 自动干预

```
用户消息序列: "好嗨" → "还行吧" → "累了"
                    ↓
情绪轨迹:           [+0.7] → [+0.2] → [-0.3]
                    ↓
检测: 连续 2 次下降 → isEmotionDropping() = true
                    ↓
路由: detectIntent() → "recommend_calm"
                    ↓
LLM 上下文: "## 情绪干预\n检测到情绪连续下降，优先推荐平静/治愈类音乐"
```

---

### 语义检索（TF 向量门控 + 同义词兜底）

```
查询: "来点迷幻的"
  │
  ├─ Path 1 (主): TF 词频余弦相似度
  │    → 与所有 extensionFacts 计算 cosine(tf_query, tf_fact)
  │    → 权重: 0.6 (TF ≥ 0.3) 或 0.2 (TF < 0.3)
  │
  ├─ Path 2 (兜底): 双字组重叠 + 9组同义词扩展
  │    → 带劲→摇滚/电子, 安静→民谣/钢琴, ...
  │    → 权重: 0.4 (TF ≥ 0.3) 或 0.8 (TF < 0.3)
  │
  ├─ SM-2 回血: 命中事实 confidence + 0.08
  │
  └─ 过滤: dislikes + deprecatedFacts
```

---

### 候选池加权积分晋升制

```
Score = (提及次数 × 1.0 + 反馈强度 × 2.0) × e^(-0.01 × 天数)

晋升条件: Score ≥ 3.0 AND confidence ≥ 0.65

特殊规则:
  • 情绪加权: "超喜欢X" → 初始置信度 0.8 → 可一次晋升
  • 时间折扣: 30天后权重衰减至 74%，60天后 55%
  • 反馈权重: 点赞 ×2，切歌 ×0（受切歌惩罚独立处理）
```

---

### SM-2 衰减 + 复习回血

| 事实类别 | 半衰期 | 公式 |
|---------|--------|------|
| mood | 3天 | peak × 0.5^(days/3) |
| preference | 30天 | peak × 0.5^(days/30) |
| user_habit | 14天 | peak × 0.5^(days/14) |
| event | 10天 | peak × 0.5^(days/10) |
| relationship | 20天 | peak × 0.5^(days/20) |
| discovery | 21天 | peak × 0.5^(days/21) |

**复习回血**: recallMemory 命中 → confidence + 0.08 + 重置半衰期起点
**固化记忆**: ≥ 3 次召回 → 半衰期永久 × 2

---

### 意图感知动态路由

```
detectIntent()
  │
  ├─ recommend (推荐):  矩阵 40% + 画像 30% + 模式 20% + 回顾 10%
  │   + 马尔可夫序列规则 + 禁止重复警告
  │
  ├─ recommend_calm (干预): 画像 40% + 回顾 20% + 矩阵 20% + 对话 10%
  │   + 情绪干预提示
  │
  ├─ chat (闲聊):       情绪 50% + 回顾 30% + 快照 10% + 画像 10%
  │
  └─ command (指令):    对话 70% + 画像 20% + dislikes 10%
```

---

### 反馈信号映射

| 用户行为 | L1 (工作) | L2 (情景) | L3 (长期) |
|---------|-----------|-----------|-----------|
| 点赞 ♡ | — | patternMatrix +1 | confidence +0.15, 反馈权重 ×2 |
| 切歌 ⏭ | — | — | **切歌惩罚**: 匹配事实 -0.05 + addDislike |
| 说"别放X" | — | — | dislikeArtist → 软删除 deprecated |
| 完整听完 | playedInSession +1 | songStats +1, transitions +1 | — |
| "超喜欢X" | — | — | 候选池初始置信度 0.8 |
| 情绪变化 | emotionTrajectory +1 | — | extractFacts 映射 valence 值 |
| recallMemory 命中 | — | — | confidence + 0.08 复习回血 |

---

### 归因追踪（开发者可观测性）

```js
getAttributionTrace()
// → "路由: 时段night→草东/陈粒 | 转移: 陈粒→草东(2) | 核心: 喜欢听草东 | 情绪轨迹: 0.7→-0.3"
```

实时输出推荐决策链：哪个模块主导、数据来源、状态变化，方便调试和权重调优。

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

## 序列规则
草东后常接: 陈粒(67%)、周杰伦(33%)

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
feedbackBoost(artist, positive) // 正反馈 boost / 负反馈 切歌惩罚
dislikeArtist(artist)           // 软删除 deprecated

// === 管理（自动触发）===
decayFacts()                    // SM-2 衰减
consolidateFacts()              // 语义去重合并

// === 读取 (L3) ===
recallMemory(query, n)          // TF向量 + 同义词 + 回血
getTopFacts(n)                  // Top N 摘要
getEmotionalContext()           // 实时情绪
getSessionTopic()               // 当前场景
buildMemoryContext()            // 意图路由 + 动态预算 + 马尔可夫 + 足迹警告
getAttributionTrace()           // 归因追踪

// === 数据层 (L1/L2) ===
getPatternForSlot(slot, n)      // 预聚合矩阵查询
getNextArtist(artist, n)        // 马尔可夫转移
getEmotionTrajectory(n)         // 情绪轨迹
isEmotionDropping()             // 情绪下降检测
getPlayedInSession(n)           // 会话足迹
getDislikes()                   // 负向偏好
getDeprecatedFacts()            // 已废弃事实
```

## 音乐老友 记忆系统框架 v2

### 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│                       记 忆 分 层                             │
├───────────┬────────────────┬────────────────────────────────┤
│ 工作记忆   │   情景记忆       │       长期偏好                   │
│ L1: WM    │   L2: EM        │       L3: LTM                   │
├───────────┼────────────────┼────────────────────────────────┤
│ 当前对话   │ 近期交互 + 状态  │  稳定用户画像                     │
│ LLM 窗口  │ DB + 衰减       │  持久化 + 分级存储                 │
│ 仅当前会话 │ 小时 ~ 周       │  永久                             │
└───────────┴────────────────┴────────────────────────────────┘
```

---

### 数据模型

```
db.json
├── messages[200]        ← L1: 最近聊天（LLM context 来源）
├── plays[500]           ← L2: 最近播放（去重 + 模式分析源）
├── songStats{}          ← L2: 每首歌播放次数/时间（跨 session 去重）
├── artistStats{}        ← L2: 每位歌手播放次数（长期偏好统计）
├── session{}            ← L2: 累计播放总数/总时长
└── prefs
    ├── facts[≤30]       ← L3 Core: 高置信度事实（LLM 上下文注入）
    ├── extensionFacts[≤500] ← L3 Extension: 全量事实（检索用）
    ├── candidateFacts[≤100] ← L3 Candidate: 待确认事实（≥2次晋升）
    ├── dislikes[≤50]    ← L3: 负向偏好（独立存储，不污染 preference）
    ├── patternMatrix{}  ← L2: 预聚合：{ 歌手: { 时段: 次数 } }
    ├── summary          ← L3: 跨会话摘要（最近 5 块）
    └── patterns         ← L3: 播放模式文本

user/
└── memory.md            ← L3: 冻结快照（Agent 手写长期记忆）
```

### 三级存储的生命周期

```
候选池 (candidateFacts)
  │  首次观察 → 入池 (confidence 0.3-0.5)
  │  ≥2 次观察 → 晋升核心库
  │  长期未确认 → 丢弃
  ▼
核心库 (facts ≤30)
  │  高置信度 (≥0.5)
  │  注入 LLM 上下文
  │  SM-2 衰减
  ▼
扩展层 (extensionFacts ≤500)
  │  所有事实（含核心库副本）
  │  不支持上下文注入，仅用于 recallMemory 检索
  │  持久化
  ▼
删除 (confidence < 0.3)
```

---

### 事实类别与衰减策略

| Category | 示例 | 半衰期 | SM-2 公式 |
|----------|------|--------|-----------|
| `mood` | "用户感到疲惫" | 3 天 | `confidence = peak × 0.5^(days/3)` |
| `preference` | "喜欢听周杰伦" | 30 天 | `confidence = peak × 0.5^(days/30)` |
| `user_habit` | "用户深夜听歌" | 14 天 | `confidence = peak × 0.5^(days/14)` |
| `event` | "用户在备考" | 10 天 | `confidence = peak × 0.5^(days/10)` |
| `discovery` | "听过《晴天》" | 21 天 | `confidence = peak × 0.5^(days/21)` |
| `relationship` | "深夜疲惫时偏好草东" | 20 天 | `confidence = peak × 0.5^(days/20)` |

---

### 语义检索（双字组重叠评分）

```
输入: "来点带劲的"
  → 双字组: ["来点","点带","带劲","劲的"]
  → 对每条事实计算 Jaccard 重叠系数
  → 排序: 重叠分 × 10 + 置信度 × 3 + 观察次数 × 0.5
  → 过滤 dislikes
  → 返回 Top 5

对比:
  关键词匹配: "带劲" → 0 结果（字面不匹配任何事实）
  语义检索:   "带劲" → 匹配到 "喜欢连续听歌不停歇"(双字组"不/停/歇"等有重叠)
```

---

### 写-管-读 三轮循环

```
                    ┌──────────────┐
                    │   用  户     │
                    └──┬───────┬──┘
            对话/指令  │       │ 显式反馈(喜欢/跳过/"别放X")
                       ▼       ▼
┌──────────────────────────────────────────────────────────┐
│                       写 入                               │
│                                                          │
│  extractFacts()     ──→ 8 种情绪 + 歌手 + 行为模式        │
│  extractFactsLLM()  ──→ DeepSeek 分析（每 30 条）         │
│  rememberLine()     ──→ memory.md Agent 手写              │
│  feedbackBoost()    ──→ 喜欢(↓) / 不喜欢(→dislikes)      │
│  dislikeArtist()    ──→ 负向偏好独立存储                  │
│                                                          │
│  所有事实先入候选池 (candidateFacts)                        │
│  ≥2 次观察 → 晋升核心库 (facts)                            │
│  同时副本入扩展层 (extensionFacts)                          │
└──────────────────────┬───────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────┐
│                       管 理                               │
│                                                          │
│  decayFacts()        ──→ SM-2: 动态半衰期衰减             │
│  consolidateFacts()  ──→ 语义去重合并相似事实              │
│  低置信度清除        ──→ confidence < 0.3 自动删除          │
│  分级控制            ──→ core≤30 / ext≤500 / cand≤100      │
│  patternMatrix       ──→ addPlay 时实时更新               │
└──────────────────────┬───────────────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────────────┐
│                       读 取                               │
│                                                          │
│  动态预算 (≤1500 字):                                      │
│    ① 角色设定          — context.js 中 (~200字)            │
│    ② 长期记忆快照      — Top 10 条 + dislikes 过滤 (≤300) │
│    ③ 当前时段偏好      — patternMatrix 直接查 (≤200)      │
│    ④ 用户画像          — 高置信度 facts (≤300)             │
│    ⑤ 听歌模式          — analyzePatterns 统计             │
│    ⑥ 近期回顾          — 最近 1 个会话块 (≤400)            │
│    ⑦ 当前对话流        — 最近 5 条用户消息 (≤200)          │
│                                                          │
│  API:                                                    │
│    recallMemory(q)     — 语义检索（搜索 core + extension）  │
│    getRelevantFacts(t) — 话题匹配                          │
│    getEmotionalContext — 实时情绪（1 词）                   │
│    getSessionTopic     — 当前场景                          │
│    buildMemoryContext  — 分层 LLM 上下文                   │
└──────────────────────────────────────────────────────────┘
```

---

### 反馈信号映射

| 用户行为 | 记忆影响 |
|---------|---------|
| 点赞 ♡ | 候选池或核心库 +0.15 → 候选池不足 2 次则创建候选事实 |
| 取消赞 | 核心库 -0.15 |
| 切歌 ⏭ | → **addDislike**（不降 preference，独立存 dislikes） |
| 说"别放X" | → dislikeArtist，从核心库移除该歌手的 preference 事实 |
| 说"喜欢X" | extractFacts → 候选池 (0.5) |
| 说"烦/累/emo" | extractFacts → 情绪候选事实 (0.6) |
| 深夜疲惫时点赞 | → feedbackBoost 检测 {时间, 情绪} → 生成组合事实 "深夜疲惫时偏好X" |
| 完整听完 | 播放统计 +1（songStats + patternMatrix） |

---

### LLM 获取的上下文示例

```
## 当前感知
用户情绪: 疲惫

## 长期记忆
- 用户深夜时段活跃 氛围感和摇滚交替
- 最近迷上了草东没有派对 尤其是深夜
- 明确不喜欢周杰伦——已列入回避名单

## 当前时段偏好 (深夜)
草东(8次)、陈粒(5次)

## 用户画像
习惯: 喜欢连续听歌不停歇；聊天简洁，习惯短指令
偏好: 喜欢听草东
情绪: 用户感到疲惫/困倦

## 听歌模式
时段: 深夜(60%)、晚上(25%)
歌手: 草东、陈粒

## 近期回顾
7/13-7/15 — 操作: 漫游→继续 — 深夜疲惫时偏好草东

## 当前
好累 来点草东 → 漫游 → 继续
```

---

### API 清单

```js
// 写入
rememberLine(text)              // Agent 写入 memory.md
forgetLine(pattern)             // Agent 删除 memory.md 条目
feedbackBoost(artist, positive) // 反馈驱动：positive → boost, !positive → addDislike
dislikeArtist(artist)           // 明确负向偏好

// 管理（自动触发）
decayFacts()                    // module load + maybeSummarize: SM-2 衰减
consolidateFacts()              // maybeSummarize: 语义去重

// 读取
getMemorySnapshot()             // memory.md 全文
recallMemory(query, n)          // 语义检索（双字组重叠）
getRelevantFacts(topic, n)      // 按话题检索
getTopFacts(n)                  // Top N 高置信度事实摘要
getEmotionalContext()           // 当前情绪（1 词）
getSessionTopic()               // 当前话题
buildMemoryContext()            // 动态预算 LLM 上下文
analyzePatterns()               // 播放模式分析

// 数据层（db.js）
getPatternForSlot(slot, n)      // 预聚合矩阵查询
getDislikes()                   // 负向偏好列表
getCandidateFacts()             // 候选池状态
```

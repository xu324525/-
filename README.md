# 音乐老友 AI 桌面音乐

不只是播放器，是一个**懂你听歌品味的聊天机器人**。

基于网易云音乐 + DeepSeek 大模型 + Electron 桌面端，本地运行，扫码登录即可用。

## 功能

- **AI 漫游** — 每首歌都经过 LLM 思考上下文后选择，不是固定轮替。Agent 记得你刚才听了什么、现在几点、情绪偏哪种
- **自然语言操控** — "来点安静的"、"放周杰伦"、"换个风格"、"推荐理由"——像跟朋友聊天一样
- **无限续播** — 歌曲快结束时自动预取下一批，不中断
- **Hermes 多层记忆** — 长期快照 + 结构化事实 + 跨会话摘要 + 播放模式统计，越用越懂你
- **智能去重** — Session 内绝不重复、同歌手冷却、Fisher-Yates 洗牌、指数衰减惩罚
- **3D 视觉** — Three.js 银河背景、封面波纹动画、歌词逐字渐入
- **桌面常驻** — Electron 包装，系统托盘最小化，全屏沉浸模式

## 快速开始

### 1. 环境要求

- Node.js >= 18
- 网易云音乐账号（扫码登录）

### 2. 安装

```bash
git clone https://github.com/xu324525/yin.git
cd yin
npm install
```

### 3. 配置

复制环境变量模板并填写 DeepSeek API Key：

```bash
cp .env.example .env
```

编辑 `.env`：

```
DEEPSEEK_API_KEY=sk-你的key
```

### 4. 启动

**命令行模式**（浏览器打开 http://localhost:7749）：

```bash
npm start
```

**Electron 桌面端**：

```bash
npm run electron
```

## 使用方式

### 基本操作

| 操作 | 方式 |
|------|------|
| 开始漫游 | 说"漫游"，Agent 开始自动选歌 |
| 下一首 | 说"下一首" / "切歌" / 点 ⏭ 按钮 |
| 暂停/播放 | 点封面或播放按钮 / 按空格键 |
| 喜欢 | 说"喜欢这首歌" / 双击封面 / 点 ♡ |
| 调整音量 | 滚轮在播放器区域滚动 / 上下箭头键 |
| 快进/快退 | 左右箭头键 |
| 进度拖拽 | 拖拽进度条 |

### AI 对话

直接跟它聊天，它听得懂：

- **"来点摇滚"** — 搜摇滚风格歌曲
- **"放周杰伦"** — 搜特定歌手
- **"推荐理由"** — 让 Agent 解释为什么选这首歌
- **"今天听什么"** — 每日推荐
- **"换一首"** — 切歌
- **"换个风格"** — 切换到不同曲风
- **"我的歌单"** — 查看你的网易云歌单
- **"放第3首"** — 从列表中选择

### 快捷键

| 键 | 功能 |
|----|------|
| 空格 | 播放/暂停 |
| ← → | 快退/快进 5 秒 |
| ↑ ↓ | 音量 +/- 10% |
| N | 下一首 |
| P | 上一首 |
| L | 喜欢/取消喜欢 |

## 项目结构

```
├── agent-server.js     # WebSocket + HTTP 服务入口
├── core/
│   ├── router.js       # 消息路由：命令解析、搜索、LLM 调用、播放控制
│   ├── claude.js       # DeepSeek API 客户端 + 响应解析
│   ├── context.js      # 系统提示词构建（时间、记忆、偏好）
│   ├── memory.js       # Hermes 记忆系统（快照/事实/摘要/模式）
│   └── list-state.js   # 列表选择状态
├── state/
│   └── db.js           # LowDB 持久化（消息/播放/偏好）
├── dist/
│   └── index.html      # 前端 SPA（播放器 + 聊天）
├── electron/
│   └── main.js         # Electron 主进程
├── prompts/
│   └── dj_persona.md   # Agent 人设提示词
├── module/             # NetEaseCloudMusicApi 模块
├── server.js           # Express 网易云 API 服务
└── config.js           # 配置加载
```

## 个性化

编辑 `prompts/dj_persona.md` 可以修改 Agent 的性格和说话风格。默认是"用户的音乐老友"——随意、懂你、不啰嗦。

`user/` 目录会随着使用自动生成：
- `memory.md` — AI 发现的长期记忆
- `taste.md` — 你可以写自己的口味偏好
- `routines.md` — 日常习惯记录

## 常见问题

**启动报 SSL 错误？**
公司网络可能有代理拦截。可以在 `config.js` 中配置 `NODE_TLS_REJECT_UNAUTHORIZED=0`。

**登录二维码不显示？**
确认网易云 API 服务正常启动（终端应有 `Server started successfully @ http://localhost:7749`）。

**声音卡顿/暂停？**
检查网络是否稳定，网易云 CDN 偶有波动。已内置音频流断线自动恢复。

## License

MIT

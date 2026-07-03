# Gemini 3.5 Live Translate on Cloudflare Pages

一个免安装的网页同声传译 demo：浏览器采集麦克风音频，用 Gemini 3.5 Live Translate 做低延迟语音到语音翻译，并通过 Cloudflare Pages Functions 代理同源 WebSocket，避免把长期 Gemini API key 放到前端，也提升移动端 / 内置浏览器兼容性。

## 功能

- Gemini Live API model: `gemini-3.5-live-translate-preview`
- 双向同声传译：为两种语言各开一个受限 Live session，同一个麦克风音频同时送入两个 session，`echoTargetLanguage: false` 避免回声式重复朗读
- 不用语言下拉框：用户用自然语言说/写“我说中文，对方说英文”来配置语言
- 低延迟：前端连接同源 `/api/live` WebSocket，Cloudflare Function 只做轻量桥接，避免移动浏览器跨域 WebSocket 问题
- 自动识别说话语言：Gemini Live Translate 处理连续音频流，不要求用户手动切换方向
- 智能降噪：浏览器原生降噪 + 40ms 低延迟音频切片 + 自适应噪声门限，抑制旁边环境音触发
- 实时原文/译文字幕和翻译音频播放
- 数据监控后台：`/admin/` 查看会话量、使用时长、首音频延迟、错误、语言方向和设备分布；只保存指标，不保存录音和聊天内容
- API key 仅存于 Cloudflare secret / 本地 `.dev.vars`

## 产品取舍：为什么有机会比 Google Translate 更好用

Google Translate 已经免费且强大，所以这个页面的优势不是“也能翻译”，而是把面对面聊天的操作降到最低：

1. **无需下载 App / 无需账号流程**：打开链接即可开始。
2. **不用找语言下拉框**：直接说“我说中文，对方说英文”。
3. **不用按方向切换**：两条 Gemini Live Translate session 同时监听，两个人谁说话都自动翻成另一种语言。
4. **更少无效触发**：本地先做噪声门限，背景杂音少发给模型；同时保留短预录缓冲，避免吞掉句首。
5. **同源实时连接**：浏览器只连自己的 Pages 域名，降低微信 / Safari / 移动网络下 WebSocket 失败概率。

## 本地开发

需要 Node.js 22+（Wrangler 4 要求）。

```bash
npm install
printf 'GEMINI_API_KEY="your_api_key_here"\n' > .dev.vars
npm run dev
```

打开 Wrangler 输出的本地地址。麦克风权限只会在点击“开始同声传译”后请求。

## 部署到 Cloudflare Pages

1. 安装依赖：

   ```bash
   npm install
   ```

2. 创建/部署 Pages 项目：

   ```bash
   npx wrangler pages deploy public --project-name gemini-live-translate
   ```

3. 设置 Cloudflare Pages Secret。推荐用交互式命令输入，避免 key 出现在 shell history：

   ```bash
   npx wrangler pages secret put GEMINI_API_KEY --project-name gemini-live-translate
   ```

   或者在 Cloudflare Dashboard → Workers & Pages → 项目 → Settings → Variables and Secrets 添加 Secret：

   - Name: `GEMINI_API_KEY`
   - Value: 你的 Gemini API key

4. 配置监控后台：

   ```bash
   npx wrangler d1 create gemini-live-translate-metrics
   npx wrangler d1 execute gemini-live-translate-metrics --remote --file=migrations/0001_metrics.sql
   npx wrangler pages secret put ADMIN_TOKEN --project-name gemini-live-translate
   ```

5. 重新部署一次，让 Function 拿到 secret 和 D1 binding。

> 不要把 Gemini API key 写进前端 JS、HTML、仓库或 Pages 普通 plaintext variable。这个项目的 `/api/live` / `/api/token` Function 只在服务端使用长期 key。

# 声浪 SonicWave · AI 歌曲生成

参考 suno.cn 交互的本地网页：**输入一句话 → AI 写词 → 谱曲演唱 → 试听 → 下载**。四种引擎可选，默认无需登录、无需 Key 也能用。

![界面预览](preview.png)

## 四种引擎

| | StepFun 阶跃（实验性） | 网页登录态（实验性） | MiniMax 官方接口 | 公益免费 Space |
| --- | --- | --- | --- | --- |
| 触发条件 | 填入 www.stepfun.com 的 Oasis-Token | 填入 www.minimax.cn 的登录 Token | 填入 MiniMax API Key | 不填（默认） |
| 写词 | 本地歌词 / Pollinations | 官方歌词接口 / Pollinations | 官方 `/v1/lyrics_generation`，失败回退 Pollinations | Pollinations |
| 音乐 | `step-music` | 网页版 `music-3.0` / `music-2.6` | `music-3.0-free`（限免，RPM 3）等 | [MiniMax Music 3](https://huggingface.co/spaces/MiniMaxAI/MiniMax-Music3) 公开 Space |
| 额度 | 账号音乐额度（示例账号 10 次） | 网页账号创作次数 | 官方限免模型，按账号限速 | 匿名约 2 分钟 GPU/天 |
| 输出 | MP3 · 44.1kHz | MP3 · 44.1kHz | MP3 · 44.1kHz | WAV · 44.1kHz |
| 实时试听 | 不支持 | 不支持 | 不支持 | 支持，边生成边播放 |

优先级：**StepFun > 网页登录态 > 官方 API Key > 公益 Space**。填了多个时按这个顺序走，页面顶部会显示当前实际使用的引擎。

### StepFun 阶跃音乐（实验性）

网页版内部接口，HTTP 提交 + 轮询：

- 提交：`POST https://www.stepfun.com/api/audio/capy.audio.v1.AudioService/SubmitMusicTask`
- 轮询：`.../GetMusicTask`，`MUSIC_TASK_STATUS_SUCCESS` 后返回 `audioUrl` 和 `duration`
- 额度：`.../GetQuota`（示例账号音乐额度共 10 次）
- 鉴权：`Oasis-Token` Cookie，格式是 `<access>...<refresh>`；服务端通过 `/passport/proto.api.passport.v1.PassportService/RefreshToken` 自动续期
- 固定模型 `step-music`，支持 `instrumental`；歌曲长度由歌词决定

**怎么拿 Token**：登录 <https://www.stepfun.com/studio/audio?tab=music> → DevTools → Application → Cookies → 复制 `Oasis-Token` 的完整值（中间有一个 `...` 分隔两段 JWT），整段粘到网页「接口设置 → StepFun 登录态」。

**注意**：

- access token 约 **30 分钟**过期，refresh token 约 30 天；服务端会先刷新，如果 access 过期太久则需要在网页重新复制。
- 会消耗账号的音乐生成额度，生成记录也会出现在阶跃的「我的作品」里。
- 非官方接口，可能随时失效；自动化使用可能不符合网站条款。
- 从 Render 海外机房访问 `stepfun.com` 可能较慢或被 WAF 拦截。

### 网页登录态（实验性）

网页版没有公开 API，走的是 `www.minimax.cn` 自己的 WebSocket：

- 连接：`wss://www.minimax.cn/v1/api/music/ws`，鉴权参数放在 URL 里
- 签名：`yy = md5(encodeURIComponent(path+query) + "_" + "{}" + md5(unix) + "ooui")`
- 消息：`MusicGen` / `Heartbeat` / `StopMusicGen`，音频以 MP3 分块流式下发，完成后可从历史列表拿到 CDN 地址

**怎么拿 Token**：登录 <https://www.minimax.cn/> → 打开 DevTools → Application → Local Storage → 复制 `_token` 的值（`eyJ...` 开头的 JWT），粘到网页「接口设置 → 网页登录态 Token」。

**必须知道的限制**：

- 这是**非官方接口**，不属于开放平台，可能随时失效；自动化使用也可能不符合网站条款，请自行评估风险。
- 会**消耗你网页账号的创作次数**，生成的歌也会出现在网页版的「我的作品」里。
- Token 大约 **40 天**过期（JWT 的 exp），过期后重新登录复制即可。
- Token 等同于账号登录态，**只在本机使用**；不要把服务开到公网，也不要把 Token 提交到代码仓库。
- 需要 **Node.js 22+**（用内置 WebSocket）；其它引擎 Node 18+ 即可。

### 官方 MiniMax 接口

- 文档：<https://platform.minimaxi.com/docs/api-reference/music-generation>
- Key 获取：<https://platform.minimaxi.com/> → 账户管理 → 接口密钥
- 生成：`POST https://api.minimax.cn/v1/music_generation`
- 写词：`POST https://api.minimax.cn/v1/lyrics_generation`（`mode: write_full_song`）
- 模型：默认 `music-3.0-free`；网页里可切换 `music-2.6-free`（限免）、`music-3.0` / `music-2.6`（按量计费），也可以「跟随服务器配置」由 `MINIMAX_MODEL` 决定
- 纯音乐：`is_instrumental: true`；不写歌词时自动用 `lyrics_optimizer`

Key 只保存在本机浏览器的 localStorage 里，生成时经本机服务转发给 MiniMax，不会写进代码或日志。

### 公益免费路径

不填任何 Key 时，音乐走 MiniMax 官方 Hugging Face Space，写词走 [Pollinations](https://pollinations.ai) 的匿名文本接口。Hugging Face ZeroGPU 按账号/IP 每天限额：

| 身份 | 每日免费 GPU | 大约能生成 |
| --- | --- | --- |
| 未登录 | 2 分钟 | 1 首 30 秒的歌 |
| 免费账号 Token | 5 分钟 | 2~3 首 30~60 秒的歌 |

额度用完会提示，24 小时后自动重置。网页的「接口设置」里可以填 HF Token 提升额度。

## 运行

```bash
cd ai-song
node server.mjs
# 打开 http://127.0.0.1:8899
```

Windows 也可以直接双击 `start.bat`，会自动启动并打开浏览器。

**零依赖**，不需要 `npm install`。出站请求优先使用系统自带的 `curl`（Windows 10+ / macOS 自带），没有 curl 时回退 Node 原生 HTTPS。

## 部署到 Render

项目已内置 `render.yaml`、`/healthz` 健康检查、Render 的 `PORT`/`0.0.0.0` 适配，以及可选的 `ACCESS_PASSWORD` 访问密码。完整步骤见 **[DEPLOY_RENDER.md](DEPLOY_RENDER.md)**。

要点：用 Render Blueprint 连接 GitHub 私有仓库即可；公网实例**务必设置 `ACCESS_PASSWORD`**，并注意免费套餐的文件系统是临时的（歌曲重启会丢）。

## 功能

- **四种引擎**：StepFun 阶跃 / MiniMax 网页登录态 / MiniMax 官方 API / 公益免费 Space，按优先级自动选择
- **简单模式**：一句描述 → AI 写词 → 生成完整歌曲
- **自定义模式**：自己写歌词（`[Verse]` / `[Chorus]` 分段）+ 风格标签
- **纯音乐**：跳过人声
- **实时试听**（仅公益 Space）：生成过程中音频边生成边播放（Web Audio 流式播放 + 可视化）
- **作品库**：自动保存到 `.cache/audio/`，刷新不丢，可下载 MP3 / WAV
- 网页/官方引擎会同时保存模型生成的封面图（CDN 地址）
- 时长 30–180 秒、三档质量（仅公益 Space 生效）
- 生成失败会给出明确原因（Token 失效、Key 无效、余额不足、限流、额度用完、网络等）

## 配置

| 环境变量 | 说明 | 默认 |
| --- | --- | --- |
| `SONICWAVE_PORT` | 端口 | `8899` |
| `HTTPS_PROXY` / `HTTP_PROXY` | 出站代理 | 自动读取 Windows 系统代理 |
| `PROXY=off` | 强制直连 | — |
| `STEP_TOKEN` | 服务器级 StepFun Oasis-Token（等价于网页里填） | 空 |
| `MM_WEB_TOKEN` | 服务器级 MiniMax 网页登录态 Token（等价于网页里填） | 空 |
| `MM_WEB_OP_TICKET` | 网页端的 op_ticket（一般不用填） | 空 |
| `MINIMAX_API_KEY` | 服务器级 MiniMax Key（等价于网页里填） | 空 |
| `MINIMAX_MODEL` | 官方默认模型（网页里可覆盖） | `music-3.0-free` |
| `MINIMAX_BASE` | 官方接口域名 | `https://api.minimax.cn` |
| `HF_TOKEN` | 公益 Space 的 HF Token（可选） | 空 |
| `MAX_CONCURRENT` | 同时生成的任务数 | `2` |
| `ACCESS_PASSWORD` | 公网访问密码（Basic Auth），设置后所有页面/接口都要密码 | 空（不启用） |
| `CACHE_DIR` | 音频缓存目录（挂载 Render Disk 时用） | `.cache` |

> 没开代理时，Hugging Face 在国内通常无法直连，而且直连的 DNS 还可能被污染。程序按这个顺序找通路：环境变量代理 → Windows「Internet 选项」里的系统代理 → 上次成功用过的代理（`.cache/proxy.json`）→ 自动探测本机常见代理端口（7890 / 7897 / 10809 / 10808 / 8888 / 1080 / 8080）。

## 目录

```
ai-song/
├── server.mjs          # 零依赖后端：三引擎 / 代理 / SSE / WS / 缓存
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js          # 流式播放、任务状态、作品库
├── .cache/audio/       # 生成的 MP3 / WAV + 元数据（可随时删除）
└── preview.png
```

## 实现说明

- **公益引擎**：通过 Gradio 的 `studio_generate` 接口，服务端把上游事件流转成 SSE，PCM 块实时推给浏览器用 Web Audio 播放。
- **官方引擎**：一次性 HTTP 返回（`output_format: url`），后端拿到 24 小时有效的音频 URL 后立刻下载缓存。
- **网页引擎**：服务端直连 WebSocket，心跳保活，等到 `status=2` 后用历史列表补全 `audio_url` / 时长 / 封面，再下载缓存。
- **StepFun 引擎**：先刷新 token，再 `SubmitMusicTask` 提交、每 3 秒 `GetMusicTask` 轮询，成功后下载 `audioUrl`。
- 官方和网页引擎没有流式进度，前端用缓动进度条示意；公益引擎是真实进度。
- 上游网络请求优先走 `curl`：国内网络里 Node(OpenSSL) 的 TLS 握手更容易被重置，而 Windows 自带的 curl（Schannel）稳定得多。WebSocket 用 Node 内置实现，直连 `www.minimax.cn`。

## 说明与限制

- StepFun 和 MiniMax 网页登录态都是**非官方、实验性**能力：可能随时失效，可能不符合网站条款，账号也可能因此受限，请自行判断。
- 官方限免模型不扣费但限速（RPM 3）；正式模型按 MiniMax 计费。
- 公益 Space 的匿名额度很小，适合尝鲜；高峰期会排队。
- 请勿做成公开高并发服务，每一次生成都在真实消耗模型方/账号的算力或次数。
- 只有本地服务，没有账号体系；如需局域网/公网访问，改 `HOST=0.0.0.0` 并设置 `ACCESS_PASSWORD`（**不要把带网页 Token 的实例无密码暴露到公网**）。
- 生成的音乐版权归相应模型/平台条款约束，商用前请自行确认。
- `.cache/audio/` 里带有开发时生成的测试曲，可直接删除。
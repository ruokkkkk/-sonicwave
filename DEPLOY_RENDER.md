# 部署到 Render

这个项目已经为 Render 做好适配：自动使用 Render 注入的 `PORT`、监听 `0.0.0.0`、提供 `/healthz`，并支持用 `ACCESS_PASSWORD` 给公网实例加一道访问密码。

推荐用 **Render Blueprint + GitHub 私有仓库**，仓库里已经带好 `render.yaml`。

## 0. 前提

- 一个 GitHub 账号
- 一个 Render 账号（<https://render.com>，用 GitHub 登录即可）
- 本项目的代码（`D:\claude\ai-song`）

## 1. 推到 GitHub

本地仓库已经初始化并提交过。只需要在 GitHub 上新建一个**空仓库**（私有即可），然后：

```bash
cd D:\claude\ai-song
git remote add origin https://github.com/<你的用户名>/sonicwave.git
git push -u origin main
```

> 不要提交 `.cache/`、`.env` 或任何 Token。`.gitignore` 已经排除了它们。

## 2. 在 Render 创建 Blueprint

1. 打开 Render Dashboard → **New → Blueprint**
2. 选择刚才的仓库 `sonicwave`
3. Render 会读到 `render.yaml`，点 **Apply**
4. 它会提示输入 `ACCESS_PASSWORD`（必填建议设置），填一个你自己的密码
5. 等待构建完成，打开生成的 `https://sonicwave-xxxx.onrender.com`

访问时浏览器会弹出 HTTP Basic Auth 登录框：

- 用户名：随便填（例如 `me`）
- 密码：`ACCESS_PASSWORD`

## 手动创建（不想用 Blueprint 时）

Render Dashboard → **New → Web Service** → 选仓库，然后：

| 配置项 | 值 |
| --- | --- |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `node server.mjs` |
| Health Check Path | `/healthz` |
| Instance Type | Free |
| Environment Variables | `NODE_VERSION=24.22.1`、`ACCESS_PASSWORD=你的密码` |

`PORT` 和 `HOST` 不用配，代码检测到 Render 会自动用 `PORT` + `0.0.0.0`。

## 免费套餐要注意

- **闲置 15 分钟会休眠**，下次访问冷启动约 30~60 秒。
- **文件系统是临时的**：`.cache/audio/` 里的歌会在重启/重新部署后消失。要保留就升级付费实例并挂 Disk，例如挂到 `/var/data`，再加环境变量 `CACHE_DIR=/var/data`。
- 每月 750 小时实例时长、100 GB 流量，单实例够用。
- 区域默认 Oregon；Dashboard 里能选 Singapore 的话对中国访问更快。

## 网络

- Render 在美国/新加坡，出网直连 Hugging Face 不需要代理；代码在 Render 上会跳过本机代理探测。
- 官方 API（`api.minimax.cn`）和网页登录态（`www.minimax.cn`）从海外访问通常可用，延迟会比国内高一些。如果发现网页引擎握手失败，先用官方 API 或公益 Space。
- 上游请求用系统自带 `curl`；Render 的 Node 镜像一般自带，缺失时会自动回退 Node 原生 HTTPS。

## 安全（重要）

- **一定要设置 `ACCESS_PASSWORD`**。不设的话，任何拿到 URL 的人都能用你的实例，而且「我的作品」是所有人共享的。
- 不要在**公开实例**的环境变量里配置 `STEP_TOKEN`、`MM_WEB_TOKEN` 或 `MINIMAX_API_KEY`：那等于把你的账号额度开放给所有访问者。让每个用户在自己的浏览器里填自己的 Key/Token 即可。私用实例加了密码后，再考虑配在环境变量里。
- 访客在页面里填的 Key/Token 只保存在**访客自己的浏览器 localStorage**，经你的服务转发给 MiniMax，不会落盘、不会写日志。
- 不要把这套服务暴露成无密码的公网实例后再去配置个人网页 Token。

## 更新

改完代码后：

```bash
git add .
git commit -m "update"
git push
```

Render 的 `autoDeploy: true` 会自动重新部署。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 一直弹密码 / 401 | 浏览器缓存了旧的 Basic Auth，换无痕窗口；或到 Render 环境变量里改 `ACCESS_PASSWORD` |
| 构建报 Node 版本错误 | 确认 `NODE_VERSION=24.22.1`，仓库根目录有 `.node-version` |
| 网页登录态报 Node 不支持 WebSocket | Node 必须是 22+，本项目固定 24 |
| StepFun 报 401 / token is illegal | `Oasis-Token` 的 access 段约 30 分钟过期，重新从 stepfun.com 复制完整值 |
| StepFun 请求被 403/挑战 | 海外机房可能被 WAF 拦截，改用官方 API 或公益 Space |
| 冷启动很慢 | 免费套餐休眠导致，属正常现象 |
| 生成中途断开 | 服务端每 15 秒发心跳保活；检查 Render 日志里是否有上游报错 |
| 作品重启后消失 | 免费套餐文件系统是临时的，需要挂 Disk 并设置 `CACHE_DIR` |
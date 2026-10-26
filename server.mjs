/* 声浪 · 免费 AI 歌曲生成 —— 零依赖 Node 后端
 *
 * 音乐生成：MiniMax Music 3 官方 Hugging Face Space（匿名、免费）
 * 歌词创作：Pollinations 免费文本接口（匿名）
 *
 * 本服务只做三件事：代理跨域请求、把 Gradio 事件流转成 SSE、缓存生成的 WAV。
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import os from 'node:os';
import dns from 'node:dns';

// 优先 IPv4：部分网络环境会先解析到不可用的 IPv6，导致 TLS 握手被重置
dns.setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '.cache');
const AUDIO_DIR = path.join(CACHE_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// 注意：很多环境会预置 PORT，容易冲突，这里用独立变量
// Render 会注入 RENDER=true 和 PORT，并要求监听 0.0.0.0
const IS_RENDER = process.env.RENDER === 'true' || Boolean(process.env.RENDER_SERVICE_ID);
const PORT = Number(process.env.SONICWAVE_PORT) || (IS_RENDER ? Number(process.env.PORT) || 10000 : 8899);
const HOST = process.env.HOST || (IS_RENDER ? '0.0.0.0' : '127.0.0.1');
const ACCESS_PASSWORD = (process.env.ACCESS_PASSWORD || '').trim();
const POLLINATIONS = 'https://text.pollinations.ai';
const MM_WEB_TOKEN = (process.env.MM_WEB_TOKEN || '').trim();
const MM_WEB_OP_TICKET = (process.env.MM_WEB_OP_TICKET || '').trim();
const MM_WEB_BASE = 'https://www.minimax.cn';
const MM_WEB_MODELS = ['music-3.0', 'music-2.6'];
const STEP_BASE = 'https://www.stepfun.com';
const STEP_TOKEN = (process.env.STEP_TOKEN || '').trim();
const STEP_MODEL = 'step-music';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;
const JOB_TTL_MS = 45 * 60 * 1000;

const log = (...a) => console.log('[声浪]', new Date().toLocaleTimeString('zh-CN'), ...a);

/* ------------------------------------------------------------------ *
 * 网络层：支持 HTTP 代理（环境变量或 Windows 系统代理），失败自动直连
 * ------------------------------------------------------------------ */
function proxyFromEnv() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (!raw) return null;
  if (/^socks/i.test(raw)) return null;
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return { host: u.hostname, port: Number(u.port) || 80 };
  } catch { return null; }
}

function proxyFromRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"',
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }
    );
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)) return null;
    const m = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    if (!m) return null;
    let server = m[1].trim();
    if (server.includes('=')) {
      const parts = Object.fromEntries(server.split(';').filter(Boolean).map(s => s.split('=')));
      server = parts.https || parts.http || '';
    }
    const [host, port] = server.replace(/^https?:\/\//, '').split(':');
    if (!host) return null;
    return { host, port: Number(port) || 80 };
  } catch { return null; }
}

const PROXY_OFF = /^(off|0|false|no)$/i.test(process.env.PROXY || '');
const ENV_PROXY = proxyFromEnv();
const REGISTRY_PROXY = proxyFromRegistry();
let PROXY = PROXY_OFF ? null : (ENV_PROXY || REGISTRY_PROXY || null);
// 代理偶尔会抖，不能一次失败就永久放弃：短暂退避后继续尝试
let proxyFailCount = 0;
let proxyBackoffUntil = 0;
let lastProxyProbe = Date.now();
const proxyReady = () => Boolean(PROXY) && Date.now() >= proxyBackoffUntil;

// 系统代理开关是用户随时会动的，定时重新探测（环境变量优先，不动）
function refreshProxy() {
  if (PROXY_OFF || ENV_PROXY) return;
  if (Date.now() - lastProxyProbe < 60000) return;
  lastProxyProbe = Date.now();
  const next = proxyFromRegistry();
  if (next && (!PROXY || next.host !== PROXY.host || next.port !== PROXY.port)) {
    PROXY = next;
    proxyFailCount = 0;
    proxyBackoffUntil = 0;
    log(`检测到系统代理 ${next.host}:${next.port}`);
  }
}

function openTunnel(proxy, targetHost, targetPort, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('代理连接超时')));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`代理 CONNECT 失败 (${res.statusCode})`));
      }
      const tlsSock = tls.connect({ socket, servername: targetHost });
      tlsSock.once('error', reject);
      tlsSock.once('secureConnect', () => resolve(tlsSock));
    });
    req.on('error', reject);
    req.end();
  });
}

class SocketAgent extends https.Agent {
  constructor(socket) {
    super({ keepAlive: false });
    this.socket = socket;
  }
  createConnection(options, cb) {
    cb(null, this.socket);
  }
}

const PROXY_PORTS = [7890, 7897, 10809, 10808, 8888, 1080, 8080, 20171];
const PROXY_CACHE_FILE = path.join(CACHE_DIR, 'proxy.json');

function loadCachedProxy() {
  try {
    const p = JSON.parse(fs.readFileSync(PROXY_CACHE_FILE, 'utf8'));
    if (p && p.port) return { host: p.host || '127.0.0.1', port: Number(p.port) };
  } catch { /* 没有缓存 */ }
  return null;
}

function rememberProxy(p) {
  try { fs.writeFileSync(PROXY_CACHE_FILE, JSON.stringify({ host: p.host, port: p.port })); } catch {}
}

// 上次成功用过的代理，下次启动直接复用（失败会自动重新探测）
if (!PROXY && !PROXY_OFF && !IS_RENDER) PROXY = loadCachedProxy();

function useProxy(p, reason) {
  if (PROXY && PROXY.host === p.host && PROXY.port === p.port) return;
  PROXY = p;
  proxyFailCount = 0;
  proxyBackoffUntil = 0;
  rememberProxy(p);
  log(`${reason}：使用代理 ${p.host}:${p.port}`);
}

let proxyProbe = null;
let lastProbeAt = 0;
/** 探测本机常见代理端口（只做 CONNECT，不握手），用于系统代理关闭但代理仍在运行的场景 */
function probeLocalProxies(host = 'huggingface.co') {
  if (IS_RENDER) return Promise.resolve(null); // 云上没有本机代理
  if (proxyProbe) return proxyProbe;
  if (Date.now() - lastProbeAt < 20000) return Promise.resolve(null);
  lastProbeAt = Date.now();
  proxyProbe = (async () => {
    for (const port of PROXY_PORTS) {
      if (PROXY && PROXY.host === '127.0.0.1' && PROXY.port === port) continue;
      try {
        const sock = await openTunnel({ host: '127.0.0.1', port }, host, 443, 1500);
        sock.destroy();
        return { host: '127.0.0.1', port };
      } catch { /* 该端口不可用 */ }
    }
    return null;
  })().finally(() => { proxyProbe = null; });
  return proxyProbe;
}

function attemptViaProxy(proxy, url, method, headers, body, timeout) {
  return openTunnel(proxy, url.hostname, Number(url.port) || 443, 8000).then(stream =>
    new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        method,
        path: url.pathname + url.search,
        headers,
        agent: new SocketAgent(stream),
      }, res => {
        proxyFailCount = 0;
        proxyBackoffUntil = 0;
        resolve(res);
      });
      req.setTimeout(timeout || 0, () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
      if (body != null) req.write(body);
      req.end();
    })
  );
}

function attemptDirect(url, method, headers, body, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      family: 4,
      method,
      path: url.pathname + url.search,
      headers,
      timeout: timeout || 0,
    }, res => resolve(res));
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * 发起 HTTPS 请求，返回 IncomingMessage。
 * 顺序：当前代理 → 直连 → 重试代理 → 探测本机代理端口。
 * 很多网络环境下直连会被 DNS 污染，代理才是唯一通路。
 */
/* ------------------------------------------------------------------ *
 * curl 传输层
 * 国内网络下 Node(OpenSSL) 的 TLS 握手经常被重置，系统自带的 curl
 * （Windows Schannel / macOS SecureTransport）要稳得多，因此优先用 curl。
 * ------------------------------------------------------------------ */
let CURL_BIN; // undefined=未检测, null=不可用
function detectCurl() {
  if (CURL_BIN !== undefined) return CURL_BIN;
  try {
    const out = execFileSync('curl', ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    CURL_BIN = /^curl /m.test(out) ? 'curl' : null;
  } catch {
    CURL_BIN = null;
  }
  return CURL_BIN;
}

function parseHttpHeader(text) {
  const blocks = String(text).split(/\r?\n\r?\n/).filter(Boolean);
  let status = 0;
  let headers = {};
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(lines[0] || '');
    if (!m) continue;
    status = Number(m[1]);
    headers = {};
    for (const line of lines.slice(1)) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return { status, headers };
}

function curlRequest(urlStr, { method = 'GET', headers = {}, body = null, timeout = 60000, useProxy = true } = {}) {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(6).toString('hex');
    const headerFile = path.join(os.tmpdir(), `sonicwave-h-${token}`);
    const bodyFile = path.join(os.tmpdir(), `sonicwave-b-${token}`);
    const args = ['-sS', '--http1.1', '--suppress-connect-headers', '--connect-timeout', '15',
      '-D', headerFile, '-o', bodyFile, '-X', method];
    if (timeout) args.push('--max-time', String(Math.ceil(timeout / 1000) + 5));
    if (useProxy && PROXY && proxyReady()) args.push('-x', `http://${PROXY.host}:${PROXY.port}`);
    for (const [k, v] of Object.entries(headers)) {
      const key = k.toLowerCase();
      if (key === 'host' || key === 'content-length') continue;
      args.push('-H', `${k}: ${v}`);
    }
    if (body != null) args.push('--data-binary', '@-');
    args.push(urlStr);

    let child;
    try {
      child = spawn(CURL_BIN || 'curl', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(e);
    }

    let stderr = '';
    let settled = false;
    let hard = null;
    const cleanup = () => {
      try { fs.unlinkSync(headerFile); } catch {}
      try { fs.unlinkSync(bodyFile); } catch {}
    };
    const finish = (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      if (err) {
        try { child.kill(); } catch {}
        cleanup();
        reject(err);
        return;
      }
      resolve(res);
    };

    hard = setTimeout(() => finish(new Error('请求超时')), timeout ? timeout + 8000 : 20 * 60 * 1000);

    child.stderr.on('data', d => { stderr += d.toString(); });
    child.stdin.on('error', () => {});
    child.on('error', err => finish(err));
    child.on('exit', code => {
      if (settled) { cleanup(); return; }
      let headerText = '';
      let bodyBuf = Buffer.alloc(0);
      try { headerText = fs.readFileSync(headerFile, 'latin1'); } catch {}
      try { bodyBuf = fs.readFileSync(bodyFile); } catch {}
      const parsed = headerText ? parseHttpHeader(headerText) : { status: 0, headers: {} };
      if (!parsed.status) {
        finish(new Error(stderr.trim() || `curl 退出码 ${code}`));
        cleanup();
        return;
      }
      const stream = Readable.from([bodyBuf]);
      stream.statusCode = parsed.status;
      stream.headers = parsed.headers;
      const origDestroy = stream.destroy.bind(stream);
      stream.destroy = (err) => { try { child.kill(); } catch {} return origDestroy(err); };
      resolve(stream);
      settled = true;
      clearTimeout(hard);
      cleanup();
    });

    if (body != null) child.stdin.end(body); else child.stdin.end();
  });
}

async function nodeRequest(urlStr, { method = 'GET', headers = {}, body = null, timeout = 60000 } = {}) {
  refreshProxy();
  const url = new URL(urlStr);
  const finalHeaders = { 'user-agent': 'SonicWave/1.0 (+local)', 'accept-encoding': 'identity', ...headers };
  if (body != null && finalHeaders['content-length'] == null && finalHeaders['Content-Length'] == null) {
    finalHeaders['content-length'] = Buffer.byteLength(body);
  }

  const errors = [];

  if (PROXY && proxyReady()) {
    try {
      return await attemptViaProxy(PROXY, url, method, finalHeaders, body, timeout);
    } catch (err) {
      errors.push(err);
      proxyFailCount++;
      proxyBackoffUntil = Date.now() + (proxyFailCount >= 2 ? 60000 : 8000);
      log(`代理请求失败（第 ${proxyFailCount} 次）：${err.message}`);
    }
  }

  try {
    return await attemptDirect(url, method, finalHeaders, body, timeout);
  } catch (err) {
    errors.push(err);
  }

  // 直连失败：可能只是暂时退避，或系统代理没开但代理还在跑
  if (PROXY && !proxyReady()) {
    try {
      return await attemptViaProxy(PROXY, url, method, finalHeaders, body, timeout);
    } catch (err) { errors.push(err); }
  }

  const probed = await probeLocalProxies(url.hostname);
  if (probed) {
    try {
      const res = await attemptViaProxy(probed, url, method, finalHeaders, body, timeout);
      useProxy(probed, '自动探测到本机代理');
      return res;
    } catch (err) { errors.push(err); }
  }

  throw errors[0] || new Error('网络连接失败');
}

// 这些域名国内通常可直连，优先直连避免代理抖动拖慢
const DIRECT_FIRST_HOSTS = ['text.pollinations.ai', 'www.minimax.cn', 'api.minimax.cn'];

async function request(urlStr, opts = {}) {
  refreshProxy();
  const host = new URL(urlStr).hostname;
  if (detectCurl()) {
    if (DIRECT_FIRST_HOSTS.includes(host)) {
      try {
        return await curlRequest(urlStr, { ...opts, useProxy: false });
      } catch (err) {
        log(`${host} 直连失败（${err.message}），尝试代理`);
      }
    }
    const usedProxy = Boolean(PROXY && proxyReady());
    try {
      return await curlRequest(urlStr, opts);
    } catch (err) {
      // 代理挂了但直连可用（或反过来）：先换一种方式重试，再谈 Node
      if (usedProxy) {
        proxyFailCount++;
        proxyBackoffUntil = Date.now() + 60000;
        log(`curl 代理失败（${err.message}），重试直连`);
        try {
          return await curlRequest(urlStr, { ...opts, useProxy: false });
        } catch (err2) {
          log('curl 直连也失败，改用 Node：' + err2.message);
        }
      } else {
        log('curl 传输失败，改用 Node：' + err.message);
      }
    }
  }
  return nodeRequest(urlStr, opts);
}

async function requestFollow(urlStr, opts = {}, depth = 0) {
  const res = await request(urlStr, opts);
  if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 5) {
    res.resume();
    return requestFollow(new URL(res.headers.location, urlStr).toString(), opts, depth + 1);
  }
  return res;
}

function readBody(res, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    res.on('data', d => {
      size += d.length;
      if (size > limit) { res.destroy(new Error('响应过大')); return; }
      parts.push(d);
    });
    res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    res.on('error', reject);
  });
}

async function fetchJson(urlStr, opts = {}, limit) {
  const res = await requestFollow(urlStr, opts);
  const text = await readBody(res, limit);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`上游 ${res.statusCode}: ${text.slice(0, 300)}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error('上游返回了非 JSON 内容: ' + text.slice(0, 200)); }
}

/* ------------------------------------------------------------------ *
 * 歌词创作（Pollinations，匿名免费）
 * ------------------------------------------------------------------ */
const LYRICS_SYSTEM = `你是顶尖的中文流行作词人。根据用户描述写一首可以演唱的完整歌词。

只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。格式：
{"title":"歌名","lyrics":"歌词","style":"英文风格标签"}

要求：
- lyrics 使用 [Verse] [Chorus] [Bridge] [Outro] 等段落标签（标签单独占一行），每行一句，共 12~24 行；副歌要重复、抓耳；有画面感和具体细节。
- 段落数量随目标时长调整：30 秒以内写一个主歌加一个副歌；约 60 秒写主歌-副歌-主歌-副歌；120 秒以上再加 Bridge 和 Outro。
- 语言与用户描述一致（中文描述写中文词）。
- style 用英文逗号分隔的标签，包含曲风、人声类型/性别、主要乐器、情绪、BPM，例如 "mandopop, warm female vocal, acoustic guitar, nostalgic, 92 BPM"。
- instrumental 为 true 时，lyrics 只写 "[instrumental]"。`;

function stripJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch { return null; }
}

// 模型偶尔会漏转义引号/换行，尽力把字段抠出来
function lenientExtract(text) {
  const t = String(text || '');
  const title = (t.match(/"title"\s*:\s*"([^"]*)"/) || [])[1] || '';
  const style = (t.match(/"style"\s*:\s*"([^"]*)"/) || [])[1] || '';
  const lm = t.match(/"lyrics"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"style"|\})/);
  if (!lm) return null;
  const lyrics = lm[1]
    .replace(/\\r/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\t/g, '\t');
  return { title, lyrics, style };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function writeLyrics({ description, style, instrumental, duration }) {
  const desc = String(description || '').trim().slice(0, 600);
  const baseUser = [
    `歌曲描述：${desc}`,
    style ? `指定风格：${String(style).slice(0, 240)}` : '',
    `目标时长：约 ${duration || 60} 秒`,
    `纯音乐：${instrumental ? '是' : '否'}`,
    '请直接输出 JSON。',
  ].filter(Boolean).join('\n');

  let lastRaw = '';
  let lastError = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);

    const user = attempt === 0
      ? baseUser
      : `${baseUser}\n\n注意：上一次的回复不是合法 JSON。这次请严格只输出 {"title":"...","lyrics":"...","style":"..."}，不要任何解释，歌词里的换行写 \\n。`;

    const payload = JSON.stringify({
      model: 'openai-fast',
      messages: [
        { role: 'system', content: LYRICS_SYSTEM },
        { role: 'user', content: user },
      ],
      temperature: 0.9 + attempt * 0.05,
      max_tokens: 1400,
    });

    try {
      const res = await requestFollow(`${POLLINATIONS}/openai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: payload,
        timeout: 100000,
      });
      if (res.statusCode !== 200) {
        lastRaw = (await readBody(res).catch(() => '')).slice(0, 200);
        lastError = `写词服务返回 ${res.statusCode}`;
        log(`写词第 ${attempt + 1} 次失败：HTTP ${res.statusCode}`);
        continue;
      }
      const text = await readBody(res, 2 * 1024 * 1024);
      if (!text.trim()) log(`写词返回空 body：status=${res.statusCode} headers=${JSON.stringify(res.headers).slice(0, 200)}`);
      let content = '';
      try {
        const msg = JSON.parse(text)?.choices?.[0]?.message || {};
        // 推理模型有时把结果全放在 reasoning 里，content 为空
        content = String(msg.content || '').trim() || String(msg.reasoning || '');
      } catch { content = text; }
      lastRaw = String(content || '').slice(0, 400);

      let data = stripJson(content);
      if (!data) data = lenientExtract(content);
      if (!data) {
        // 模型把歌词当普通文本写了出来的兜底
        const prose = String(content).trim();
        if (prose.length > 40 && /\[(verse|chorus|bridge|intro|outro)/i.test(prose)) {
          data = { lyrics: prose };
        }
      }

      const lyrics = String(data?.lyrics || '').trim();
      if (lyrics.length >= 40) {
        return {
          title: String(data.title || '').trim().slice(0, 40) || desc.slice(0, 16) || '未命名作品',
          lyrics: lyrics.slice(0, 8000),
          style: String(data.style || style || 'pop, warm production, 100 BPM').trim().slice(0, 300),
        };
      }
      log(`写词第 ${attempt + 1} 次结果不可用，重试…`);
    } catch (e) {
      lastError = e.message;
      log(`写词第 ${attempt + 1} 次异常：${e.message}`);
    }
  }

  log('写词最终失败，最后一次返回：', lastRaw.replace(/\s+/g, ' ').slice(0, 160));
  throw new Error(lastError || '写词服务暂时没有给出可用歌词');
}

/* ------------------------------------------------------------------ *
 * 引擎 C：MiniMax 网页登录态（非官方接口）
 * 网页端用 WebSocket + 签名访问，签名算法：
 *   yy = md5(encodeURIComponent(path+query) + "_" + "{}" + md5(unix) + "ooui")
 * ------------------------------------------------------------------ */
const md5 = value => crypto.createHash('md5').update(String(value), 'utf8').digest('hex');

function jwtPayload(token) {
  try {
    const part = String(token).split('.')[1] || '';
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return {}; }
}

function webClientUuid() {
  const file = path.join(CACHE_DIR, 'web-client.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.uuid) return saved.uuid;
  } catch { /* 首次运行 */ }
  const uuid = crypto.randomUUID();
  try { fs.writeFileSync(file, JSON.stringify({ uuid })); } catch {}
  return uuid;
}

function webSignedPath(pathname, token, extra = {}) {
  const t = Date.now();
  const payload = jwtPayload(token);
  const deviceId = payload?.user?.deviceID || payload?.deviceID || '';
  const params = new URLSearchParams({
    device_platform: 'web', app_id: '3001', version_code: '22201', biz_id: '1',
    uuid: webClientUuid(), lang: 'zh-Hans',
    os_name: 'Windows', browser_name: 'chrome',
    device_memory: '16', cpu_core_num: '16',
    browser_language: 'zh-CN', browser_platform: 'Win32',
    screen_width: '1536', screen_height: '864', unix: String(t),
  });
  if (deviceId) params.set('device_id', String(deviceId));
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  const full = pathname + '?' + params.toString();
  const yy = md5(encodeURIComponent(full) + '_' + '{}' + md5(String(t)) + 'ooui');
  return { path: full, yy };
}

async function webGet(pathname, token, extra = {}) {
  const { path: signedPath, yy } = webSignedPath(pathname, token, extra);
  const res = await requestFollow(MM_WEB_BASE + signedPath, {
    headers: {
      token,
      yy,
      accept: 'application/json, text/plain, */*',
      referer: 'https://www.minimax.cn/audio/music',
    },
    timeout: 30000,
  });
  const text = await readBody(res, 8 * 1024 * 1024);
  if (res.statusCode !== 200) throw new Error(`网页接口 ${res.statusCode}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('网页接口返回了非 JSON'); }
  if (data?.statusInfo?.code) {
    throw new Error(`MiniMax web ${data.statusInfo.code}: ${data.statusInfo.message || ''}`);
  }
  return data?.data;
}

function webWsUrl(token) {
  const { path: signedPath, yy } = webSignedPath('/v1/api/music/ws', token);
  return `wss://www.minimax.cn${signedPath}&yy=${encodeURIComponent(yy)}&token=${encodeURIComponent(token)}&op_ticket=${encodeURIComponent(MM_WEB_OP_TICKET)}`;
}

function pickWebToken(raw) {
  const token = String(raw || '').trim();
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return token;
  return MM_WEB_TOKEN;
}

function webModelFor(selected) {
  const model = String(selected || '').replace(/-free$/i, '');
  return MM_WEB_MODELS.includes(model) ? model : 'music-3.0';
}

/* ---------- 引擎 C：网页登录态任务 ---------- */
async function runWebJob(job) {
  let ws = null;
  let timer = null;
  try {
    const input = job.input;
    const token = job.mmWebToken;
    const model = webModelFor(input.minimaxModel);
    if (!token) throw new Error('没有网页登录态 Token');
    if (typeof WebSocket === 'undefined') throw new Error('当前 Node 版本不支持内置 WebSocket，请升级到 Node 22+');

    setStage(job, 'submitting', '正在连接 MiniMax 网页接口…');
    ws = new WebSocket(webWsUrl(token));
    job.webSocket = ws;
    const msgId = crypto.randomUUID();

    const answer = await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      timer = setTimeout(() => done(reject, new Error('网页接口超时（10 分钟）')), 10 * 60 * 1000);

      ws.addEventListener('open', () => {
        if (job.canceled) return;
        setStage(job, 'generating', '网页版模型正在谱曲演唱，通常 3~8 分钟…', { progress: 0.08 });
        job.status = 'generating';
        const ideaText = [input.style, input.description]
          .filter(Boolean).join('，').replace(/\s+/g, ' ').slice(0, 1000) || 'pop music, warm vocal';
        const payLoad = {
          model,
          generation_type: 1,
          idea: ideaText,
          n: 1,
          stream: true,
          rewrite_idea_switch: false,
        };
        if (input.title) payLoad.title = input.title;
        if (input.lyrics && !/^\[instrumental\]$/i.test(input.lyrics)) payLoad.lyrics = input.lyrics.slice(0, 3500);
        if (input.instrumental) payLoad.instrumental = true;
        ws.send(JSON.stringify({ method: 'MusicGen', music_payLoad: payLoad, msg_id: msgId }));
      });

      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.method === 'Heartbeat') {
          try { ws.send(JSON.stringify({ method: 'Heartbeat', msg_id: msg.msg_id, timestamp: Date.now() })); } catch {}
          return;
        }
        if (msg.method === 'Close') {
          done(reject, new Error('网页接口关闭了连接'));
          return;
        }
        if (msg.statusInfo && msg.statusInfo.code !== 0) {
          done(reject, new Error(`MiniMax web ${msg.statusInfo.code}: ${msg.statusInfo.message || ''}`));
          return;
        }
        if (msg.input_sensitive) {
          done(reject, new Error('输入内容触发了平台审核，请换个描述'));
          return;
        }
        if (Array.isArray(msg.data)) {
          for (const item of msg.data) {
            if (item.music_id) job.musicId = item.music_id;
            if (item.status === 2 && item.audio_url) { done(resolve, item); return; }
            if (item.status >= 3) { done(reject, new Error(`网页生成失败（状态 ${item.status}）`)); return; }
          }
        }
        if (msg.ended) done(resolve, (msg.data || [])[0] || null);
      });

      ws.addEventListener('error', () => { /* close 事件会兜底 */ });
      ws.addEventListener('close', (e) => {
        if (!settled) done(reject, new Error(`网页接口断开（${e.code}）`));
      });
    });

    if (job.canceled) return;
    try { ws.close(); } catch {}

    let item = answer;
    if (!item?.audio_url) {
      const history = await webGet('/v1/api/music/history_list', token, { page: 1, page_size: 10 });
      const list = history?.music_list || [];
      item = list.find(x => x.music_id === job.musicId) || list[0];
    }
    if (!item?.audio_url) throw new Error('网页接口没有返回可下载的音频');

    setStage(job, 'downloading', '生成完成，正在保存音频…', { progress: 0.96 });
    const target = path.join(AUDIO_DIR, `${job.id}.mp3`);
    await downloadToFile(item.audio_url, target);
    const stat = await fsp.stat(target);
    if (!stat.size) throw new Error('保存的音频为空');

    const duration = item.duration
      ? Math.max(1, Math.round(item.duration / 1000))
      : Math.max(1, Math.round((stat.size * 8) / 256000));

    const meta = baseMeta(job, {
      duration,
      requestedDuration: input.duration,
      audio: `/api/audio/${job.id}.mp3`,
      format: 'mp3',
      bytes: stat.size,
      model: item.model || model,
      coverUrl: item.cover_url || '',
    });
    await completeJob(job, meta);
  } catch (err) {
    try { ws?.close(); } catch {}
    failJob(job, err);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 引擎 D：StepFun 阶跃音乐（网页登录态，非官方接口）
 * Oasis-Token 的格式是 <access>...<refresh>，用 RefreshToken 换新 access。
 * ------------------------------------------------------------------ */
function stepCookie(access, refresh, webid) {
  return `Oasis-Webid=${webid}; Oasis-appID=10200; Oasis-Platform=web; Oasis-Token=${access}...${refresh}`;
}

function parseStepToken(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  let webid = '';
  if (text.includes('Oasis-Token=')) {
    const wm = text.match(/Oasis-Webid=([^;]+)/);
    if (wm) webid = wm[1].trim();
    const tm = text.match(/Oasis-Token=([^;\s]+)/);
    text = tm ? decodeURIComponent(tm[1]) : '';
  }
  const idx = text.indexOf('...');
  let access = '';
  let refresh = text;
  if (idx >= 0) {
    access = text.slice(0, idx);
    refresh = text.slice(idx + 3);
  }
  if (!refresh || !/^eyJ/.test(refresh)) return null;
  const payload = jwtPayload(refresh);
  webid = webid || String(payload?.device_id || '');
  if (!webid) return null;
  return { access, refresh, webid, token: text };
}

async function stepPost(pathname, body, cookie, timeout = 60000) {
  const res = await requestFollow(STEP_BASE + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'connect-protocol-version': '1',
      'oasis-appid': '10200',
      'oasis-platform': 'web',
      origin: 'https://www.stepfun.com',
      referer: 'https://www.stepfun.com/studio/audio?tab=music',
      'x-waf-client-type': 'fetch_sdk',
      accept: '*/*',
      cookie,
    },
    body: JSON.stringify(body),
    timeout,
  });
  const text = await readBody(res, 16 * 1024 * 1024);
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  if (res.statusCode !== 200 || data?.code) {
    throw new Error(`StepFun ${res.statusCode}: ${data?.message || data?.code || text.slice(0, 120)}`);
  }
  if (!data) throw new Error('StepFun 返回了非 JSON');
  return data;
}

async function stepRefresh(parsed) {
  const cookie = stepCookie(parsed.access, parsed.refresh, parsed.webid);
  const data = await stepPost(
    '/passport/proto.api.passport.v1.PassportService/RefreshToken', {}, cookie, 30000
  );
  const access = data?.accessToken?.raw;
  const refresh = data?.refreshToken?.raw || parsed.refresh;
  if (!access) throw new Error('StepFun 登录态刷新失败');
  const accessPayload = jwtPayload(access);
  const refreshPayload = jwtPayload(parsed.refresh);
  if (accessPayload?.activated === false || accessPayload?.mode === 1) {
    throw new Error('StepFun 刷新后是游客态（Oasis-Token 不完整或 refresh 已失效）');
  }
  if (accessPayload?.oasis_id && refreshPayload?.oasis_id
      && String(accessPayload.oasis_id) !== String(refreshPayload.oasis_id)) {
    throw new Error('StepFun 登录态不匹配（access 与 refresh 不是同一次登录）');
  }
  return { cookie: stepCookie(access, refresh, parsed.webid), access, refresh };
}



/* ---------- 引擎 D：StepFun 任务 ---------- */
async function runStepfunJob(job) {
  try {
    const input = job.input;
    const parsed = parseStepToken(job.stepToken);
    if (!parsed) throw new Error('StepFun 登录态格式不对，请复制完整的 Oasis-Token');

    setStage(job, 'submitting', '正在刷新 StepFun 登录态…');
    const session = await stepRefresh(parsed);
    const freshToken = `${session.access}...${session.refresh}`;
    job.stepToken = freshToken;
    if (job.stepTokenFromClient) {
      broadcast(job, { type: 'token', stepToken: freshToken });
    }
    const cookie = session.cookie;

    try {
      const quota = await stepPost('/api/audio/capy.audio.v1.AudioService/GetQuota', {}, cookie, 20000);
      const remaining = Number(quota?.musicQuota?.remainingQuota);
      if (Number.isFinite(remaining) && remaining <= 0) throw new Error('StepFun 音乐额度已用完');
    } catch (e) {
      if (/额度已用完/.test(e.message)) throw e;
      // 配额接口异常不阻塞提交，交给提交接口报错
    }

    const caption = [input.style, input.description]
      .filter(Boolean).join('，').replace(/\s+/g, ' ').slice(0, 2000) || 'pop music, warm vocal';
    const body = {
      task: 'MUSIC_TASK_TYPE_TEXT_TO_MUSIC',
      modelId: STEP_MODEL,
      title: (input.title || '未命名作品').slice(0, 100),
      caption,
      lyrics: input.instrumental ? '' : (input.lyrics || '').slice(0, 5000),
      instrumental: Boolean(input.instrumental),
      responseFormat: 'AUDIO_FORMAT_MP3',
    };

    setStage(job, 'submitting', '正在提交到 StepFun 阶跃音乐…');
    const submit = await stepPost(
      '/api/audio/capy.audio.v1.AudioService/SubmitMusicTask', body, cookie, 60000
    );
    const taskId = submit?.taskId;
    if (!taskId) throw new Error('StepFun 没有返回任务号');

    setStage(job, 'generating', '阶跃音乐正在谱曲演唱，通常 1~3 分钟…', { progress: 0.1 });
    job.status = 'generating';

    const started = Date.now();
    let record = null;
    while (Date.now() - started < 10 * 60 * 1000) {
      if (job.canceled) return;
      await sleep(3000);
      const result = await stepPost(
        '/api/audio/capy.audio.v1.AudioService/GetMusicTask',
        { taskId, withAudioB64: false },
        cookie,
        30000
      );
      record = result?.musicRecord || null;
      const status = record?.status;
      if (status === 'MUSIC_TASK_STATUS_SUCCESS') break;
      if (status === 'MUSIC_TASK_STATUS_FAILED') throw new Error('StepFun 生成失败，可能触发了审核或模型异常');
      setStage(job, 'generating',
        status === 'MUSIC_TASK_STATUS_PENDING' ? '阶跃音乐排队中…' : '阶跃音乐正在演唱…');
    }
    if (!record || record.status !== 'MUSIC_TASK_STATUS_SUCCESS') throw new Error('StepFun 生成超时');
    if (!record.audioUrl) throw new Error('StepFun 没有返回音频地址');

    setStage(job, 'downloading', '生成完成，正在保存音频…', { progress: 0.96 });
    const target = path.join(AUDIO_DIR, `${job.id}.mp3`);
    await downloadToFile(record.audioUrl, target);
    const stat = await fsp.stat(target);
    if (!stat.size) throw new Error('保存的音频为空');

    const duration = record.duration
      ? Math.max(1, Math.round(record.duration))
      : Math.max(1, Math.round((stat.size * 8) / 256000));

    const meta = baseMeta(job, {
      title: record.title || input.title || '未命名作品',
      lyrics: record.lyrics || input.lyrics || '',
      duration,
      requestedDuration: input.duration,
      audio: `/api/audio/${job.id}.mp3`,
      format: 'mp3',
      bytes: stat.size,
      model: STEP_MODEL,
    });
    await completeJob(job, meta);
  } catch (err) {
    failJob(job, err);
  }
}

/* ------------------------------------------------------------------ *
 * 任务：提交 Gradio → 消费 SSE → 下载 WAV
 * ------------------------------------------------------------------ */
const jobs = new Map();
const queue = [];
let running = 0;

function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function broadcast(job, obj) {
  for (const client of job.clients) {
    try { sseSend(client, obj); } catch { job.clients.delete(client); }
  }
}

function setStage(job, stage, message, extra = {}) {
  job.stage = stage;
  job.message = message;
  Object.assign(job, extra);
  broadcast(job, { type: 'status', stage, message, progress: job.progress, ...extra });
  log(`[${job.id.slice(0, 6)}] ${message}`);
}

function createJob(input, engine, mmWebToken = '', stepToken = '', minimaxModel = '') {
  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id,
    createdAt: Date.now(),
    status: 'queued',
    stage: 'queued',
    message: '排队中…',
    progress: 0,
    seconds: 0,
    duration: input.duration,
    clients: new Set(),
    canceled: false,
    engine,
    minimaxModel,
    mmWebToken,
    stepToken,
    input,
    audioUrl: null,
    error: null,
  };
  jobs.set(id, job);
  return job;
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (job.canceled) continue;
    running++;
    runJob(job).finally(() => { running--; pump(); });
  }
}

function enqueue(job) {
  queue.push(job);
  pump();
}

async function runJob(job) {
  if (job.engine === 'stepfun') return runStepfunJob(job);
  if (job.engine === 'web') return runWebJob(job);
  failJob(job, new Error('未知的生成引擎'));
}

function baseMeta(job, extra) {
  return {
    id: job.id,
    title: job.input.title || '未命名作品',
    style: job.input.style || '',
    description: job.input.description || '',
    lyrics: job.input.lyrics || '',
    instrumental: Boolean(job.input.instrumental),
    createdAt: Date.now(),
    engine: job.engine,
    ...extra,
  };
}

async function completeJob(job, meta) {
  await fsp.writeFile(path.join(AUDIO_DIR, `${job.id}.json`), JSON.stringify(meta, null, 2));
  job.status = 'done';
  job.progress = 1;
  job.meta = meta;
  job.audioUrl = meta.audio;
  broadcast(job, { type: 'done', meta, audioUrl: meta.audio });
  setStage(job, 'done', '完成', { progress: 1 });
  for (const c of job.clients) { try { c.end(); } catch {} }
  job.clients.clear();
  log(`[${job.id.slice(0, 6)}] 完成：${meta.title} (${meta.duration}s)`);
}

function failJob(job, err) {
  if (job.canceled) return;
  job.status = 'error';
  job.error = err.message;
  log(`[${job.id.slice(0, 6)}] 失败：${err.message}`);
  broadcast(job, { type: 'error', message: friendlyError(err.message) });
  for (const c of job.clients) { try { c.end(); } catch {} }
  job.clients.clear();
}

function friendlyError(msg) {
  if (/StepFun.*(unauthenticated|token is illegal|401)/i.test(msg)) return 'StepFun 登录态已失效，请重新登录 www.stepfun.com 后复制新的 Oasis-Token。';
  if (/StepFun 刷新后是游客态/.test(msg)) return 'StepFun 登录态不完整或 refresh 已失效。请重新登录 www.stepfun.com，复制完整的 Oasis-Token（两段 JWT，中间有 ...）。';
  if (/StepFun 登录态不匹配/.test(msg)) return 'StepFun 的 access 与 refresh 不是同一次登录，请重新复制完整的 Oasis-Token。';
  if (/StepFun 登录态已过期/.test(msg)) return 'StepFun 登录态已失效，请重新复制完整的 Oasis-Token（含 access 和 refresh 两段）。';
  if (/StepFun 音乐额度已用完/.test(msg)) return 'StepFun 账号的音乐生成额度已用完。';
  if (/StepFun 生成失败/.test(msg)) return 'StepFun 生成失败，可能触发审核或模型异常，请重试或换歌词。';
  if (/StepFun 生成超时/.test(msg)) return 'StepFun 10 分钟没有返回结果，请重试。';
  if (/StepFun/.test(msg)) return 'StepFun 接口报错：' + msg.replace(/^StepFun\s*/, '');
  if (/MiniMax web 1004|login fail|unauthorized/i.test(msg)) return '网页登录态已失效，请重新登录 www.minimax.cn 后复制新的 token。';
  if (/网页接口超时/.test(msg)) return '网页接口 10 分钟没有返回结果，可能排队或任务异常，请重试。';
  if (/网页接口断开/.test(msg)) return '网页接口连接被断开，请重试；如果反复失败，重新登录复制新 token。';
  if (/审核/.test(msg)) return '输入内容触发了平台审核，换个描述或歌词再试。';
  if (/网页接口没有返回可下载的音频/.test(msg)) return '网页接口没有返回音频，可能生成失败，请重试。';
  if (/ECONN|ETIMEDOUT|请求超时|socket|network/i.test(msg)) return '网络连接失败，请检查代理后重试。';
  return msg;
}

async function downloadToFile(url, dest) {
  const res = await requestFollow(url, { timeout: 300000 });
  if (res.statusCode !== 200) throw new Error(`下载音频失败 (${res.statusCode})`);
  const tmp = dest + '.part';
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    ws.on('finish', resolve);
    ws.on('error', reject);
    res.on('error', reject);
    res.pipe(ws);
  });
  await fsp.rename(tmp, dest);
}

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */
function basicAuthOk(req) {
  if (!ACCESS_PASSWORD) return true;
  const header = req.headers.authorization || '';
  const matched = /^Basic\s+(.+)$/i.exec(header);
  if (!matched) return false;
  let decoded = '';
  try { decoded = Buffer.from(matched[1], 'base64').toString('utf8'); } catch { return false; }
  const index = decoded.indexOf(':');
  const password = index >= 0 ? decoded.slice(index + 1) : decoded;
  const a = Buffer.from(password);
  const b = Buffer.from(ACCESS_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', d => {
      size += d.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function cleanText(v, max) {
  return String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

async function serveAudio(req, res, id, ext = 'wav') {
  const filePath = path.join(AUDIO_DIR, `${id}.${ext}`);
  let stat;
  try { stat = await fsp.stat(filePath); } catch { res.writeHead(404).end('not found'); return; }

  const headers = {
    'content-type': ext === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
  };
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
      return;
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  }
}

async function listLibrary() {
  const files = await fsp.readdir(AUDIO_DIR);
  const items = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(AUDIO_DIR, f), 'utf8'));
      const audioName = meta.audio ? path.basename(meta.audio) : f.replace(/\.json$/, '.wav');
      await fsp.access(path.join(AUDIO_DIR, audioName));
      items.push(meta);
    } catch { /* 忽略损坏记录 */ }
  }
  items.sort((a, b) => b.createdAt - a.createdAt);
  return items.slice(0, 60);
}

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      proxy: PROXY ? `${PROXY.host}:${PROXY.port}` : null,
      proxyMode: PROXY ? (proxyReady() ? 'proxy' : 'direct-fallback') : 'direct',
      running,
      pending: queue.length,
    });
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    return json(res, 200, {
      engines: ['stepfun', 'web'],
      hasWebToken: Boolean(MM_WEB_TOKEN),
      hasStepToken: Boolean(STEP_TOKEN),
      stepModel: STEP_MODEL,
      webModels: MM_WEB_MODELS,
    });
  }

  if (pathname === '/api/lyrics' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const duration = 60;
    const description = cleanText(body.description, 600);
    const style = cleanText(body.style, 240);
    const instrumental = Boolean(body.instrumental);

    if (instrumental) {
      return json(res, 200, {
        title: cleanText(body.title, 40) || description.slice(0, 16) || '纯音乐',
        lyrics: '[instrumental]',
        style,
        engine: 'pollinations',
      });
    }

    try {
      const result = await writeLyrics({ description, style, instrumental, duration });
      return json(res, 200, { ...result, engine: 'pollinations' });
    } catch (e) {
      log('写词失败：', e.message);
      return json(res, 502, { error: '歌词生成失败：' + friendlyError(e.message) });
    }
  }

  if (pathname === '/api/generate' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const description = cleanText(body.description, 1000);
    const lyrics = cleanText(body.lyrics, 8000);
    const instrumental = Boolean(body.instrumental);
    if (!description && !lyrics && !body.style) {
      return json(res, 400, { error: '至少写点描述或歌词吧' });
    }
    let engine = body.engine === 'web' ? 'web' : body.engine === 'stepfun' ? 'stepfun' : '';
    const minimaxModel = cleanText(body.minimaxModel, 40);
    const mmWebToken = pickWebToken(body.mmWebToken);
    const rawStep = cleanText(body.stepToken, 4000);
    const parsedStep = rawStep ? parseStepToken(rawStep) : null;
    const stepToken = rawStep ? (parsedStep ? rawStep : (STEP_TOKEN || '')) : STEP_TOKEN;
    if (!engine) engine = stepToken ? 'stepfun' : 'web';
    if (engine === 'web' && !mmWebToken) {
      return json(res, 400, { error: '请先填入 MiniMax 网页登录态 Token' });
    }
    if (engine === 'stepfun') {
      if (rawStep && !parsedStep) {
        return json(res, 400, { error: 'StepFun 登录态格式不对：请粘贴完整的 Oasis-Token（access...refresh 两段）' });
      }
      if (stepToken) {
        const info = parsedStep || parseStepToken(stepToken);
        if (info && !info.access) {
          return json(res, 400, { error: 'StepFun 登录态缺少 access 段：请复制完整的 Oasis-Token（中间有 ... 分隔）' });
        }
      }
      if (!stepToken) {
        return json(res, 400, { error: '请先填入 StepFun 登录态 Token' });
      }
    }
    if (!instrumental && lyrics.length < 10) {
      return json(res, 400, { error: '歌词太短了，至少写几句' });
    }
    const input = {
      title: cleanText(body.title, 60) || '未命名作品',
      description,
      lyrics: instrumental ? '[instrumental]' : lyrics,
      style: cleanText(body.style, 300) || 'pop, warm production, 100 BPM',
      duration: 60,
      instrumental,
    };
    const job = createJob(input, engine, mmWebToken, stepToken, minimaxModel);
    job.stepTokenFromClient = Boolean(rawStep && parsedStep);
    enqueue(job);
    log(`[${job.id.slice(0, 6)}] 新任务（${job.engine}${job.engine === 'web' ? ' / ' + job.minimaxModel : ''}）：${input.title} / ${input.style}`);
    return json(res, 200, { id: job.id, status: job.status, engine: job.engine });
  }

  const jobMatch = pathname.match(/^\/api\/jobs\/([a-f0-9]{16})(\/stream|\/cancel)?$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: '任务不存在或已过期' });
    const action = jobMatch[2];

    if (action === '/cancel' && req.method === 'POST') {
      job.canceled = true;
      job.status = 'canceled';
      try {
        if (job.webSocket) {
          try { job.webSocket.send(JSON.stringify({ method: 'StopMusicGen', payload: {}, msg_id: crypto.randomUUID() })); } catch {}
          job.webSocket.close();
        }
      } catch {}
      broadcast(job, { type: 'error', message: '已停止生成' });
      for (const c of job.clients) { try { c.end(); } catch {} }
      job.clients.clear();
      return json(res, 200, { ok: true });
    }

    if (action === '/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': hello\n\n');
      job.clients.add(res);

      sseSend(res, {
        type: 'status', stage: job.stage, message: job.message,
        progress: job.progress, status: job.status, engine: job.engine,
      });
      if (job.engine === 'stepfun' && job.stepTokenFromClient && job.stepToken) {
        sseSend(res, { type: 'token', stepToken: job.stepToken });
      }
      if (job.status === 'done' && job.meta) {
        sseSend(res, { type: 'done', meta: job.meta, audioUrl: job.audioUrl });
        res.end();
        return;
      }
      if (job.status === 'error') {
        sseSend(res, { type: 'error', message: friendlyError(job.error || '生成失败') });
        res.end();
        return;
      }
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ping); job.clients.delete(res); });
      return;
    }

    return json(res, 200, {
      id: job.id,
      engine: job.engine,
      status: job.status,
      stage: job.stage,
      message: job.message,
      progress: job.progress,
      seconds: job.seconds,
      duration: job.duration,
      audioUrl: job.audioUrl,
      meta: job.meta || null,
      error: job.status === 'error' ? friendlyError(job.error || '') : null,
    });
  }

  if (pathname === '/api/library' && req.method === 'GET') {
    return json(res, 200, { items: await listLibrary() });
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // Render 健康检查：不鉴权、不访问上游
    if (url.pathname === '/healthz') {
      return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    }

    if (!basicAuthOk(req)) {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="SonicWave", charset="UTF-8"',
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('需要访问密码');
      return;
    }

    const audio = url.pathname.match(/^\/api\/audio\/([a-f0-9]{16})\.(wav|mp3)$/);
    if (audio) return serveAudio(req, res, audio[1], audio[2]);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (e) {
    log('请求出错：', e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS && job.clients.size === 0) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

process.on('unhandledRejection', err => log('未处理的 Promise 拒绝：', err?.message || err));
process.on('uncaughtException', err => log('未捕获异常：', err?.stack || err));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`端口 ${PORT} 已被占用，换一个端口再启动：SONICWAVE_PORT=8900 node server.mjs`);
    process.exit(1);
  }
  throw err;
});

// 没有显式代理时，后台先探一次本机常见端口，避免首个请求先吃一次直连失败
if (!PROXY && !PROXY_OFF && !IS_RENDER) {
  probeLocalProxies().then(p => { if (p) useProxy(p, '自动探测到本机代理'); });
}

server.listen(PORT, HOST, () => {
  log(`服务已启动 →  http://${HOST}:${PORT}`);
  log(`网络模式：${PROXY ? `代理 ${PROXY.host}:${PROXY.port}（失败会自动切换/探测）` : IS_RENDER ? '直连（Render 云上）' : '未检测到代理，正在探测本机常见端口…'}`);
  log(`监听：${HOST}:${PORT}${ACCESS_PASSWORD ? ' · 已开启访问密码' : ''}${IS_RENDER ? ' · Render' : ''}`);
  log('引擎：StepFun / MiniMax 网页登录态（页面可切换）');
});
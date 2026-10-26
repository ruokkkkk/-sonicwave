/* 声浪 SonicWave · 前端逻辑
 * 流程：写词（简单模式）→ 提交任务 → SSE 接收实时音频块边生成边播放 → 完成后播放 WAV
 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const el = {
    tabs: [...document.querySelectorAll('.tab')],
    panelSimple: $('#panel-simple'),
    panelCustom: $('#panel-custom'),
    desc: $('#desc'),
    styleSimple: $('#styleSimple'),
    ideaChips: $('#ideaChips'),
    title: $('#title'),
    lyrics: $('#lyrics'),
    styleCustom: $('#styleCustom'),
    duration: $('#duration'),
    durationOut: $('#durationOut'),
    quality: $('#quality'),
    hfToken: $('#hfToken'),
    minimaxModel: $('#minimaxModel'),
    mmWebToken: $('#mmWebToken'),
    stepToken: $('#stepToken'),
    modelTip: $('#modelTip'),
    engineNow: $('#engineNow'),
    durationField: $('#durationField'),
    durationNote: $('#durationNote'),
    quotaBox: $('#quotaBox'),
    quotaEstimate: $('#quotaEstimate'),
    instrumental: $('#instrumental'),
    generate: $('#generate'),
    empty: $('#empty'),
    generating: $('#generating'),
    stageText: $('#stageText'),
    stageSub: $('#stageSub'),
    elapsed: $('#elapsed'),
    viz: $('#viz'),
    barFill: $('#barFill'),
    progressText: $('#progressText'),
    cancel: $('#cancel'),
    liveHint: $('#liveHint'),
    result: $('#result'),
    cover: $('#cover'),
    coverLetter: $('#coverLetter'),
    songTitle: $('#songTitle'),
    songMeta: $('#songMeta'),
    styleChips: $('#styleChips'),
    audio: $('#audio'),
    playBtn: $('#playBtn'),
    seek: $('#seek'),
    curTime: $('#curTime'),
    totTime: $('#totTime'),
    download: $('#download'),
    regen: $('#regen'),
    copyLyrics: $('#copyLyrics'),
    lyricsBox: $('#lyricsBox'),
    resultLyrics: $('#resultLyrics'),
    errorCard: $('#errorCard'),
    errorText: $('#errorText'),
    retry: $('#retry'),
    library: $('#library'),
    libraryCount: $('#libraryCount'),
    engineStatus: $('#engineStatus'),
    engineText: $('#engineText'),
    toast: $('#toast'),
    modeBadge: $('#modeBadge'),
  };

  let mode = 'simple';
  let busy = false;
  let currentJob = null;
  let eventSource = null;
  let lastSeq = 0;
  let timerHandle = null;
  let timerStart = 0;
  let cancelRequested = false;
  let lyricAbort = null;
  let rafHandle = null;
  let currentMeta = null;
  let seekDragging = false;
  let currentEngine = 'hf';
  let pseudoTimer = null;

  /* ------------------------------------------------------------------ *
   * 实时播放：把服务端转发的 PCM 块排队喂给 Web Audio
   * ------------------------------------------------------------------ */
  const StreamPlayer = {
    ctx: null,
    analyser: null,
    sources: new Set(),
    nextTime: 0,
    sampleRate: 0,

    ensureContext(sr = 44100) {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try {
          this.ctx = new AC({ sampleRate: sr });
        } catch {
          this.ctx = new AC();
        }
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.82;
        this.analyser.connect(this.ctx.destination);
        this.sampleRate = this.ctx.sampleRate;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    },

    push(base64, sr, channels) {
      try {
        const ctx = this.ensureContext(sr || 44100);
        if (!ctx) return;
        const ch = Math.max(1, Math.min(2, channels || 2));
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const view = new DataView(bytes.buffer);
        const frames = Math.floor(bin.length / (2 * ch));
        if (!frames) return;

        const buffer = ctx.createBuffer(ch, frames, sr || ctx.sampleRate);
        for (let c = 0; c < ch; c++) {
          const out = buffer.getChannelData(c);
          for (let i = 0; i < frames; i++) {
            out[i] = view.getInt16((i * ch + c) * 2, true) / 32768;
          }
        }

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.analyser);
        const when = Math.max(this.nextTime, ctx.currentTime + 0.05);
        src.start(when);
        this.nextTime = when + buffer.duration;
        this.sources.add(src);
        src.onended = () => this.sources.delete(src);
      } catch (err) {
        console.warn('音频块解码失败', err);
      }
    },

    stop() {
      for (const src of this.sources) {
        try { src.stop(); } catch { /* 已结束 */ }
      }
      this.sources.clear();
      this.nextTime = 0;
    },

    reset() {
      this.stop();
      this.nextTime = 0;
    },
  };

  /* ------------------------------------------------------------------ *
   * 界面基础
   * ------------------------------------------------------------------ */
  function toast(message, ms = 2600) {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  function setBusy(value) {
    busy = value;
    el.generate.disabled = value;
    el.generate.querySelector('.btn-label').textContent = value ? '创作中…' : '开始创作';
  }

  function switchMode(next) {
    mode = next;
    el.tabs.forEach(t => {
      const active = t.dataset.tab === next;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', String(active));
    });
    el.panelSimple.classList.toggle('is-hidden', next !== 'simple');
    el.panelCustom.classList.toggle('is-hidden', next !== 'custom');
  }

  function hasWebToken() {
    const t = (el.mmWebToken.value || '').trim();
    return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t);
  }

  function hasStepToken() {
    const t = (el.stepToken.value || '').trim();
    return t.length > 80 && (t.includes('...') || t.includes('Oasis-Token='));
  }

  function activeEngine() {
    if (hasStepToken()) return 'stepfun';
    if (hasWebToken()) return 'web';
    return 'hf';
  }

  function webModelLabel() {
    const m = String(el.minimaxModel?.value || 'music-3.0').replace(/-free$/i, '');
    return ['music-3.0', 'music-2.6'].includes(m) ? m : 'music-3.0';
  }

  const HF_MODEL_OPTIONS = [
    ['', '公益 Space · 固定模型'],
  ];
  const WEB_MODEL_OPTIONS = [
    ['music-3.0', 'music-3.0 · 网页版'],
    ['music-2.6', 'music-2.6 · 网页版'],
  ];
  const STEPFUN_MODEL_OPTIONS = [
    ['step-music', 'step-music · 阶跃'],
  ];

  function syncModelOptions(engine) {
    const want = engine === 'web' ? WEB_MODEL_OPTIONS
      : engine === 'stepfun' ? STEPFUN_MODEL_OPTIONS
        : HF_MODEL_OPTIONS;
    const sig = want.map(x => x[0]).join(',');
    if (el.minimaxModel.dataset.sig === sig) return;
    const current = el.minimaxModel.value;
    el.minimaxModel.dataset.sig = sig;
    el.minimaxModel.innerHTML = '';
    for (const [value, label] of want) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      el.minimaxModel.appendChild(option);
    }
    el.minimaxModel.value = want.some(([v]) => v === current) ? current : want[0][0];
  }

  function updateEngineUI() {
    const engine = activeEngine();
    syncModelOptions(engine);
    if (el.engineNow) {
      if (engine === 'stepfun') {
        el.engineNow.innerHTML = '当前使用：<b>StepFun 阶跃</b> · step-music（消耗账号音乐额度）';
      } else if (engine === 'web') {
        el.engineNow.innerHTML = `当前使用：<b>网页登录态</b> · ${webModelLabel()}（消耗网页创作额度）`;
      } else {
        el.engineNow.innerHTML = '当前使用：<b>公益免费 Space</b> · 无需 Key';
      }
    }
    const fixedLength = engine === 'web' || engine === 'stepfun';
    if (el.minimaxModel) el.minimaxModel.disabled = engine === 'hf';
    if (el.durationField) el.durationField.classList.toggle('is-disabled', fixedLength);
    el.duration.disabled = fixedLength;
    el.quality.disabled = fixedLength;
    if (el.durationNote) {
      el.durationNote.textContent = engine === 'stepfun' ? '阶跃按歌词长度决定时长'
        : engine === 'web' ? '网页版按歌词/描述决定时长' : '';
    }
    if (el.quotaEstimate) el.quotaEstimate.style.display = engine === 'hf' ? '' : 'none';
    if (el.modelTip) {
      el.modelTip.textContent = engine === 'stepfun'
        ? '阶跃使用固定模型 step-music，按账号的音乐生成额度计费。'
        : engine === 'web'
          ? '网页登录态使用正式模型，按网页账号的创作次数计费。'
          : '公益 Space 固定使用 MiniMax Music 3 公开模型；填入 Token 后会切换可选模型。';
    }
    if (el.modeBadge) {
      el.modeBadge.textContent = engine === 'stepfun' ? 'StepFun 登录态'
        : engine === 'web' ? '网页登录态' : '免登录 · 免费';
    }
    const dot = el.engineStatus.querySelector('.dot');
    if (engine !== 'hf') {
      if (dot) dot.className = 'dot ok';
      el.engineText.textContent = engine === 'stepfun' ? 'StepFun 登录态已配置'
        : '网页登录态已配置';
    } else {
      if (dot) dot.className = 'dot wait';
      el.engineText.textContent = '检测音源…';
      clearTimeout(updateEngineUI._h);
      updateEngineUI._h = setTimeout(checkHealth, 500);
    }
  }

  // 估算本次生成会消耗多少 ZeroGPU 额度（官方 Space 的 get_duration × xlarge 2 倍）
  function updateQuotaEstimate() {
    if (!el.quotaEstimate) return;
    const d = +el.duration.value;
    const steps = +el.quality.value;
    const gpu = Math.round((0.75 * d + 0.2 * d * (steps / 30) + 15) * 2);
    let hint;
    if (gpu <= 120) hint = `匿名每日 120 秒约可生成 ${Math.max(1, Math.floor(120 / gpu))} 首`;
    else if (gpu <= 300) hint = '超过匿名额度，需填入 Token（每天 300 秒）';
    else hint = '超过 Token 每日额度，建议缩短时长';
    el.quotaEstimate.innerHTML = `本次预计消耗 <b>≈ ${gpu} 秒</b> GPU 额度 · ${hint}`;
  }

  function updateRangeFill() {
    const min = +el.duration.min;
    const max = +el.duration.max;
    const val = +el.duration.value;
    const pct = ((val - min) / (max - min)) * 100;
    el.duration.style.setProperty('--fill', pct + '%');
    el.durationOut.textContent = val + ' 秒';
    updateQuotaEstimate();
  }

  function showGenerating(title, sub) {
    el.empty.classList.add('is-hidden');
    el.result.classList.add('is-hidden');
    el.errorCard.classList.add('is-hidden');
    el.generating.classList.remove('is-hidden');
    el.stageText.textContent = title || '正在创作…';
    el.stageSub.textContent = sub || '';
    el.barFill.style.width = '0%';
    el.progressText.textContent = '0 秒 / ' + el.duration.value + ' 秒';
    el.elapsed.textContent = '00:00';
    timerStart = Date.now();
    clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      const s = Math.floor((Date.now() - timerStart) / 1000);
      el.elapsed.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 1000);
    startVisualizer();
  }

  function stopGenerating() {
    clearInterval(timerHandle);
    timerHandle = null;
    stopPseudoProgress();
    stopVisualizer();
  }

  // 官方接口是一次性返回，没有流式进度，用缓动进度条示意
  function startPseudoProgress() {
    stopPseudoProgress();
    let sim = 0.08;
    el.barFill.style.width = (sim * 100).toFixed(1) + '%';
    pseudoTimer = setInterval(() => {
      sim = Math.min(0.92, sim + 0.008);
      el.barFill.style.width = (sim * 100).toFixed(1) + '%';
      const secs = Math.round((Date.now() - timerStart) / 1000);
      el.progressText.textContent = `${currentEngine === 'stepfun' ? '阶跃生成中' : currentEngine === 'web' ? '网页生成中' : '官方生成中'} · 已用 ${secs} 秒`;
    }, 1000);
  }

  function stopPseudoProgress() {
    if (pseudoTimer) clearInterval(pseudoTimer);
    pseudoTimer = null;
  }

  function showError(message) {
    stopGenerating();
    StreamPlayer.stop();
    el.generating.classList.add('is-hidden');
    el.result.classList.add('is-hidden');
    el.empty.classList.add('is-hidden');
    el.errorCard.classList.remove('is-hidden');
    el.errorText.textContent = message || '未知错误';
    if (/额度|Token|Key|quota|登录/i.test(message || '')) el.quotaBox.open = true;
    setBusy(false);
  }

  function backToEmpty() {
    stopGenerating();
    StreamPlayer.stop();
    el.generating.classList.add('is-hidden');
    el.result.classList.add('is-hidden');
    el.errorCard.classList.add('is-hidden');
    el.empty.classList.remove('is-hidden');
    setBusy(false);
  }

  /* ------------------------------------------------------------------ *
   * 可视化
   * ------------------------------------------------------------------ */
  function startVisualizer() {
    stopVisualizer();
    const canvas = el.viz;
    const ctx2d = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const freq = new Uint8Array(256);
    const start = performance.now();

    const resize = () => {
      const w = canvas.clientWidth || 600;
      const h = canvas.clientHeight || 120;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
    };

    const draw = (now) => {
      rafHandle = requestAnimationFrame(draw);
      resize();
      const W = canvas.width;
      const H = canvas.height;
      ctx2d.clearRect(0, 0, W, H);

      const analyser = StreamPlayer.analyser;
      let hasSignal = false;
      if (analyser) {
        analyser.getByteFrequencyData(freq);
        for (let i = 0; i < freq.length; i++) if (freq[i] > 8) { hasSignal = true; break; }
      }

      const grad = ctx2d.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, 'rgba(167,139,250,.95)');
      grad.addColorStop(0.45, 'rgba(244,114,182,.95)');
      grad.addColorStop(1, 'rgba(251,191,36,.9)');
      ctx2d.fillStyle = grad;

      const bars = 56;
      const gap = W / bars;
      const barW = Math.max(2 * dpr, gap * 0.42);
      const t = (now - start) / 1000;
      const mid = H / 2;

      for (let i = 0; i < bars; i++) {
        let amp;
        if (hasSignal) {
          const idx = Math.floor((i / bars) * (freq.length * 0.62));
          amp = (freq[idx] / 255) ** 1.35;
        } else {
          const phase = i / bars * Math.PI * 3 + t * 1.6;
          amp = 0.10 + 0.09 * (0.5 + 0.5 * Math.sin(phase)) + 0.05 * Math.sin(t * 2 + i);
        }
        const h = Math.max(2 * dpr, amp * (H * 0.82));
        const x = i * gap + (gap - barW) / 2;
        ctx2d.beginPath();
        const r = barW / 2;
        const y = mid - h / 2;
        // 圆角竖条
        ctx2d.roundRect ? ctx2d.roundRect(x, y, barW, h, r) : ctx2d.rect(x, y, barW, h);
        ctx2d.fill();
      }

      // 中轴线光
      ctx2d.globalAlpha = 0.16;
      ctx2d.fillRect(0, mid - 1, W, 2);
      ctx2d.globalAlpha = 1;
    };

    rafHandle = requestAnimationFrame(draw);
  }

  function stopVisualizer() {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }

  /* ------------------------------------------------------------------ *
   * 生成流程
   * ------------------------------------------------------------------ */
  async function startGeneration() {
    if (busy) return;
    const duration = +el.duration.value;
    const steps = +el.quality.value;
    const instrumental = el.instrumental.checked;

    let payload = { duration, steps, instrumental };

    if (mode === 'simple') {
      const description = el.desc.value.trim();
      if (description.length < 2) {
        toast('先用一句话描述你想要的歌吧');
        el.desc.focus();
        return;
      }
      payload.description = description;
      payload.style = el.styleSimple.value.trim();

      // 纯音乐不需要写词，直接进入生成
      if (instrumental) {
        payload.lyrics = '[instrumental]';
        payload.title = description.slice(0, 16) || '纯音乐';
        payload.style = payload.style || 'cinematic, ambient, warm strings, 80 BPM';
        return startJob(payload);
      }

      cancelRequested = false;
      setBusy(true);
      showGenerating('正在写词…', 'AI 作词人正在为你构思');
      StreamPlayer.ensureContext();
      lyricAbort = new AbortController();

      try {
        const res = await fetch('/api/lyrics', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ description, style: payload.style, instrumental, duration }),
          signal: lyricAbort.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '歌词生成失败');
        if (cancelRequested) return;
        payload.lyrics = data.lyrics;
        payload.title = data.title;
        payload.style = data.style || payload.style;
        payload.description = description;
        el.stageText.textContent = '歌词写好了，正在谱曲…';
        el.stageSub.textContent = data.title ? `《${data.title}》` : '';
      } catch (err) {
        if (err.name === 'AbortError' || cancelRequested) return;
        showError(err.message);
        return;
      } finally {
        lyricAbort = null;
      }
    } else {
      const lyrics = el.lyrics.value.trim();
      const style = el.styleCustom.value.trim();
      if (!instrumental && lyrics.length < 10) {
        toast('歌词太短了，至少写几句');
        el.lyrics.focus();
        return;
      }
      payload.lyrics = lyrics;
      payload.title = el.title.value.trim() || '未命名作品';
      payload.style = style;
      payload.description = el.title.value.trim() || style;
    }

    return startJob(payload);
  }

  async function startJob(payload) {
    const token = el.hfToken.value.trim();
    if (token) payload.hfToken = token;
    const webToken = el.mmWebToken.value.trim();
    if (webToken) payload.mmWebToken = webToken;
    const stepToken = el.stepToken.value.trim();
    if (stepToken) payload.stepToken = stepToken;
    payload.minimaxModel = el.minimaxModel.value || '';
    cancelRequested = false;
    setBusy(true);
    showGenerating('正在提交…', '连接免费音源');
    StreamPlayer.ensureContext();
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '提交失败');

      if (cancelRequested) {
        fetch(`/api/jobs/${data.id}/cancel`, { method: 'POST' }).catch(() => {});
        return;
      }
      connectStream(data.id, data.engine);
    } catch (err) {
      showError(err.message);
    }
  }

  // 用同一份歌词/风格再生成一版（换随机种子）
  async function regenerateCurrent() {
    if (busy) return;
    if (!currentMeta) return startGeneration();
    if (eventSource) { eventSource.close(); eventSource = null; }
    StreamPlayer.stop();
    el.result.classList.add('is-hidden');
    await startJob({
      title: currentMeta.title || '未命名作品',
      description: currentMeta.description || '',
      lyrics: currentMeta.lyrics || '',
      style: currentMeta.style || '',
      duration: currentMeta.requestedDuration || currentMeta.duration || +el.duration.value,
      steps: +el.quality.value,
      instrumental: Boolean(currentMeta.instrumental),
    });
  }

  function connectStream(jobId, engine) {
    currentJob = jobId;
    lastSeq = 0;
    currentEngine = engine || 'hf';
    StreamPlayer.reset();
    if (currentEngine === 'web' || currentEngine === 'stepfun') {
      el.liveHint.textContent = currentEngine === 'stepfun'
        ? '阶跃音乐生成中，通常 1~3 分钟，完成后自动保存'
        : '网页版生成中，通常 3~8 分钟，完成后自动保存';
      startPseudoProgress();
    } else {
      el.liveHint.textContent = '正在实时演唱，声音会随生成进度播放';
    }
    if (eventSource) eventSource.close();

    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    eventSource = es;

    es.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'status') {
        if (msg.engine) currentEngine = msg.engine;
        if (msg.message) el.stageText.textContent = msg.message;
        const map = currentEngine === 'stepfun' ? stageSubtitleStepfun
          : currentEngine === 'web' ? stageSubtitleWeb : stageSubtitle;
        if (msg.stage && map[msg.stage]) el.stageSub.textContent = map[msg.stage];
        if (typeof msg.progress === 'number') setProgress(msg.progress, msg.seconds);
      } else if (msg.type === 'progress') {
        setProgress(msg.progress, msg.seconds);
      } else if (msg.type === 'chunk') {
        if (msg.seq && msg.seq <= lastSeq) return;
        lastSeq = msg.seq || lastSeq;
        StreamPlayer.push(msg.pcm, msg.sr, msg.ch);
      } else if (msg.type === 'done') {
        es.close();
        if (eventSource === es) eventSource = null;
        finish(msg.meta, msg.audioUrl);
      } else if (msg.type === 'error') {
        es.close();
        if (eventSource === es) eventSource = null;
        showError(msg.message || '生成失败');
      }
    };

    es.onerror = () => {
      // 浏览器会自动重连；若任务已结束，服务端会直接补发 done 并关闭。
      if (eventSource !== es) return;
      el.stageSub.textContent = '网络抖动，正在重连…';
    };
  }

  const stageSubtitle = {
    queued: '排队等待免费算力',
    submitting: '正在连接免费音源',
    waiting: '免费 GPU 排队中，请稍候',
    generating: '实时演唱中，可以边听边等',
    downloading: '正在保存音频',
    done: '完成',
  };

  const stageSubtitleStepfun = {
    queued: '等待阶跃接口',
    submitting: '连接 StepFun 阶跃音乐',
    waiting: '阶跃接口排队中',
    generating: '阶跃模型谱曲演唱中，通常 1~3 分钟',
    downloading: '正在保存音频',
    done: '完成',
  };

  const stageSubtitleWeb = {
    queued: '等待网页接口',
    submitting: '连接网页接口',
    waiting: '网页接口排队中',
    generating: '网页版模型谱曲演唱中，通常 3~8 分钟',
    downloading: '正在保存音频',
    done: '完成',
  };

  let lastProgress = 0;
  function setProgress(ratio, seconds) {
    if (currentEngine === 'web' || currentEngine === 'stepfun') return; // 无流式进度，交给伪进度
    const pct = Math.max(0, Math.min(1, ratio || 0));
    lastProgress = pct;
    el.barFill.style.width = (pct * 100).toFixed(1) + '%';
    const total = +el.duration.value;
    const sec = seconds != null ? seconds : pct * total;
    el.progressText.textContent = `${Math.max(0, sec).toFixed(0)} 秒 / ${total} 秒`;
  }

  async function finish(meta, audioUrl) {
    stopGenerating();
    setBusy(false);
    currentMeta = meta;

    el.generating.classList.add('is-hidden');
    el.errorCard.classList.add('is-hidden');
    el.result.classList.remove('is-hidden');

    const title = meta?.title || '未命名作品';
    el.songTitle.textContent = title;
    const fmt = String(meta?.format || (String(meta?.audio || '').endsWith('.mp3') ? 'mp3' : 'wav')).toUpperCase();
    const engineLabel = meta?.engine === 'stepfun' ? 'StepFun 阶跃'
      : meta?.engine === 'web' ? 'MiniMax 网页' : '公益 Space';
    el.songMeta.textContent = `${meta?.duration || 0} 秒 · ${fmt} · 44.1kHz · ${engineLabel}`;
    el.resultLyrics.textContent = (meta?.lyrics && !/[instrumental]/i.test(meta.lyrics || ''))
      ? meta.lyrics
      : '纯音乐作品，无人声。';

    // 封面配色随歌名变化
    const [c1, c2] = paletteFor(title);
    el.cover.style.setProperty('--c1', c1);
    el.cover.style.setProperty('--c2', c2);
    el.coverLetter.textContent = firstGlyph(title);
    applyCover(el.cover, el.coverLetter, title, meta?.coverUrl);

    // 风格标签
    el.styleChips.innerHTML = '';
    const tags = String(meta?.style || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
    if (meta?.instrumental && !tags.some(t => /instrumental|纯音乐/i.test(t))) tags.push('纯音乐');
    for (const tag of tags) {
      const span = document.createElement('span');
      span.className = 'chip';
      span.textContent = tag;
      el.styleChips.appendChild(span);
    }

    const url = audioUrl || meta?.audio;
    if (url) {
      el.audio.src = url;
      el.download.href = url;
      const ext = meta?.format || (String(url).endsWith('.mp3') ? 'mp3' : 'wav');
      el.download.setAttribute('download', safeFileName(title) + '.' + ext);
      el.audio.load();
      resetPlayerUI();
    }

    el.lyricsBox.open = false;
    el.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    loadLibrary();
    toast('歌曲生成完成 🎵');
  }

  function resetPlayerUI() {
    el.playBtn.querySelector('.i-play').classList.remove('is-hidden');
    el.playBtn.querySelector('.i-pause').classList.add('is-hidden');
    el.seek.value = 0;
    el.seek.style.setProperty('--fill', '0%');
    el.curTime.textContent = '0:00';
    el.totTime.textContent = formatTime(el.audio.duration || currentMeta?.duration || 0);
  }

  function applyCover(node, letterNode, title, coverUrl) {
    if (!node) return;
    if (coverUrl) {
      node.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,.03), rgba(0,0,0,.45)), url("${coverUrl}")`;
      node.classList.add('has-art');
    } else {
      node.style.backgroundImage = '';
      node.classList.remove('has-art');
    }
  }

  function paletteFor(text) {
    const palettes = [
      ['#7c3aed', '#f472b6'],
      ['#0ea5e9', '#8b5cf6'],
      ['#f97316', '#db2777'],
      ['#10b981', '#0ea5e9'],
      ['#eab308', '#ec4899'],
      ['#8b5cf6', '#f59e0b'],
      ['#ef4444', '#8b5cf6'],
    ];
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return palettes[h % palettes.length];
  }

  function firstGlyph(text) {
    const t = (text || '').trim();
    return t ? Array.from(t)[0].toUpperCase() : '♪';
  }

  function safeFileName(name) {
    return (name || 'song').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  async function cancelGeneration() {
    cancelRequested = true;
    if (lyricAbort) { try { lyricAbort.abort(); } catch {} }
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (currentJob) {
      fetch(`/api/jobs/${currentJob}/cancel`, { method: 'POST' }).catch(() => {});
      currentJob = null;
    }
    StreamPlayer.stop();
    backToEmpty();
    toast('已停止生成');
  }

  /* ------------------------------------------------------------------ *
   * 播放器
   * ------------------------------------------------------------------ */
  function bindPlayer() {
    el.playBtn.addEventListener('click', async () => {
      StreamPlayer.stop(); // 结束实时流，避免双重播放
      if (el.audio.paused) {
        try { await el.audio.play(); } catch (e) { toast('浏览器阻止了播放，请再点一次'); }
      } else {
        el.audio.pause();
      }
    });

    el.audio.addEventListener('play', () => {
      el.playBtn.querySelector('.i-play').classList.add('is-hidden');
      el.playBtn.querySelector('.i-pause').classList.remove('is-hidden');
    });
    el.audio.addEventListener('pause', () => {
      el.playBtn.querySelector('.i-play').classList.remove('is-hidden');
      el.playBtn.querySelector('.i-pause').classList.add('is-hidden');
    });
    el.audio.addEventListener('loadedmetadata', () => {
      el.totTime.textContent = formatTime(el.audio.duration);
    });
    el.audio.addEventListener('timeupdate', () => {
      if (seekDragging || !el.audio.duration) return;
      const pct = (el.audio.currentTime / el.audio.duration) * 100;
      el.seek.value = String(Math.round(pct * 10));
      el.seek.style.setProperty('--fill', pct + '%');
      el.curTime.textContent = formatTime(el.audio.currentTime);
    });
    el.audio.addEventListener('ended', () => {
      el.seek.value = 0;
      el.seek.style.setProperty('--fill', '0%');
      el.curTime.textContent = '0:00';
    });

    el.seek.addEventListener('input', () => { seekDragging = true; });
    el.seek.addEventListener('change', () => {
      seekDragging = false;
      if (!el.audio.duration) return;
      const pct = Number(el.seek.value) / 1000;
      el.audio.currentTime = pct * el.audio.duration;
      el.seek.style.setProperty('--fill', (pct * 100) + '%');
      el.curTime.textContent = formatTime(el.audio.currentTime);
    });

    el.copyLyrics.addEventListener('click', async () => {
      const text = el.resultLyrics.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        toast('歌词已复制');
      } catch {
        toast('复制失败，请手动选择');
      }
    });

    el.regen.addEventListener('click', () => {
      if (busy) return;
      regenerateCurrent();
    });
  }

  /* ------------------------------------------------------------------ *
   * 作品库
   * ------------------------------------------------------------------ */
  async function loadLibrary() {
    try {
      const res = await fetch('/api/library');
      const data = await res.json();
      renderLibrary(data.items || []);
    } catch {
      el.library.innerHTML = '';
    }
  }

  function renderLibrary(items) {
    el.library.innerHTML = '';
    el.libraryCount.textContent = items.length ? `${items.length} 首` : '';
    if (!items.length) {
      el.library.innerHTML = '<p class="library-empty">还没有作品，生成的第一首歌会出现在这里。</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const item of items) {
      const card = document.createElement('button');
      card.className = 'song-card';
      card.type = 'button';
      const [c1, c2] = paletteFor(item.title || '');
      card.innerHTML = `
        <span class="mini" style="--c1:${c1};--c2:${c2}"></span>
        <span class="info">
          <span class="name"></span>
          <span class="sub"></span>
        </span>`;
      const mini = card.querySelector('.mini');
      mini.textContent = firstGlyph(item.title);
      if (item.coverUrl) {
        mini.style.backgroundImage = `url("${item.coverUrl}")`;
        mini.classList.add('has-art');
        mini.textContent = '';
      }
      card.querySelector('.name').textContent = item.title || '未命名作品';
      card.querySelector('.sub').textContent = `${item.duration || 0} 秒 · ${(item.style || '').split(',')[0] || 'AI 音乐'}`;
      card.addEventListener('click', () => loadSong(item));
      frag.appendChild(card);
    }
    el.library.appendChild(frag);
  }

  function loadSong(item) {
    StreamPlayer.stop();
    if (eventSource) { eventSource.close(); eventSource = null; }
    if (busy) {
      if (currentJob) fetch(`/api/jobs/${currentJob}/cancel`, { method: 'POST' }).catch(() => {});
      setBusy(false);
      stopGenerating();
    }
    el.generating.classList.add('is-hidden');
    el.errorCard.classList.add('is-hidden');
    el.empty.classList.add('is-hidden');
    el.result.classList.remove('is-hidden');

    currentMeta = item;
    el.songTitle.textContent = item.title || '未命名作品';
    const itemFmt = String(item.format || (String(item.audio || '').endsWith('.mp3') ? 'mp3' : 'wav')).toUpperCase();
    const itemEngine = item.engine === 'stepfun' ? 'StepFun 阶跃'
      : item.engine === 'web' ? 'MiniMax 网页' : '公益 Space';
    el.songMeta.textContent = `${item.duration || 0} 秒 · ${itemFmt} · 44.1kHz · ${itemEngine}`;
    el.resultLyrics.textContent = item.lyrics && !/[instrumental]/i.test(item.lyrics || '') ? item.lyrics : '纯音乐作品，无人声。';
    const [c1, c2] = paletteFor(item.title || '');
    el.cover.style.setProperty('--c1', c1);
    el.cover.style.setProperty('--c2', c2);
    el.coverLetter.textContent = firstGlyph(item.title);
    applyCover(el.cover, el.coverLetter, item.title, item.coverUrl);

    el.styleChips.innerHTML = '';
    for (const tag of String(item.style || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 6)) {
      const span = document.createElement('span');
      span.className = 'chip';
      span.textContent = tag;
      el.styleChips.appendChild(span);
    }

    el.audio.src = item.audio;
    el.download.href = item.audio;
    const itemExt = item.format || (String(item.audio).endsWith('.mp3') ? 'mp3' : 'wav');
    el.download.setAttribute('download', safeFileName(item.title) + '.' + itemExt);
    el.audio.load();
    resetPlayerUI();
    el.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ------------------------------------------------------------------ *
   * 健康检查
   * ------------------------------------------------------------------ */
  async function checkHealth() {
    if (hasStepToken()) {
      const dot = el.engineStatus.querySelector('.dot');
      if (dot) dot.className = 'dot ok';
      el.engineText.textContent = 'StepFun 登录态已配置';
      return;
    }
    if (hasWebToken()) {
      const dot = el.engineStatus.querySelector('.dot');
      if (dot) dot.className = 'dot ok';
      el.engineText.textContent = '网页登录态已配置';
      return;
    }
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      const dot = el.engineStatus.querySelector('.dot');
      if (data.ok) {
        dot.className = 'dot ok';
        el.engineText.textContent = `免费音源在线 · ${data.latency}ms`;
      } else {
        dot.className = 'dot bad';
        el.engineText.textContent = '音源离线 · 检查代理';
      }
    } catch {
      const dot = el.engineStatus.querySelector('.dot');
      dot.className = 'dot bad';
      el.engineText.textContent = '无法连接本地服务';
    }
  }

  /* ------------------------------------------------------------------ *
   * 草稿保存 & 初始化
   * ------------------------------------------------------------------ */
  const DRAFT_KEY = 'sonicwave.draft.v1';
  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        mode,
        desc: el.desc.value,
        styleSimple: el.styleSimple.value,
        title: el.title.value,
        lyrics: el.lyrics.value,
        styleCustom: el.styleCustom.value,
        duration: el.duration.value,
        quality: el.quality.value,
        instrumental: el.instrumental.checked,
        hfToken: el.hfToken.value,
        minimaxModel: el.minimaxModel.value,
        mmWebToken: el.mmWebToken.value,
        stepToken: el.stepToken.value,
      }));
    } catch { /* 隐私模式忽略 */ }
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.mode === 'custom' || d.mode === 'simple') switchMode(d.mode);
      el.desc.value = d.desc || '';
      el.styleSimple.value = d.styleSimple || '';
      el.title.value = d.title || '';
      el.lyrics.value = d.lyrics || '';
      el.styleCustom.value = d.styleCustom || '';
      if (d.duration) el.duration.value = d.duration;
      if (d.quality) el.quality.value = d.quality;
      el.instrumental.checked = Boolean(d.instrumental);
      el.hfToken.value = d.hfToken || '';
      el.minimaxModel.value = d.minimaxModel || '';
      el.mmWebToken.value = d.mmWebToken || '';
      el.stepToken.value = d.stepToken || '';
    } catch { /* 忽略损坏草稿 */ }
  }

  function bind() {
    el.tabs.forEach(tab => tab.addEventListener('click', () => switchMode(tab.dataset.tab)));

    el.duration.addEventListener('input', updateRangeFill);
    el.quality.addEventListener('change', updateQuotaEstimate);
    el.instrumental.addEventListener('change', () => {
      if (el.instrumental.checked && mode === 'custom') {
        el.lyrics.placeholder = '纯音乐模式：歌词会被忽略';
      } else {
        el.lyrics.placeholder = '[Verse]\n霓虹落在海面上\n你笑着说要走\n\n[Chorus]\n整个夏天都在回荡';
      }
      saveDraft();
    });

    el.ideaChips.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      el.desc.value = btn.textContent;
      el.desc.focus();
      saveDraft();
    });

    el.generate.addEventListener('click', startGeneration);
    el.cancel.addEventListener('click', cancelGeneration);
    el.retry.addEventListener('click', startGeneration);

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!busy) startGeneration();
      }
    });

    el.minimaxModel.addEventListener('change', () => { updateEngineUI(); saveDraft(); });
    el.mmWebToken.addEventListener('input', () => { updateEngineUI(); saveDraft(); });
    el.mmWebToken.addEventListener('change', () => { updateEngineUI(); saveDraft(); });
    el.stepToken.addEventListener('input', () => { updateEngineUI(); saveDraft(); });
    el.stepToken.addEventListener('change', () => { updateEngineUI(); saveDraft(); });

    for (const input of [el.desc, el.styleSimple, el.title, el.lyrics, el.styleCustom, el.quality, el.hfToken, el.minimaxModel, el.mmWebToken, el.stepToken]) {
      input.addEventListener('input', saveDraft);
      input.addEventListener('change', saveDraft);
    }

    bindPlayer();
  }

  function init() {
    bind();
    loadDraft();
    updateEngineUI();
    updateRangeFill();
    checkHealth();
    setInterval(checkHealth, 60000);
    loadLibrary();
  }

  init();
})();
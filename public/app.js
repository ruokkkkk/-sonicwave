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
    minimaxModel: $('#minimaxModel'),
    mmWebToken: $('#mmWebToken'),
    stepToken: $('#stepToken'),
    webTokenBox: $('#webTokenBox'),
    stepTokenBox: $('#stepTokenBox'),
    modelTip: $('#modelTip'),
    engineNow: $('#engineNow'),
    engineSelect: $('#engineSelect'),
    quotaBox: $('#quotaBox'),
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
  let timerHandle = null;
  let hardTimer = null;
  let timerStart = 0;
  let cancelRequested = false;
  let lyricAbort = null;
  let rafHandle = null;
  let currentMeta = null;
  let seekDragging = false;
  let currentEngine = 'stepfun';
  let serverWebToken = false;
  let serverStepToken = false;
  let pseudoTimer = null;

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

  function stepTokenInfo() {
    let raw = (el.stepToken.value || '').trim();
    if (raw.includes('Oasis-Token=')) {
      const m = raw.match(/Oasis-Token=([^;\s]+)/);
      raw = m ? m[1] : '';
      try { raw = decodeURIComponent(raw); } catch { /* 保持原样 */ }
    }
    const parts = raw.split('...');
    const complete = parts.length === 2 && /^eyJ/.test(parts[0]) && /^eyJ/.test(parts[1]);
    return { raw, complete };
  }

  function hasStepToken() {
    return stepTokenInfo().complete;
  }

  function stepReady() { return hasStepToken() || serverStepToken; }
  function webReady() { return hasWebToken() || serverWebToken; }

  function activeEngine() {
    return el.engineSelect.value === 'web' ? 'web' : 'stepfun';
  }

  function webModelLabel() {
    const m = String(el.minimaxModel?.value || 'music-3.0').replace(/-free$/i, '');
    return ['music-3.0', 'music-2.6'].includes(m) ? m : 'music-3.0';
  }

  const WEB_MODEL_OPTIONS = [
    ['music-3.0', 'music-3.0 · 网页版'],
    ['music-2.6', 'music-2.6 · 网页版'],
  ];
  const STEPFUN_MODEL_OPTIONS = [
    ['step-music', 'step-music · 阶跃'],
  ];

  function syncModelOptions(engine) {
    const want = engine === 'web' ? WEB_MODEL_OPTIONS : STEPFUN_MODEL_OPTIONS;
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
    const stepInfo = stepTokenInfo();
    const stepIncomplete = Boolean(stepInfo.raw) && !stepInfo.complete && !serverStepToken;
    const ready = engine === 'stepfun' ? stepReady() : webReady();
    if (el.engineNow) {
      if (engine === 'stepfun') {
        el.engineNow.innerHTML = ready
          ? '当前使用：<b>StepFun 阶跃</b> · step-music（消耗账号音乐额度）'
          : stepIncomplete
            ? '当前使用：<b>StepFun 阶跃</b> · Token 不完整（需要 access...refresh 两段）'
            : '当前使用：<b>StepFun 阶跃</b> · 还没配置登录态';
      } else {
        el.engineNow.innerHTML = ready
          ? `当前使用：<b>MiniMax 网页登录态</b> · ${webModelLabel()}（消耗网页创作额度）`
          : '当前使用：<b>MiniMax 网页登录态</b> · 还没配置登录态';
      }
    }
    if (el.minimaxModel) el.minimaxModel.disabled = false;
    if (el.webTokenBox) el.webTokenBox.classList.toggle('is-hidden', engine !== 'web');
    if (el.stepTokenBox) el.stepTokenBox.classList.toggle('is-hidden', engine !== 'stepfun');
    if (el.modelTip) {
      el.modelTip.textContent = engine === 'stepfun'
        ? '阶跃使用固定模型 step-music，按账号的音乐生成额度计费。'
        : '网页登录态使用正式模型，按网页账号的创作次数计费。';
    }
    if (el.modeBadge) el.modeBadge.textContent = engine === 'stepfun' ? 'StepFun 登录态' : '网页登录态';
    const dot = el.engineStatus.querySelector('.dot');
    const bad = engine === 'stepfun' && stepIncomplete;
    if (dot) dot.className = 'dot ' + (ready ? 'ok' : bad ? 'bad' : 'wait');
    el.engineText.textContent = engine === 'stepfun'
      ? (ready ? 'StepFun 登录态已配置' : bad ? 'StepFun Token 不完整' : '等待填入 StepFun Token')
      : (ready ? '网页登录态已配置' : '等待填入网页 Token');
  }

  async function loadConfig() {
    try {
      const cfg = await (await fetch('/api/config')).json();
      serverWebToken = Boolean(cfg.hasWebToken);
      serverStepToken = Boolean(cfg.hasStepToken);
    } catch { /* 忽略 */ }
    updateEngineUI();
  }

  function showGenerating(title, sub) {
    el.empty.classList.add('is-hidden');
    el.result.classList.add('is-hidden');
    el.errorCard.classList.add('is-hidden');
    el.generating.classList.remove('is-hidden');
    el.stageText.textContent = title || '正在创作…';
    el.stageSub.textContent = sub || '';
    el.barFill.style.width = '0%';
    el.progressText.textContent = '准备中…';
    el.elapsed.textContent = '00:00';
    timerStart = Date.now();
    clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      const s = Math.floor((Date.now() - timerStart) / 1000);
      el.elapsed.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 1000);
    startVisualizer();

    // 兜底：任何引擎超过 12 分钟都没结束，自动停表并提示
    clearTimeout(hardTimer);
    hardTimer = setTimeout(() => {
      if (!busy) return;
      if (currentJob) fetch(`/api/jobs/${currentJob}/cancel`, { method: 'POST' }).catch(() => {});
      if (eventSource) { eventSource.close(); eventSource = null; }
      showError('生成超过 12 分钟仍未完成，已自动停止。请重试，或换用其它引擎。');
    }, 12 * 60 * 1000);
  }

  function stopGenerating() {
    clearInterval(timerHandle);
    timerHandle = null;
    clearTimeout(hardTimer);
    hardTimer = null;
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

      const hasSignal = false;

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
    const instrumental = el.instrumental.checked;
    const engine = activeEngine();
    if (engine === 'stepfun' && !stepReady()) {
      const info = stepTokenInfo();
      toast(info.raw
        ? 'StepFun Token 不完整：需要完整的 Oasis-Token（access...refresh 两段）'
        : '先填入 StepFun 登录态 Token');
      el.quotaBox.open = true;
      return;
    }
    if (engine === 'web' && !webReady()) {
      toast('先填入 MiniMax 网页登录态 Token');
      el.quotaBox.open = true;
      return;
    }
    let payload = { instrumental, engine };

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
      lyricAbort = new AbortController();

      try {
        const res = await fetch('/api/lyrics', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ description, style: payload.style, instrumental }),
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
    payload.engine = activeEngine();
    const webToken = el.mmWebToken.value.trim();
    if (webToken) payload.mmWebToken = webToken;
    const stepToken = el.stepToken.value.trim();
    if (stepToken) payload.stepToken = stepToken;
    payload.minimaxModel = el.minimaxModel.value || '';
    cancelRequested = false;
    setBusy(true);
    showGenerating('正在提交…', '连接免费音源');
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
    el.result.classList.add('is-hidden');
    await startJob({
      title: currentMeta.title || '未命名作品',
      description: currentMeta.description || '',
      lyrics: currentMeta.lyrics || '',
      style: currentMeta.style || '',
      instrumental: Boolean(currentMeta.instrumental),
    });
  }

  function connectStream(jobId, engine) {
    currentJob = jobId;
    currentEngine = engine === 'web' ? 'web' : 'stepfun';
    el.liveHint.textContent = currentEngine === 'stepfun'
      ? '阶跃音乐生成中，通常 1~3 分钟（超过 12 分钟会自动停止）'
      : '网页版生成中，通常 3~8 分钟（超过 12 分钟会自动停止）';
    startPseudoProgress();
    if (eventSource) eventSource.close();

    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    eventSource = es;

    es.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'status') {
        if (msg.engine) currentEngine = msg.engine;
        if (msg.message) el.stageText.textContent = msg.message;
        const map = currentEngine === 'web' ? stageSubtitleWeb : stageSubtitleStepfun;
        if (msg.stage && map[msg.stage]) el.stageSub.textContent = map[msg.stage];
      } else if (msg.type === 'token' && msg.stepToken) {
        el.stepToken.value = msg.stepToken;
        saveDraft();
        updateEngineUI();
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
      if (eventSource !== es) return;
      el.stageSub.textContent = '网络抖动，正在重连…';
    };
  }

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
      : meta?.engine === 'web' ? 'MiniMax 网页' : '旧版 Space';
    el.songMeta.textContent = `${meta?.duration || 0} 秒 · ${fmt} · 44.1kHz · ${engineLabel}`;
    el.resultLyrics.textContent = isInstrumentalSong(meta) ? '纯音乐作品，无人声。' : meta.lyrics;

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

  function isInstrumentalSong(meta) {
    const lyrics = String(meta?.lyrics || '').trim();
    return Boolean(meta?.instrumental) || !lyrics || /^\[instrumental\]$/i.test(lyrics);
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
    backToEmpty();
    toast('已停止生成');
  }

  /* ------------------------------------------------------------------ *
   * 播放器
   * ------------------------------------------------------------------ */
  function bindPlayer() {
    el.playBtn.addEventListener('click', async () => {
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
      : item.engine === 'web' ? 'MiniMax 网页' : '旧版 Space';
    el.songMeta.textContent = `${item.duration || 0} 秒 · ${itemFmt} · 44.1kHz · ${itemEngine}`;
    el.resultLyrics.textContent = isInstrumentalSong(item) ? '纯音乐作品，无人声。' : item.lyrics;
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
        instrumental: el.instrumental.checked,
        engine: el.engineSelect.value,
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
      el.instrumental.checked = Boolean(d.instrumental);
      if (d.engine === 'web' || d.engine === 'stepfun') el.engineSelect.value = d.engine;
      el.minimaxModel.value = d.minimaxModel || '';
      el.mmWebToken.value = d.mmWebToken || '';
      el.stepToken.value = d.stepToken || '';
    } catch { /* 忽略损坏草稿 */ }
  }

  function bind() {
    el.tabs.forEach(tab => tab.addEventListener('click', () => switchMode(tab.dataset.tab)));

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

    el.engineSelect.addEventListener('change', () => { updateEngineUI(); saveDraft(); });
    el.minimaxModel.addEventListener('change', () => { updateEngineUI(); saveDraft(); });
    el.mmWebToken.addEventListener('input', () => { updateEngineUI(); saveDraft(); });
    el.mmWebToken.addEventListener('change', () => { updateEngineUI(); saveDraft(); });
    el.stepToken.addEventListener('input', () => { updateEngineUI(); saveDraft(); });
    el.stepToken.addEventListener('change', () => { updateEngineUI(); saveDraft(); });

    for (const input of [el.desc, el.styleSimple, el.title, el.lyrics, el.styleCustom, el.minimaxModel, el.mmWebToken, el.stepToken]) {
      input.addEventListener('input', saveDraft);
      input.addEventListener('change', saveDraft);
    }

    bindPlayer();
  }

  function init() {
    bind();
    loadDraft();
    updateEngineUI();
    loadConfig();
    loadLibrary();
  }

  init();
})();
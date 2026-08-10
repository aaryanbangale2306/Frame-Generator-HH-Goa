/* ============================================================
   HH GOA 2026 — ID Card Generator
   Vanilla JS · single-canvas render pipeline · no backend
   ============================================================ */
(() => {
  'use strict';

  // ── DOM refs ──
  const $ = (id) => document.getElementById(id);
  const dropzone     = $('dropzone');
  const fileInput    = $('fileInput');
  const dzEmpty      = $('dropzoneEmpty');
  const dzLoading    = $('dropzoneLoading');
  const loadingLabel = $('loadingLabel');
  const cropSection  = $('cropSection');
  const cropCanvas   = $('cropCanvas');
  const cropMaskFrame= $('cropMaskFrame');
  const zoomSlider   = $('zoomSlider');
  const changePhotoBtn = $('changePhotoBtn');
  const fieldsStep   = $('fieldsStep');
  const nameInput    = $('nameInput');
  const roleInput    = $('roleInput');
  const titlePreview = $('titlePreview');
  const shuffleTitleBtn = $('shuffleTitleBtn');
  const previewEmpty = $('previewEmpty');
  const outputCanvas = $('outputCanvas');
  const renderBadge  = $('renderBadge');
  const actions      = $('actions');
  const downloadBtn  = $('downloadBtn');
  const shareBtn     = $('shareBtn');
  const shareNote    = $('shareNote');
  const toastEl      = $('toast');
  const previewFormatBadge = $('previewFormatBadge');
  const stepNums     = [null, $('stepNum1'), $('stepNum2')];

  const cropCtx = cropCanvas.getContext('2d');
  const outCtx  = outputCanvas.getContext('2d');

  // ── Design tokens (keep in sync with CSS) ──
  const T = {
    ink:       '#041a0d',
    inkRaised: '#072b12',
    gold:      '#ffe500',
    goldDim:   'rgba(255,229,0,.7)',
    magenta:   '#e9148c',
    lime:      '#8ec92a',
    white:     '#ffffff',
    black:     '#000000',
    greenBg:   '#09451e',
  };

  // ── State — initialised to match HTML defaults ──
  const state = {
    img: null,
    zoom: 1,
    panX: 0.5, panY: 0.5,
    name: '',
    role: '',
    titleSeed: 0,
  };

  let dragging = false;
  let dragStart = { x: 0, y: 0, panX: 0.5, panY: 0.5 };
  let pinchStartDist = null, pinchStartZoom = 1;

  // Re-render after fonts load so canvas text gets webfonts
  if (document.fonts) {
    document.fonts.ready.then(() => scheduleRender()).catch(() => {});
    document.fonts.addEventListener('loadingdone', () => scheduleRender());
  }

  // ── Initialise UI state from defaults ──
  function initUI() {
    cropMaskFrame.className = 'crop-mask crop-mask--square';
    fieldsStep.hidden = false;
    updateFormatBadge();
    highlightStep(1);
  }

  function highlightStep(active) {
    [1, 2, 3].forEach((i) => {
      if (stepNums[i]) {
        stepNums[i].classList.toggle('active', i <= active);
      }
    });
  }

  function updateFormatBadge() {
    if (!previewFormatBadge) return;
    previewFormatBadge.textContent = 'ID CARD';
  }

  // ── Toast ──
  let toastTimer;
  function toast(msg, ms = 3200) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  // ── Mobile helper ──
  function isMobile() { return window.innerWidth <= 900; }
  function scrollPreviewIntoView() {
    if (!isMobile()) return;
    outputCanvas.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ============================================================
  // File loading (HEIC-aware)
  // ============================================================
  let heic2anyReady = null;
  function ensureHeic2any() {
    if (window.heic2any) return Promise.resolve();
    if (heic2anyReady) return heic2anyReady;
    heic2anyReady = new Promise((resolve, reject) => {
      const check = () => (window.heic2any ? resolve() : setTimeout(check, 60));
      check();
      setTimeout(() => reject(new Error('heic2any load timeout')), 8000);
    });
    return heic2anyReady;
  }

  function loadHTMLImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  async function loadImageFile(file) {
    const looksHeic = /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
    if (!looksHeic) {
      try { return await loadHTMLImage(URL.createObjectURL(file)); } catch (_) {}
    }
    loadingLabel.textContent = 'Converting HEIC…';
    await ensureHeic2any();
    const converted = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    const blob = Array.isArray(converted) ? converted[0] : converted;
    return loadHTMLImage(URL.createObjectURL(blob));
  }

  async function handleFile(file) {
    if (!file || (!/^image\//.test(file.type) && !/\.hei[cf]$/i.test(file.name))) {
      toast('Please choose a photo file (JPG, PNG, or HEIC).');
      return;
    }
    dzEmpty.hidden = true; dzLoading.hidden = false;
    loadingLabel.textContent = 'Reading photo…';
    try {
      const img = await loadImageFile(file);
      state.img = img;
      state.zoom = 1; state.panX = 0.5; state.panY = 0.5;
      zoomSlider.value = '1';
      cropSection.hidden = false;
      dropzone.hidden = true;
      fieldsStep.hidden = false;
      highlightStep(2);
      renderCropPreview();
      scheduleRender();
      requestAnimationFrame(() => scrollPreviewIntoView());
    } catch (err) {
      console.error(err);
      toast("Couldn't read that photo — try a JPG or PNG.");
      dzEmpty.hidden = false; dzLoading.hidden = true;
    }
  }

  // ============================================================
  // Cover-fit drawing helper
  // ============================================================
  function drawCoverImage(ctx, img, dx, dy, dw, dh, zoom, panX, panY) {
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const coverScale = Math.max(dw / nw, dh / nh);
    const scale = coverScale * zoom;
    const sw = nw * scale, sh = nh * scale;
    const excessX = Math.max(0, sw - dw), excessY = Math.max(0, sh - dh);
    const offX = dx - panX * excessX;
    const offY = dy - panY * excessY;
    ctx.save();
    ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip();
    ctx.drawImage(img, offX, offY, sw, sh);
    ctx.restore();
  }

  // ============================================================
  // Crop interaction
  // ============================================================
  function renderCropPreview() {
    const size = cropCanvas.width;
    cropCtx.clearRect(0, 0, size, size);
    cropCtx.fillStyle = T.ink;
    cropCtx.fillRect(0, 0, size, size);
    if (state.img) {
      drawCoverImage(cropCtx, state.img, 0, 0, size, size, state.zoom, state.panX, state.panY);
    }
  }

  function pointerPos(e) {
    const r = cropCanvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, rectW: r.width, rectH: r.height };
  }

  function excessAt(displaySize, zoom) {
    if (!state.img) return { ex: 0, ey: 0 };
    const nw = state.img.naturalWidth, nh = state.img.naturalHeight;
    const coverScale = Math.max(displaySize / nw, displaySize / nh);
    const scale = coverScale * zoom;
    return { ex: Math.max(0, nw * scale - displaySize), ey: Math.max(0, nh * scale - displaySize) };
  }

  function clamp01(v) { return Math.min(1, Math.max(0, v)); }

  cropCanvas.addEventListener('pointerdown', (e) => {
    if (!state.img) return;
    cropCanvas.setPointerCapture(e.pointerId);
    const p = pointerPos(e);
    dragging = true;
    dragStart = { x: p.x, y: p.y, panX: state.panX, panY: state.panY };
  });
  cropCanvas.addEventListener('pointermove', (e) => {
    if (!dragging || !state.img) return;
    const p = pointerPos(e);
    const { ex, ey } = excessAt(p.rectW, state.zoom);
    const dx = p.x - dragStart.x, dy = p.y - dragStart.y;
    state.panX = clamp01(dragStart.panX - (ex ? dx / ex : 0));
    state.panY = clamp01(dragStart.panY - (ey ? dy / ey : 0));
    renderCropPreview(); scheduleRender();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    cropCanvas.addEventListener(ev, () => { dragging = false; })
  );
  cropCanvas.addEventListener('wheel', (e) => {
    if (!state.img) return;
    e.preventDefault();
    setZoom(state.zoom - e.deltaY * 0.0015);
  }, { passive: false });

  // Pinch-to-zoom
  const activeTouches = new Map();
  cropCanvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activeTouches.size === 2) {
      const pts = [...activeTouches.values()];
      pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartZoom = state.zoom;
      dragging = false;
    }
  });
  cropCanvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && activeTouches.has(e.pointerId)) {
      activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouches.size === 2 && pinchStartDist) {
        const pts = [...activeTouches.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        setZoom(pinchStartZoom * (dist / pinchStartDist));
      }
    }
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    cropCanvas.addEventListener(ev, (e) => {
      activeTouches.delete(e.pointerId);
      if (activeTouches.size < 2) pinchStartDist = null;
    })
  );

  function setZoom(z) {
    state.zoom = Math.min(3, Math.max(1, z));
    zoomSlider.value = String(state.zoom);
    renderCropPreview(); scheduleRender();
  }
  zoomSlider.addEventListener('input', () => setZoom(parseFloat(zoomSlider.value)));

  // ============================================================
  // Upload wiring
  // ============================================================
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  fileInput.addEventListener('change', (e) => e.target.files[0] && handleFile(e.target.files[0]));
  ['dragover', 'dragenter'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); dropzone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); dropzone.classList.remove('dragover');
  }));
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  const samplePhotoBtn = $('samplePhotoBtn');
  if (samplePhotoBtn) {
    samplePhotoBtn.addEventListener('click', (e) => { e.stopPropagation(); loadSamplePhoto(); });
  }

  async function loadSamplePhoto() {
    dzEmpty.hidden = true; dzLoading.hidden = false; loadingLabel.textContent = 'Loading sample…';
    try {
      const res = await fetch('user_photo.jpg');
      if (res.ok) {
        const blob = await res.blob();
        await handleFile(new File([blob], 'user-photo.jpg', { type: 'image/jpeg' }));
        return;
      }
    } catch (_) {}
    // Generate a vivid placeholder avatar
    const c = document.createElement('canvas');
    c.width = 800; c.height = 800;
    const cx = c.getContext('2d');
    // Gradient background
    const g = cx.createLinearGradient(0, 0, 800, 800);
    g.addColorStop(0, '#0d5c27'); g.addColorStop(0.5, '#e9148c'); g.addColorStop(1, '#ffe500');
    cx.fillStyle = g; cx.fillRect(0, 0, 800, 800);
    // Head silhouette
    cx.fillStyle = 'rgba(255,255,255,0.2)';
    cx.beginPath(); cx.arc(400, 310, 140, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(400, 680, 260, 0, Math.PI * 2); cx.fill();
    // Glow ring
    cx.strokeStyle = 'rgba(255,229,0,0.8)'; cx.lineWidth = 10;
    cx.beginPath(); cx.arc(400, 310, 140, 0, Math.PI * 2); cx.stroke();
    // "HH" text
    cx.font = 'bold 80px sans-serif'; cx.fillStyle = 'rgba(255,229,0,0.9)';
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText('HH', 400, 310);
    c.toBlob((blob) => {
      handleFile(new File([blob], 'sample.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.95);
  }

  changePhotoBtn.addEventListener('click', () => {
    state.img = null;
    cropSection.hidden = true;
    dropzone.hidden = false;
    dzEmpty.hidden = false; dzLoading.hidden = true;
    fileInput.value = '';
    previewEmpty.hidden = false;
    outputCanvas.hidden = true; renderBadge.hidden = true;
    actions.hidden = true; shareNote.hidden = true;
    highlightStep(1);
  });

  // ============================================================
  // Builder title & tagline generator
  // ============================================================
  const STACK_TITLES = [
    [/front|react|vue|css|ui\b/i, ['Pixel Pusher', 'Div Whisperer', 'Flexbox Diplomat', 'Component Alchemist']],
    [/back|api|server|node|django|rails/i, ['Query Whisperer', 'Endpoint Architect', 'Latency Hunter', 'Middleware Monk']],
    [/ai|ml|model|llm|gpt/i, ['Prompt Alchemist', 'Gradient Descender', 'Token Wrangler', 'Hallucination Herder']],
    [/design|ux|figma/i, ['Vibes Engineer', 'Pixel Perfectionist', 'Whitespace Advocate', 'Contrast Crusader']],
    [/full[\s-]?stack/i, ['Swiss Army Dev', 'Context Switcher-in-Chief', 'Both-Ends Bandit']],
    [/block|web3|crypto|solidity/i, ['Gas Fee Survivor', 'Consensus Chaser', 'Mempool Philosopher']],
    [/mobile|ios|android|flutter|swift|kotlin/i, ['Thumb-Zone Architect', 'Notch Negotiator', 'App Store Gambler']],
    [/data|analytics|sql/i, ['Pivot Table Poet', 'Outlier Hunter', 'Dashboard Druid']],
    [/devops|infra|cloud|kubernetes|docker/i, ['Uptime Guardian', 'YAML Sherpa', 'Container Whisperer']],
    [/security|sec|hack|pentest/i, ['Threat Model Sommelier', 'Zero-Day Optimist', 'Firewall Poet']],
    [/game|unity|unreal/i, ['Frame-Rate Diplomat', 'Hitbox Perfectionist', 'NPC Therapist']],
    [/product|pm\b/i, ['Roadmap Cartographer', 'Scope Creep Survivor', 'Backlog Archaeologist']],
  ];
  const GENERIC_TITLES = [
    'Bug Whisperer', 'Ship-It Specialist', 'Merge-Conflict Survivor', 'Midnight-Deploy Veteran',
    'Stack Overflow Alumnus', 'Coffee-to-Code Converter', 'Rubber-Duck Diplomat', '404 Page Aesthete',
    'Chaos-Branch Cartographer', 'Semicolon Enthusiast', 'Demo-Day Gambler', 'Sleep-Deprived Visionary',
  ];
  const STACK_TAGLINES = [
    [/front|react|vue|css|ui\b/i,         ['PIXEL PUSHER BY DAY, DEBUGGER BY 3AM', 'MAKING THE WEB PRETTY, ONE DIV AT A TIME', 'CSS IS MY LOVE LANGUAGE']],
    [/back|api|server|node|django|rails/i, ['BUILDING THE INVISIBLE MACHINERY', 'QUERY MASTER & ENDPOINT ARCHITECT', 'BACKEND MAGIC, FRONTEND MYSTERY']],
    [/ai|ml|model|llm|gpt/i,              ['TRAINING MODELS & LOSING SLEEP', 'PROMPT ENGINEER IN THE STREETS', 'LET THE MACHINE DO THE THINKING']],
    [/design|ux|figma/i,                  ['DESIGNING FOR HUMANS, BREAKING FOR ROBOTS', 'WHITESPACE IS NOT WASTED SPACE', 'PIXEL PERFECTIONIST AT YOUR SERVICE']],
    [/full[\s-]?stack/i,                  ['FULL STACK: EQUALLY BAD AT EVERYTHING', 'BACKEND BY DAY, FRONTEND BY 3AM', 'CONTEXT SWITCHER IN CHIEF']],
    [/block|web3|crypto|solidity/i,       ['SURVIVING GAS FEES SINCE 2021', 'DECENTRALISED AND SLEEP-DEPRIVED', 'CONSENSUS CHASER & MEMPOOL POET']],
    [/mobile|ios|android|flutter/i,       ['BUILDING FOR THUMBS, TESTED ON VIBE', 'NOTCH NEGOTIATOR & APP STORE GAMBLER', 'MAKING APPS PEOPLE ACTUALLY USE']],
    [/data|analytics|sql/i,               ['TURNING DATA INTO SOMETHING BEAUTIFUL', 'PIVOT TABLE POET & OUTLIER HUNTER', 'DASHBOARDS ARE MY AESTHETIC']],
    [/devops|infra|cloud|docker/i,        ['UPTIME IS MY LOVE LANGUAGE', 'YAML SHERPA & CONTAINER WHISPERER', '99.9% UPTIME, 0% SLEEP']],
    [/security|sec|hack|pentest/i,        ['BREAKING THINGS SO YOU DON\'T HAVE TO', 'FIREWALL POET & THREAT MODEL SOMMELIER', 'ZERO-DAY OPTIMIST']],
    [/product|pm\b/i,                     ['SURVIVING SCOPE CREEP SINCE FOREVER', 'ROADMAP CARTOGRAPHER & BACKLOG POET', 'BUILDING WHAT USERS ACTUALLY WANT']],
  ];
  const GENERIC_TAGLINES = [
    'SHIPPING CODE & VIBES SINCE FOREVER',
    'DEBUGGING LIFE ONE COMMIT AT A TIME',
    'COFFEE → CODE → CHAOS → REPEAT',
    'BUILDING THINGS THAT MATTER',
    'ALWAYS IN BETA, NEVER IN PRODUCTION',
    'ASYNC BY NATURE, REACTIVE BY CHOICE',
    'DOCUMENTATION? NEVER HEARD OF HER',
    'IT WORKS ON MY MACHINE',
  ];

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function generateBuilderTitle() {
    const role = state.role.trim();
    let pool = GENERIC_TITLES;
    for (const [re, titles] of STACK_TITLES) if (re.test(role)) { pool = titles; break; }
    return pool[hashStr((state.name || 'builder') + '|' + role + '|' + state.titleSeed) % pool.length];
  }

  function generateTagline() {
    const role = state.role.trim();
    let pool = GENERIC_TAGLINES;
    for (const [re, lines] of STACK_TAGLINES) if (re.test(role)) { pool = lines; break; }
    return pool[hashStr((state.name || 'aaryan') + '|tagline|' + role + '|' + state.titleSeed) % pool.length];
  }

  function refreshTitlePreview() {
    const hasInput = state.role.trim() || state.name.trim();
    if (!hasInput) {
      titlePreview.textContent = 'Add your role to generate one';
      titlePreview.classList.remove('has-value');
      return;
    }
    titlePreview.textContent = generateBuilderTitle();
    titlePreview.classList.add('has-value');
  }

  nameInput.addEventListener('input', () => { state.name = nameInput.value; refreshTitlePreview(); scheduleRender(); });
  roleInput.addEventListener('input', () => { state.role = roleInput.value; refreshTitlePreview(); scheduleRender(); });
  shuffleTitleBtn.addEventListener('click', () => { state.titleSeed++; refreshTitlePreview(); scheduleRender(); });

  // ============================================================
  // Canvas drawing helpers
  // ============================================================
  function roundRect(ctx, x, y, w, h, r) {
    if (typeof r === 'number') r = { tl: r, tr: r, br: r, bl: r };
    ctx.beginPath();
    ctx.moveTo(x + r.tl, y);
    ctx.lineTo(x + w - r.tr, y);
    ctx.arcTo(x + w, y, x + w, y + r.tr, r.tr);
    ctx.lineTo(x + w, y + h - r.br);
    ctx.arcTo(x + w, y + h, x + w - r.br, y + h, r.br);
    ctx.lineTo(x + r.bl, y + h);
    ctx.arcTo(x, y + h, x, y + h - r.bl, r.bl);
    ctx.lineTo(x, y + r.tl);
    ctx.arcTo(x, y, x + r.tl, y, r.tl);
    ctx.closePath();
  }

  function paintHorizonBackground(ctx, w, h) {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#041a0d');
    grad.addColorStop(0.4, T.magenta);
    grad.addColorStop(1, '#ffe500');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(w * 0.5, h * 0.36, 10, w * 0.5, h * 0.36, w * 0.55);
    glow.addColorStop(0, 'rgba(237,217,176,0.4)');
    glow.addColorStop(1, 'rgba(237,217,176,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
  }

  function paintWaveBand(ctx, w, h, baseY, color, opacity) {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(0, baseY);
    for (let i = 0; i <= 3; i++) {
      const x = (w / 3) * i;
      const y = baseY + Math.sin(i) * h * 0.03;
      ctx.quadraticCurveTo(x - w / 6, y - h * 0.05, x, y);
    }
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fill(); ctx.restore();
  }

  function dashedCircle(ctx, cx, cy, r, opts = {}) {
    const { dash = [10, 10], color = T.gold, width = 2, alpha = 0.6, rotate = 0 } = opts;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(rotate);
    ctx.globalAlpha = alpha; ctx.strokeStyle = color;
    ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  function arcText(ctx, text, cx, cy, r, opts = {}) {
    const { font = '700 40px "Space Grotesk",sans-serif', color = T.gold, startAngle = Math.PI * 1.18, sweep = Math.PI * 0.64 } = opts;
    ctx.save();
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const total = text.length - 1;
    for (let i = 0; i < text.length; i++) {
      const t = total === 0 ? 0.5 : i / total;
      const angle = startAngle + sweep * t;
      const x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle);
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle + Math.PI / 2);
      ctx.fillText(text[i], 0, 0); ctx.restore();
    }
    ctx.restore();
  }

  function pill(ctx, cx, cy, text, opts = {}) {
    const { font = '600 22px "JetBrains Mono",monospace', pad = 16, bg = T.ink, fg = T.gold, borderColor = 'rgba(255,229,0,.5)' } = opts;
    ctx.save(); ctx.font = font;
    const tw = ctx.measureText(text).width;
    const w = tw + pad * 2, h = 42;
    const x = cx - w / 2, y = cy - h / 2;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = borderColor; ctx.stroke();
    ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 1);
    ctx.restore();
  }

  function palmFrond(ctx, x, y, scale, flip, color, alpha) {
    ctx.save();
    ctx.translate(x, y); ctx.scale(flip ? -scale : scale, scale);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.lineWidth = 14; ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.42;
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(Math.cos(a) * 90, Math.sin(a) * 90 - 30, Math.cos(a) * 180, Math.sin(a) * 180 - 120);
      ctx.stroke();
    }
    ctx.restore();
  }

  function fitText(ctx, text, maxWidth, startSize, fontTemplate, minSize = 14) {
    let size = startSize;
    ctx.font = fontTemplate.replace('{size}', size);
    while (ctx.measureText(text).width > maxWidth && size > minSize) {
      size -= 2;
      ctx.font = fontTemplate.replace('{size}', size);
    }
    return size;
  }

  function drawStripedTape(ctx, x, y, w, h, color1, color2, stripeW = 22) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = color1; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color2;
    for (let cx = -h * 2; cx < w + h * 2; cx += stripeW * 2) {
      ctx.beginPath();
      ctx.moveTo(cx, y + h); ctx.lineTo(cx + stripeW, y + h);
      ctx.lineTo(cx + stripeW + h, y); ctx.lineTo(cx + h, y);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function drawDuctTape(ctx, x, y, w, h, angle = -0.1, color = '#e5c414') {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(angle);
    ctx.globalAlpha = 0.88; ctx.fillStyle = color;
    roundRect(ctx, -w / 2, -h / 2, w, h, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-w / 2 + 4, 0); ctx.lineTo(w / 2 - 4, 0); ctx.stroke();
    ctx.restore();
  }

  function drawBarcode(ctx, x, y, w, h, seed) {
    let rng = seed | 0;
    function next() { rng = (Math.imul(rng, 1664525) + 1013904223) | 0; return (rng >>> 0) / 0xffffffff; }
    ctx.save();
    let cx = x;
    while (cx < x + w - 2) {
      const bw = next() > 0.45 ? 5 : 2.5;
      const gap = next() > 0.5 ? 4 : 2;
      ctx.fillStyle = cx < x + w * 0.85 ? '#ffe500' : 'rgba(255,229,0,.45)';
      ctx.fillRect(cx, y, bw, h);
      cx += bw + gap;
    }
    ctx.restore();
  }

  function drawViewfinderCorners(ctx, x, y, w, h, len, color) {
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.lineCap = 'round';
    const corners = [
      [x,     y,      1,  1],
      [x + w, y,     -1,  1],
      [x,     y + h,  1, -1],
      [x + w, y + h, -1, -1],
    ];
    corners.forEach(([cx0, cy0, dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(cx0 + dx * len, cy0);
      ctx.lineTo(cx0, cy0);
      ctx.lineTo(cx0, cy0 + dy * len);
      ctx.stroke();
    });
    ctx.restore();
  }

  // ============================================================
  // Builder Badge / ID Card (1080×1350)
  // ============================================================
  function renderCard(ctx, w, h) {
    const pad = Math.round(w * 0.068);
    const stripH = 24;

    // 1 — Striped tape borders
    drawStripedTape(ctx, 0, 0, w, stripH, T.magenta, T.gold, 16);
    drawStripedTape(ctx, 0, h - stripH, w, stripH, T.magenta, T.gold, 16);

    // 2 — Background
    ctx.save();
    const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.45, 80, w * 0.5, h * 0.45, w * 0.75);
    bgGrad.addColorStop(0, '#0d5c29'); bgGrad.addColorStop(1, '#063316');
    ctx.fillStyle = bgGrad; ctx.fillRect(0, stripH, w, h - stripH * 2);
    // Watermark "26"
    ctx.font = '900 460px "Space Grotesk",sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText('26', w - 10, h * 0.52);
    ctx.restore();

    const name    = state.name.trim() || 'Your Name';
    const role    = state.role.trim() || 'Builder';
    const bSeed   = hashStr(name + role);
    const badgeNo = String(bSeed % 9000 + 1000);

    // 3 — Header
    const headerY = stripH + 32;
    const titleBaselineY = headerY + 44;
    const subtitleY = headerY + 78;

    // HACKER गोवा HOUSE — title occupies full width, so measured first
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const titleSize = Math.round(w * 0.096);
    ctx.font = `900 ${titleSize}px "DM Serif Display","Space Grotesk",serif`;
    ctx.fillStyle = T.gold;
    const hhW = ctx.measureText('HACKER').width;
    ctx.fillText('HACKER', pad, titleBaselineY);

    ctx.font = `900 ${Math.round(w * 0.092)}px system-ui,"Arial Black",sans-serif`;
    ctx.fillStyle = T.magenta;
    const goaW = ctx.measureText('गोवा').width;
    ctx.fillText('गोवा', pad + hhW + 8, titleBaselineY);

    ctx.font = `900 ${titleSize}px "DM Serif Display","Space Grotesk",serif`;
    ctx.fillStyle = T.gold;
    ctx.fillText('HOUSE', pad + hhW + goaW + 14, titleBaselineY);

    // Subtitle line
    ctx.font = `600 ${Math.round(w * 0.023)}px "JetBrains Mono",monospace`;
    ctx.fillStyle = T.lime;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('GOA, INDIA  ·  28 – 31 OCT 2026', pad, subtitleY);

    // BUILDER #XXXX badge — right-aligned on subtitle row (clear of title text)
    ctx.save();
    ctx.font = `700 ${Math.round(w * 0.022)}px "JetBrains Mono",monospace`;
    const bdgText = `BUILDER #${badgeNo}`;
    const bdgW = ctx.measureText(bdgText).width + 24;
    const bdgH = 34;
    const bdgX = w - pad - bdgW;
    const bdgY = subtitleY - bdgH + 4;
    roundRect(ctx, bdgX, bdgY, bdgW, bdgH, 6);
    ctx.fillStyle = T.gold; ctx.fill();
    ctx.fillStyle = T.black;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(bdgText, bdgX + bdgW / 2, bdgY + bdgH / 2 + 1);
    ctx.restore();

    // 4 — Photo section (tilted card + tape)
    const photoTopY = headerY + 104;
    const photoH    = Math.round(h * 0.36);
    const photoW    = w - pad * 2;
    const photoCx   = pad + photoW / 2;
    const photoCy   = photoTopY + photoH / 2;

    ctx.save();
    ctx.translate(photoCx, photoCy);
    ctx.rotate(-1.5 * Math.PI / 180);

    // White card background + shadow
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 6;
    ctx.fillStyle = T.white;
    roundRect(ctx, -photoW / 2 - 8, -photoH / 2 - 8, photoW + 16, photoH + 16, 12);
    ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    // Photo clip + draw
    ctx.save();
    roundRect(ctx, -photoW / 2, -photoH / 2, photoW, photoH, 6);
    ctx.clip();
    if (state.img) {
      drawCoverImage(ctx, state.img, -photoW / 2, -photoH / 2, photoW, photoH, state.zoom, state.panX, state.panY);
    } else {
      const ig = ctx.createLinearGradient(-photoW / 2, -photoH / 2, photoW / 2, photoH / 2);
      ig.addColorStop(0, '#0b5c27'); ig.addColorStop(1, T.magenta);
      ctx.fillStyle = ig; ctx.fillRect(-photoW / 2, -photoH / 2, photoW, photoH);
    }
    ctx.restore();

    // Viewfinder corners
    drawViewfinderCorners(ctx, -photoW / 2, -photoH / 2, photoW, photoH, 36, T.magenta);

    // Duct tape accent (top-left)
    drawDuctTape(ctx, -photoW / 2 + 55, -photoH / 2 + 12, 115, 33, -0.22, '#e5c414');

    // Builder title pill (bottom-left of photo)
    const builderTitle = (state.name.trim() || state.role.trim()) ? generateBuilderTitle() : 'Demo-Day Gambler';
    const overlayLabel = `"${builderTitle}"`;
    ctx.save();
    ctx.font = `italic 700 ${Math.round(w * 0.032)}px "Space Grotesk",system-ui,sans-serif`;
    const olW = Math.min(ctx.measureText(overlayLabel).width + 42, photoW - 36);
    const olH = 54;
    const olX = -photoW / 2 + 22;
    const olY = photoH / 2 - olH - 26;
    ctx.translate(olX + olW / 2, olY + olH / 2);
    ctx.rotate(-1.2 * Math.PI / 180);
    roundRect(ctx, -olW / 2, -olH / 2, olW, olH, 10);
    ctx.fillStyle = T.magenta; ctx.fill();
    ctx.fillStyle = T.white; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // Ensure title fits in pill
    let titleFontSize = Math.round(w * 0.032);
    ctx.font = `italic 700 ${titleFontSize}px "Space Grotesk",sans-serif`;
    while (ctx.measureText(overlayLabel).width > olW - 16 && titleFontSize > 18) {
      titleFontSize -= 2;
      ctx.font = `italic 700 ${titleFontSize}px "Space Grotesk",sans-serif`;
    }
    ctx.fillText(overlayLabel, 0, 1);
    ctx.restore();

    ctx.restore(); // end photo rotation

    // 5 — Name & tagline
    let y = photoTopY + photoH + 96;

    // Name — large serif
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const nameSize = fitText(ctx, name, w - pad * 2, Math.round(w * 0.09), '700 {size}px "DM Serif Display",Georgia,serif', 36);
    ctx.font = `700 ${nameSize}px "DM Serif Display",Georgia,serif`;
    ctx.fillStyle = T.gold;
    ctx.fillText(name, pad, y);
    y += Math.round(h * 0.052);

    // Role sub-label
    ctx.font = `600 ${Math.round(w * 0.025)}px "JetBrains Mono",monospace`;
    ctx.fillStyle = T.lime;
    ctx.fillText(role.toUpperCase(), pad, y);
    y += Math.round(h * 0.046);

    // Tagline — full-width, auto-shrink
    const tagline = generateTagline();
    let tSize = Math.round(w * 0.026);
    ctx.font = `700 ${tSize}px "JetBrains Mono",monospace`;
    while (ctx.measureText(tagline).width > w - pad * 2 && tSize > 15) {
      tSize -= 1;
      ctx.font = `700 ${tSize}px "JetBrains Mono",monospace`;
    }
    ctx.fillStyle = T.white;
    ctx.textAlign = 'left';
    ctx.fillText(tagline, pad, y);

    // Status + barcode (right column, separated into clear rows)
    const statusY = y + 6;
    ctx.save();
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.font = `700 ${Math.round(w * 0.021)}px "JetBrains Mono",monospace`;
    ctx.fillStyle = T.gold;
    ctx.fillText('STATUS: VERIFIED', w - pad, statusY);
    ctx.font = `500 ${Math.round(w * 0.019)}px "JetBrains Mono",monospace`;
    ctx.fillStyle = T.lime;
    ctx.fillText('PASS: ALL-DAYS // GOA', w - pad, statusY + 26);
    ctx.restore();

    const barcodeH = Math.round(h * 0.038);
    const barcodeY = statusY + 50;
    drawBarcode(ctx, w - pad - 150, barcodeY, 150, barcodeH, bSeed);

    // 6 — Coordinates bar
    const sepY = barcodeY + barcodeH + 26;
    ctx.save();
    ctx.strokeStyle = 'rgba(142,201,42,.4)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 10]); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(pad, sepY); ctx.lineTo(w - pad, sepY); ctx.stroke();
    ctx.restore();

    const coordY = sepY + 36;
    ctx.font = `600 ${Math.round(w * 0.022)}px "JetBrains Mono",monospace`;
    ctx.fillStyle = T.lime;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('📍 15.2993° N, 74.1240° E  ·  GOA, INDIA', pad, coordY);
    ctx.textAlign = 'right';
    ctx.fillText('HACKER HOUSE 2026', w - pad, coordY);

    // 7 — Bottom black strip
    const blackStripH = 56;
    const blackStripY = h - stripH - blackStripH;
    ctx.fillStyle = T.black;
    ctx.fillRect(0, blackStripY, w, blackStripH);
    // Yellow dashed border
    ctx.save();
    ctx.strokeStyle = T.gold; ctx.lineWidth = 2.5; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(0, blackStripY); ctx.lineTo(w, blackStripY); ctx.stroke();
    ctx.restore();

    ctx.font = `700 ${Math.round(w * 0.02)}px "JetBrains Mono",monospace`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left'; ctx.fillStyle = T.gold;
    ctx.fillText('#FrameInGoa', pad, blackStripY + blackStripH / 2);
    ctx.textAlign = 'center'; ctx.fillStyle = T.white;
    ctx.fillText('HACKER HOUSE GOA  ★  OFFICIAL BUILDER PASS', w / 2, blackStripY + blackStripH / 2);
    ctx.textAlign = 'right'; ctx.fillStyle = T.gold;
    ctx.fillText('28–31 OCT 2026', w - pad, blackStripY + blackStripH / 2);
  }

  // ============================================================
  // Render orchestration
  // ============================================================
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    if (!state.img) return;
    const w = 1080;
    const h = 1350;
    outputCanvas.width = w; outputCanvas.height = h;

    outCtx.clearRect(0, 0, w, h);
    renderCard(outCtx, w, h);

    previewEmpty.hidden = true;
    outputCanvas.hidden = false;
    renderBadge.hidden = false;
    actions.hidden = false;
  }

  // ============================================================
  // Download
  // ============================================================
  function canvasToBlob(canvas) {
    return new Promise((res) => canvas.toBlob(res, 'image/png'));
  }

  downloadBtn.addEventListener('click', async () => {
    if (!state.img) return;
    const blob = await canvasToBlob(outputCanvas);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const slug = state.name.trim() ? state.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'builder';
    a.download = `hh-goa-2026-${slug}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('✓ Image downloaded!');
  });

  // ============================================================
  // Share to X
  // ============================================================
  function buildCaption() {
    const handle = state.name.trim();
    const lead = `Here's my HH Goa 2026 builder badge${handle ? `, ${handle} here` : ''} 🏝️⚡`;
    return `${lead} #FrameInGoa`;
  }

  shareBtn.addEventListener('click', async () => {
    if (!state.img) return;
    const blob = await canvasToBlob(outputCanvas);
    const caption = buildCaption();
    const file = new File([blob], 'hh-goa-2026-builder-badge.png', { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], text: caption }); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }

    // Fallback: download + open tweet intent
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(caption)}`, '_blank', 'noopener');
    shareNote.hidden = false;
    shareNote.textContent = 'Image downloaded — drag it into the tweet window that just opened.';
    toast('Downloaded — attach the image to your tweet');
  });

  // ── Boot ──
  initUI();

})();

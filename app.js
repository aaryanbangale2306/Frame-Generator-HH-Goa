/* ============================================================
   HH GOA 2026 — Frame / ID Card Generator
   Vanilla JS, single canvas render pipeline, no backend.
   ============================================================ */
(() => {
  'use strict';

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const dropzone = $('dropzone'), fileInput = $('fileInput');
  const dzEmpty = $('dropzoneEmpty'), dzLoading = $('dropzoneLoading'), loadingLabel = $('loadingLabel');
  const cropSection = $('cropSection'), cropCanvas = $('cropCanvas'), cropMaskFrame = $('cropMaskFrame');
  const zoomSlider = $('zoomSlider'), changePhotoBtn = $('changePhotoBtn');
  const fieldsStep = $('fieldsStep'), nameInput = $('nameInput'), roleInput = $('roleInput');
  const titlePreview = $('titlePreview'), shuffleTitleBtn = $('shuffleTitleBtn');
  const previewEmpty = $('previewEmpty'), outputCanvas = $('outputCanvas'), renderBadge = $('renderBadge');
  const actions = $('actions'), downloadBtn = $('downloadBtn'), shareBtn = $('shareBtn'), shareNote = $('shareNote');
  const toastEl = $('toast');
  const formatBtns = document.querySelectorAll('.format-btn');
  const cropCtx = cropCanvas.getContext('2d');
  const outCtx = outputCanvas.getContext('2d');

  // ---------- Theme tokens (keep in sync with styles.css :root) ----------
  const T = {
    ink:       '#060D18',   // background
    inkRaised: '#0B2D35',   // deep-teal — cards/sections
    inkLine:   'rgba(0,229,201,.14)',
    aqua:      '#00E5C9',   // primary CTA / accent
    magenta:   '#E91490',   // secondary highlights / badges
    sand:      '#EDD9B0',   // text on dark / light surfaces
    violet:    '#0E1E3A',   // deep header tones
    // legacy aliases kept so canvas code referencing these still works
    coral:  '#E91490',  // → magenta
    gold:   '#EDD9B0',  // → sand
    teal:   '#00E5C9',  // → aqua
    cream:  '#EDD9B0',  // → sand
  };

  // ---------- Mobile helper ----------
  function isMobile() { return window.innerWidth <= 860; }
  function scrollPreviewIntoView() {
    if (!isMobile()) return;
    outputCanvas.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- State ----------
  const state = {
    format: 'frame',       // 'frame' | 'card'
    img: null,             // HTMLImageElement
    zoom: 1,               // 1..3, relative to cover-fit
    panX: 0.5, panY: 0.5, // 0..1 fraction of excess space
    name: '', role: '',
    titleSeed: 0,
  };

  let dragging = false, dragStart = { x: 0, y: 0, panX: 0.5, panY: 0.5 };
  let pinchStartDist = null, pinchStartZoom = 1;

  // Re-render once the display webfonts finish downloading — canvas text is drawn
  // eagerly with system fallbacks, then upgraded automatically so it never blocks.
  if (document.fonts) {
    if (document.fonts.ready) document.fonts.ready.then(() => scheduleRender()).catch(() => {});
    document.fonts.addEventListener('loadingdone', () => scheduleRender());
  }

  // ============================================================
  // Toast
  // ============================================================
  let toastTimer;
  function toast(msg, ms = 3200) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
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

    // Try a direct decode first (fast path — covers jpg/png/webp and Safari's native HEIC support).
    if (!looksHeic) {
      try {
        return await loadHTMLImage(URL.createObjectURL(file));
      } catch (_) { /* fall through to conversion */ }
    }

    // HEIC/HEIF (or a direct decode failure): convert client-side, then load the result.
    loadingLabel.textContent = 'Converting HEIC photo…';
    await ensureHeic2any();
    const convertedBlob = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    const blob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
    return loadHTMLImage(URL.createObjectURL(blob));
  }

  async function handleFile(file) {
    if (!file || !/^image\//.test(file.type) && !/\.hei[cf]$/i.test(file.name)) {
      toast('Please choose a photo file (JPG, PNG, or HEIC).');
      return;
    }
    dzEmpty.hidden = true; dzLoading.hidden = false; loadingLabel.textContent = 'Reading photo…';
    try {
      const img = await loadImageFile(file);
      state.img = img;
      state.zoom = 1; state.panX = 0.5; state.panY = 0.5;
      zoomSlider.value = '1';
      cropSection.hidden = false;
      dropzone.hidden = true;
      fieldsStep.hidden = state.format !== 'card';
      renderCropPreview();
      scheduleRender();
      // On mobile, scroll the preview panel into view after render
      requestAnimationFrame(() => scrollPreviewIntoView());
    } catch (err) {
      console.error(err);
      toast("Couldn't read that photo — try a JPG or PNG.");
      dzEmpty.hidden = false; dzLoading.hidden = true;
    }
  }

  // ============================================================
  // Cover-fit drawing helper (resolution-independent crop model)
  // panX/panY are fractions [0,1] of the "excess" scroll space.
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
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    ctx.drawImage(img, offX, offY, sw, sh);
    ctx.restore();
  }

  // ============================================================
  // Crop stage interaction
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

  function onDragStart(x, y) {
    dragging = true;
    dragStart = { x, y, panX: state.panX, panY: state.panY };
  }
  function onDragMove(x, y, rectSize) {
    if (!dragging || !state.img) return;
    const { ex, ey } = excessAt(rectSize, state.zoom);
    const dx = x - dragStart.x, dy = y - dragStart.y;
    state.panX = clamp01(dragStart.panX - (ex ? dx / ex : 0));
    state.panY = clamp01(dragStart.panY - (ey ? dy / ey : 0));
    renderCropPreview();
    scheduleRender();
  }
  function clamp01(v) { return Math.min(1, Math.max(0, v)); }

  cropCanvas.addEventListener('pointerdown', (e) => {
    if (!state.img) return;
    cropCanvas.setPointerCapture(e.pointerId);
    const p = pointerPos(e);
    onDragStart(p.x, p.y);
  });
  cropCanvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = pointerPos(e);
    onDragMove(p.x, p.y, p.rectW);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    cropCanvas.addEventListener(ev, () => { dragging = false; })
  );

  // wheel-to-zoom (desktop)
  cropCanvas.addEventListener('wheel', (e) => {
    if (!state.img) return;
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    setZoom(state.zoom + delta);
  }, { passive: false });

  // pinch-to-zoom (touch) — pointer events give us multi-touch via a manual tracker
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
    renderCropPreview();
    scheduleRender();
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
    samplePhotoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      loadSamplePhoto();
    });
  }

  async function loadSamplePhoto() {
    dzEmpty.hidden = true; dzLoading.hidden = false; loadingLabel.textContent = 'Loading photo…';
    try {
      const res = await fetch('user_photo.jpg');
      if (res.ok) {
        const blob = await res.blob();
        const sampleFile = new File([blob], 'user-photo.jpg', { type: 'image/jpeg' });
        await handleFile(sampleFile);
        return;
      }
    } catch (_) {}

    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 600;
    const ctx = canvas.getContext('2d');
    
    // Create a default avatar (Goa sunset aesthetic profile)
    const g = ctx.createLinearGradient(0, 0, 600, 600);
    g.addColorStop(0, '#5B3A9E'); g.addColorStop(0.5, '#FF6B4A'); g.addColorStop(1, '#FFB84D');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 600, 600);

    // Avatar silhouette / graphics
    ctx.fillStyle = 'rgba(255,243,224,0.3)';
    ctx.beginPath(); ctx.arc(300, 240, 110, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(300, 540, 200, 0, Math.PI * 2); ctx.fill();

    // Subtle glass outline
    ctx.strokeStyle = 'rgba(255,243,224,0.6)'; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(300, 240, 110, 0, Math.PI * 2); ctx.stroke();

    canvas.toBlob((blob) => {
      const sampleFile = new File([blob], 'sample-builder.jpg', { type: 'image/jpeg' });
      handleFile(sampleFile);
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
  });

  // ============================================================
  // Format toggle
  // ============================================================
  formatBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      formatBtns.forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
      state.format = btn.dataset.format;
      cropMaskFrame.className = 'crop-mask ' + (state.format === 'frame' ? 'crop-mask--circle' : 'crop-mask--square');
      fieldsStep.hidden = state.format !== 'card';
      scheduleRender();
      // On mobile, scroll preview into view after format switch
      if (state.img) requestAnimationFrame(() => scrollPreviewIntoView());
    });
  });

  // ============================================================
  // Builder title generator
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

  // ---------- Tagline generator ----------
  const STACK_TAGLINES = [
    [/front|react|vue|css|ui\b/i, ['PIXEL PUSHER BY DAY, DEBUGGER BY 3AM', 'MAKING THE WEB PRETTY, ONE DIV AT A TIME', 'CSS IS MY LOVE LANGUAGE']],
    [/back|api|server|node|django|rails/i, ['BACKEND BY DAY, FRONTEND BY 3AM', 'BUILDING THE INVISIBLE MACHINERY', 'QUERY MASTER & ENDPOINT ARCHITECT']],
    [/ai|ml|model|llm|gpt/i, ['TRAINING MODELS & LOSING SLEEP', 'PROMPT ENGINEER IN THE STREETS', 'LET THE MACHINE DO THE THINKING']],
    [/design|ux|figma/i, ['DESIGNING FOR HUMANS, BREAKING FOR ROBOTS', 'WHITESPACE IS NOT WASTED SPACE', 'PIXEL PERFECTIONIST AT YOUR SERVICE']],
    [/full[\s-]?stack/i, ['FULL STACK: EQUALLY BAD AT EVERYTHING', 'BACKEND BY DAY, FRONTEND BY 3AM', 'CONTEXT SWITCHER IN CHIEF']],
    [/block|web3|crypto|solidity/i, ['SURVIVING GAS FEES SINCE 2021', 'DECENTRALISED AND SLEEP-DEPRIVED', 'CONSENSUS CHASER & MEMPOOL POET']],
    [/mobile|ios|android|flutter/i, ['BUILDING FOR THUMBS, TESTED ON VIBE', 'NOTCH NEGOTIATOR & APP STORE GAMBLER', 'MAKING APPS PEOPLE ACTUALLY USE']],
    [/data|analytics|sql/i, ['TURNING DATA INTO SOMETHING BEAUTIFUL', 'PIVOT TABLE POET & OUTLIER HUNTER', 'DASHBOARDS ARE MY AESTHETIC']],
    [/devops|infra|cloud|docker/i, ['UPTIME IS MY LOVE LANGUAGE', 'YAML SHERPA & CONTAINER WHISPERER', '99.9% UPTIME, 0% SLEEP']],
    [/security|sec|hack|pentest/i, ['BREAKING THINGS SO YOU DON\'T HAVE TO', 'FIREWALL POET & THREAT MODEL SOMMELIER', 'ZERO-DAY OPTIMIST']],
    [/product|pm\b/i, ['SURVIVING SCOPE CREEP SINCE FOREVER', 'ROADMAP CARTOGRAPHER & BACKLOG POET', 'BUILDING WHAT USERS ACTUALLY WANT']],
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
  function generateTagline() {
    const role = state.role.trim();
    let pool = GENERIC_TAGLINES;
    for (const [re, lines] of STACK_TAGLINES) if (re.test(role)) { pool = lines; break; }
    const seed = hashStr((state.name || 'aaryan') + '|tagline|' + role + '|' + state.titleSeed);
    return pool[seed % pool.length];
  }

  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function generateBuilderTitle() {
    const role = state.role.trim();
    let pool = GENERIC_TITLES;
    for (const [re, titles] of STACK_TITLES) if (re.test(role)) { pool = titles; break; }
    const seed = hashStr((state.name || 'builder') + '|' + role + '|' + state.titleSeed);
    return pool[seed % pool.length];
  }
  function refreshTitlePreview() {
    if (!state.role.trim() && !state.name.trim()) {
      titlePreview.textContent = 'Add your role to generate one';
      titlePreview.style.opacity = .5;
      return;
    }
    titlePreview.style.opacity = 1;
    titlePreview.textContent = generateBuilderTitle();
  }
  nameInput.addEventListener('input', () => { state.name = nameInput.value; refreshTitlePreview(); scheduleRender(); });
  roleInput.addEventListener('input', () => { state.role = roleInput.value; refreshTitlePreview(); scheduleRender(); });
  shuffleTitleBtn.addEventListener('click', () => { state.titleSeed++; refreshTitlePreview(); scheduleRender(); });
  // Trigger initial title preview with pre-filled name
  refreshTitlePreview();

  // ============================================================
  // Drawing helpers shared by both formats
  // ============================================================
  function paintHorizonBackground(ctx, w, h) {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0,    T.violet);    // deep navy
    grad.addColorStop(0.45, T.magenta);   // hot magenta
    grad.addColorStop(1,    T.aqua);      // electric aqua
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // soft centre glow
    const glow = ctx.createRadialGradient(w * 0.5, h * 0.36, 10, w * 0.5, h * 0.36, w * 0.55);
    glow.addColorStop(0, 'rgba(237,217,176,0.45)');
    glow.addColorStop(1, 'rgba(237,217,176,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
  }

  function paintWaveBand(ctx, w, h, baseY, color, opacity) {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    const waves = 3;
    for (let i = 0; i <= waves; i++) {
      const x = (w / waves) * i;
      const y = baseY + Math.sin(i) * h * 0.03;
      ctx.quadraticCurveTo(x - w / waves / 2, y - h * 0.05, x, y);
    }
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function dashedCircle(ctx, cx, cy, r, opts = {}) {
    const { dash = [10, 10], color = T.gold, width = 2, alpha = 0.6, rotate = 0 } = opts;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(rotate);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  function arcText(ctx, text, cx, cy, r, opts = {}) {
    const { font = '700 40px "Space Grotesk", "Arial Black", system-ui, sans-serif', color = T.cream, letterSpacing = 0.055, startAngle = Math.PI * 1.18, sweep = Math.PI * 0.64 } = opts;
    ctx.save();
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const total = text.length - 1;
    for (let i = 0; i < text.length; i++) {
      const t = total === 0 ? 0.5 : i / total;
      const angle = startAngle + sweep * t;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle + Math.PI / 2);
      ctx.fillText(text[i], 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  function pill(ctx, cx, cy, text, opts = {}) {
    const { font = '600 22px "JetBrains Mono", ui-monospace, "Courier New", monospace', pad = 16, bg = T.ink, fg = T.gold, borderColor = 'rgba(255,184,77,.5)' } = opts;
    ctx.save();
    ctx.font = font;
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

  function palmFrond(ctx, x, y, scale, flip, color, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(flip ? -scale : scale, scale);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.lineWidth = 14; ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.42;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(Math.cos(a) * 90, Math.sin(a) * 90 - 30, Math.cos(a) * 180, Math.sin(a) * 180 - 120);
      ctx.stroke();
    }
    ctx.restore();
  }

  function fitText(ctx, text, maxWidth, startSize, font, minSize = 14) {
    let size = startSize;
    ctx.font = `${font.replace('{size}', size)}`;
    while (ctx.measureText(text).width > maxWidth && size > minSize) {
      size -= 2;
      ctx.font = font.replace('{size}', size);
    }
    return size;
  }

  function drawBarcode(ctx, x, y, w, h, seed) {
    // Deterministic barcode using LCG seeded by builder info
    let rng = seed | 0;
    function next() { rng = (Math.imul(rng, 1664525) + 1013904223) | 0; return (rng >>> 0) / 0xffffffff; }
    ctx.save();
    let cx = x;
    while (cx < x + w - 2) {
      const bw = next() > 0.45 ? 5 : 2.5;
      const gap = next() > 0.5 ? 4 : 2;
      ctx.fillStyle = cx < x + w * 0.85 ? 'rgba(0,229,201,0.85)' : 'rgba(0,229,201,0.35)';
      ctx.fillRect(cx, y, bw, h);
      cx += bw + gap;
    }
    ctx.restore();
  }

  // ============================================================
  // FORMAT A — PFP Frame (1080×1080, circular photo + badge ring)
  // ============================================================
  function renderFrame(ctx, size) {
    const cx = size / 2, cy = size / 2;
    const r = size * 0.352; // photo radius

    paintHorizonBackground(ctx, size, size);
    paintWaveBand(ctx, size, size, size * 0.78, T.teal, 0.22);
    paintWaveBand(ctx, size, size, size * 0.86, T.ink, 0.35);

    palmFrond(ctx, size * 0.06, size * 0.98, 1.1, false, T.ink, 0.5);
    palmFrond(ctx, size * 0.94, size * 0.98, 1.1, true, T.ink, 0.5);

    dashedCircle(ctx, cx, cy, r * 1.2, { color: T.sand, alpha: 0.3, dash: [3, 14], width: 2, rotate: 0.2 });
    dashedCircle(ctx, cx, cy, r * 1.12, { color: T.aqua, alpha: 0.5, dash: [14, 10], width: 2.5, rotate: -0.4 });

    // ring (magenta → sand → aqua)
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r + size * 0.022, 0, Math.PI * 2);
    const ringGrad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    ringGrad.addColorStop(0, T.magenta); ringGrad.addColorStop(0.5, T.sand); ringGrad.addColorStop(1, T.aqua);
    ctx.strokeStyle = ringGrad; ctx.lineWidth = size * 0.028;
    ctx.stroke();
    ctx.restore();

    // photo, clipped to circle
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
    if (state.img) {
      drawCoverImage(ctx, state.img, cx - r, cy - r, r * 2, r * 2, state.zoom, state.panX, state.panY);
    } else {
      ctx.fillStyle = T.inkRaised; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    ctx.restore();

    // inner ring hairline for crispness
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(237,217,176,0.45)'; ctx.stroke();
    ctx.restore();

    arcText(ctx, 'HH GOA 2026', cx, cy, r * 1.32, {
      font: `700 ${Math.round(size * 0.052)}px "Space Grotesk", "Arial Black", system-ui, sans-serif`,
      color: T.sand, startAngle: Math.PI * 1.18, sweep: Math.PI * 0.64,
    });

    pill(ctx, cx, cy + r + size * 0.075, '#FrameInGoa', {
      font: `600 ${Math.round(size * 0.024)}px "JetBrains Mono", ui-monospace, "Courier New", monospace`,
      bg: T.ink, fg: T.aqua, borderColor: 'rgba(0,229,201,.5)',
    });
  }

  // ============================================================
  // FORMAT B — Official Builder Pass (1080×1350, HH Goa 2026 edition)
  // ============================================================
  function renderCard(ctx, w, h) {
    const pad = Math.round(w * 0.072);

    // ── Background ──
    ctx.fillStyle = T.ink;
    ctx.fillRect(0, 0, w, h);

    // Subtle dot-grid texture (aqua dots at very low opacity)
    ctx.save();
    ctx.globalAlpha = 0.045;
    for (let gx = 30; gx < w; gx += 42) {
      for (let gy = 30; gy < h; gy += 42) {
        ctx.fillStyle = T.aqua;
        ctx.beginPath(); ctx.arc(gx, gy, 1.6, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();

    // Ambient glow corners (magenta top-left, aqua bottom-right)
    const gl1 = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.6);
    gl1.addColorStop(0, 'rgba(233,20,144,0.25)'); gl1.addColorStop(1, 'rgba(6,13,24,0)');
    ctx.fillStyle = gl1; ctx.fillRect(0, 0, w, h);
    const gl2 = ctx.createRadialGradient(w, h, 0, w, h, w * 0.7);
    gl2.addColorStop(0, 'rgba(0,229,201,0.16)'); gl2.addColorStop(1, 'rgba(6,13,24,0)');
    ctx.fillStyle = gl2; ctx.fillRect(0, 0, w, h);

    const name  = state.name.trim()  || 'Your Name Here';
    const role  = state.role.trim()  || 'Add Stack / Role';
    const bSeed = hashStr(name + role);
    const badgeNo = String(bSeed % 9000 + 1000);

    // ── HEADER gradient strip ──
    const headerH = Math.round(h * 0.185);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, headerH); ctx.clip();
    paintHorizonBackground(ctx, w, headerH * 1.8);
    // dark wave at bottom of header
    paintWaveBand(ctx, w, headerH * 1.8, headerH * 1.1, T.ink, 0.6);
    ctx.restore();

    // Header top border line (magenta→aqua)
    const hbg = ctx.createLinearGradient(0, 0, w, 0);
    hbg.addColorStop(0, T.violet); hbg.addColorStop(0.35, T.magenta);
    hbg.addColorStop(0.7, T.sand); hbg.addColorStop(1, T.aqua);
    ctx.fillStyle = hbg; ctx.fillRect(0, 0, w, 7);

    // BUILDER #XXXX badge — top right
    ctx.save();
    ctx.font = `700 ${Math.round(w * 0.024)}px "JetBrains Mono", ui-monospace, monospace`;
    const bdgText = `BUILDER #${badgeNo}`;
    const bdgW = ctx.measureText(bdgText).width + 28;
    const bdgH = 40;
    const bdgX = w - pad - bdgW, bdgY = Math.round(headerH * 0.16);
    roundRect(ctx, bdgX, bdgY, bdgW, bdgH, bdgH / 2);
    ctx.fillStyle = T.aqua; ctx.fill();
    ctx.fillStyle = T.ink;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(bdgText, bdgX + bdgW / 2, bdgY + bdgH / 2);
    ctx.restore();

    // Main wordmark: "HH" + "गोवा" + "2026"
    const titleY = Math.round(headerH * 0.72);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = `900 ${Math.round(w * 0.098)}px "Space Grotesk", "Arial Black", system-ui, sans-serif`;
    ctx.fillStyle = T.cream;
    const hhW = ctx.measureText('HACKER ').width;
    ctx.fillText('HACKER ', pad, titleY);
    ctx.fillStyle = T.gold;
    const goaW = ctx.measureText('गोवा').width;
    ctx.fillText('गोवा', pad + hhW, titleY);
    ctx.fillStyle = T.coral;
    ctx.fillText(' HOUSE', pad + hhW + goaW, titleY);

    // Date line
    ctx.font = `500 ${Math.round(w * 0.025)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(11,18,32,0.65)';
    ctx.fillText('GOA, INDIA  ·  28 – 31 OCT 2026', pad, Math.round(headerH * 0.92));

    // ── PHOTO SECTION ──
    const photoTopY = headerH + Math.round(h * 0.02);
    const photoH    = Math.round(h * 0.44);
    const photoW    = w - pad * 2;
    const photoR    = 18;

    // Photo clip & draw
    ctx.save();
    roundRect(ctx, pad, photoTopY, photoW, photoH, photoR);
    ctx.clip();
    if (state.img) {
      drawCoverImage(ctx, state.img, pad, photoTopY, photoW, photoH, state.zoom, state.panX, state.panY);
    } else {
      const ig = ctx.createLinearGradient(pad, photoTopY, pad + photoW, photoTopY + photoH);
      ig.addColorStop(0, T.violet); ig.addColorStop(1, T.coral);
      ctx.fillStyle = ig; ctx.fillRect(pad, photoTopY, photoW, photoH);
    }
    ctx.restore();

    // Photo frame border (gradient)
    roundRect(ctx, pad, photoTopY, photoW, photoH, photoR);
    const pbg = ctx.createLinearGradient(pad, photoTopY, pad + photoW, photoTopY + photoH);
    pbg.addColorStop(0, T.coral); pbg.addColorStop(0.5, T.gold); pbg.addColorStop(1, T.teal);
    ctx.lineWidth = 4; ctx.strokeStyle = pbg; ctx.stroke();

    // Viewfinder corner marks on photo
    drawViewfinderCorners(ctx, pad, photoTopY, photoW, 44, T.teal, photoH);

    // Builder-title overlay pill on photo
    const builderTitle = (state.name.trim() || state.role.trim()) ? generateBuilderTitle() : '"The Undecided"';
    const overlayLabel = `"${builderTitle}"`;
    ctx.save();
    ctx.font = `italic 700 ${Math.round(w * 0.034)}px "Space Grotesk", system-ui, sans-serif`;
    const olW = ctx.measureText(overlayLabel).width + 36;
    const olH = 56;
    const olX = pad + 24;
    const olY = photoTopY + photoH - olH - 24;
    roundRect(ctx, olX, olY, olW, olH, olH / 2);
    const olg = ctx.createLinearGradient(olX, 0, olX + olW, 0);
    olg.addColorStop(0, T.coral); olg.addColorStop(1, T.gold);
    ctx.fillStyle = olg; ctx.fill();
    ctx.fillStyle = T.ink;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(overlayLabel, olX + 18, olY + olH / 2);
    ctx.restore();

    // ── BOTTOM CONTENT ──
    let y = photoTopY + photoH + Math.round(h * 0.045);

    // Name (left-aligned, large, gold→coral gradient) — full width
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const nameFont = `700 {size}px "Space Grotesk", "Arial Black", system-ui, sans-serif`;
    const nameSize = fitText(ctx, name, w - pad * 2, w * 0.084, nameFont, 30);
    ctx.font = nameFont.replace('{size}', nameSize);
    const ng = ctx.createLinearGradient(pad, 0, pad + w * 0.75, 0);
    ng.addColorStop(0, T.gold); ng.addColorStop(1, T.coral);
    ctx.fillStyle = ng;
    ctx.fillText(name, pad, y);

    y += Math.round(h * 0.038);

    // Tagline / role sub-text (left side)
    const tagline = role !== 'HH GOA BUILDER' ? generateTagline() : 'BUILDING THE NEXT BIG THING IN GOA';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    let tSize = Math.round(w * 0.025);
    ctx.font = `600 ${tSize}px "JetBrains Mono", ui-monospace, monospace`;
    while (ctx.measureText(tagline).width > w * 0.56 && tSize > 15) {
      tSize -= 1;
      ctx.font = `600 ${tSize}px "JetBrains Mono", ui-monospace, monospace`;
    }
    ctx.fillStyle = 'rgba(185,194,214,0.85)';
    ctx.fillText(tagline, pad, y);

    // Status block (right side, same row as tagline)
    ctx.save();
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.font = `700 ${Math.round(w * 0.022)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = T.teal;
    ctx.fillText('STATUS: VERIFIED', w - pad, y - Math.round(tSize * 0.35));
    ctx.font = `500 ${Math.round(w * 0.019)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(185,194,214,0.72)';
    ctx.fillText('PASS: ALL-DAYS // GOA', w - pad, y + Math.round(tSize * 0.6));
    ctx.restore();

    // Barcode — below status block, right-aligned
    const barcodeH = Math.round(h * 0.052);
    const barcodeY = y + Math.round(h * 0.012);
    drawBarcode(ctx, w - pad - 148, barcodeY, 148, barcodeH, bSeed);

    // ── SEPARATOR (placed cleanly below barcode) ──
    const sepY = barcodeY + barcodeH + Math.round(h * 0.025);
    ctx.save();
    ctx.strokeStyle = 'rgba(185,194,214,0.28)';
    ctx.lineWidth = 1.5; ctx.setLineDash([2, 12]); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(pad, sepY); ctx.lineTo(w - pad, sepY); ctx.stroke();
    ctx.restore();

    // Coordinates row
    const coordY = sepY + Math.round(h * 0.038);
    ctx.font = `500 ${Math.round(w * 0.023)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(185,194,214,0.65)';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('\uD83D\uDCCD  15.2993\u00B0 N, 73.9540\u00B0 E  \u00B7  GOA, INDIA', pad, coordY);
    ctx.textAlign = 'right';
    ctx.fillStyle = T.gold;
    ctx.fillText('HACKER HOUSE 2026', w - pad, coordY);

    // ── BOTTOM STRIP (magenta→aqua gradient bar) ──
    const stripH = Math.round(h * 0.068);
    const stripY = h - stripH;
    const sbg = ctx.createLinearGradient(0, 0, w, 0);
    sbg.addColorStop(0, T.violet);  sbg.addColorStop(0.35, T.magenta);
    sbg.addColorStop(0.7, T.sand);  sbg.addColorStop(1,   T.aqua);
    ctx.fillStyle = sbg; ctx.fillRect(0, stripY, w, stripH);

    ctx.font = `700 ${Math.round(w * 0.017)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = T.ink;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('#FrameInGoa', pad, stripY + stripH / 2);
    ctx.textAlign = 'center';
    ctx.fillText('HACKER HOUSE GOA  \u2726  OFFICIAL BUILDER PASS', w / 2, stripY + stripH / 2);
    ctx.textAlign = 'right';
    ctx.fillText('28-31 OCT 2026', w - pad, stripY + stripH / 2);
  }


  function drawViewfinderCorners(ctx, x, y, w, len, color, h) {
    // h is optional; falls back to w for square photos
    const sh = h !== undefined ? h : w;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.lineCap = 'round';
    const corners = [
      [x,     y,      1,  1],
      [x + w, y,     -1,  1],
      [x,     y + sh, 1, -1],
      [x + w, y + sh,-1, -1],
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
  // Render orchestration (near-instant: pure canvas draw, rAF-batched)
  // ============================================================
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    if (!state.img) return;
    let w, h;
    if (state.format === 'frame') { w = h = 1080; }
    else { w = 1080; h = 1350; }
    outputCanvas.width = w; outputCanvas.height = h;

    if (state.format === 'frame') renderFrame(outCtx, w);
    else renderCard(outCtx, w, h);

    previewEmpty.hidden = true;
    outputCanvas.hidden = false;
    renderBadge.hidden = false;
    actions.hidden = false;
  }

  // ============================================================
  // Download
  // ============================================================
  function canvasToBlob(canvas) {
    return new Promise((res) => canvas.toBlob(res, 'image/png', 0.95));
  }

  downloadBtn.addEventListener('click', async () => {
    if (!state.img) return;
    const blob = await canvasToBlob(outputCanvas);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const nameSlug = state.name.trim() ? state.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'builder';
    a.download = `hh-goa-2026-${nameSlug}-${state.format}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Image downloaded ✓');
  });

  // ============================================================
  // Share to X
  // ============================================================
  function buildCaption() {
    const handle = state.name.trim();
    const lead = state.format === 'frame'
      ? `Just framed my PFP for HH Goa 2026 🏝️⚡`
      : `Here's my HH Goa 2026 builder badge${handle ? `, ${handle} here` : ''} 🏝️⚡`;
    return `${lead} #FrameInGoa`;
  }

  shareBtn.addEventListener('click', async () => {
    if (!state.img) return;
    const blob = await canvasToBlob(outputCanvas);
    const caption = buildCaption();
    const file = new File([blob], `hh-goa-2026-${state.format}.png`, { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: caption });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user cancelled — no error toast
        // fall through to link fallback
      }
    }

    // Desktop / unsupported browsers: download the file, then open a pre-filled tweet.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(caption)}`;
    window.open(intent, '_blank', 'noopener');
    shareNote.hidden = false;
    shareNote.textContent = 'Image downloaded — drag it into the tweet window that just opened to attach it.';
    toast('Downloaded — attach the image to your tweet');
  });

})();

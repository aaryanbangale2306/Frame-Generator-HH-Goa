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
    ink:       '#08401b',   // deep forest green background
    inkRaised: '#0b5625',   // vibrant green card container
    inkLine:   'rgba(255,208,0,.22)',
    aqua:      '#ffd000',   // bright yellow accent
    magenta:   '#e9148c',   // hot pink accent
    sand:      '#ffe500',   // bright yellow title typography
    violet:    '#052e13',   // header green
    coral:     '#e9148c',   // hot pink
    gold:      '#ffe500',   // yellow typography
    teal:      '#ffd000',   // bright yellow
    cream:     '#ffe500',   // bright yellow
    greenBg:   '#0d5e2a',   // forest green background fill
    limeText:  '#8ec92a',   // muted lime green subtext
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

  function drawStripedTape(ctx, x, y, w, h, color1, color2, stripeW = 22) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = color1; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color2;
    for (let cx = -h * 2; cx < w + h * 2; cx += stripeW * 2) {
      ctx.beginPath();
      ctx.moveTo(cx, y + h);
      ctx.lineTo(cx + stripeW, y + h);
      ctx.lineTo(cx + stripeW + h, y);
      ctx.lineTo(cx + h, y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawDuctTape(ctx, x, y, w, h, angle = -0.1, color = '#e5c414') {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = color;
    roundRect(ctx, -w / 2, -h / 2, w, h, 3);
    ctx.fill();
    // texture line
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-w / 2 + 4, 0); ctx.lineTo(w / 2 - 4, 0); ctx.stroke();
    ctx.restore();
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
      ctx.fillStyle = cx < x + w * 0.85 ? '#ffe500' : 'rgba(255,229,0,0.45)';
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
      font: `700 ${Math.round(size * 0.052)}px "DM Serif Display", "Space Grotesk", serif`,
      color: T.sand, startAngle: Math.PI * 1.18, sweep: Math.PI * 0.64,
    });

    pill(ctx, cx, cy + r + size * 0.075, '#FrameInGoa', {
      font: `600 ${Math.round(size * 0.024)}px "JetBrains Mono", ui-monospace, "Courier New", monospace`,
      bg: '#000000', fg: '#ffe500', borderColor: 'rgba(255,229,0,.6)',
    });
  }

  // ============================================================
  // FORMAT B — Official Builder Pass (1080×1350, HH Goa 2026 template edition)
  // ============================================================
  function renderCard(ctx, w, h) {
    const pad = Math.round(w * 0.068);
    const stripHeight = 24;

    // ── 1. Top & Bottom Striped Tape Borders ──
    drawStripedTape(ctx, 0, 0, w, stripHeight, '#e9148c', '#ffd000', 16);
    drawStripedTape(ctx, 0, h - stripHeight, w, stripHeight, '#e9148c', '#ffd000', 16);

    // ── 2. Background Fill & Textured Vignette ──
    ctx.save();
    ctx.fillStyle = '#09451e';
    ctx.fillRect(0, stripHeight, w, h - stripHeight * 2);

    // Radial vignette
    const bgGlow = ctx.createRadialGradient(w * 0.5, h * 0.45, 100, w * 0.5, h * 0.45, w * 0.75);
    bgGlow.addColorStop(0, '#0d5c29');
    bgGlow.addColorStop(1, '#063316');
    ctx.fillStyle = bgGlow;
    ctx.fillRect(0, stripHeight, w, h - stripHeight * 2);

    // Watermark "26" on right background
    ctx.font = '900 460px "Space Grotesk", sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.09)';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText('26', w - 10, h * 0.52);
    ctx.restore();

    const name  = state.name.trim()  || 'Arham Boonlia';
    const role  = state.role.trim()  || 'Full-stack';
    const bSeed = hashStr(name + role);
    const badgeNo = String(bSeed % 9000 + 1000);

    // ── 3. HEADER ──
    const headerY = stripHeight + 48;

    // BUILDER #XXXX badge — top right
    ctx.save();
    ctx.font = `700 ${Math.round(w * 0.024)}px "JetBrains Mono", ui-monospace, monospace`;
    const bdgText = `BUILDER #${badgeNo}`;
    const bdgW = ctx.measureText(bdgText).width + 26;
    const bdgH = 38;
    const bdgX = w - pad - bdgW, bdgY = headerY - 14;
    roundRect(ctx, bdgX, bdgY, bdgW, bdgH, 6);
    ctx.fillStyle = '#ffd000'; ctx.fill();
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(bdgText, bdgX + bdgW / 2, bdgY + bdgH / 2 + 1);
    ctx.restore();

    // Title: "HACKER" + "गोवा" + "HOUSE"
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = `900 ${Math.round(w * 0.105)}px "DM Serif Display", "Space Grotesk", Georgia, serif`;
    ctx.fillStyle = '#ffe500';
    const hhW = ctx.measureText('HACKER').width;
    ctx.fillText('HACKER', pad, headerY + 50);

    ctx.font = `900 ${Math.round(w * 0.10)}px system-ui, "Arial Black", sans-serif`;
    ctx.fillStyle = '#e9148c';
    const goaW = ctx.measureText('गोवा').width;
    ctx.fillText('गोवा', pad + hhW + 4, headerY + 50);

    ctx.font = `900 ${Math.round(w * 0.105)}px "DM Serif Display", "Space Grotesk", Georgia, serif`;
    ctx.fillStyle = '#ffe500';
    ctx.fillText('HOUSE', pad + hhW + goaW + 10, headerY + 50);

    // Subtitle line
    ctx.font = `600 ${Math.round(w * 0.023)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = '#8ec92a';
    ctx.fillText('GOA, INDIA  ·  28 - 31 OCT 2026', pad, headerY + 86);

    // ── 4. PHOTO SECTION (Tilted Frame with Tape) ──
    const photoTopY = headerY + 110;
    const photoH    = Math.round(h * 0.43);
    const photoW    = w - pad * 2;

    ctx.save();
    // Rotate photo box slightly (-1.5 deg)
    const photoCx = pad + photoW / 2;
    const photoCy = photoTopY + photoH / 2;
    ctx.translate(photoCx, photoCy);
    ctx.rotate(-1.5 * Math.PI / 180);

    // Draw white photo card container background & border
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, -photoW / 2 - 6, -photoH / 2 - 6, photoW + 12, photoH + 12, 10);
    ctx.fill();

    // Clip & draw photo inside
    ctx.save();
    roundRect(ctx, -photoW / 2, -photoH / 2, photoW, photoH, 6);
    ctx.clip();
    if (state.img) {
      drawCoverImage(ctx, state.img, -photoW / 2, -photoH / 2, photoW, photoH, state.zoom, state.panX, state.panY);
    } else {
      const ig = ctx.createLinearGradient(-photoW / 2, -photoH / 2, photoW / 2, photoH / 2);
      ig.addColorStop(0, '#0b5c27'); ig.addColorStop(1, '#e9148c');
      ctx.fillStyle = ig; ctx.fillRect(-photoW / 2, -photoH / 2, photoW, photoH);
    }
    ctx.restore();

    // Photo corner brackets (Red/Pink viewfinder marks on top-right & bottom-right)
    drawViewfinderCorners(ctx, -photoW / 2, -photoH / 2, photoW, 36, '#e9148c', photoH);

    // Yellow tape on top-left corner
    drawDuctTape(ctx, -photoW / 2 + 50, -photoH / 2 + 10, 110, 32, -0.22, '#e5c414');

    // Builder title overlay pill on bottom left of photo
    const builderTitle = (state.name.trim() || state.role.trim()) ? generateBuilderTitle() : 'Console.log Archaeologist';
    const overlayLabel = `"${builderTitle}"`;
    ctx.save();
    ctx.font = `italic 700 ${Math.round(w * 0.033)}px "Space Grotesk", system-ui, sans-serif`;
    const olW = ctx.measureText(overlayLabel).width + 36;
    const olH = 54;
    const olX = -photoW / 2 + 20;
    const olY = photoH / 2 - olH - 18;
    
    ctx.translate(olX + olW / 2, olY + olH / 2);
    ctx.rotate(-1.2 * Math.PI / 180);

    roundRect(ctx, -olW / 2, -olH / 2, olW, olH, 10);
    ctx.fillStyle = '#e9148c'; ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(overlayLabel, 0, 1);

    // Small tape accent on pill edge
    drawDuctTape(ctx, olW / 2 - 10, -olH / 2 + 5, 45, 18, 0.3, '#e9148c');
    ctx.restore();

    ctx.restore(); // restore photo rotation transform

    // ── 5. NAME & TAGLINE ──
    let y = photoTopY + photoH + 54;

    // Name (large yellow serif typography)
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const nameFont = `700 {size}px "DM Serif Display", Georgia, serif`;
    const nameSize = fitText(ctx, name, w - pad * 2, w * 0.092, nameFont, 36);
    ctx.font = nameFont.replace('{size}', nameSize);
    ctx.fillStyle = '#ffe500';
    ctx.fillText(name, pad, y);

    y += Math.round(h * 0.038);

    // Tagline / role sub-text (left side)
    const tagline = role !== 'Full-stack' ? generateTagline() : 'BACKEND BY DAY, FRONTEND BY 3AM';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    let tSize = Math.round(w * 0.026);
    ctx.font = `700 ${tSize}px "JetBrains Mono", ui-monospace, monospace`;
    while (ctx.measureText(tagline).width > w * 0.56 && tSize > 15) {
      tSize -= 1;
      ctx.font = `700 ${tSize}px "JetBrains Mono", ui-monospace, monospace`;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillText(tagline, pad, y);

    // Status block & Barcode (right side)
    ctx.save();
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.font = `700 ${Math.round(w * 0.021)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = '#ffe500';
    ctx.fillText('STATUS: VERIFIED', w - pad, y - Math.round(tSize * 0.35));
    ctx.font = `500 ${Math.round(w * 0.019)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = '#8ec92a';
    ctx.fillText('PASS: ALL-DAYS // GOA', w - pad, y + Math.round(tSize * 0.65));
    ctx.restore();

    // Barcode — below status block, right-aligned
    const barcodeH = Math.round(h * 0.048);
    const barcodeY = y + Math.round(h * 0.012);
    drawBarcode(ctx, w - pad - 148, barcodeY, 148, barcodeH, bSeed);

    // ── 6. COORDINATES BAR ──
    const sepY = barcodeY + barcodeH + 24;
    ctx.save();
    ctx.strokeStyle = 'rgba(142,201,42,0.4)';
    ctx.lineWidth = 1.5; ctx.setLineDash([2, 10]); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(pad, sepY); ctx.lineTo(w - pad, sepY); ctx.stroke();
    ctx.restore();

    const coordY = sepY + 34;
    ctx.font = `600 ${Math.round(w * 0.023)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = '#8ec92a';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('\uD83D\uDCCD 15.2993\u00B0 N, 74.1240\u00B0 E  \u00B7  GOA, INDIA', pad, coordY);
    ctx.textAlign = 'right';
    ctx.fillText('HACKER HOUSE 2026', w - pad, coordY);

    // ── 7. BOTTOM BLACK STRIP ──
    const blackStripH = 54;
    const blackStripY = h - stripHeight - blackStripH;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, blackStripY, w, blackStripH);

    // Yellow dashed line top border of black strip
    ctx.save();
    ctx.strokeStyle = '#ffd000'; ctx.lineWidth = 2.5; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(0, blackStripY); ctx.lineTo(w, blackStripY); ctx.stroke();
    ctx.restore();

    ctx.font = `700 ${Math.round(w * 0.020)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd000';
    ctx.fillText('#FrameInGoa', pad, blackStripY + blackStripH / 2);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('HACKER HOUSE GOA  \u2726  OFFICIAL BUILDER PASS', w / 2, blackStripY + blackStripH / 2);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd000';
    ctx.fillText('28-31 OCT 2026', w - pad, blackStripY + blackStripH / 2);
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
